import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  describeError,
  logAuthEvent,
  logGenerationEvent,
  logHlOAuthEvent,
  logProxyEvent,
  redact,
  REDACTED,
  type AuthLogContext,
  type GenerationLogContext,
  type HlOAuthLogContext,
  type ProxyLogContext,
} from './log'

describe('redact', () => {
  it.each([
    'password',
    'newPassword',
    'oobCode',
    'idToken',
    'refreshToken',
    'accessToken',
    'apiKey',
    'authorization',
    'cookie',
  ])('replaces the value of a %s field', (key) => {
    const out = redact({ [key]: 'super-secret' }) as Record<string, unknown>

    expect(out[key]).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain('super-secret')
  })

  it('matches field names case-insensitively', () => {
    const out = redact({ Password: 'p', OOBCODE: 'o', 'X-Api-Key': 'k' })

    expect(JSON.stringify(out)).not.toContain('"p"')
    expect(JSON.stringify(out)).not.toContain('"o"')
    expect(JSON.stringify(out)).not.toContain('"k"')
  })

  it('reaches into nested objects and arrays', () => {
    const out = redact({
      body: { user: { password: 'nested-secret' } },
      attempts: [{ oobCode: 'array-secret' }],
    })

    const json = JSON.stringify(out)
    expect(json).not.toContain('nested-secret')
    expect(json).not.toContain('array-secret')
  })

  // An action link is a bearer credential: whoever holds it can verify the
  // address or set the password. It must never reach a log sink.
  it.each([
    'https://app.example.test/auth/action?mode=verifyEmail&oobCode=ABC123',
    'https://app.example.test/auth/action?oobcode=abc123&mode=resetPassword',
  ])('redacts a whole string that carries an action code', (link) => {
    const out = redact({ note: link }) as Record<string, unknown>

    expect(out['note']).toBe(REDACTED)
  })

  /* The one exclusion from the substring net, and the reason it is by *type*. */
  it('keeps a numeric value under a sensitive-looking name', () => {
    const out = redact({ inputTokens: 214, cacheReadInputTokens: 0, expiresIn: 3600 })

    expect(out).toEqual({ inputTokens: 214, cacheReadInputTokens: 0, expiresIn: 3600 })
  })

  it('still redacts a string under the same name', () => {
    const out = redact({ inputTokens: 'sk-not-a-count' }) as Record<string, unknown>

    expect(out['inputTokens']).toBe(REDACTED)
  })

  it('keeps fields that carry no secret, so the log stays useful', () => {
    const out = redact({ status: 429, branch: 'existing_unverified', emailHash: 'a1b2' })

    expect(out).toEqual({ status: 429, branch: 'existing_unverified', emailHash: 'a1b2' })
  })

  it('survives a circular reference rather than throwing inside a catch block', () => {
    const circular: Record<string, unknown> = { status: 500 }
    circular['self'] = circular

    expect(() => redact(circular)).not.toThrow()
  })
})

/*
 * OAuth adds two bearer credentials that the original patterns do not catch: the authorization
 * `code` and the `state` token. Both arrive on the callback URL, and a URL is exactly the sort
 * of thing that gets logged whole when something goes wrong.
 */
