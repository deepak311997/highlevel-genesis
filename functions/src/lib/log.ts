/**
 * Logging that cannot leak a credential.
 *
 * Registration handles plaintext passwords and mints action links, both bearer
 * credentials, and Cloud Logging retains what it is given — a single
 * `console.error(err)` on a rejected Admin SDK call is enough to put a password
 * in a sink that outlives the request.
 *
 * The defence is not discipline at call sites: every value goes through
 * {@link redact} on the way out, so a secret arriving from an `unknown` in a
 * catch block is scrubbed by the sink rather than by whoever remembered.
 */

export const REDACTED = '[redacted]'

/**
 * Field names whose *value* is always a secret.
 *
 * Substring matching, case-insensitive, so `newPassword`, `X-Api-Key` and
 * `refreshToken` are all caught without enumerating every spelling.
 */
const SENSITIVE_KEY =
  /pass|token|secret|oobcode|api[-_]?key|authorization|cookie|credential|^state$/i

/** A URL carrying an out-of-band action code. The whole link is the secret. */
const ACTION_LINK = /https?:\/\/\S*oobcode=/i

/**
 * `password=hunter2` or `oobCode: ABC` embedded in prose, as errors often do —
 * and `"access_token":"…"` embedded in JSON, since {@link describeError} now logs
 * upstream response bodies verbatim. The quotes are optional on both sides of the
 * separator, so the same rule covers prose and a serialised body.
 */
const INLINE_SECRET = /\b(pass\w*|[\w-]*token|oobcode|api[-_]?key|secret)"?\s*[=:]\s*"?\S+/gi

/**
 * The OAuth callback's two bearer credentials, matched in **query-string
 * position only** — a logged callback URL hands over both.
 *
 * The position anchor is what makes this safe: `code` is also the property every
 * Firebase error reports its error code on, so a rule matching it anywhere would
 * redact precisely the lines written to diagnose a failing OAuth flow. The
 * parameter name is kept, so the line still says which credential was present.
 */
const SENSITIVE_QUERY = /([?&](?:code|state)=)[^&\s]+/gi

function scrubString(value: string): string {
  if (ACTION_LINK.test(value)) return REDACTED
  return value
    .replace(SENSITIVE_QUERY, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(INLINE_SECRET, (_match, name: string) => `${name}=${REDACTED}`)
}

/**
 * Deep-copy a value with every secret replaced.
 *
 * Never throws: it runs in catch blocks and in the terminal error handler, where
 * a throw would replace a useful line with an unhandled rejection. Circular
 * references — common in HTTP errors that hold their own request — resolve to a
 * marker rather than blowing the stack.
 */
export function redact(value: unknown, seen = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'function') return '[function]'
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => redact(item, seen))

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecret(key, item) ? REDACTED : redact(item, seen)
  }
  return out
}

/**
 * A sensitive *name* over a value that could actually be a credential.
 *
 * The key pattern matches substrings on purpose, which has one false positive
 * worth excluding: **token counts**. `inputTokens` matches `token`, and redacting
 * it would empty the generation line of the numbers it exists to carry, with no
 * warning — a redacted field still looks deliberate.
 *
 * Excluded by *type* rather than by name: every credential this codebase handles
 * is a string, and a number under a sensitive name is a count or an expiry. A
 * name list would be a list to maintain, and the next field would not be on it.
 */
function isSecret(key: string, value: unknown): boolean {
  if (!SENSITIVE_KEY.test(key)) return false
  return typeof value !== 'number' && typeof value !== 'boolean'
}

/**
 * How much of an upstream response body a log line may carry.
 *
 * Bounded because the body is somebody else's and its size is not ours to
 * predict, and a validation error puts what matters first: HighLevel's own 422
 * leads with the field it refused.
 */
const BODY_MAX = 400

/**
 * The upstream half of a thrown value: the endpoint that answered, and what it
 * said.
 *
 * `HighLevel responded 422` is a true sentence and a useless one — it was all a
 * failed production install left behind, and it names neither the call that was
 * refused nor the reason given. The status is already in the message; the body is
 * where the reason lives, so it is appended, truncated and scrubbed.
 *
 * Matched **structurally**, on a numeric `status` beside a string `body`, so this
 * module still knows nothing about HighLevel. The pairing is what makes it safe:
 * a Firebase error carries its `body` nested under `response`, not at the top
 * level, so the branch that hides its payload keeps hiding it.
 */
