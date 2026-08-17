import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const applyActionCode = vi.hoisted(() => vi.fn())
const confirmPasswordReset = vi.hoisted(() => vi.fn())
const verifyPasswordResetCode = vi.hoisted(() => vi.fn())
const refreshVerification = vi.hoisted(() => vi.fn())
const ensure = vi.hoisted(() => vi.fn())
const query = vi.hoisted((): { value: Record<string, string | undefined> } => ({ value: {} }))

vi.mock('firebase/auth', () => ({
  applyActionCode,
  confirmPasswordReset,
  verifyPasswordResetCode,
}))

vi.mock('@/lib/firebase', () => ({ auth: {} }))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ refreshVerification }),
}))

vi.mock('@/stores/profile', () => ({ useProfileStore: () => ({ ensure }) }))

vi.mock('vue-router', () => ({
  RouterLink: { template: '<a><slot /></a>' },
  useRoute: () => ({ query: query.value }),
  useRouter: () => ({ push: vi.fn() }),
}))

import AuthActionView from './AuthActionView.vue'

function firebaseError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

async function mountWith(q: Record<string, string | undefined>) {
  query.value = q
  const wrapper = mount(AuthActionView)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  applyActionCode.mockResolvedValue(undefined)
  confirmPasswordReset.mockResolvedValue(undefined)
  verifyPasswordResetCode.mockResolvedValue('alice@example.test')
  refreshVerification.mockResolvedValue(true)
  ensure.mockResolvedValue(undefined)
})

describe('AuthActionView — verifying an email', () => {
  it('applies the code and confirms', async () => {
    const wrapper = await mountWith({ mode: 'verifyEmail', oobCode: 'ABC' })

    expect(applyActionCode).toHaveBeenCalledWith({}, 'ABC')
    expect(wrapper.find('[data-testid="action-verified"]').exists()).toBe(true)
  })

  /** The stale-claim trap again — the rules read the token, not the user object. */
  it('forces a token refresh after applying the code', async () => {
    await mountWith({ mode: 'verifyEmail', oobCode: 'ABC' })

    expect(refreshVerification).toHaveBeenCalled()
    expect(ensure).toHaveBeenCalled()
  })
})

describe('AuthActionView — resetting a password', () => {
  it('asks for a new password once the code checks out', async () => {
    const wrapper = await mountWith({ mode: 'resetPassword', oobCode: 'XYZ' })

    expect(wrapper.find('#new-password').exists()).toBe(true)
  })

  it('refuses a password that misses the policy, without calling Firebase', async () => {
    const wrapper = await mountWith({ mode: 'resetPassword', oobCode: 'XYZ' })

    await wrapper.find('#new-password').setValue('correct-horse-9')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(confirmPasswordReset).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="action-password-error"]').exists()).toBe(true)
  })

  it('sets the password and confirms', async () => {
    const wrapper = await mountWith({ mode: 'resetPassword', oobCode: 'XYZ' })

    await wrapper.find('#new-password').setValue('Long-Enough-1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(confirmPasswordReset).toHaveBeenCalledWith({}, 'XYZ', 'Long-Enough-1')
    expect(wrapper.find('[data-testid="action-password-set"]').exists()).toBe(true)
  })
})

describe('AuthActionView — links that do not work', () => {
  /**
   * AC-18. Expired and already-used are given different copy on purpose:
   * "request a new one" is only useful advice for the first.
   */
  it('tells an expired link from a spent one', async () => {
    applyActionCode.mockRejectedValue(firebaseError('auth/expired-action-code'))
    const expired = await mountWith({ mode: 'verifyEmail', oobCode: 'ABC' })

    applyActionCode.mockRejectedValue(firebaseError('auth/invalid-action-code'))
    const spent = await mountWith({ mode: 'verifyEmail', oobCode: 'ABC' })

    expect(expired.find('[data-testid="action-invalid"]').text()).toContain('expired')
    expect(spent.find('[data-testid="action-invalid"]').text()).toContain('already have been used')
  })

  /** AC-19: the 24h cleanup removed the account this link belonged to. */
  it('sends someone back to sign up when the account is gone', async () => {
    applyActionCode.mockRejectedValue(firebaseError('auth/user-not-found'))

    const wrapper = await mountWith({ mode: 'verifyEmail', oobCode: 'ABC' })

    expect(wrapper.find('[data-testid="action-invalid"]').text()).toContain('sign up again')
  })

  it.each([
    ['an unknown mode', { mode: 'deleteAccount', oobCode: 'ABC' }],
    ['no mode', { oobCode: 'ABC' }],
    ['no code', { mode: 'verifyEmail' }],
    ['nothing', {}],
  ])('refuses %s rather than passing it through', async (_label, q) => {
    const wrapper = await mountWith(q)

    expect(wrapper.find('[data-testid="action-invalid"]').exists()).toBe(true)
    expect(applyActionCode).not.toHaveBeenCalled()
    expect(verifyPasswordResetCode).not.toHaveBeenCalled()
  })

  it('shows a loading state before the code resolves', () => {
    applyActionCode.mockImplementation(() => new Promise(() => undefined))
    query.value = { mode: 'verifyEmail', oobCode: 'ABC' }

    const wrapper = mount(AuthActionView)

    expect(wrapper.find('[data-testid="action-loading"]').exists()).toBe(true)
  })
})
