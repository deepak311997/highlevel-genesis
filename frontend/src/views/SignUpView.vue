<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import PasswordField from '@/components/PasswordField.vue'
import { register } from '@/lib/authApi'
import { rememberEmail } from '@/lib/handoff'
import { passwordProblem } from '@/lib/password'

/**
 * The success screen is reached for *every* accepted submission — a new
 * address or one already registered. That sameness is the feature: the server
 * returns an identical response either way, and this screen must not undo that
 * by looking different.
 *
 * It does not promise an email, because registration deliberately sends none.
 * Verification is sent by the gate, after sign-in, once Firebase has a
 * `currentUser` to send it for — which also means registering someone else's
 * address mails them nothing.
 */
type State =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'sent' }
  | { kind: 'failed'; message: string }

const email = ref('')
const password = ref('')
const state = ref<State>({ kind: 'editing' })
const fieldError = ref<{ email?: string; password?: string }>({})

function validate(): boolean {
  const errors: { email?: string; password?: string } = {}

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
    errors.email = 'Enter a valid email address.'
  }
  const problem = passwordProblem(password.value)
  if (problem !== null) {
    errors.password = problem
  }

  fieldError.value = errors
  return Object.keys(errors).length === 0
}

async function submit(): Promise<void> {
  if (!validate()) return

  state.value = { kind: 'submitting' }
  try {
    await register(email.value.trim(), password.value)
    // So sign-in can prefill rather than asking for it a second time.
    rememberEmail(email.value.trim())
    state.value = { kind: 'sent' }
  } catch (err) {
    state.value = {
      kind: 'failed',
      message: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
    }
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-5">
    <Card>
      <CardHeader>
        <CardTitle>{{ state.kind === 'sent' ? 'Almost there' : 'Create an account' }}</CardTitle>
      </CardHeader>

      <CardContent class="flex flex-col gap-4">
        <div v-if="state.kind === 'sent'" data-testid="signup-sent" class="flex flex-col gap-4">
          <Alert variant="success">
            You can sign in now. We'll confirm your email address next.
          </Alert>
          <Button as-child><RouterLink to="/signin">Sign in</RouterLink></Button>
        </div>

        <form v-else class="flex flex-col gap-3.5" novalidate @submit.prevent="submit">
          <Alert v-if="state.kind === 'failed'" variant="destructive" data-testid="signup-error">
            {{ state.message }}
          </Alert>

          <div class="flex flex-col gap-1.5">
            <Label for="signup-email">Email</Label>
            <Input
              id="signup-email"
              v-model="email"
              type="email"
              autocomplete="email"
              autofocus
              :invalid="fieldError.email !== undefined"
            />
            <p
              v-if="fieldError.email"
              data-testid="signup-email-error"
              class="text-xs text-destructive"
            >
              {{ fieldError.email }}
            </p>
          </div>

          <div class="flex flex-col gap-1.5">
            <PasswordField
              id="signup-password"
              v-model="password"
              label="Password"
              autocomplete="new-password"
              show-rules
              :invalid="fieldError.password !== undefined"
            />
            <p
              v-if="fieldError.password"
              data-testid="signup-password-error"
              class="text-xs text-destructive"
            >
              {{ fieldError.password }}
            </p>
          </div>

          <Button type="submit" :disabled="state.kind === 'submitting'">
            {{ state.kind === 'submitting' ? 'Creating…' : 'Create account' }}
          </Button>
        </form>

        <p v-if="state.kind !== 'sent'" class="text-sm text-muted-foreground">
          Already have an account?
          <RouterLink to="/signin" class="underline">Sign in</RouterLink>
        </p>
      </CardContent>
    </Card>
  </div>
</template>
