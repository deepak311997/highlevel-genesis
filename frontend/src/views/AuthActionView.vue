<script setup lang="ts">
import { applyActionCode, confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth'
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import PasswordField from '@/components/PasswordField.vue'
import { auth } from '@/lib/firebase'
import { passwordProblem } from '@/lib/password'
import { useAuthStore } from '@/stores/auth'

/**
 * Handler for emailed links — `verifyEmail` and `resetPassword`.
 *
 * This route is exempt from the verification gate in every auth state, and it
 * has to be: whoever follows a verification link is signed in and unverified,
 * which is precisely the state the gate intercepts. Guarded, this page would be
 * redirected away before the code could be applied and there would be no way to
 * ever verify.
 *
 * `mode` comes off the URL, so it is matched against a closed set rather than
 * passed through to anything.
 */
const MODES = ['verifyEmail', 'resetPassword'] as const
type Mode = (typeof MODES)[number]

type State =
  | { kind: 'working' }
  | { kind: 'verified' }
  | { kind: 'needs-password'; code: string }
  | { kind: 'saving'; code: string }
  | { kind: 'password-set' }
  | { kind: 'invalid'; message: string; canResend: boolean }

const state = ref<State>({ kind: 'working' })
const password = ref('')
const passwordError = ref('')

const route = useRoute()
const router = useRouter()
const store = useAuthStore()

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/**
 * Turn a Firebase action-code failure into something a person can act on.
 *
 * `expired-action-code` and `invalid-action-code` are deliberately given
 * different copy: one is a link that was fine and aged out, the other is a link
 * that was already used or never valid, and telling someone to "request a new
 * one" is only useful advice in the first case.
 */
function describe(err: unknown): { message: string; canResend: boolean } {
  const code = (err as { code?: unknown }).code

  if (code === 'auth/expired-action-code') {
    return { message: 'That link has expired.', canResend: true }
  }
  if (code === 'auth/invalid-action-code') {
    return {
      message: 'That link is no longer valid — it may already have been used.',
      canResend: true,
    }
  }
  if (code === 'auth/user-not-found' || code === 'auth/user-disabled') {
    return { message: 'That link is no longer valid — sign up again.', canResend: false }
  }
  return { message: 'Something went wrong. Please try again.', canResend: true }
}

async function run(): Promise<void> {
  const mode = route.query['mode']
  const oobCode = route.query['oobCode']

  if (!isMode(mode) || typeof oobCode !== 'string' || oobCode === '') {
    state.value = {
      kind: 'invalid',
      message: 'That link is not one we recognise.',
      canResend: false,
    }
    return
  }

  try {
    if (mode === 'verifyEmail') {
      await applyActionCode(auth, oobCode)
      // The claim inside the ID token is what Firestore rules read, and it does
      // not update on its own.
      await store.refreshVerification()
      await store.ensureProfile()
      state.value = { kind: 'verified' }
      return
    }

    await verifyPasswordResetCode(auth, oobCode)
    state.value = { kind: 'needs-password', code: oobCode }
  } catch (err) {
    const { message, canResend } = describe(err)
    state.value = { kind: 'invalid', message, canResend }
  }
}

async function savePassword(): Promise<void> {
  const current = state.value
  if (current.kind !== 'needs-password') return

  const problem = passwordProblem(password.value)
  if (problem !== null) {
    passwordError.value = problem
    return
  }
  passwordError.value = ''

  state.value = { kind: 'saving', code: current.code }
  try {
    await confirmPasswordReset(auth, current.code, password.value)
    state.value = { kind: 'password-set' }
  } catch (err) {
    const { message, canResend } = describe(err)
    state.value = { kind: 'invalid', message, canResend }
  }
}

async function goOn(): Promise<void> {
  await router.push('/dashboard')
}

onMounted(run)
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>
          {{
            state.kind === 'needs-password' || state.kind === 'saving'
              ? 'Set a new password'
              : 'Your account'
          }}
        </CardTitle>
      </CardHeader>

      <CardContent class="flex flex-col gap-4">
        <p
          v-if="state.kind === 'working'"
          data-testid="action-loading"
          class="text-sm text-muted-foreground"
        >
          Checking your link…
        </p>

        <div
          v-else-if="state.kind === 'verified'"
          data-testid="action-verified"
          class="flex flex-col gap-4"
        >
          <Alert tone="success">Your email is verified.</Alert>
          <Button @click="goOn">Continue</Button>
        </div>

        <div
          v-else-if="state.kind === 'password-set'"
          data-testid="action-password-set"
          class="flex flex-col gap-4"
        >
          <Alert tone="success">Your password is set.</Alert>
          <Button as-child><RouterLink to="/signin">Sign in</RouterLink></Button>
        </div>

        <form
          v-else-if="state.kind === 'needs-password' || state.kind === 'saving'"
          class="flex flex-col gap-4"
          novalidate
          @submit.prevent="savePassword"
        >
          <div class="flex flex-col gap-1.5">
            <PasswordField
              id="new-password"
              v-model="password"
              label="New password"
              autocomplete="new-password"
              show-rules
              autofocus
              :invalid="passwordError !== ''"
            />
            <p
              v-if="passwordError"
              data-testid="action-password-error"
              class="text-xs text-destructive"
            >
              {{ passwordError }}
            </p>
          </div>
          <Button type="submit" :disabled="state.kind === 'saving'">
            {{ state.kind === 'saving' ? 'Saving…' : 'Set password' }}
          </Button>
        </form>

        <div
          v-else-if="state.kind === 'invalid'"
          data-testid="action-invalid"
          class="flex flex-col gap-4"
        >
          <Alert tone="error">{{ state.message }}</Alert>
          <Button as-child variant="outline">
            <RouterLink :to="state.canResend ? '/verify-email' : '/signup'">
              {{ state.canResend ? 'Get a new link' : 'Start again' }}
            </RouterLink>
          </Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
