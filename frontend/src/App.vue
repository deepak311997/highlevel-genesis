<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'

import ThemeToggle from '@/components/ThemeToggle.vue'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

/**
 * How much room the route gets (D22).
 *
 * `contained` is the default, so every route that predates the workspace keeps the
 * centred container without saying anything. `full` drops the max width and the
 * padding and makes `main` a flex child that may shrink — `min-h-0` is the
 * load-bearing half of that: without it a flex item refuses to go below its
 * content's height, so the workspace's panels would push the page taller instead of
 * scrolling inside it.
 */
const contained = computed(() => route.meta.layout !== 'full')

async function signOut(): Promise<void> {
  await auth.signOutNow()
  await router.push('/signin')
}
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="shrink-0 border-b bg-gradient-to-b from-raised to-card">
      <nav class="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
        <RouterLink to="/" class="flex items-center gap-2 text-base font-bold tracking-tight">
          <svg viewBox="0 0 96 96" class="h-5 w-5" aria-hidden="true">
            <g fill="none" stroke="var(--primary)" stroke-width="9" stroke-linecap="round">
              <path d="M67.80 28.20 A 28 28 0 1 0 57.58 74.31" />
              <path d="M69.45 66.00 A 28 28 0 0 0 73.38 59.83" />
            </g>
            <circle cx="75.89" cy="45.56" r="4.5" fill="var(--primary)" />
            <circle cx="48" cy="48" r="8.5" fill="var(--accent)" />
          </svg>
          Genesis
        </RouterLink>

        <RouterLink
          v-if="auth.initialised && auth.isVerified"
          to="/dashboard"
          class="text-sm text-muted-foreground hover:text-foreground"
        >
          Dashboard
        </RouterLink>
        <div class="ml-auto flex items-center gap-3">
          <!--
            Nothing auth-dependent renders until Firebase has answered. Without
            the guard the header paints "Sign in" on every load and then swaps
            to the signed-in state a moment later — a flicker on the one element
            that is on every page.
          -->
          <template v-if="auth.initialised">
            <span
              v-if="auth.isSignedIn"
              data-testid="header-email"
              class="hidden text-sm text-muted-foreground sm:inline"
            >
              {{ auth.email }}
            </span>
            <Button v-if="auth.isSignedIn" variant="ghost" size="sm" @click="signOut">
              Sign out
            </Button>
            <Button v-else as-child variant="secondary" size="sm">
              <RouterLink to="/signin">Sign in</RouterLink>
            </Button>
          </template>
          <ThemeToggle />
        </div>
      </nav>
    </header>

    <main
      :class="contained ? 'mx-auto w-full max-w-5xl px-6 py-10' : 'flex min-h-0 flex-1 flex-col'"
    >
      <!--
        The router guard awaits the same signal before resolving any route, so
        until Firebase answers there is nothing to show. Saying so beats an
        empty page on a slow connection.
      -->
      <p v-if="!auth.initialised" data-testid="app-loading" class="text-sm text-muted-foreground">
        Loading…
      </p>
      <RouterView v-else />
    </main>
  </div>
</template>