function upstreamDetail(err: object): string {
  const { status, body, endpoint } = err as {
    status?: unknown
    body?: unknown
    endpoint?: unknown
  }
  if (typeof status !== 'number' || typeof body !== 'string') return ''

  const where = typeof endpoint === 'string' && endpoint !== '' ? ` ${endpoint}` : ''
  const text = body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}…` : body

  /*
   * Joined with a dash rather than a colon, and that is not cosmetic: half of
   * HighLevel's OAuth paths end in `locationToken`, and `…locationToken: {body}`
   * is exactly the `name: value` shape {@link INLINE_SECRET} redacts. The blunt
   * rule is right — it is why a credential in an unknown string never survives —
   * so the line formats itself out of its way instead.
   */
  return ` —${where} body ${text}`
}

/**
 * A one-line description of a thrown value, safe to log. Firebase errors carry
 * the failing request on the object, so the message and code are extracted rather
 * than the whole thing serialised.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const { code } = err as { code?: unknown }
    const prefix = typeof code === 'string' ? `${code}: ` : ''
    return scrubString(`${prefix}${err.message}${upstreamDetail(err)}`)
  }
  if (typeof err === 'string') return scrubString(err)
  return `Non-error thrown (${typeof err})`
}

/**
 * Context an auth log line may carry. Deliberately narrow — no free-form body.
 *
 * **There is deliberately no `branch` field.** `emailHash` is an unsalted SHA-256
 * over a guessable space, so a wordlist reverses it offline in seconds — and a
 * line pairing that hash with "this address already existed" hands anyone who can
 * read Cloud Logging the account-existence oracle the uniform response, the
 * identical screens and the existence-blind throttle were all built to refuse.
 *
 * Branch volume, if ever wanted, belongs in an aggregate counter with no
 * per-request identifier on it.
 */
export interface AuthLogContext {
  /** SHA-256 of the normalised address. Never the address itself. */
  emailHash?: string
  outcome?: 'ok' | 'throttled' | 'invalid'
  status?: number
  detail?: string
}

/**
 * Emit one structured line for an auth event — JSON on a single call, so Cloud
 * Logging parses it as structured data and redaction has one place to run.
 */
export function logAuthEvent(event: string, context: AuthLogContext = {}): void {
  const safe = redact(context) as Record<string, unknown>
  console.info(JSON.stringify({ event, ...safe }))
}

/**
 * Context a generation log line may carry.
 *
 * **A second typed context rather than a widening of {@link AuthLogContext}**,
 * which is narrow on purpose: a generation line that could carry an arbitrary
 * string would be one refactor away from carrying a prompt, and a prompt is the
 * user's own prose. There is no `content`, no `text`, no `projectId` and no uid —
 * nothing here identifies a conversation, it describes a call.
 *
 * `cacheReadInputTokens` is where the prompt cache becomes observable: the
 * confirmation is a non-zero read on the second generation of a session, which is
 * a manual check because no automated test calls the real model.
 *
 * The two `hlCalls*` counters say whether generated code reaches allowlisted
 * routes at all. They are admitted to a body-less context because they are
 * **integers**, and an integer cannot carry a contact id or a sentence somebody
 * wrote — which is the bar the next field will have to clear too.
 */
export interface GenerationLogContext {
  model: string
  stopReason: string | null
  truncated: boolean
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  /** Extracted `hl()` calls that reach an enabled allowlist row. */
  hlCallsKnown: number
  /** Extracted `hl()` calls that do not — a route the proxy would refuse. */
  hlCallsUnknown: number
}

/**
 * Emit one structured line for a generation — the same shape as
 * {@link logAuthEvent}, through the same `redact` pass, so a value arriving
 * despite the typed context is still scrubbed.
 */
export function logGenerationEvent(event: string, context: GenerationLogContext): void {
  const safe = redact(context) as Record<string, unknown>
  console.info(JSON.stringify({ event, ...safe }))
}

/**
 * Context a proxy log line may carry — one line per HighLevel call.
 *
 * **A third narrow context**, and this is the family where that matters most:
 * every proxied response is somebody's CRM data.
 *
 * `pattern` is the matched pattern, never the concrete path — a pattern
 * aggregates, a path carries a contact id into Cloud Logging for no gain.
 *
 * `rateLimitRemaining` is the header verbatim rather than a parsed number, so a
 * value we did not expect is visible instead of becoming `NaN`.
 */
export interface ProxyLogContext {
  pattern: string
  status: number
  durationMs: number
  rateLimitRemaining: string | null
}

/** Emit one structured line for a proxied call. */
export function logProxyEvent(event: string, context: ProxyLogContext): void {
  const safe = redact(context) as Record<string, unknown>
  console.info(JSON.stringify({ event, ...safe }))
}

/**
 * Context an OAuth install log line may carry — a fourth narrow context, for the
 * flow that is hardest to debug from the outside.
 *
 * An install crosses two companies and answers the user with one word. When it
 * fails in production there is no request to inspect, no response body to read and
 * no way to reproduce it: whatever these lines say is the whole of the evidence.
 * So the fields are the ones that separate the plausible causes from each other —
 * *which* upstream call was refused, with what status, on which install shape.
 *
 * **`redirectUri` is deliberately here.** It is not a credential; it is in the
 * browser's address bar for the whole flow. It is in Secret Manager only because
 * `functions/.env` is uploaded as plain Cloud Run environment. And its drift from
 * the marketplace app's own Redirect URL field is a failure that looks like every
 * other failure, from a value no log has ever shown.
 *
 * **The authorization code and the state are deliberately not here**, in any
 * form. Both are bearer credentials, and `hasCode` answers the only question a log
 * needs to ask about them.
 */
export interface HlOAuthLogContext {
  /** Which step of the install this line describes. */
  step: 'connect' | 'callback' | 'exchange' | 'resolve' | 'store'
  outcome: 'ok' | 'invalid'
  /** The HighLevel path that answered — a path, never a URL with ids in it. */
  endpoint?: string
  /** The upstream HTTP status, where one came back. */
  status?: number
  durationMs?: number
  /** `Location` or `Company` — which install shape HighLevel produced. */
  userType?: string
  /** How many sub-accounts a bulk install turned out to cover. */
  locationCount?: number
  /** Whether a parameter arrived. Never which one arrived. */
  hasCode?: boolean
  hasState?: boolean
  /** The redirect URI as configured here — see above. */
  redirectUri?: string
  detail?: string
}

/** Emit one structured line for a step of the HighLevel install. */
export function logHlOAuthEvent(event: string, context: HlOAuthLogContext): void {
  const safe = redact(context) as Record<string, unknown>
  console.info(JSON.stringify({ event, ...safe }))
}
