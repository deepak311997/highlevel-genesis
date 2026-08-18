import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildShim, encodeAssets, HL_CALL_LIMIT, HL_TIMEOUT_MS } from './previewShim'
import type { PreviewAsset } from './previewShim'

/**
 * The shim, evaluated for real (AC-9 … AC-16).
 *
 * D8 makes the shim a string constant rather than a function put through
 * `.toString()`, because esbuild's `keepNames` wraps functions in `__name(...)`
 * and a serialised body would then call a helper that does not exist inside the
 * iframe — a bug visible only in a production build. The cost of that decision
 * is that **nothing typechecks the shim**, so this file is what the compiler
 * would otherwise be: the source is evaluated over stubbed globals and its
 * behaviour asserted, rather than its text matched.
 */

/** A message the shim posted to the host, shaped only as far as these tests read it. */
type PostedMessage = Record<string, unknown>

/** The `Error` the shim rejects with — a plain `Error` plus the two fields D9 pins. */
type HlError = Error & { status?: unknown; code?: unknown }

/**
 * The signature `new Function` really has, once its arguments are named.
 *
 * `new Function` is typed as returning `Function`, whose call signature is
 * `any`-shaped; asserting to this type is what keeps the call sites free of
 * `any` rather than silencing the unsafe-call rule at each one.
 */
type ShimEntry = (window: Record<string, unknown>, document: Document, parent: unknown) => void

interface ShimHarness {
  /** The global the generated code calls. */
  hl: (method: string, path: string, payload?: unknown) => Promise<unknown>
  /** Everything the shim has posted to the parent, in order. */
  posted: PostedMessage[]
  /** Dispatch an event to the listeners the shim registered for `type`. */
  fire: (type: string, event: unknown) => void
  /** The loader every rewritten reference calls, by asset index. */
  installAsset: (index: number) => void
}

/**
 * A stand-in `document`, so the asset loader can be driven without a real one.
 *
 * `__genesisAsset` is the only part of the shim that touches the DOM, and what
 * it does there is the whole of AC-2 and AC-3's "and run" — a `<style>` or a
 * `<script>` element, built through the DOM so the HTML parser never sees the
 * content (D7), swapped in at the position the reference occupied. A real jsdom
 * document would execute an inserted `<script>` for real, which is a different
 * test; this one records what was built and where it went.
 */
interface FakeNode {
  tag: string
  textContent: string
}

interface FakeDocument {
  created: FakeNode[]
  appended: FakeNode[]
  replaced: { node: FakeNode; old: unknown }[]
  as: Document
}

function fakeDocument(withCurrentScript: boolean): FakeDocument {
  const created: FakeNode[] = []
  const appended: FakeNode[] = []
  const replaced: { node: FakeNode; old: unknown }[] = []

  const currentScript = withCurrentScript
    ? {
        parentNode: {
          replaceChild: (node: FakeNode, old: unknown) => {
            replaced.push({ node, old })
          },
        },
      }
    : null

  const doc = {
    createElement: (tag: string): FakeNode => {
      const node = { tag, textContent: '' }
      created.push(node)
      return node
    },
    currentScript,
    head: {
      appendChild: (node: FakeNode) => {
        appended.push(node)
      },
    },
  }

  return { created, appended, replaced, as: doc as unknown as Document }
}

