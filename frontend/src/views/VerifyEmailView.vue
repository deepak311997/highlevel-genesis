<script setup lang="ts">
import { sendEmailVerification } from 'firebase/auth'
import { onScopeDispose, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
 *
 * This screen also *sends* the verification email. Registration cannot: it runs
 * server-side through the Admin SDK, which only generates links, and Firebase's
 * own sender needs a signed-in `currentUser`. Sending here rather than at
 * sign-up has a second benefit — registering someone else's address mails them
 * nothing at all, so the endpoint cannot be used to send unsolicited email.
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

/**
 * Whether the link has actually gone out.
 *
 * Tracked rather than assumed: the headline below used to claim "we've sent a
 * link" from the first frame, which was untrue while the request was in flight
 * and stayed untrue if it failed — leaving the screen asserting a send and
 * showing an error about it at the same time.
 */
const delivery = ref<'sending' | 'sent' | 'failed'>('sending')

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

async function send(): Promise<boolean> {
  const user = auth.user
  if (user === null) return false

  delivery.value = 'sending'
  try {
    await sendEmailVerification(user)
    delivery.value = 'sent'
    return true
  } catch (err) {
    delivery.value = 'failed'
    const code = (err as { code?: unknown }).code
    state.value = {
      kind: 'failed',
      message:
        code === 'auth/too-many-requests'
          ? 'Too many attempts. Try again in a few minutes.'
          : 'Something went wrong. Please try again.',
    }
    return false
  }
}

async function resend(): Promise<void> {
  state.value = { kind: 'resending' }
  if (await send()) state.value = { kind: 'resent' }
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
  // Sent once when the gate is first reached, so the user has a link without
  // pressing anything. `sent` lives on the store rather than here, so returning
  // to the gate — or a remount from a route change — does not send again.
  if (!auth.verificationSent) {
    auth.markVerificationSent()
    void send()
  }

  timer = setInterval(() => void releaseIfVerified(), POLL_INTERVAL_MS)
})

onScopeDispose(stop)
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6">
    <Card>
      <CardContent class="flex flex-col gap-5 pt-6" data-testid="verify-gate">
        <!-- A single focal point. The page has no action the user takes *here* —
             the work happens in their mail client — so the design points at the
             inbox rather than at a button. -->
        <div class="flex flex-col items-center gap-3 text-center">
          <span
            class="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-2xl"
            aria-hidden="true"
            >✉️</span
          >
          <h1 class="text-xl font-bold tracking-tight">Check your email</h1>

          <p class="text-sm text-muted-foreground" data-testid="verify-headline">
            <template v-if="delivery === 'sending'">Sending a verification link to </template>
            <template v-else-if="delivery === 'failed'">We couldn't send a link to </template>
            <template v-else>We've sent a link to </template>
            <span class="font-medium text-foreground" data-testid="verify-address">{{
              auth.email ?? 'your address'
            }}</span>
          </p>
        </div>

        <Alert v-if="state.kind === 'failed'" tone="error" data-testid="verify-error">
          {{ state.message }}
        </Alert>

        <Alert v-else-if="state.kind === 'resent'" tone="success" data-testid="verify-resent">
          Sent again — check your inbox.
        </Alert>

        <!-- The page polls, so the user does not have to come back and press
             anything. Saying so is what stops the screen looking stuck. -->
        <div
          v-else-if="delivery === 'sent'"
          data-testid="verify-watching"
          class="flex items-center justify-center gap-2 rounded-md border border-border-strong bg-secondary px-3 py-2 text-sm text-muted-foreground"
        >
          <span class="relative flex h-2 w-2" aria-hidden="true">
            <span
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60"
            ></span>
            <span class="relative inline-flex h-2 w-2 rounded-full bg-accent"></span>
          </span>
          <span>Waiting for you to open it — this page continues on its own.</span>
        </div>

        <Alert v-if="stillUnverified" tone="info" data-testid="verify-still-waiting">
          We can't see a verification yet — check your inbox, or resend the link.
        </Alert>

        <div class="flex flex-col gap-2">
          <Button variant="secondary" :disabled="state.kind === 'resending'" @click="resend">
            {{ state.kind === 'resending' ? 'Sending…' : 'Resend the link' }}
          </Button>
          <Button variant="outline" :disabled="state.kind === 'checking'" @click="checkNow">
            {{ state.kind === 'checking' ? 'Checking…' : "I've verified — continue" }}
          </Button>
        </div>

        <p class="text-center text-xs text-muted-foreground">
          Not in your inbox? Check the spam folder — it can take a minute to arrive.
        </p>

        <p class="border-t pt-4 text-center text-xs text-muted-foreground">
          Signed in as {{ auth.email }}. Not you?
          <button type="button" class="underline hover:text-foreground" @click="signOut">
            Sign out
          </button>
        </p>
      </CardContent>
    </Card>
  </div>
</template>
