import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '@/views/HomeView.vue'
import { installAuthGuard } from './guard'

/**
 * Every route declares its `access` class. There is a fail-closed default in
 * the guard, but relying on it would mean a route added in a later slice is
 * protected by accident rather than by decision — and the one route that must
 * *not* be protected, `/auth/action`, would be the easiest to get wrong.
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView, meta: { access: 'public' } },
    {
      path: '/health',
      name: 'health',
      component: () => import('@/views/HealthView.vue'),
      meta: { access: 'public' },
    },
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
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { access: 'protected' },
    },
  ],
})

installAuthGuard(router)

export default router
