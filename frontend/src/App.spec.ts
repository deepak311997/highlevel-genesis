import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { defineComponent, h } from 'vue'

const auth = vi.hoisted(() => ({
  initialised: true,
  isSignedIn: false,
  isVerified: false,
  email: null as string | null,
  signOutNow: vi.fn(),
}))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

import App from './App.vue'
import { Toaster } from '@/components/ui/sonner'

/**
 * The app shell's one decision: how much room `main` gives the route.
 *
 * Every screen before this slice wanted the centred, padded container. The workspace wants the
 * whole window — the three panels need a *bounded* height to scroll inside, and a flex column
 * gives them one without a `calc()` that hard-codes the header's height and breaks the first
 * time the header gains a line.
 */

const Blank = defineComponent({ render: () => h('p', 'route') })

/** A router with one route of each layout, so the switch is what is under test. */
function routerWith(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      // No `meta.layout` at all: `contained` is the default, and every route that
      // predates this slice relies on that.
      { path: '/contained', component: Blank, meta: { access: 'public' } },
      { path: '/full', component: Blank, meta: { access: 'public', layout: 'full' } },
      // The shell's wordmark points here once a session is verified.
      { path: '/dashboard', component: Blank, meta: { access: 'public' } },
    ],
  })
}

/*
 * `ThemeToggle` is stubbed: it owns the store-free `useTheme` composable, needs a
 * `matchMedia` jsdom does not provide, and has a suite of its own — the same reason
 * `ProjectsCard.spec.ts` stubs its dialogs.
 */
async function mountAt(path: string) {
  const router = routerWith()
  await router.push(path)
  await router.isReady()

  const wrapper = mount(App, { global: { plugins: [router], stubs: { ThemeToggle: true } } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  auth.initialised = true
  auth.isSignedIn = false
  auth.isVerified = false
  vi.clearAllMocks()
})

describe('App shell', () => {
  it('contains main on a route that declares no layout', async () => {
    const wrapper = await mountAt('/contained')

    const classes = wrapper.find('main').classes()
    expect(classes).toContain('max-w-5xl')
    expect(classes).toContain('mx-auto')
  })

  /* Full-bleed, and a flex child that may shrink: without `min-h-0` a flex item
   * refuses to go below its content's height, so the panels would push the page
   * taller instead of scrolling inside it. */
  it('lets main fill the window on a route that declares layout: full', async () => {
    const wrapper = await mountAt('/full')

    const classes = wrapper.find('main').classes()
    expect(classes).not.toContain('max-w-5xl')
    expect(classes).toContain('flex-1')
    expect(classes).toContain('min-h-0')
  })

  /* The header is outside the switch and keeps its own container on both. */
  /*
   * The two scroll models. A contained route is a document and the window scrolls it; a full
   * route is an application window, exactly the viewport, with the scrolling inside the panels.
   */
  it('scrolls the window on a contained route and not on a full one', async () => {
    const contained = (await mountAt('/contained')).find('div').classes()
    expect(contained).toContain('min-h-screen')
    expect(contained).not.toContain('overflow-hidden')

    const full = (await mountAt('/full')).find('div').classes()
    expect(full).toContain('h-screen')
    expect(full).toContain('overflow-hidden')
    expect(full).not.toContain('min-h-screen')
  })

  /* The wordmark is the only way back, and where back *is* depends on the session. */
  it('points the wordmark at the dashboard only once there is a verified session', async () => {
    auth.isSignedIn = true
    auth.isVerified = true
    const signedIn = await mountAt('/contained')
    expect(signedIn.find('[data-testid="header-home"]').attributes('href')).toBe('/dashboard')

    auth.isSignedIn = false
    auth.isVerified = false
    const signedOut = await mountAt('/contained')
    expect(signedOut.find('[data-testid="header-home"]').attributes('href')).toBe('/')
  })

  it('carries no second link to the dashboard', async () => {
    auth.isSignedIn = true
    auth.isVerified = true
    const wrapper = await mountAt('/contained')

    const toDashboard = wrapper.findAll('a[href="/dashboard"]')
    expect(toDashboard).toHaveLength(1)
    expect(toDashboard[0]?.attributes('data-testid')).toBe('header-home')
  })

  it('renders the header on both layouts', async () => {
    for (const path of ['/contained', '/full']) {
      const wrapper = await mountAt(path)

      expect(wrapper.find('header').exists()).toBe(true)
    }
  })

  /*
   * The guard awaits the same signal before resolving any route, so until Firebase answers there
   * is nothing to show — and saying so beats an empty page on a slow connection.
   */
  it('says it is loading until Firebase has answered', async () => {
    auth.initialised = false

    const wrapper = await mountAt('/contained')

    expect(wrapper.find('[data-testid="app-loading"]').exists()).toBe(true)
  })

  /*
   * One toast region for the whole app, and it lives outside `<main>` — outside the
   * `contained`/`full` switch and outside the routed area.
   */
  it('mounts exactly one Toaster', async () => {
    for (const path of ['/contained', '/full']) {
      const wrapper = await mountAt(path)

      expect(wrapper.findAllComponents(Toaster)).toHaveLength(1)
    }
  })
})
