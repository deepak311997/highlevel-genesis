import { ApiError } from './api'

/**
 * The host half of the preview channel.
 *
 * ## Why there is a channel at all
 *
 * The generated app runs in a sandboxed `srcdoc` iframe with **no
 * `allow-same-origin`** (D16). That is the whole security posture: the frame has
 * an opaque origin, so it cannot read our cookies, cannot reach our API with the
 * user's credentials, and cannot touch anything on the parent page. It also
 * means it cannot call HighLevel by itself. So a shim inside the frame posts
 * `hl()` requests up to us, we verify them, we call `hlProxy` on our own
 * credentialed, same-origin page, and we post the JSON body back down.
 * **No credential ever enters the iframe** — not an ID token, not an App Check
 * token, not a location id. What crosses is a method, a path, a payload and a
 * response body.
 *
 * ## Why origin is not the check, and the nonce is
 *
 * A message from an opaque origin arrives with `event.origin === 'null'` — the
 * literal four-character string, which every sandboxed frame everywhere also
 * has. It identifies nothing, so comparing it would be a check that looks like
 * security and is not. What does identify the peer is `event.source`: the exact
 * `Window` object of the iframe we are currently showing. And what distinguishes
 * the *current* document from the previous build's — which stays alive long
 * enough to post after a `srcdoc` swap — is a nonce minted per build and handed
 * only to that document (AC-17).
 *
 * Replies go out with `targetOrigin: '*'`, because an opaque origin has no
 * nameable origin string to target. That is precisely why a reply must never
 * carry a token, a uid or a location id: `'*'` means any document that ends up
 * in that frame can read it.
 *
 * ## Why a malformed message is dropped in silence
 *
 * No reply, no HighLevel call, no log the frame can observe (AC-18). A reply
 * that said *which* field was wrong would be an oracle for probing the gate, and
 * the only sender that can legitimately reach here already knows the protocol.
 */

/** Bumped only for a breaking change to the message shapes below. */
export const PREVIEW_V = 1

/** Frame → host. */
export const FRAME_TAG = 'preview'
/** Host → frame. Distinct so our own replies cannot be echoed back as requests. */
export const HOST_TAG = 'preview-host'

/** The three the proxy allowlist uses — `hlProxy`'s `HlMethod`, restated at the boundary. */
export type PreviewMethod = 'GET' | 'POST' | 'PUT'

const METHODS: readonly string[] = ['GET', 'POST', 'PUT']

/**
 * An accepted message, as a discriminated union rather than optional-field soup.
 *
 * A runtime error report has no `id` and expects no reply; a HighLevel request
 * has both. Modelling that as one record with four optional fields would make
 * every reader re-derive which combination is real.
 */
export type PreviewMessage =
  | { kind: 'hl'; id: string; method: PreviewMethod; path: string; payload?: unknown }
  | { kind: 'error'; message: string }

/** What the host reports about a brokered call that failed. */
export interface PreviewFailure {
  message: string
  status: number
  code: string | null
}

/**
 * Everything the gate needs, supplied by the component that owns the iframe.
 *
 * Passed in rather than imported so this module stays a pure function of its
 * inputs: `proxy` is `hlProxy` in the app and a stub in the spec, and `frame` is
 * `null` for the whole window between builds — during which nothing is accepted.
 */
export interface BridgeContext {
  nonce: string
  frame: Window | null
  proxy: (method: PreviewMethod, path: string, payload?: unknown) => Promise<unknown>
  post: (message: unknown) => void
  onFailure: (failure: PreviewFailure) => void
  onRuntimeError: (message: string) => void
}

export type HostReply =
  | {
      genesis: typeof HOST_TAG
      v: typeof PREVIEW_V
      nonce: string
      id: string
      ok: true
      data: unknown
    }
  | {
      genesis: typeof HOST_TAG
      v: typeof PREVIEW_V
      nonce: string
      id: string
      ok: false
      error: { message: string; status: number; code?: string }
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Parse, don't validate: an untrusted `postMessage` payload in, a
 * `PreviewMessage` or `null` out.
 *
 * Every field the dispatcher goes on to read is checked here and nowhere else,
 * so there is one place to look for what the host will accept. The nonce is a
 * parameter rather than read from a module-level variable because it changes on
 * every build, and a stale one must fail this check rather than be corrected
 * later.
 */
export function readPreviewMessage(data: unknown, nonce: string): PreviewMessage | null {
  if (!isRecord(data)) return null
  if (data['genesis'] !== FRAME_TAG) return null
  if (data['v'] !== PREVIEW_V) return null
  if (data['nonce'] !== nonce) return null

  const kind = data['kind']

  if (kind === 'hl') {
    const { id, method, path } = data
    if (typeof id !== 'string' || id === '') return null
    if (typeof method !== 'string' || !METHODS.includes(method)) return null
    if (typeof path !== 'string') return null

    return {
      kind: 'hl',
      id,
      method: method as PreviewMethod,
      path,
      // Spread conditionally so an absent payload stays absent rather than
      // becoming an explicit `undefined` — `hlProxy` distinguishes the two on a
      // GET, where the payload becomes the query string.
      ...('payload' in data ? { payload: data['payload'] } : {}),
    }
  }

  if (kind === 'error') {
    const { message } = data
    return typeof message === 'string' ? { kind: 'error', message } : null
  }

  return null
}

export function successReply(nonce: string, id: string, data: unknown): HostReply {
  return { genesis: HOST_TAG, v: PREVIEW_V, nonce, id, ok: true, data }
}

export function failureReply(nonce: string, id: string, failure: PreviewFailure): HostReply {
  const { message, status, code } = failure
  return {
    genesis: HOST_TAG,
    v: PREVIEW_V,
    nonce,
    id,
    ok: false,
    // Conditional spread, as in `functions/src/lib/errors.ts`: a client reads
    // `code` as a string or as nothing, never as null. `PreviewFailure` uses
    // null internally because it is a value we always compute; the wire shape
    // is the server's envelope, and the two should not drift.
    error: { message, status, ...(code === null ? {} : { code }) },
  }
}

function failureFor(err: unknown): PreviewFailure {
  if (err instanceof ApiError) {
    return { message: err.message, status: err.status, code: err.code ?? null }
  }
  // Nothing else has a status worth reporting, and a rejection that is not an
  // ApiError never reached the server at all.
  return { message: 'The preview could not reach HighLevel. Try again.', status: 0, code: null }
}

/**
 * The gate and the broker, in that order.
 *
 * `event.source` is compared before anything else is read, so a message from
 * another frame costs one identity comparison and nothing more. `ctx.frame`
 * being `null` — the state between builds — rejects everything, which is the
 * correct answer while no document is being shown.
 */
export async function handlePreviewMessage(event: MessageEvent, ctx: BridgeContext): Promise<void> {
  if (ctx.frame === null || event.source !== ctx.frame) return

  // `MessageEvent.data` is typed `any`; naming it `unknown` is what makes the
  // parse below the only thing that can widen it.
  const data: unknown = event.data
  const message = readPreviewMessage(data, ctx.nonce)
  if (message === null) return

  if (message.kind === 'error') {
    ctx.onRuntimeError(message.message)
    return
  }

  try {
    const result = await ctx.proxy(message.method, message.path, message.payload)
    ctx.post(successReply(ctx.nonce, message.id, result))
  } catch (err) {
    const failure = failureFor(err)
    ctx.post(failureReply(ctx.nonce, message.id, failure))
    // Reported whether or not the generated app catches its own rejection: the
    // app's try/catch is model output, so the host's record of what failed
    // cannot depend on it (D17).
    ctx.onFailure(failure)
  }
}
