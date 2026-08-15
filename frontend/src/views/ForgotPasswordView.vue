<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { sendPasswordResetEmail } from 'firebase/auth'

import { auth } from '@/lib/firebase'

/**
 * Firebase sends this one directly.
 *
 * `sendPasswordResetEmail` does not disclose whether the account exists —
 * *provided email-enumeration protection is enabled on the project*, which
 * suppresses the `auth/user-not-found` it would otherwise throw. That is a
 * console setting this repo cannot enforce, so the confirmation below is
 * non-committal regardless: it is shown for every accepted submission, and
 * saying "we've sent you a link" would disclose what the API is trying not to.
 */
type State =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'sent' }
  | { kind: 'failed'; message: string }

const email = ref('')
const state = ref<State>({ kind: 'editing' })
const fieldError = ref('')

async function submit(): Promise<void> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
    fieldError.value = 'Enter a valid email address.'
    return
  }
  fieldError.value = ''

  state.value = { kind: 'submitting' }
  try {
    await sendPasswordResetEmail(auth, email.value.trim())
    state.value = { kind: 'sent' }
  } catch (err) {
    const code = (err as { code?: unknown }).code

    // Belt and braces: if enumeration protection is off, this is the code that
    // would leak. Treated as success so the screen cannot become the oracle.
    if (code === 'auth/user-not-found' || code === 'auth/invalid-email') {
      state.value = { kind: 'sent' }
      return
    }

    state.value = {
      kind: 'failed',
      message:
        code === 'auth/too-many-requests'
          ? 'Too many attempts. Try again in a few minutes.'
          : 'Something went wrong. Please try again.',
    }
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
      </CardHeader>

      <CardContent class="flex flex-col gap-4">
        <div v-if="state.kind === 'sent'" data-testid="forgot-sent">
          <Alert tone="success">
            If an account exists for that address, we've sent a reset link.
          </Alert>
        </div>

        <form v-else class="flex flex-col gap-4" novalidate @submit.prevent="submit">
          <Alert v-if="state.kind === 'failed'" tone="error" data-testid="forgot-error">
            {{ state.message }}
          </Alert>

          <div class="flex flex-col gap-1.5">
            <Label for="forgot-email">Email</Label>
            <Input
              id="forgot-email"
              v-model="email"
              type="email"
              autocomplete="email"
              :invalid="fieldError !== ''"
            />
            <p v-if="fieldError" data-testid="forgot-email-error" class="text-xs text-destructive">
              {{ fieldError }}
            </p>
          </div>

          <Button type="submit" :disabled="state.kind === 'submitting'">
            {{ state.kind === 'submitting' ? 'Sending…' : 'Send reset link' }}
          </Button>
        </form>

        <p class="text-sm text-muted-foreground">
          <RouterLink to="/signin" class="underline">Back to sign in</RouterLink>
        </p>
      </CardContent>
    </Card>
  </div>
</template>
