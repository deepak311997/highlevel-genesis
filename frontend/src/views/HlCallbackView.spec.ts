import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { replace, noteCallbackError, refresh, query } = vi.hoisted(() => ({
  replace: vi.fn(),
  noteCallbackError: vi.fn(),
  refresh: vi.fn(),
  query: {},
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query }),
  useRouter: () => ({ replace }),
}))

vi.mock('@/stores/hl', () => ({
  useHlStore: () => ({ noteCallbackError, refresh }),
}))

import HlCallbackView from './HlCallbackView.vue'

/**
 * The landing route for the OAuth callback.
 *
 * It exists so the dashboard never has to know about OAuth: the outcome comes
 * off the URL here, goes into the store, and the URL is replaced with a clean
 * one. Two behaviours below are the reason it is a route rather than a query
 * parameter on the dashboard.
 */

function mountWith(q: Record<string, string>): ReturnType<typeof mount> {
  for (const key of Object.keys(query)) Reflect.deleteProperty(query, key)
  Object.assign(query, q)
  return mount(HlCallbackView)
}

beforeEach(() => {
  vi.clearAllMocks()
  refresh.mockResolvedValue(undefined)
  replace.mockResolvedValue(undefined)
})

describe('HlCallbackView', () => {
  it('tells the user something is happening rather than showing a blank screen', () => {
    const wrapper = mountWith({ status: 'connected' })

    expect(wrapper.find('[data-testid="hl-callback-status"]').exists()).toBe(true)
  })

  it('refreshes the connection before leaving, so the dashboard lands settled', async () => {
    mountWith({ status: 'connected' })
    await flushPromises()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/dashboard')
  })

  /*
   * `replace`, never `push`. The callback URL carries a spent authorization
   * code, so leaving it in history gives the back button a destination that can
   * only fail.
   */
  it('replaces history rather than pushing, so Back cannot revisit a spent code', async () => {
    mountWith({ status: 'connected' })
    await flushPromises()

    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('records a failure so the dashboard panel can render it', async () => {
    mountWith({ status: 'error', code: 'invalid_state' })
    await flushPromises()

    expect(noteCallbackError).toHaveBeenCalledWith('invalid_state')
    // Still lands on a clean URL — the error travels in the store, not the query.
    expect(replace).toHaveBeenCalledWith('/dashboard')
  })

  it('records nothing on the happy path', async () => {
    mountWith({ status: 'connected' })
    await flushPromises()

    expect(noteCallbackError).not.toHaveBeenCalled()
  })

  it('falls back to a usable code when the server sent none', async () => {
    mountWith({ status: 'error' })
    await flushPromises()

    expect(noteCallbackError).toHaveBeenCalledWith('exchange_failed')
  })

  /*
   * A user who arrives with no query at all — a bookmark, a stray link — must
   * not be stranded on a spinner.
   */
  it('still leaves when there is no outcome on the URL', async () => {
    mountWith({})
    await flushPromises()

    expect(replace).toHaveBeenCalledWith('/dashboard')
    expect(noteCallbackError).not.toHaveBeenCalled()
  })
})
