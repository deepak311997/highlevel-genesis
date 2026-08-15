import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signIn = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const query = vi.hoisted((): { value: Record<string, string> } => ({ value: {} }))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ signIn }) }))

vi.mock('vue-router', () => ({
  RouterLink: { template: '<a><slot /></a>' },
  useRouter: () => ({ push, getRoutes: () => [{ path: '/dashboard' }, { path: '/health' }] }),
  useRoute: () => ({ query: query.value }),
}))

import SignInView from './SignInView.vue'

function mountView() {
  return mount(SignInView)
}

async function submit(wrapper: ReturnType<typeof mountView>, password = 'a-password') {
  await wrapper.find('#signin-email').setValue('alice@example.test')
  await wrapper.find('#signin-password').setValue(password)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

function firebaseError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  query.value = {}
  signIn.mockResolvedValue(undefined)
})

describe('SignInView', () => {
  it('signs in and lands on the dashboard', async () => {
    const wrapper = mountView()

    await submit(wrapper)

    expect(signIn).toHaveBeenCalledWith('alice@example.test', 'a-password')
    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  it('honours a safe redirect target', async () => {
    query.value = { redirect: '/health' }
    const wrapper = mountView()

    await submit(wrapper)

    expect(push).toHaveBeenCalledWith('/health')
  })

  it.each([
    ['protocol-relative', '//evil.test'],
    ['absolute', 'https://evil.test'],
    ['unknown route', '/nowhere'],
  ])('ignores a %s redirect target', async (_label, redirect) => {
    query.value = { redirect }
    const wrapper = mountView()

    await submit(wrapper)

    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  /**
   * AC-22. A wrong password and an unregistered address must be
   * indistinguishable. Firebase collapses them into `invalid-credential` when
   * enumeration protection is on, but that is a console setting this repo
   * cannot enforce — so the mapping does not rely on it.
   */
  it.each([
    'auth/invalid-credential',
    'auth/user-not-found',
    'auth/wrong-password',
    'auth/invalid-email',
  ])('shows one message for %s', async (code) => {
    signIn.mockRejectedValue(firebaseError(code))
    const wrapper = mountView()

    await submit(wrapper)

    expect(wrapper.find('[data-testid="signin-error"]').text()).toBe(
      'Email or password is incorrect.',
    )
  })

  it('distinguishes a network failure, which is not a credential problem', async () => {
    signIn.mockRejectedValue(firebaseError('auth/network-request-failed'))
    const wrapper = mountView()

    await submit(wrapper)

    expect(wrapper.find('[data-testid="signin-error"]').text()).toContain('connection')
  })

  it('distinguishes being rate limited', async () => {
    signIn.mockRejectedValue(firebaseError('auth/too-many-requests'))
    const wrapper = mountView()

    await submit(wrapper)

    expect(wrapper.find('[data-testid="signin-error"]').text()).toContain('Too many attempts')
  })

  it('shows a submitting state while the request is in flight', async () => {
    signIn.mockImplementation(() => new Promise(() => undefined))
    const wrapper = mountView()

    await wrapper.find('#signin-email').setValue('alice@example.test')
    await wrapper.find('#signin-password').setValue('a-password')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })
})
