/**
 * Logging that cannot leak a credential.
 *
 * The registration endpoint receives a plaintext password and mints action
 * links, both of which are bearer credentials — whoever holds the link can
 * verify the address or set the password. Cloud Logging retains what it is
 * given, so a single `console.error(err)` on a rejected Admin SDK call is
 * enough to put a password in a log sink that outlives the request.
 *
 * The defence is not discipline at call sites. Every value is passed through
 * {@link redact} on the way out, so a secret arriving from an `unknown` in a
 * catch block is scrubbed by the sink itself rather than by whoever remembered.
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

/** `password=hunter2` or `oobCode: ABC` embedded in prose, as errors often do. */
const INLINE_SECRET = /\b(pass\w*|[\w-]*token|oobcode|api[-_]?key|secret)\s*[=:]\s*\S+/gi

/**
 * The OAuth callback's two bearer credentials, matched in **query-string
 * position only**.
 *
 * `?code=…` is the authorization code and `?state=…` is the sealed token
 * carrying a uid; a logged callback URL hands over both. The position anchor is
 * what makes this safe to add: `code` is also the property every Firebase error
 * reports its error code on, and this slice's callback logs which outcome it
 * redirected with, so a rule matching `code` anywhere would redact precisely
 * the lines written to diagnose a failing OAuth flow.
 *
 * The parameter name is kept and only the value replaced, so the line still
 * says *which* credential was present.
 */
const SENSITIVE_QUERY = /([?&](?:code|state)=)[^&\s]+/gi

function scrubString(value: string): string {
  if (ACTION_LINK.test(value)) return REDACTED
  return value
    .replace(SENSITIVE_QUERY, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(INLINE_SECRET, (match) => {
      const [name] = match.split(/[=:]/)
      return `${name ?? ''}=${REDACTED}`
    })
}

/**
 * Deep-copy a value with every secret replaced.
 *
 * Never throws: it is called from catch blocks and from the terminal error
 * handler, where a throw would replace a useful log line with an unhandled
 * rejection. Circular references — common in HTTP error objects that reference
 * their own request — resolve to a marker rather than blowing the stack.
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
 * `SENSITIVE_KEY` matches substrings on purpose, so that `newPassword`,
 * `X-Api-Key` and `refreshToken` are all caught without enumerating spellings.
 * That breadth has one false positive worth excluding: **token counts**.
 * `inputTokens` and `cacheReadInputTokens` match `token`, and redacting them
 * would empty the generation log line of the only numbers it exists to carry
 * (D25) — with no warning, because a redacted field still looks deliberate.
 *
 * Excluding by *type* rather than by name is what keeps the net intact: every
 * credential this codebase handles is a string — access and refresh tokens,
 * passwords, out-of-band codes, API keys, the sealed OAuth state. A number under
 * a sensitive name is a count or an expiry. Narrowing by name instead would mean
 * a list to maintain, and the next field somebody adds would not be on it.
 */
function isSecret(key: string, value: unknown): boolean {
  if (!SENSITIVE_KEY.test(key)) return false
  return typeof value !== 'number' && typeof value !== 'boolean'
}

/**
 * A one-line description of a thrown value, safe to log.
 *
 * Firebase errors carry the failing request on the error object, so the message
 * is extracted deliberately rather than serialising the whole thing — the code
 * is the part worth keeping, and the payload is the part that leaks.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const { code } = err as { code?: unknown }
    const prefix = typeof code === 'string' ? `${code}: ` : ''
    return scrubString(`${prefix}${err.message}`)
  }
  if (typeof err === 'string') return scrubString(err)
  return `Non-error thrown (${typeof err})`
}

/**
 * Context an auth log line may carry. Deliberately narrow — no free-form body.
 *
 * **There is deliberately no `branch` field**, and adding one would undo the
 * endpoint's central property. `emailHash` is an unsalted SHA-256 over a
 * guessable space: email addresses are not high-entropy, so a wordlist reverses
 * the hash offline in seconds. A line pairing that hash with "this address
 * already existed" therefore hands anyone who can read Cloud Logging the exact
 * account-existence oracle that the uniform response, the identical screens and
 * the existence-blind throttle were all built to refuse. The log sink is a
 * disclosure channel like any other.
 *
 * If registration-branch volume is ever wanted, it belongs in an aggregate
 * counter with no per-request identifier attached — never on a line that also
 * carries the subject.
 */
export interface AuthLogContext {
  /** SHA-256 of the normalised address. Never the address itself. */
  emailHash?: string
  outcome?: 'ok' | 'throttled' | 'invalid'
  status?: number
  detail?: string
}

/**
 * Emit one structured line for an auth event.
 *
 * JSON on a single call so Cloud Logging parses it as structured data, and so
 * the redaction pass has one place to run rather than one per field.
 */
export function logAuthEvent(event: string, context: AuthLogContext = {}): void {
  const safe = redact(context) as Record<string, unknown>
  console.info(JSON.stringify({ event, ...safe }))
}

/**
 * Context a generation log line may carry — F3.4's metadata, in a log (D25).
 *
 * **A second typed context rather than a widening of {@link AuthLogContext}**,
 * and the reason is that interface's own comment: it is narrow on purpose, with
 * no free-form body. A generation line that could carry an arbitrary string
 * would be one refactor away from carrying a prompt — and a prompt, or a reply,
 * is the user's own prose, which a log sink retains for longer than the request
 * that produced it.
 *
 * There is deliberately no `content`, no `text`, no `projectId` and no uid.
 * Nothing here identifies a conversation; it describes a call.
 *
 * `cacheReadInputTokens` is the field worth naming. It is how D16's declared
 * no-op becomes observable: this slice's system prompt is far shorter than
 * `claude-opus-5`'s 512-token minimum cacheable prefix, so it will read `0` and
 * nothing will error. Slice 9 adds the HighLevel cheat-sheet above the
 * breakpoint, and this line is where the cache read shows up.
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
}

/**
 * Emit one structured line for a generation.
 *
 * Same shape as {@link logAuthEvent}: JSON on a single `console.info` so Cloud
 * Logging parses it as structured data, through the same `redact` pass so a
 * value arriving despite the typed context is still scrubbed.
 */
export function logGenerationEvent(event: string, context: GenerationLogContext): void {
  const safe = redact(context) as Record<string, unknown>
  console.info(JSON.stringify({ event, ...safe }))
}