describe('redact — OAuth callback credentials', () => {
  it('scrubs the authorization code and the state from a URL', () => {
    const url = 'https://app.test/api/oauth/callback?code=SUPERSECRETCODE&state=SEALEDSTATE'
    const scrubbed = String(redact(url))

    expect(scrubbed).not.toContain('SUPERSECRETCODE')
    expect(scrubbed).not.toContain('SEALEDSTATE')
    // Still recognisable as the callback, which is what makes the line useful.
    expect(scrubbed).toContain('/api/oauth/callback')
  })

  it('scrubs them whichever order they appear in', () => {
    const scrubbed = String(redact('/cb?state=AAA&code=BBB&other=keepme'))

    expect(scrubbed).not.toContain('AAA')
    expect(scrubbed).not.toContain('BBB')
    expect(scrubbed).toContain('keepme')
  })

  it('leaves a Firebase error code intact — the reason this is position-scoped', () => {
    expect(String(redact("code: 'auth/email-already-exists'"))).toContain(
      'auth/email-already-exists',
    )
  })

  it('scrubs a value under a `state` key', () => {
    expect(JSON.stringify(redact({ state: 'SEALEDSTATE' }))).not.toContain('SEALEDSTATE')
  })

  /*
   * `code` is deliberately NOT a redacted key name, and the asymmetry with `state` above is the
   * decision worth recording.
   */
  it('keeps a `code` field, because ours name outcomes rather than credentials', () => {
    expect(JSON.stringify(redact({ code: 'invalid_state' }))).toContain('invalid_state')
  })
})

