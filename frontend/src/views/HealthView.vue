<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDuration } from '@/lib/format'
import { fetchHealth, type HealthResult } from '@/lib/health'

/**
 * One value, three shapes — `result` exists only when the check succeeded and
 * `message` only when it failed. Three parallel refs would let the template ask
 * for a timing that isn't there, which is what the `?? -1` sentinels used to
 * paper over.
 */
type State =
  | { kind: 'loading' }
  | { kind: 'ok'; result: HealthResult }
  | { kind: 'error'; message: string }

const state = ref<State>({ kind: 'loading' })

async function run(): Promise<void> {
  state.value = { kind: 'loading' }
  try {
    state.value = { kind: 'ok', result: await fetchHealth() }
  } catch (err) {
    state.value = {
      kind: 'error',
      message: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

onMounted(run)
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-2">
      <h1 class="text-2xl font-bold tracking-tight">Health</h1>
      <p class="max-w-prose text-sm text-muted-foreground">
        Writes a document to Firestore through a Cloud Function, reads it back, and reports the
        round trip. If this is green, every layer of the stack is wired.
      </p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Round trip</CardTitle>
      </CardHeader>
      <CardContent class="flex flex-col items-start gap-4">
        <p
          v-if="state.kind === 'loading'"
          data-testid="health-loading"
          class="text-sm text-muted-foreground"
        >
          Checking…
        </p>

        <div
          v-else-if="state.kind === 'error'"
          data-testid="health-error"
          class="flex flex-col gap-2"
        >
          <p class="text-sm font-medium text-destructive">Health check failed</p>
          <p class="text-sm text-muted-foreground">{{ state.message }}</p>
          <p class="text-sm text-muted-foreground">
            Are the emulators running? <code class="text-xs">npm run emulators</code>
          </p>
        </div>

        <dl
          v-else-if="state.kind === 'ok'"
          data-testid="health-ok"
          class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm"
        >
          <dt class="text-muted-foreground">Status</dt>
          <dd class="font-medium text-accent">ok</dd>

          <dt class="text-muted-foreground">Write</dt>
          <dd>{{ formatDuration(state.result.writeMs) }}</dd>

          <dt class="text-muted-foreground">Read</dt>
          <dd>{{ formatDuration(state.result.readMs) }}</dd>

          <dt class="text-muted-foreground">Round trip</dt>
          <dd>{{ formatDuration(state.result.roundTripMs) }}</dd>

          <dt class="text-muted-foreground">Server time</dt>
          <dd class="font-mono text-xs">{{ state.result.serverTime }}</dd>
        </dl>

        <Button variant="outline" size="sm" @click="run">Run again</Button>
      </CardContent>
    </Card>
  </div>
</template>
