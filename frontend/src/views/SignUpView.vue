<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { register } from '@/lib/authApi'

/**
 * The success screen is reached for *every* accepted submission — a new
 * address, one already registered, one registered but unverified. That
 * sameness is the feature: the server returns an identical response for all
 * three, and this screen must not undo that by looking different.
 */
type State =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'sent' }
  | { kind: 'failed'; message: string }

/** Mirrors PASSWORD_MIN in functions/src/auth/schema.ts. */
const PASSWORD_MIN = 8

const email = ref('')
const password = ref('')
const state = ref<State>({ kind: 'editing' })
const fieldError = ref<{ email?: string; password?: string }>({})

function validate(): boolean {
  const errors: { email?: string; password?: string } = {}

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
    errors.email = 'Enter a valid email address.'
  }
  if (password.value.length < PASSWORD_MIN) {
    errors.password = `Use at least ${String(PASSWORD_MIN)} characters.`
  }

  fieldError.value = errors
  return Object.keys(errors).length === 0
}

async function submit(): Promise<void> {
  if (!validate()) return

  state.value = { kind: 'submitting' }
  try {
    await register(email.value.trim(), password.value)
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
  <div class="mx-auto flex max-w-md flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>{{
          state.kind === 'sent' ? 'Check your inbox' : 'Create an account'
        }}</CardTitle>
      </CardHeader>

      <CardContent class="flex flex-col gap-4">
        <div v-if="state.kind === 'sent'" data-testid="signup-sent" class="flex flex-col gap-4">
          <Alert tone="success">
            If that address can be used, we've sent it an email. Follow the link to finish setting
            up your account.
          </Alert>
          <p class="text-sm text-muted-foreground">
            Didn't get it? Check your spam folder, or
            <RouterLink to="/signin" class="underline">try signing in</RouterLink>.
          </p>
        </div>

        <form v-else class="flex flex-col gap-4" novalidate @submit.prevent="submit">
          <Alert v-if="state.kind === 'failed'" tone="error" data-testid="signup-error">
            {{ state.message }}
          </Alert>

          <div class="flex flex-col gap-1.5">
            <Label for="signup-email">Email</Label>
            <Input
              id="signup-email"
              v-model="email"
              type="email"
              autocomplete="email"
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
            <Label for="signup-password">Password</Label>
            <Input
              id="signup-password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              :invalid="fieldError.password !== undefined"
            />
            <p
              v-if="fieldError.password"
              data-testid="signup-password-error"
              class="text-xs text-destructive"
            >
              {{ fieldError.password }}
            </p>
            <p v-else class="text-xs text-muted-foreground">
              At least {{ PASSWORD_MIN }} characters. Length is what matters — a passphrase beats a
              short password with symbols.
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