describe('describeError', () => {
  it('reports a Firebase error code without its payload', () => {
    const err = Object.assign(new Error('Request failed'), {
      code: 'auth/email-already-exists',
      response: { body: { password: 'leaked-in-the-error' } },
    })

    const described = describeError(err)

    expect(described).toContain('auth/email-already-exists')
    expect(described).not.toContain('leaked-in-the-error')
  })

  it('reports a plain Error by message only', () => {
    expect(describeError(new Error('boom'))).toContain('boom')
  })

  it.each([
    ['a string', 'just a string'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('degrades safely for %s', (_label, value) => {
    expect(() => describeError(value)).not.toThrow()
    expect(typeof describeError(value)).toBe('string')
  })

  it('redacts a message that itself embeds a credential', () => {
    const err = new Error('failed for password=hunter2 oobCode=ABC')

    expect(describeError(err)).not.toContain('hunter2')
  })
})

describe('logAuthEvent', () => {
  let info: ReturnType<typeof vi.fn>

  beforeEach(() => {
    info = vi.fn()
    vi.stubGlobal('console', { ...console, info, error: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes one line carrying the event code and its safe context', () => {
    logAuthEvent('register.sent', { emailHash: 'a1b2c3', outcome: 'ok' })

    expect(info).toHaveBeenCalledTimes(1)
    const line = JSON.stringify(info.mock.calls[0])
    expect(line).toContain('register.sent')
    expect(line).toContain('a1b2c3')
  })

  // The context type is the enforcement point, so the test asserts on the type
  // as well as the output: `branch` must not be assignable. Were it to come
  // back, `emailHash` alongside it would turn Cloud Logging into the
  // account-existence oracle the whole endpoint design exists to close — email
  // hashes are unsalted SHA-256 over a guessable space, so they are reversible
  // by anyone who can read the logs.
  it('has no field naming which registration branch was taken', () => {
    const context: AuthLogContext = { emailHash: 'a1b2c3', outcome: 'ok' }
    // @ts-expect-error — `branch` is not part of AuthLogContext, deliberately.
    context.branch = 'existing'

    logAuthEvent('register.completed', { emailHash: 'a1b2c3', outcome: 'ok' })

    expect(JSON.stringify(info.mock.calls[0])).not.toContain('existing')
  })

  it('redacts a secret that reaches it despite the typed context', () => {
    // Callers are typed, but an `unknown` from a catch block is not — the
    // helper must not depend on discipline it cannot enforce.
    logAuthEvent('register.failed', { password: 'hunter2' } as never)

    expect(JSON.stringify(info.mock.calls[0])).not.toContain('hunter2')
  })
})

/**
 * The generation log line — F3.4's "generation metadata", in a log rather than in Firestore.
 *
 * Nothing in the product reads it, and an unread field is a schema to maintain, a wire shape to
 * version and a test to write for a value whose only consumer is a human debugging. The log is
 * where that human looks anyway, and it is also how D16's cache claim gets verified in
 * production once Slice 9 makes caching real.
 */
describe('logGenerationEvent', () => {
  let info: ReturnType<typeof vi.fn>

  const context: GenerationLogContext = {
    model: 'claude-opus-5',
    stopReason: 'end_turn',
    truncated: false,
    durationMs: 4210,
    inputTokens: 214,
    outputTokens: 638,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    hlCallsKnown: 0,
    hlCallsUnknown: 0,
  }

  beforeEach(() => {
    info = vi.fn()
    vi.stubGlobal('console', { ...console, info, error: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes one line, parseable as a single JSON object', () => {
    logGenerationEvent('generation.complete', context)

    expect(info).toHaveBeenCalledTimes(1)
    const line: unknown = JSON.parse(String(info.mock.calls[0]?.[0]))
    expect(typeof line).toBe('object')
  })

  /* The four token counts are the point of the line — `cacheReadInputTokens`
   * most of all, since it is how D16's no-op becomes observable in Slice 9. */
  it('carries the event, the model, the stop reason and the four token counts', () => {
    logGenerationEvent('generation.complete', context)

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      event: 'generation.complete',
      ...context,
    })
  })

  /* The enforcement point is the type, so the test asserts on the type as well as the output. */
  it('has no field for message content', () => {
    const widened: GenerationLogContext = { ...context }
    // @ts-expect-error — `content` is not part of GenerationLogContext, deliberately.
    widened.content = 'build a contact dashboard'

    logGenerationEvent('generation.complete', context)

    expect(String(info.mock.calls[0]?.[0])).not.toContain('build a contact dashboard')
  })

  it('redacts a secret that reaches it despite the typed context', () => {
    logGenerationEvent('generation.complete', { ...context, apiKey: 'sk-leaked' } as never)

    expect(String(info.mock.calls[0]?.[0])).not.toContain('sk-leaked')
  })
})

/**
 * A third narrow context, not a widening of either of the other two.
 *
 * The precedent is explicit in `log.ts`: one typed context per event family is what makes "no
 * body, no token, no contact id" a property of the type rather than of whoever remembered.
 * Nothing here would survive being widened — a proxy line that could carry a free-form string
 * would be one refactor away from carrying a CRM record.
 */
describe('logProxyEvent', () => {
  let info: ReturnType<typeof vi.fn>

  const context: ProxyLogContext = {
    pattern: '/conversations/:conversationId/messages',
    status: 200,
    durationMs: 96,
    rateLimitRemaining: '9997',
  }

  beforeEach(() => {
    info = vi.fn()
    vi.stubGlobal('console', { ...console, info })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('carries the event and the four fields, and nothing else', () => {
    logProxyEvent('hl.proxy', context)

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({ event: 'hl.proxy', ...context })
  })

  it('has no field for a request or response body', () => {
    const widened: ProxyLogContext = { ...context }
    // @ts-expect-error — `body` is not part of ProxyLogContext, deliberately.
    widened.body = '{"contacts":[{"email":"someone@example.test"}]}'

    logProxyEvent('hl.proxy', context)

    expect(String(info.mock.calls[0]?.[0])).not.toContain('someone@example.test')
  })

  /*
   * No field of ProxyLogContext matches SENSITIVE_KEY, so nothing useful is redacted away — but
   * a value arriving despite the type still goes through the same scrub, which is what makes the
   * sink the defence rather than the call site.
   */
  it('redacts a secret that reaches it despite the typed context', () => {
    logProxyEvent('hl.proxy', { ...context, accessToken: 'live-token' } as never)

    expect(String(info.mock.calls[0]?.[0])).not.toContain('live-token')
  })

  it('keeps the four fields it exists to carry out of the redaction net', () => {
    logProxyEvent('hl.proxy', context)

    const line = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(line['pattern']).toBe(context.pattern)
    expect(line['rateLimitRemaining']).toBe('9997')
  })
})

/*
 * The upstream half of `describeError`.
 *
 * `HighLevel responded 422` is a true statement and a useless one: it was the whole of what
 * production had to say about an install that failed, and it names neither the call that was
 * refused nor the reason the body gave. The response body is where HighLevel puts that, so it
 * is logged — truncated, and through the same scrub as everything else.
 */
describe('describeError — an upstream HTTP failure', () => {
  function upstream(overrides: Record<string, unknown> = {}): Error {
    return Object.assign(new Error('HighLevel responded 422'), {
      status: 422,
      endpoint: '/oauth/locationToken',
      body: '{"message":["companyId must be a string"],"error":"Unprocessable Entity"}',
      ...overrides,
    })
  }

  it('reports the endpoint that answered and the body it answered with', () => {
    const described = describeError(upstream())

    expect(described).toContain('/oauth/locationToken')
    expect(described).toContain('companyId must be a string')
  })

  it('truncates a long body rather than filling the sink with one line', () => {
    const described = describeError(upstream({ body: 'x'.repeat(5_000) }))

    expect(described.length).toBeLessThan(700)
    expect(described).toContain('…')
  })

  it('scrubs a credential the body happens to carry', () => {
    const described = describeError(
      upstream({ body: '{"access_token":"live-token","refresh_token":"live-refresh"}' }),
    )

    expect(described).not.toContain('live-token')
    expect(described).not.toContain('live-refresh')
  })

  /* The existing branch must keep working: a Firebase error has no top-level body. */
  it('leaves an ordinary Error alone', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })
})

/**
 * The OAuth install's own log family — a fourth narrow context.
 *
 * Separate from {@link AuthLogContext} for the reason the other two are separate: the fields
 * that make an install diagnosable (which upstream call, which status, which install shape)
 * are meaningless to a registration line, and a context wide enough for both is a context
 * wide enough to carry something neither wanted.
 *
 * **`redirectUri` is deliberately loggable.** It is not a credential — it is in the browser's
 * address bar for the whole flow — and it is the one value whose drift from the marketplace
 * app's own setting produces a failure that looks like nothing else.
 */
describe('logHlOAuthEvent', () => {
  let info: ReturnType<typeof vi.fn>

  beforeEach(() => {
    info = vi.fn()
    vi.stubGlobal('console', { ...console, info, error: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes one line carrying the step and its context', () => {
    logHlOAuthEvent('hl.callback.resolve_failed', {
      step: 'resolve',
      outcome: 'invalid',
      endpoint: '/oauth/locationToken',
      status: 422,
      userType: 'Company',
      locationCount: 1,
    })

    expect(info).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(line['event']).toBe('hl.callback.resolve_failed')
    expect(line['endpoint']).toBe('/oauth/locationToken')
    expect(line['status']).toBe(422)
    expect(line['userType']).toBe('Company')
  })

  it('keeps the redirect URI, which is the point of the line', () => {
    logHlOAuthEvent('hl.connect.start', {
      step: 'connect',
      outcome: 'ok',
      redirectUri: 'https://app.test/api/oauth/callback',
    })

    expect(String(info.mock.calls[0]?.[0])).toContain('https://app.test/api/oauth/callback')
  })

  /* Whether a parameter arrived is diagnostic; its value is a bearer credential. */
  it('has no field for the authorization code or the state', () => {
    const context: HlOAuthLogContext = { step: 'callback', outcome: 'ok', hasCode: true }
    // @ts-expect-error — the values are credentials; only their presence is loggable.
    context.code = 'SUPERSECRETCODE'

    logHlOAuthEvent('hl.callback.received', { step: 'callback', outcome: 'ok', hasCode: true })

    expect(String(info.mock.calls[0]?.[0])).not.toContain('SUPERSECRETCODE')
  })

  it('redacts a secret that reaches it despite the typed context', () => {
    logHlOAuthEvent('hl.callback.received', {
      step: 'callback',
      outcome: 'ok',
      accessToken: 'live-token',
    } as never)

    expect(String(info.mock.calls[0]?.[0])).not.toContain('live-token')
  })
})
