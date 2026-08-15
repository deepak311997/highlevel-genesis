import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const refreshVerification = vi.hoisted(() => vi.fn())
const ensureProfile = vi.hoisted(() => vi.fn())
const signOutNow = vi.hoisted(() => vi.fn())
const resendVerification = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const consumeRedirect = vi.hoisted(() => vi.fn())

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    email: 'alice@example.test',
    refreshVerification,
    ensureProfile,
    signOutNow,
  }),
}))

vi.mock('@/lib/authApi', () => ({ resendVerification }))

vi.mock('@/lib/redirect', () => ({ consumeRedirect }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push, getRoutes: () => [{ path: '/dashboard' }] }),
}))

import VerifyEmailView from './VerifyEmailView.vue'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  refreshVerification.mockResolvedValue(false)
  ensureProfile.mockResolvedValue(undefined)
  signOutNow.mockResolvedValue(undefined)
  resendVerification.mockResolvedValue(undefined)
  consumeRedirect.mockReturnValue('/dashboard')
})

describe('VerifyEmailView', () => {
  it('names the address the link was sent to', () => {
    const wrapper = mount(VerifyEmailView)

    expect(wrapper.find('[data-testid="verify-address"]').text()).toBe('alice@example.test')
  })

  it('keeps the user here while the address is still unverified', async () => {
    const wrapper = mount(VerifyEmailView)

    await wrapper.findAll('button')[0]?.trigger('click')
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

    await wrapper.findAll('button')[0]?.trigger('click')
    await flushPromises()

    expect(refreshVerification).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  it('writes the profile once released', async () => {
    refreshVerification.mockResolvedValue(true)
    const wrapper = mount(VerifyEmailView)

    await wrapper.findAll('button')[0]?.trigger('click')
    await flushPromises()

    expect(ensureProfile).toHaveBeenCalled()
  })

  it('returns the user to where they were originally headed', async () => {
    refreshVerification.mockResolvedValue(true)
    consumeRedirect.mockReturnValue('/health')
    const wrapper = mount(VerifyEmailView)

    await wrapper.findAll('button')[0]?.trigger('click')
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

  it('resends without confirming whether the address needs it', async () => {
    const wrapper = mount(VerifyEmailView)

    await wrapper.findAll('button')[1]?.trigger('click')
    await flushPromises()

    expect(resendVerification).toHaveBeenCalledWith('alice@example.test')
    expect(wrapper.find('[data-testid="verify-resent"]').text()).toContain('If that address needs')
  })

  it('surfaces a resend failure', async () => {
    resendVerification.mockRejectedValue(
      new Error('Too many attempts. Try again in a few minutes.'),
    )
    const wrapper = mount(VerifyEmailView)

    await wrapper.findAll('button')[1]?.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="verify-error"]').text()).toContain('Too many attempts')
  })

  it('lets someone signed in as the wrong account get out', async () => {
    const wrapper = mount(VerifyEmailView)

    await wrapper.findAll('button')[2]?.trigger('click')
    await flushPromises()

    expect(signOutNow).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/signin')
  })
})
