<script setup lang="ts">
import { onMounted } from 'vue'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useHlStore } from '@/stores/hl'

/**
 * The HighLevel connection, on the dashboard.
 *
 * Six states, and they all ship: loading, not-connected, connected,
 * connected-without-a-name, reconnect-required, and error-with-retry. The last
 * one matters more than it looks — this panel's only source of truth is an
 * endpoint, so "we could not ask" is a real state and not a theoretical one.
 */
const hl = useHlStore()

/**
 * One message per outcome the callback can return.
 *
 * Keyed by the same union the server redirects with, so a new code cannot be
 * added on one side alone without this map going stale — and the fallback
 * covers exactly that, rather than rendering nothing.
 */
const ERROR_COPY: Record<string, string> = {
  denied: 'Connection cancelled. You can try again whenever you like.',
  invalid_state: 'That connection link expired. Try connecting again.',
  exchange_failed: "Couldn't complete the connection. Try again.",
  wrong_account_type:
    'Connect a single HighLevel sub-account rather than a whole agency, then try again.',
}

function copyFor(code: string): string {
  return ERROR_COPY[code] ?? "Couldn't complete the connection. Try again."
}

onMounted(() => {
  void hl.refresh()
})
</script>

<template>
  <Card data-testid="connection-panel">
    <CardHeader>
      <CardTitle>HighLevel</CardTitle>
    </CardHeader>

    <CardContent class="flex flex-col gap-4">
      <!-- The callback's outcome, carried in the store rather than the URL. -->
      <Alert v-if="hl.lastError" variant="destructive" data-testid="connection-callback-error">
        <AlertDescription>{{ copyFor(hl.lastError) }}</AlertDescription>
      </Alert>

      <!-- Loading: first load only, so a refresh does not blank the panel. -->
      <div v-if="hl.loading" data-testid="connection-loading" class="flex flex-col gap-2">
        <div class="h-4 w-40 animate-pulse rounded bg-secondary" />
        <div class="h-9 w-32 animate-pulse rounded bg-secondary" />
      </div>

      <!-- Error: the status request itself failed. Retry re-issues it. -->
      <div v-else-if="hl.error" data-testid="connection-error" class="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>{{ hl.error }}</AlertDescription>
        </Alert>
        <Button variant="outline" data-testid="connection-retry" @click="hl.refresh()">
          Try again
        </Button>
      </div>

      <!-- Reconnect required: a refresh was definitively rejected. -->
      <div
        v-else-if="hl.needsReconnect"
        data-testid="connection-needs-reconnect"
        class="flex flex-col gap-3"
      >
        <p class="text-sm text-muted-foreground">
          Your HighLevel connection expired. Reconnect to keep using your CRM data.
        </p>
        <Button :disabled="hl.busy" data-testid="connection-connect" @click="hl.connect()">
          Reconnect HighLevel
        </Button>
      </div>

      <!-- Connected. `label` falls back to the location id when no name. -->
      <div v-else-if="hl.isConnected" data-testid="connection-connected" class="flex flex-col gap-3">
        <p class="text-sm text-muted-foreground">
          Connected to
          <span class="font-medium text-foreground" data-testid="connection-location">{{
            hl.label
          }}</span>
        </p>
        <Button
          variant="outline"
          :disabled="hl.busy"
          data-testid="connection-disconnect"
          @click="hl.disconnect()"
        >
          Disconnect
        </Button>
      </div>

      <!-- Not connected: the empty state. -->
      <div v-else data-testid="connection-empty" class="flex flex-col gap-3">
        <p class="text-sm text-muted-foreground">
          Not connected. Link a HighLevel sub-account to build apps against its contacts,
          conversations and calendars.
        </p>
        <Button :disabled="hl.busy" data-testid="connection-connect" @click="hl.connect()">
          Connect HighLevel
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
