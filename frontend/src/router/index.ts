import { createRouter, createWebHistory } from 'vue-router'

import { installAuthGuard } from './guard'

/**
 * Every route declares its `access` class. There is a fail-closed default in
 * the guard, but relying on it would mean a route added in a later slice is
 * protected by accident rather than by decision — and the one route that must
 * *not* be protected, `/auth/action`, would be the easiest to get wrong.
 *
 * There is no landing page. `/` is classed `protected`, so the guard resolves
 * it the same way it resolves anything else: signed out goes to sign-in,
 * unverified to the gate, verified to the dashboard. A marketing page in front
 * of a tool nobody can use without an account is a step, not a welcome.
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', redirect: '/dashboard', meta: { access: 'protected' } },
    {
      path: '/signup',
      name: 'signup',
      component: () => import('@/views/SignUpView.vue'),
      meta: { access: 'auth-flow' },
    },
    {
      path: '/signin',
      name: 'signin',
      component: () => import('@/views/SignInView.vue'),
      meta: { access: 'auth-flow' },
    },
    {
      path: '/forgot-password',
      name: 'forgot-password',
      component: () => import('@/views/ForgotPasswordView.vue'),
      meta: { access: 'auth-flow' },
    },
    {
      // Exempt in every auth state. See RouteAccess['action'] — guarding this
      // one deadlocks verification entirely.
      path: '/auth/action',
      name: 'auth-action',
      component: () => import('@/views/AuthActionView.vue'),
      meta: { access: 'action' },
    },
    {
      path: '/verify-email',
      name: 'verify-email',
      component: () => import('@/views/VerifyEmailView.vue'),
      meta: { access: 'gate' },
    },
    {
      /*
       * Where HighLevel's callback lands. `protected` like the dashboard: a
       * session that lapsed while the user was away at HighLevel round-trips
       * through sign-in and comes back here, rather than losing the outcome.
       */
      path: '/hl/callback',
      name: 'hl-callback',
      component: () => import('@/views/HlCallbackView.vue'),
      meta: { access: 'protected' },
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { access: 'protected' },
    },
    // Anything unrecognised resolves through the guard rather than 404ing.
    { path: '/:pathMatch(.*)*', redirect: '/dashboard', meta: { access: 'protected' } },
  ],
})

installAuthGuard(router)

export default router
