<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import PasswordField from '@/components/PasswordField.vue'
import { recallEmail } from '@/lib/handoff'
import { DEFAULT_REDIRECT, safeRedirect, storeRedirect } from '@/lib/redirect'
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

type State = { kind: 'editing' } | { kind: 'submitting' } | { kind: 'failed'; message: string }

// Prefilled when the user has just registered, so they do not retype it.
const prefilled = recallEmail()
const email = ref(prefilled)
const password = ref('')
const state = ref<State>({ kind: 'editing' })

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

function messageFor(err: unknown): string {
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string') return 'Something went wrong. Please try again.'

  if (code === 'auth/network-request-failed') {
    return 'Something went wrong. Check your connection and try again.'
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
