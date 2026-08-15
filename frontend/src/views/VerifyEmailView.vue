<script setup lang="ts">
import { onScopeDispose, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { resendVerification } from '@/lib/authApi'
import { consumeRedirect } from '@/lib/redirect'
import { useAuthStore } from '@/stores/auth'

/**
 * The blocking gate.
 *
 * A signed-in but unverified user is held here and cannot reach any
 * application route. The session is allowed to exist while they wait, which is
 * safe because it can do nothing: Firestore rules deny an unverified token
 * every read and write, so this screen is an affordance layered over an
 * enforcement boundary that already holds.
 *
 * Polls rather than requiring a click, so verifying in a second tab releases
 * this one on its own.
 */
const POLL_INTERVAL_MS = 4_000

type State =
  | { kind: 'waiting' }
  | { kind: 'checking' }
  | { kind: 'resending' }
  | { kind: 'resent' }
  | { kind: 'failed'; message: string }

const auth = useAuthStore()
const router = useRouter()
const state = ref<State>({ kind: 'waiting' })
const stillUnverified = ref(false)

let timer: ReturnType<typeof setInterval> | undefined

/**
 * Release the user, but only after the ID token has been refreshed.
 *
 * `refreshVerification` forces that refresh. Skipping it is the trap: the
 * dashboard would load and then fail every Firestore read against a stale
 * `email_verified` claim — a working page followed by permission errors, which
 * is far harder to diagnose than a page that simply does not load.
 */
async function releaseIfVerified(): Promise<boolean> {
  const verified = await auth.refreshVerification()
  if (!verified) return false

  stop()
  await auth.ensureProfile()
  await router.push(consumeRedirect(router.getRoutes().map((r) => r.path)))
  return true
}

async function checkNow(): Promise<void> {
  state.value = { kind: 'checking' }
  stillUnverified.value = false

  if (await releaseIfVerified()) return

  stillUnverified.value = true
  state.value = { kind: 'waiting' }
}

async function resend(): Promise<void> {
  const address = auth.email
  if (address === null) return

  state.value = { kind: 'resending' }
  try {
    await resendVerification(address)
    state.value = { kind: 'resent' }
  } catch (err) {
    state.value = {
      kind: 'failed',
      message: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
    }
  }
}

async function signOut(): Promise<void> {
  stop()
  await auth.signOutNow()
  await router.push('/signin')
}

function stop(): void {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
}

onMounted(() => {
  timer = setInterval(() => void releaseIfVerified(), POLL_INTERVAL_MS)
})

onScopeDispose(stop)
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>Verify your email</CardTitle>
      </CardHeader>

      <CardContent class="flex flex-col gap-4" data-testid="verify-gate">
        <p class="text-sm text-muted-foreground">
          We sent a link to
          <span class="font-medium text-foreground" data-testid="verify-address">{{
            auth.email ?? 'your address'
          }}</span
          >. Open it to finish setting up your account — you can leave this page open.
        </p>

        <Alert v-if="state.kind === 'resent'" tone="success" data-testid="verify-resent">
          If that address needs a link, we've sent another one.
        </Alert>

        <Alert v-else-if="state.kind === 'failed'" tone="error" data-testid="verify-error">
          {{ state.message }}
        </Alert>

        <Alert v-else-if="stillUnverified" tone="info" data-testid="verify-still-waiting">
          We can't see a verification yet — check your inbox, or resend the link.
        </Alert>

        <div class="flex flex-wrap gap-2">
          <Button :disabled="state.kind === 'checking'" @click="checkNow">
            {{ state.kind === 'checking' ? 'Checking…' : "I've verified — continue" }}
          </Button>
          <Button variant="outline" :disabled="state.kind === 'resending'" @click="resend">
            {{ state.kind === 'resending' ? 'Sending…' : 'Resend link' }}
          </Button>
          <Button variant="ghost" @click="signOut">Sign out</Button>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
