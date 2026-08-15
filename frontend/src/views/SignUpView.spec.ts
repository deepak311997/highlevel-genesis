import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const register = vi.hoisted(() => vi.fn())
vi.mock('@/lib/authApi', () => ({ register }))

import SignUpView from './SignUpView.vue'

const stubs = { RouterLink: { template: '<a><slot /></a>' } }

function mountView() {
  return mount(SignUpView, { global: { stubs } })
}

async function fill(wrapper: ReturnType<typeof mountView>, email: string, password: string) {
  await wrapper.find('#signup-email').setValue(email)
  await wrapper.find('#signup-password').setValue(password)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  register.mockResolvedValue(undefined)
})

describe('SignUpView', () => {
  it('starts on the form, not the confirmation', () => {
    const wrapper = mountView()

    expect(wrapper.find('form').exists()).toBe(true)
    expect(wrapper.find('[data-testid="signup-sent"]').exists()).toBe(false)
  })

  it('submits the address and password', async () => {
    const wrapper = mountView()

    await fill(wrapper, 'alice@example.test', 'correct-horse')

    expect(register).toHaveBeenCalledWith('alice@example.test', 'correct-horse')
  })

  it('trims the address before sending it', async () => {
    const wrapper = mountView()

    await fill(wrapper, '  alice@example.test  ', 'correct-horse')

    expect(register).toHaveBeenCalledWith('alice@example.test', 'correct-horse')
  })

  it('rejects a short password client-side, without calling the API', async () => {
    const wrapper = mountView()

    await fill(wrapper, 'alice@example.test', 'short')

    expect(register).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="signup-password-error"]').text()).toContain('8')
  })

  it('rejects a malformed address without calling the API', async () => {
    const wrapper = mountView()

    await fill(wrapper, 'not-an-email', 'correct-horse')

    expect(register).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="signup-email-error"]').exists()).toBe(true)
  })

  it('shows a submitting state while the request is in flight', async () => {
    register.mockImplementation(() => new Promise(() => undefined))
    const wrapper = mountView()

    await wrapper.find('#signup-email').setValue('alice@example.test')
    await wrapper.find('#signup-password').setValue('correct-horse')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Creating')
  })

  /**
   * The screen must look the same whether the address was new, already
   * registered, or registered but unverified. The server returns an identical
   * response for all three; a confirmation that said "we've created your
   * account" would leak what the response deliberately does not.
   */
  it('shows a non-committal confirmation on success', async () => {
    const wrapper = mountView()

    await fill(wrapper, 'alice@example.test', 'correct-horse')

    const sent = wrapper.find('[data-testid="signup-sent"]')
    expect(sent.exists()).toBe(true)
    expect(wrapper.text()).toContain('Check your inbox')
    // "If that address can be used" — conditional on purpose. Anything
    // declarative would confirm whether the address was already registered.
    expect(sent.text()).toContain('If that address can be used')
    expect(sent.text().toLowerCase()).not.toContain('account created')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('surfaces a request failure and keeps the form up', async () => {
    register.mockRejectedValue(new Error('Too many attempts. Try again in a few minutes.'))
    const wrapper = mountView()

    await fill(wrapper, 'alice@example.test', 'correct-horse')

    expect(wrapper.find('[data-testid="signup-error"]').text()).toContain('Too many attempts')
    expect(wrapper.find('form').exists()).toBe(true)
  })
})