function run(nonce = 'n1', assets: PreviewAsset[] = [], doc: Document = document): ShimHarness {
  const listeners: Record<string, ((event: unknown) => void)[]> = {}
  const posted: PostedMessage[] = []

  const win: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      ;(listeners[type] ??= []).push(fn)
    },
    /*
     * Read through `globalThis` at call time rather than capturing the function
     * now, so `vi.useFakeTimers()` — which replaces the global — reaches the
     * timer the shim arms inside `hl()` (AC-14).
     */
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: number) => {
      globalThis.clearTimeout(id)
    },
  }
  const parent = { postMessage: (message: PostedMessage) => posted.push(message) }

  /*
   * Evaluating the shim is the point of this file, so the Function constructor
   * is the tool and not a smell: the string is exactly what the iframe will be
   * handed, and running it here is the only check it ever gets.
   */
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating the shim IS the test
  const entry = new Function(
    'window',
    'document',
    'parent',
    buildShim(nonce, assets),
  ) as unknown as ShimEntry
  entry(win, doc, parent)

  return {
    hl: win['hl'] as ShimHarness['hl'],
    posted,
    fire: (type, event) => {
      for (const fn of listeners[type] ?? []) fn(event)
    },
    installAsset: win['__genesisAsset'] as ShimHarness['installAsset'],
  }
}

/** A host reply as `previewHost` sends it, with the fields a case varies. */
function reply(fields: Record<string, unknown>): { data: Record<string, unknown> } {
  return { data: { genesis: 'preview-host', v: 1, nonce: 'n1', ...fields } }
}

/** The id the shim minted for the call it has just posted. */
function idOf(message: PostedMessage | undefined): unknown {
  return message?.['id']
}

/**
 * A promise that has not settled, asserted without waiting for it to.
 *
 * `Promise.race` against an already-resolved sentinel settles on the next
 * microtask: if the call's promise were resolved or rejected it would win the
 * race, since it was created first.
 */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  return (
    (await Promise.race([promise.then(() => 'settled'), Promise.resolve('pending')])) === 'pending'
  )
}

