import { ApiError } from './api'
import type { HlMethod } from './hlProxyApi'

/**
 * The host half of the preview channel.
 *
 * The generated app runs in a sandboxed `srcdoc` iframe with **no
 * `allow-same-origin`**, which is the whole security posture: the frame has an
 * opaque origin, so it cannot read our cookies, cannot reach our API with the
 * user's credentials, and cannot touch the parent page. It also cannot call
 * HighLevel by itself — so a shim inside the frame posts `hl()` requests up, we
 * verify them, call `hlProxy` on our own credentialed page, and post the JSON body
 * back down. **No credential ever enters the iframe.**
 *
 * **Origin is not the check; the nonce is.** A message from an opaque origin
 * arrives with `event.origin === 'null'`, which every sandboxed frame everywhere
 * also has — comparing it would look like security and not be. `event.source`
 * identifies the peer, and a nonce minted per build distinguishes the *current*
 * document from the previous one, which stays alive long enough to post after a
 * `srcdoc` swap.
 *
 * Replies go out with `targetOrigin: '*'`, because an opaque origin has no
 * nameable origin to target — so what a reply may carry is the rule that makes it
 * safe: **no credential and nothing identifying the Genesis account**. It does
 * carry HighLevel's own response body verbatim, which embeds the connected
 * `locationId`: a tenant identifier rather than a bearer credential, naming data
 * the frame is already rendering.
 *
 * **A malformed message is dropped in silence** — no reply, no call, nothing the
 * frame can observe. A reply naming the wrong field would be an oracle for probing
 * the gate, and the only legitimate sender already knows the protocol.
 */

/** Bumped only for a breaking change to the message shapes below. */
export const PREVIEW_V = 1

/** Frame → host. */
export const FRAME_TAG = 'preview'
/** Host → frame. Distinct so our own replies cannot be echoed back as requests. */
export const HOST_TAG = 'preview-host'

/** The three the proxy allowlist uses. An alias, not a restatement — the frame's
 * method goes straight to `hlProxy`, so a second copy could only ever drift. */
export type PreviewMethod = HlMethod

const METHODS = ['GET', 'POST', 'PUT'] as const satisfies readonly PreviewMethod[]

/** `satisfies` above plus a predicate here is what lets the parse narrow without a cast. */
function isPreviewMethod(value: unknown): value is PreviewMethod {
  return typeof value === 'string' && (METHODS as readonly string[]).includes(value)
}

/**
 * An accepted message, as a discriminated union rather than optional-field soup: a
 * runtime error report has no `id` and expects no reply, a HighLevel request has
 * both, and one record with four optional fields would make every reader
 * re-derive which combination is real.
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
 * inputs — and `frame` is `null` for the whole window between builds, during which
 * nothing is accepted.
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
 * Parse, don't validate: an untrusted `postMessage` payload in, a `PreviewMessage`
 * or `null` out.
 *
 * Every field the dispatcher goes on to read is checked here and nowhere else. The
 * nonce is a parameter because it changes on every build, and a stale one must fail
 * this check rather than be corrected later.
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
    if (!isPreviewMethod(method)) return null
    if (typeof path !== 'string') return null

    return {
      kind: 'hl',
      id,
      method,
      path,
      // Spread conditionally so an absent payload stays absent rather than becoming
      // an explicit `undefined` — `hlProxy` distinguishes the two on a GET.
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
    // Conditional spread: a client reads `code` as a string or as nothing, never as
    // null. `PreviewFailure` uses null internally because it is a value we always
    // compute; the wire shape is the server's envelope.
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
 * The gate and the broker, in that order. `event.source` is compared before
 * anything else is read, so a message from another frame costs one identity
 * comparison. `ctx.frame` being `null` — the state between builds — rejects
 * everything, which is the correct answer while no document is shown.
 */
export async function handlePreviewMessage(event: MessageEvent, ctx: BridgeContext): Promise<void> {
  if (ctx.frame === null || event.source !== ctx.frame) return

  // `MessageEvent.data` is typed `any`; naming it `unknown` is what makes the parse
  // below the only thing that can widen it.
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
    // app's try/catch is model output, so the host's record cannot depend on it.
    ctx.onFailure(failure)
  }
}
