import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import {
  disconnect as disconnectRequest,
  getConnection,
  startConnect,
  type ConnectionStatus,
} from '@/lib/hlApi'

/**
 * The HighLevel connection, as far as the browser can see it.
 *
 * Deliberately not a Firestore subscription. The connection document holds
 * tokens and is denied to every client, so this state comes from an endpoint —
 * which means it is a snapshot, refreshed on demand, rather than something that
 * updates itself.
 */

/** Every outcome the OAuth callback can hand back. */
export type CallbackErrorCode = 'denied' | 'invalid_state' | 'exchange_failed' | 'wrong_account_type'

export interface HlStore {
  status: Ref<ConnectionStatus | null>
  loading: Ref<boolean>
  busy: Ref<boolean>
  error: Ref<string | null>
  lastError: Ref<string | null>
  isConnected: ComputedRef<boolean>
  needsReconnect: ComputedRef<boolean>
  label: ComputedRef<string | null>
  refresh: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  noteCallbackError: (code: string) => void
}

export const useHlStore = defineStore('hl', (): HlStore => {
  const status = ref<ConnectionStatus | null>(null)
  /** True only while the *first* load is in flight, so a refresh does not blank the panel. */
  const loading = ref(false)
  /** True while a connect or disconnect is in flight — what disables the buttons. */
  const busy = ref(false)
  const error = ref<string | null>(null)
  /**
   * The code the OAuth callback came back with.
   *
   * Carried in the store rather than on the dashboard URL, so the address bar
   * stays clean and the dashboard never has to know about OAuth.
   */
  const lastError = ref<string | null>(null)

  const isConnected = computed(() => status.value?.connected === true)
  const needsReconnect = computed(() => status.value?.needsReconnect === true)

  /**
   * What to call the connected location.
   *
   * Falls back to the id, which is what happens when `locations.readonly` is
   * absent or the lookup failed — a working connection with a worse label, not
   * a broken one.
   */
  const label = computed(() => {
    if (status.value?.connected !== true) return null
    return status.value.locationName ?? status.value.locationId ?? null
  })

  async function refresh(): Promise<void> {
    if (status.value === null) loading.value = true
    error.value = null
    try {
      status.value = await getConnection()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Could not load the connection status.'
    } finally {
      loading.value = false
    }
  }

  /**
   * Leaves the SPA. Nothing after the assignment runs, and `busy` is never
   * cleared on the success path on purpose — the button must stay disabled
   * while the browser is navigating away, or a second click mints a second
   * state.
   */
  async function connect(): Promise<void> {
    busy.value = true
    error.value = null
    lastError.value = null
    try {
      window.location.assign(await startConnect())
    } catch (err) {
      busy.value = false
      error.value = err instanceof Error ? err.message : 'Could not start the connection.'
    }
  }

  async function disconnect(): Promise<void> {
    busy.value = true
    error.value = null
    try {
      await disconnectRequest()
      status.value = { connected: false }
      lastError.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Could not disconnect.'
    } finally {
      busy.value = false
    }
  }

  function noteCallbackError(code: string): void {
    lastError.value = code
  }

  return {
    status,
    loading,
    busy,
    error,
    lastError,
    isConnected,
    needsReconnect,
    label,
    refresh,
    connect,
    disconnect,
    noteCallbackError,
  }
})