describe('previewShim', () => {
  /*
   * Fake timers for every case, not only AC-14's.
   *
   * Several cases deliberately leave a call pending, and a pending call holds a
   * 30-second timer that would reject with nobody listening long after the test
   * ended. `vi.useRealTimers()` discards them, so the suite leaves nothing armed.
   */
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('encodeAssets', () => {
    /*
     * The assets ride inside a `<script>` element, so the one byte that could
     * end that element early must not appear. Escaping `<` — rather than only
     * the `</script>` sequence — means the invariant is a property of the whole
     * literal and can be asserted by looking for a single character.
     */
    const risky: PreviewAsset[] = [
      { kind: 'js', content: 'const marker = "</script><img src=x>"' },
      { kind: 'css', content: '/* </style> */ body { color: red }' },
    ]

    it('round-trips content byte-identically through JSON.parse', () => {
      expect(JSON.parse(encodeAssets(risky)) as PreviewAsset[]).toEqual(risky)
    })

    it('produces a literal with no "<" character at all', () => {
      expect(encodeAssets(risky)).not.toContain('<')
    })
  })

  /**
   * The other half of AC-2 and AC-3 — "when assembled **and run**".
   *
   * `previewDocument.spec.ts` proves the loader call lands where the reference
   * was and that the content reaches the embedded payload intact. What it cannot
   * prove is that the loader then installs anything: it asserts strings, and
   * jsdom does not execute the document. Without these cases a `__genesisAsset`
   * that returned early for stylesheets would leave every generated page
   * unstyled and the whole suite green.
   */
  describe('the asset loader', () => {
    const assets: PreviewAsset[] = [
      { kind: 'css', content: 'body { color: red }' },
      { kind: 'js', content: 'window.ran = true' },
    ]

    it('installs a stylesheet as a style element carrying the stored CSS', () => {
      const doc = fakeDocument(true)
      run('n1', assets, doc.as).installAsset(0)

      expect(doc.created).toEqual([{ tag: 'style', textContent: 'body { color: red }' }])
      // In place, at the position the `<link>` occupied — not appended to head,
      // which would move a stylesheet past the rules meant to override it and a
      // script past the element it expects to find.
      expect(doc.replaced).toHaveLength(1)
      expect(doc.replaced[0]?.node.tag).toBe('style')
      expect(doc.appended).toEqual([])
    })

    it('installs a script as a script element carrying the stored JS', () => {
      const doc = fakeDocument(true)
      run('n1', assets, doc.as).installAsset(1)

      expect(doc.created).toEqual([{ tag: 'script', textContent: 'window.ran = true' }])
      expect(doc.replaced).toHaveLength(1)
    })

    /* No `currentScript` means no position to replace, so head is the honest
     * fallback: the content still runs rather than being dropped in silence. */
    it('falls back to the head when there is no script to replace', () => {
      const doc = fakeDocument(false)
      run('n1', assets, doc.as).installAsset(0)

      expect(doc.appended).toHaveLength(1)
      expect(doc.appended[0]?.tag).toBe('style')
      expect(doc.replaced).toEqual([])
    })

    /* An index the payload does not hold cannot happen from an assembled
     * document, but the loader is a global the generated app can call too. */
    it('does nothing for an index the document does not carry', () => {
      const doc = fakeDocument(true)
      run('n1', assets, doc.as).installAsset(7)

      expect(doc.created).toEqual([])
      expect(doc.appended).toEqual([])
      expect(doc.replaced).toEqual([])
    })
  })

  describe('the request path', () => {
    /* AC-9 */
    it('posts exactly one request carrying the nonce, an id and the three arguments', async () => {
      const { hl, posted } = run('n1')

      const call = hl('POST', '/contacts/search', { pageLimit: 20 })

      expect(posted).toHaveLength(1)
      expect(posted[0]).toEqual({
        genesis: 'preview',
        v: 1,
        nonce: 'n1',
        id: expect.any(String) as unknown,
        kind: 'hl',
        method: 'POST',
        path: '/contacts/search',
        payload: { pageLimit: 20 },
      })
      expect(idOf(posted[0])).not.toBe('')
      /* The host has not answered, so the generated code is still awaiting. */
      expect(await isPending(call)).toBe(true)
    })

    /* AC-10 — identity, not equality: the host's object arrives unwrapped and uncopied. */
    it('resolves with the reply data exactly as sent', async () => {
      const { hl, posted, fire } = run('n1')
      const call = hl('GET', '/contacts/abc')
      const data = { contact: { id: 'abc' } }

      fire('message', reply({ id: idOf(posted[0]), ok: true, data }))

      await expect(call).resolves.toBe(data)
    })

    /* AC-11 — the `status`/`code` contract Slice 9's prompt already teaches. */
    it('rejects with an Error carrying the failure message, status and code', async () => {
      const { hl, posted, fire } = run('n1')
      const call = hl('GET', '/contacts/abc')

      fire(
        'message',
        reply({
          id: idOf(posted[0]),
          ok: false,
          error: {
            message: 'Reconnect HighLevel to continue.',
            status: 401,
            code: 'hl_reconnect_required',
          },
        }),
      )

      const error = (await call.catch((reason: unknown) => reason)) as HlError
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('Reconnect HighLevel to continue.')
      expect(error.status).toBe(401)
      expect(error.code).toBe('hl_reconnect_required')
    })

    /* AC-12 — a reply for a call this document never made. */
    it('ignores a reply carrying an unknown id', async () => {
      const { hl, fire } = run('n1')
      const call = hl('GET', '/contacts/abc')

      fire('message', reply({ id: 'not-a-call', ok: true, data: {} }))

      expect(await isPending(call)).toBe(true)
    })

    /*
     * AC-12 — the stale-document case: a reply for the *previous* build, whose
     * ids collide with this one's because both count from `c1`. The nonce is
     * what tells them apart, so it is checked before the id is looked up.
     */
    it('ignores a reply carrying a different nonce', async () => {
      const { hl, posted, fire } = run('n1')
      const call = hl('GET', '/contacts/abc')

      fire('message', {
        data: {
          genesis: 'preview-host',
          v: 1,
          nonce: 'n2',
          id: idOf(posted[0]),
          ok: true,
          data: {},
        },
      })

      expect(await isPending(call)).toBe(true)
    })
  })

  describe('the budget, the timeout and the error channel', () => {
    /*
     * AC-13 — the budget exists because a render loop in generated code is one
     * `useEffect` away, and every call it makes lands on a real CRM. The 51st is
     * refused locally: it never reaches the host, and it is reported once so the
     * user sees why the app stopped rather than watching it hang.
     */
    it('refuses the call past the limit, names it, and posts it nowhere', async () => {
      const { hl, posted } = run('n1')
      /* Held so the rejections these never get are not floating promises. */
      const spent = Array.from({ length: HL_CALL_LIMIT }, () => hl('GET', '/contacts/abc'))
      expect(spent).toHaveLength(HL_CALL_LIMIT)
      expect(posted.filter((message) => message['kind'] === 'hl')).toHaveLength(HL_CALL_LIMIT)

      const refused = hl('GET', '/contacts/abc')

      await expect(refused).rejects.toThrow(String(HL_CALL_LIMIT))
      expect(posted.filter((message) => message['kind'] === 'hl')).toHaveLength(HL_CALL_LIMIT)
      const reports = posted.filter((message) => message['kind'] === 'error')
      expect(reports).toHaveLength(1)
      expect(reports[0]?.['message']).toContain(String(HL_CALL_LIMIT))
    })

    /*
     * AC-14 — a host that never answers must not leave the generated code
     * awaiting forever. The timers are already fake (see the suite's
     * `beforeEach`), which is what lets this reach the shim's own `setTimeout`.
     */
    it('rejects a call the host never answers, once the timeout passes', async () => {
      const { hl } = run('n1')

      const call = hl('GET', '/contacts/abc')
      vi.advanceTimersByTime(HL_TIMEOUT_MS)

      await expect(call).rejects.toThrow(`${HL_TIMEOUT_MS / 1000} seconds`)
    })

    /* AC-15 — an uncaught error in generated code is the host's to show. */
    it('reports an uncaught error once, carrying its text', () => {
      const { posted, fire } = run('n1')

      fire('error', { message: 'boom' })

      expect(posted).toHaveLength(1)
      expect(posted[0]).toMatchObject({ genesis: 'preview', v: 1, nonce: 'n1', kind: 'error' })
      expect(posted[0]?.['message']).toContain('boom')
    })

    /* AC-15 — and a rejection nobody handled, which is the commoner of the two. */
    it('reports an unhandled rejection once, carrying its message', () => {
      const { posted, fire } = run('n1')

      fire('unhandledrejection', { reason: new Error('nope') })

      expect(posted).toHaveLength(1)
      expect(posted[0]?.['kind']).toBe('error')
      expect(posted[0]?.['message']).toContain('nope')
    })

    /*
     * AC-16 — `connect-src 'none'` is what stops generated code calling anything
     * itself. Naming the directive turns "nothing happened" into a message that
     * says which rule refused, which is the difference between a bug report and
     * a shrug.
     */
    it('reports a content security policy violation, naming the directive', () => {
      const { posted, fire } = run('n1')

      fire('securitypolicyviolation', { violatedDirective: 'connect-src' })

      expect(posted).toHaveLength(1)
      expect(posted[0]?.['kind']).toBe('error')
      expect(posted[0]?.['message']).toContain('connect-src')
    })
  })

  /*
   * The invariant that makes the whole `<script>`-embedding safe (D7): the shim
   * source is written without a single `<` character, so nothing it carries —
   * generated code included — can terminate the element that delivers it.
   */
  it('contains no "<" character, whatever it carries', () => {
    expect(buildShim('n', [])).not.toContain('<')
    expect(buildShim('n', [{ kind: 'js', content: 'a </script> b' }])).not.toContain('<')
  })

  it('exposes the limits the shim enforces', () => {
    expect(HL_CALL_LIMIT).toBe(50)
    expect(HL_TIMEOUT_MS).toBe(30_000)
  })
})
