import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const refreshVerification = vi.hoisted(() => vi.fn())
const ensure = vi.hoisted(() => vi.fn())
const signOutNow = vi.hoisted(() => vi.fn())
const sendEmailVerification = vi.hoisted(() => vi.fn())
const markVerificationSent = vi.hoisted(() => vi.fn())
const sent = vi.hoisted((): { value: boolean } => ({ value: false }))
const push = vi.hoisted(() => vi.fn())
const consumeRedirect = vi.hoisted(() => vi.fn())

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    email: 'alice@example.test',
    user: { uid: 'alice' },
    get verificationSent() {
      return sent.value
    },
    markVerificationSent,
    refreshVerification,
    signOutNow,
  }),
}))

vi.mock('@/stores/profile', () => ({ useProfileStore: () => ({ ensure }) }))

vi.mock('firebase/auth', () => ({ sendEmailVerification }))

vi.mock('@/lib/redirect', () => ({ consumeRedirect }))

vi.mock('vue-router', () => ({
  // `meta` included because the real router reports it, and the destination
  // allowlist is keyed off `access` — see `destinationPaths` in `router/guard`.
  useRouter: () => ({
    push,
    getRoutes: () => [{ path: '/dashboard', meta: { access: 'protected' } }],
  }),
}))

import VerifyEmailView from './VerifyEmailView.vue'

/**
 * Found by the text a user reads, not by position. The buttons have been
 * reordered twice while this screen was designed, and an index-based selector
 * silently starts asserting about a different control each time.
 */
function clickButton(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((b) => b.text().includes(text))
  if (button === undefined) {
    throw new Error(
      `no button containing "${text}". Present: ${wrapper
        .findAll('button')
        .map((b) => b.text())
        .join(' | ')}`,
    )
  }
  return button.trigger('click')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  refreshVerification.mockResolvedValue(false)
  ensure.mockResolvedValue(undefined)
  signOutNow.mockResolvedValue(undefined)
  sendEmailVerification.mockResolvedValue(undefined)
  consumeRedirect.mockReturnValue('/dashboard')
  sent.value = false
})

describe('VerifyEmailView', () => {
  it('names the address the link was sent to', () => {
    const wrapper = mount(VerifyEmailView)

    expect(wrapper.find('[data-testid="verify-address"]').text()).toBe('alice@example.test')
  })

  it('keeps the user here while the address is still unverified', async () => {
    const wrapper = mount(VerifyEmailView)

    await clickButton(wrapper, "I've verified")
    await flushPromises()

    expect(push).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="verify-still-waiting"]').text()).toContain(
      "can't see a verification yet",
    )
  })

  /**
   * The trap this whole screen exists to avoid. `email_verified` is a claim
   * inside the ID token and Firestore rules read it, so releasing the user
   * without forcing a token refresh produces a dashboard that loads and then
   * fails every read — far harder to diagnose than a page that never loads.
   */
  it('refreshes the token before releasing the user', async () => {
    refreshVerification.mockResolvedValue(true)
    const wrapper = mount(VerifyEmailView)

    await clickButton(wrapper, "I've verified")
    await flushPromises()

    expect(refreshVerification).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  it('ensures the profile once released', async () => {
    refreshVerification.mockResolvedValue(true)
    const wrapper = mount(VerifyEmailView)

    await clickButton(wrapper, "I've verified")
    await flushPromises()

    expect(ensure).toHaveBeenCalled()
  })

  it('returns the user to where they were originally headed', async () => {
    refreshVerification.mockResolvedValue(true)
    consumeRedirect.mockReturnValue('/health')
    const wrapper = mount(VerifyEmailView)

    await clickButton(wrapper, "I've verified")
    await flushPromises()

    expect(push).toHaveBeenCalledWith('/health')
  })

  /** Verifying in a second tab has to release this one without a click. */
  it('polls, so a second tab verifying releases this one', async () => {
    refreshVerification.mockResolvedValue(true)
    mount(VerifyEmailView)

    await vi.advanceTimersByTimeAsync(4_000)
    await flushPromises()

    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  it('stops polling once the component goes away', async () => {
    const wrapper = mount(VerifyEmailView)
    wrapper.unmount()

    await vi.advanceTimersByTimeAsync(20_000)

    expect(refreshVerification).not.toHaveBeenCalled()
  })

  /**
   * Registration sends nothing — it runs through the Admin SDK, which only
   * generates links, and Firebase's sender needs a signed-in currentUser. So
   * this screen is where the first verification email actually goes out.
   */
  it('sends the verification email when the gate is first reached', async () => {
    mount(VerifyEmailView)
    await flushPromises()

    expect(sendEmailVerification).toHaveBeenCalledWith({ uid: 'alice' })
    expect(markVerificationSent).toHaveBeenCalled()
  })

  it('does not send again on a remount within the same session', async () => {
    sent.value = true
    mount(VerifyEmailView)
    await flushPromises()

    expect(sendEmailVerification).not.toHaveBeenCalled()
  })

  it('resends on request', async () => {
    sent.value = true
    const wrapper = mount(VerifyEmailView)

    await clickButton(wrapper, 'Resend')
    await flushPromises()

    expect(sendEmailVerification).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-testid="verify-resent"]').text()).toContain('Sent again')
  })

  it('surfaces a rate-limited resend', async () => {
    sent.value = true
    sendEmailVerification.mockRejectedValue(
      Object.assign(new Error('slow down'), { code: 'auth/too-many-requests' }),
    )
    const wrapper = mount(VerifyEmailView)

    await clickButton(wrapper, 'Resend')
    await flushPromises()

    expect(wrapper.find('[data-testid="verify-error"]').text()).toContain('Too many attempts')
  })

  it('lets someone signed in as the wrong account get out', async () => {
    const wrapper = mount(VerifyEmailView)

    await clickButton(wrapper, 'Sign out')
    await flushPromises()

    expect(signOutNow).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/signin')
  })
})
