import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signIn = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const query = vi.hoisted((): { value: Record<string, string> } => ({ value: {} }))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ signIn }) }))

vi.mock('vue-router', () => ({
  RouterLink: { template: '<a><slot /></a>' },
  useRouter: () => ({
    push,
    // What the real router reports: patterns, including the parameterised
    // workspace route a signed-out user is most often deep-linked to.
    getRoutes: () => [
      { path: '/dashboard', meta: { access: 'protected' } },
      { path: '/signup', meta: { access: 'auth-flow' } },
      { path: '/projects/:projectId', meta: { access: 'protected' } },
      // Exempt from the guard in every auth state, and it runs a Firebase
      // action code off its own query string — so it must never be a
      // destination. See the `destinationPaths` cases in `guard.spec.ts`.
      { path: '/auth/action', meta: { access: 'action' } },
      { path: '/hl/callback', meta: { access: 'protected' } },
    ],
  }),
  useRoute: () => ({ query: query.value }),
}))

import SignInView from './SignInView.vue'

function mountView() {
  return mount(SignInView)
}

async function submit(wrapper: ReturnType<typeof mountView>, password = 'A-Password-1') {
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

    expect(signIn).toHaveBeenCalledWith('alice@example.test', 'A-Password-1')
    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  /*
   * `/hl/callback` rather than an auth-flow page: only a route a user could actually be
   * *returned to* is a legal target, and Slice 2 made this one `protected` precisely so a
   * session that lapsed at HighLevel round-trips through here and comes back to its outcome.
   */
  it('honours a safe redirect target', async () => {
    query.value = { redirect: '/hl/callback' }
    const wrapper = mountView()

    await submit(wrapper)

    expect(push).toHaveBeenCalledWith('/hl/callback')
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

  /** A wrong password and an unregistered address must be indistinguishable. */
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
    await wrapper.find('#signin-password').setValue('A-Password-1')
    await wrapper.find('form').trigger('submit')

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })
})

/**
 * Why the sign-in page is showing, when the user did not ask for it.
 *
 * Landing on a sign-in form mid-task with no explanation reads as a bug or a lost session's
 * worth of work. The reason comes off the query string, but nothing from the query string is
 * ever *rendered*: the value selects a message from a fixed map, so an attacker-supplied
 * `?reason=` can only pick one of the strings this file already contains, or nothing.
 */
describe('SignInView — the reason notice', () => {
  it('shows the expiry notice for reason=session_expired', () => {
    query.value = { reason: 'session_expired' }

    const wrapper = mountView()

    expect(wrapper.find('[data-testid="signin-notice"]').text()).toBe(
      'Your session expired. Sign in again.',
    )
  })

  it('shows no notice without a reason', () => {
    const wrapper = mountView()

    expect(wrapper.find('[data-testid="signin-notice"]').exists()).toBe(false)
  })

  it('shows no notice for an unrecognised reason', () => {
    query.value = { reason: 'banana' }

    const wrapper = mountView()

    expect(wrapper.find('[data-testid="signin-notice"]').exists()).toBe(false)
  })

  /* AC-12. The whole point of carrying the path: the user is put back in the
   * project the expired session interrupted, not on the dashboard. */
  it('returns to the workspace it was sent from', async () => {
    query.value = { redirect: '/projects/p1', reason: 'session_expired' }
    const wrapper = mountView()

    await submit(wrapper)

    expect(push).toHaveBeenCalledWith('/projects/p1')
  })
})

/**
 * A `?redirect=` is attacker-controllable, and the victim reaches it having *just* typed their
 * password — which is what makes the one guard-exempt route worth refusing by name.
 *
 * `/auth/action?mode=resetPassword&oobCode=…` renders a "choose a new password" form bound to
 * whatever code the link carried. Handed the attacker's own reset code, a user who types the
 * password they typed thirty seconds ago has just set the attacker's account to it.
 */
describe('where a successful sign-in may be sent', () => {
  it('refuses the action handler as a destination', async () => {
    query.value = { redirect: '/auth/action?mode=resetPassword&oobCode=attacker-code' }
    signIn.mockResolvedValue(undefined)

    await submit(mountView())

    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  it('still returns a deep-linked user to their project', async () => {
    query.value = { redirect: '/projects/p1' }
    signIn.mockResolvedValue(undefined)

    await submit(mountView())

    expect(push).toHaveBeenCalledWith('/projects/p1')
  })
})
