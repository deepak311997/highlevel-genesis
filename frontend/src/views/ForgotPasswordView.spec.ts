import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendPasswordResetEmail = vi.hoisted(() => vi.fn())
vi.mock('firebase/auth', () => ({ sendPasswordResetEmail }))
vi.mock('@/lib/firebase', () => ({ auth: {} }))

import ForgotPasswordView from './ForgotPasswordView.vue'

const stubs = { RouterLink: { template: '<a><slot /></a>' } }

function mountView() {
  return mount(ForgotPasswordView, { global: { stubs } })
}

async function submit(wrapper: ReturnType<typeof mountView>, email: string) {
  await wrapper.find('#forgot-email').setValue(email)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  sendPasswordResetEmail.mockResolvedValue(undefined)
})

describe('ForgotPasswordView', () => {
  it('sends the request', async () => {
    const wrapper = mountView()

    await submit(wrapper, 'alice@example.test')

    expect(sendPasswordResetEmail).toHaveBeenCalledWith({}, 'alice@example.test')
  })

  it('refuses a malformed address without calling the API', async () => {
    const wrapper = mountView()

    await submit(wrapper, 'nope')

    expect(sendPasswordResetEmail).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="forgot-email-error"]').exists()).toBe(true)
  })

  /**
   * "If an account exists" — conditional, and shown for every accepted
   * submission. Confirming delivery would disclose that the address is
   * registered on a form far easier to reach than sign-up.
   */
  it('confirms without saying whether the address is registered', async () => {
    const wrapper = mountView()

    await submit(wrapper, 'alice@example.test')

    const sent = wrapper.find('[data-testid="forgot-sent"]')
    expect(sent.text()).toContain('If an account exists')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('shows a submitting state', async () => {
    sendPasswordResetEmail.mockImplementation(() => new Promise(() => undefined))
    const wrapper = mountView()

    await wrapper.find('#forgot-email').setValue('alice@example.test')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  /**
   * If enumeration protection is ever off, this is the code that would leak.
   * Treated as success so the screen cannot become the oracle the endpoint
   * design refuses to be.
   */
  it.each(['auth/user-not-found', 'auth/invalid-email'])(
    'shows the same confirmation when Firebase reports %s',
    async (code) => {
      sendPasswordResetEmail.mockRejectedValue(Object.assign(new Error(code), { code }))
      const wrapper = mountView()

      await submit(wrapper, 'nobody@example.test')

      expect(wrapper.find('[data-testid="forgot-sent"]').text()).toContain('If an account exists')
    },
  )

  it('surfaces a failure and keeps the form up', async () => {
    sendPasswordResetEmail.mockRejectedValue(
      Object.assign(new Error('rate limited'), { code: 'auth/too-many-requests' }),
    )
    const wrapper = mountView()

    await submit(wrapper, 'alice@example.test')

    expect(wrapper.find('[data-testid="forgot-error"]').text()).toContain('Too many attempts')
    expect(wrapper.find('form').exists()).toBe(true)
  })
})
