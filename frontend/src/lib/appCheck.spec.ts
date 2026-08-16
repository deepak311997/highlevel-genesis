import { beforeEach, describe, expect, it, vi } from 'vitest'

const initializeAppCheck = vi.fn()
const getToken = vi.fn()
const ReCaptchaV3Provider = vi.fn()

vi.mock('firebase/app-check', () => ({
  initializeAppCheck,
  getToken,
  ReCaptchaV3Provider,
}))

vi.mock('./firebase', () => ({ app: { name: 'test-app' } }))

async function load(siteKey: string | undefined) {
  vi.resetModules()
  vi.stubEnv('VITE_GOOGLE_RECAPTCHA_V3_KEY', siteKey ?? '')
  return import('./appCheck')
}

describe('appCheckHeader', () => {
  beforeEach(() => {
    initializeAppCheck.mockReset().mockReturnValue({ app: 'handle' })
    getToken.mockReset()
    ReCaptchaV3Provider.mockReset()
  })

  it('carries the App Check token on the header the backend reads', async () => {
    getToken.mockResolvedValue({ token: 'attestation-token' })
    const { appCheckHeader } = await load('site-key')

    await expect(appCheckHeader()).resolves.toEqual({
      'X-Firebase-AppCheck': 'attestation-token',
    })
    expect(ReCaptchaV3Provider).toHaveBeenCalledWith('site-key')
  })

  it('initialises reCAPTCHA once however many requests are made', async () => {
    getToken.mockResolvedValue({ token: 't' })
    const { appCheckHeader } = await load('site-key')

    await Promise.all([appCheckHeader(), appCheckHeader(), appCheckHeader()])

    // Not just tidiness: initializeAppCheck throws on a second call for the
    // same app, so an un-memoised version breaks on the user's second attempt
    // rather than the first — the kind of bug that survives a manual test.
    expect(initializeAppCheck).toHaveBeenCalledOnce()
  })

  /**
   * The emulator build has no site key, and there is no App Check emulator to
   * mint against. The header is simply absent, which the backend's own
   * emulator bypass expects. Attempting reCAPTCHA here would fail the e2e
   * suite on a control those tests are not about.
   */
  it('sends no header when no site key is configured', async () => {
    const { appCheckHeader } = await load(undefined)

    await expect(appCheckHeader()).resolves.toEqual({})
    expect(initializeAppCheck).not.toHaveBeenCalled()
  })

  /**
   * A failed attestation must not swallow the request. The server is the
   * enforcement point and will answer 401 with copy the user can act on;
   * throwing here would instead surface a reCAPTCHA-shaped error on a sign-up
   * form, which tells the user nothing.
   */
  it('degrades to no header when the token cannot be fetched', async () => {
    getToken.mockRejectedValue(new Error('reCAPTCHA unavailable'))
    const { appCheckHeader } = await load('site-key')

    await expect(appCheckHeader()).resolves.toEqual({})
  })
})
