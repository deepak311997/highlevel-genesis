import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestPasswordReset = vi.hoisted(() => vi.fn())
vi.mock('@/lib/authApi', () => ({ requestPasswordReset }))

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
  requestPasswordReset.mockResolvedValue(undefined)
})

describe('ForgotPasswordView', () => {
  it('sends the request', async () => {
    const wrapper = mountView()

    await submit(wrapper, 'alice@example.test')

    expect(requestPasswordReset).toHaveBeenCalledWith('alice@example.test')
  })

  it('refuses a malformed address without calling the API', async () => {
    const wrapper = mountView()

    await submit(wrapper, 'nope')

    expect(requestPasswordReset).not.toHaveBeenCalled()
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
    requestPasswordReset.mockImplementation(() => new Promise(() => undefined))
    const wrapper = mountView()

    await wrapper.find('#forgot-email').setValue('alice@example.test')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('surfaces a failure and keeps the form up', async () => {
    requestPasswordReset.mockRejectedValue(
      new Error('Too many attempts. Try again in a few minutes.'),
    )
    const wrapper = mountView()

    await submit(wrapper, 'alice@example.test')

    expect(wrapper.find('[data-testid="forgot-error"]').text()).toContain('Too many attempts')
    expect(wrapper.find('form').exists()).toBe(true)
  })
})
