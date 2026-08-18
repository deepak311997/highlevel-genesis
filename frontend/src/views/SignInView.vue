<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import PasswordField from '@/components/PasswordField.vue'
import { CONNECTION_MESSAGE } from '@/lib/api'
import { recallEmail } from '@/lib/handoff'
import { DEFAULT_REDIRECT, safeRedirect, storeRedirect } from '@/lib/redirect'
import { SESSION_EXPIRED_REASON } from '@/lib/sessionExpiry'
import { useAuthStore } from '@/stores/auth'

/**
 * One failure message for every credential problem.
 *
 * Firebase with email-enumeration protection enabled collapses
 * `user-not-found` and `wrong-password` into `invalid-credential`, so this
 * costs nothing — but the copy is written not to distinguish them regardless,
 * because the protection is a console setting this repo cannot enforce.
 */
const CREDENTIAL_MESSAGE = 'Email or password is incorrect.'

/**
 * Why the sign-in page is showing, when the user did not ask for it (AC-11).
 *
 * A fixed map, looked up by the `?reason=` value — never a string interpolated
 * from it. The query is attacker-controllable, so the only thing it is allowed
 * to do is *select* one of the messages written here; an unrecognised value
 * selects nothing and the page looks exactly as it always did.
 *
 * A `Map` rather than the object literal the rest of this codebase uses for a
 * lookup table, and that is the attacker-controllable key again:
 * `NOTICES['constructor']` on an object returns something, and
 * `NOTICES.get('constructor')` returns `undefined`.
 *
 * The key comes from the module that writes it, so the producer and the reader
 * of this query-string contract cannot drift apart.
 */
const NOTICES = new Map<string, string>([
  [SESSION_EXPIRED_REASON, 'Your session expired. Sign in again.'],
])

type State = { kind: 'editing' } | { kind: 'submitting' } | { kind: 'failed'; message: string }

// Prefilled when the user has just registered, so they do not retype it.
const prefilled = recallEmail()
const email = ref(prefilled)
const password = ref('')
const state = ref<State>({ kind: 'editing' })

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const notice = computed<string | null>(() => {
  const raw = route.query['reason']
  return typeof raw === 'string' ? (NOTICES.get(raw) ?? null) : null
})

function messageFor(err: unknown): string {
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string') return 'Something went wrong. Please try again.'

  if (code === 'auth/network-request-failed') {
    return CONNECTION_MESSAGE
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Try again in a few minutes.'
  }
  // Everything credential-shaped resolves to one string on purpose.
  return CREDENTIAL_MESSAGE
}

async function submit(): Promise<void> {
  state.value = { kind: 'submitting' }
  try {
    await auth.signIn(email.value.trim(), password.value)

    // Held in sessionStorage as well as the URL: verifying in this same tab
    // navigates away to /auth/action and would otherwise lose the destination.
    const raw = route.query['redirect']
    const target = safeRedirect(
      typeof raw === 'string' ? raw : null,
      router.getRoutes().map((r) => r.path),
    )
    if (target !== DEFAULT_REDIRECT) storeRedirect(target)

    await router.push(target)
  } catch (err) {
    state.value = { kind: 'failed', message: messageFor(err) }
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
      </CardHeader>

      <CardContent class="flex flex-col gap-4">
        <!-- Default variant, so its role is `status`: a notice explains, it does
             not interrupt. The failure alert below is the one that is `alert`. -->
        <Alert v-if="notice !== null" data-testid="signin-notice">{{ notice }}</Alert>

        <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
          <Alert v-if="state.kind === 'failed'" variant="destructive" data-testid="signin-error">
            {{ state.message }}
          </Alert>

          <div class="flex flex-col gap-1.5">
            <Label for="signin-email">Email</Label>
            <Input
              id="signin-email"
              v-model="email"
              type="email"
              autocomplete="email"
              :autofocus="prefilled === ''"
            />
          </div>

          <PasswordField
            id="signin-password"
            v-model="password"
            label="Password"
            autocomplete="current-password"
            :autofocus="prefilled !== ''"
          />

          <Button type="submit" :disabled="state.kind === 'submitting'">
            {{ state.kind === 'submitting' ? 'Signing in…' : 'Sign in' }}
          </Button>
        </form>

        <div class="flex flex-col gap-1 text-sm text-muted-foreground">
          <RouterLink to="/forgot-password" class="underline">Forgot your password?</RouterLink>
          <p>
            No account?
            <RouterLink to="/signup" class="underline">Create one</RouterLink>
          </p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
