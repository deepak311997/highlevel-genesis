<script setup lang="ts">
import { computed, onMounted } from 'vue'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useHlStore, type ProbeResult, type SurfaceProbe } from '@/stores/hl'

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

/**
 * The three surfaces the probe reads, in the order they are shown.
 *
 * A table rather than three near-copies in the template, so a fourth surface is
 * one line here and nothing in the markup.
 */
const SURFACES = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'calendars', label: 'Calendars' },
] as const satisfies readonly { key: keyof ProbeResult; label: string }[]

const rows = computed(() => {
  const probed = hl.probeResult
  if (probed === null) return []
  return SURFACES.map((surface) => ({ ...surface, probe: probed[surface.key] }))
})

/**
 * What one row says on its right-hand side.
 *
 * The zero case is deliberately first among the counts: `0` is falsy, so any
 * truthiness test here would report an empty location as unreadable. `null` is
 * the other half — "the response carried no number we recognise" — and that is
 * an em dash rather than a `NaN` or a lie (AC-41, AC-45).
 */
function describe(probe: SurfaceProbe): string {
  if (probe.error !== null) return probe.error
  if (probe.count === null) return '—'
  if (probe.count === 0) return 'None yet'
  return String(probe.count)
}

/** Any single surface that failed this way is fixed by the same button (P11). */
const probeNeedsReconnect = computed(() => rows.value.some((row) => row.probe.reconnect))

/**
 * The section-level alert, as distinct from a row's own message.
 *
 * Two things earn one: a surface that can only be fixed by reconnecting, whose
 * own reason is the most useful copy available; and a probe where every surface
 * failed, which a set of three identical rows states poorly.
 */
const probeAlert = computed<string | null>(() => {
  const reconnecting = rows.value.find((row) => row.probe.reconnect)
  if (reconnecting !== undefined) {
    return reconnecting.probe.error ?? 'Your HighLevel connection expired. Reconnect to continue.'
  }
  if (hl.probe === 'error')
    return "Couldn't read any of your HighLevel data. Try again in a moment."
  return null
})

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
        <Skeleton class="h-4 w-40 rounded" />
        <Skeleton class="h-9 w-32 rounded" />
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
      <div
        v-else-if="hl.isConnected"
        data-testid="connection-connected"
        class="flex flex-col gap-3"
      >
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

        <!--
          Data access. Inside the connected branch on purpose: that is what
          makes "not connected renders nothing" true without a guard of its own,
          and it leaves the reconnect-required state its own screen.
        -->
        <div data-testid="data-access" class="flex flex-col gap-3 border-t pt-4">
          <div class="flex flex-col gap-1">
            <p class="text-sm font-medium">Data access</p>
            <p class="text-sm text-muted-foreground">
              Check that this connection can read your contacts, conversations and calendars. Runs
              three requests against HighLevel.
            </p>
          </div>

          <!-- Loading: the probe is three live requests, so this is not instant. -->
          <div
            v-if="hl.probe === 'loading'"
            data-testid="data-access-loading"
            class="flex flex-col gap-2"
          >
            <Skeleton v-for="n in 3" :key="n" class="h-5 w-full rounded" />
          </div>

          <!-- Result: one row per surface, each with its own outcome. -->
          <dl v-else-if="rows.length > 0" class="flex flex-col gap-1">
            <div
              v-for="row in rows"
              :key="row.key"
              :data-testid="`data-access-row-${row.key}`"
              class="flex items-baseline justify-between gap-4 text-sm"
            >
              <dt class="text-muted-foreground">{{ row.label }}</dt>
              <dd :class="row.probe.error === null ? 'font-medium' : 'text-destructive'">
                {{ describe(row.probe) }}
              </dd>
            </div>
          </dl>

          <Alert v-if="probeAlert" variant="destructive" data-testid="data-access-error">
            <AlertDescription>{{ probeAlert }}</AlertDescription>
          </Alert>

          <Button
            v-if="probeNeedsReconnect"
            :disabled="hl.busy"
            data-testid="data-access-reconnect"
            @click="hl.connect()"
          >
            Reconnect HighLevel
          </Button>

          <Button
            variant="outline"
            :disabled="hl.probe === 'loading'"
            data-testid="data-access-check"
            @click="hl.checkDataAccess()"
          >
            {{ hl.probeResult === null ? 'Check data access' : 'Check again' }}
          </Button>
        </div>
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
