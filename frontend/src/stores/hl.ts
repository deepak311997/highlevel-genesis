import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { ApiError } from '@/lib/api'
import {
  disconnect as disconnectRequest,
  getConnection,
  startConnect,
  type ConnectionStatus,
} from '@/lib/hlApi'
import { hlProxy, type HlMethod } from '@/lib/hlProxyApi'

/**
 * The HighLevel connection, as far as the browser can see it.
 *
 * Deliberately not a Firestore subscription. The connection document holds
 * tokens and is denied to every client, so this state comes from an endpoint —
 * which means it is a snapshot, refreshed on demand, rather than something that
 * updates itself.
 */

/** Every outcome the OAuth callback can hand back. */
export type CallbackErrorCode =
  'denied' | 'invalid_state' | 'exchange_failed' | 'wrong_account_type'

/**
 * What one HighLevel surface answered.
 *
 * `count: null` is not an error — it is "the response did not carry a number we
 * recognise", which renders as an em dash. A surface that genuinely holds
 * nothing answers `0`, and that is an honest empty state rather than a failure
 * (AC-41, AC-45).
 */
export interface SurfaceProbe {
  count: number | null
  error: string | null
  /** This surface failed in a way only reconnecting fixes (P11). */
  reconnect: boolean
}

export interface ProbeResult {
  contacts: SurfaceProbe
  conversations: SurfaceProbe
  calendars: SurfaceProbe
}

export type ProbeState = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Narrowed by hand, defensively (D32).
 *
 * `total` is HighLevel's field and this slice forwards their body verbatim, so
 * a shape change upstream has to render as "—" rather than as `NaN` in a panel
 * nobody can debug from. Zod on the frontend's own API responses is Slice 12's
 * cross-cutting pass; doing it for this one client alone would leave two
 * conventions in the codebase.
 */
function totalOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const { total } = body as { total?: unknown }
  return typeof total === 'number' && Number.isFinite(total) ? total : null
}

function calendarCountOf(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const { calendars } = body as { calendars?: unknown }
  return Array.isArray(calendars) ? calendars.length : null
}

/**
 * The three probe calls (D31): one per surface, the smallest payload each will
 * return, and no parameter beyond the injected `locationId`.
 *
 * Deliberately not `GET /calendars/events`, which needs a calendar id and a
 * time window in epoch milliseconds — its failure would be ambiguous between
 * "no access" and "no events this fortnight", which is the one thing this
 * section exists to answer unambiguously.
 *
 * A row rather than three near-copies, so adding a fourth surface is a line.
 */
const SURFACES = [
  {
    key: 'contacts',
    method: 'POST',
    path: '/contacts/search',
    payload: { pageLimit: 1 },
    read: totalOf,
  },
  {
    key: 'conversations',
    method: 'GET',
    path: '/conversations/search',
    payload: { limit: 1 },
    read: totalOf,
  },
  { key: 'calendars', method: 'GET', path: '/calendars/', read: calendarCountOf },
] as const satisfies readonly {
  key: keyof ProbeResult
  method: HlMethod
  path: string
  payload?: Record<string, unknown>
  read: (body: unknown) => number | null
}[]

/** HTTP 409 is the PRD's only "reconnect" status, with two codes behind it. */
const RECONNECT_STATUS = 409

/**
 * The message, plus upstream's own words about the request when they add
 * something.
 *
 * `ApiError.detail` is HighLevel's own text, passed through by the proxy, and
 * this is its reader: on the one screen whose purpose is diagnosing a HighLevel
 * call, "Could not read contacts." is a shrug and
 * "Could not read contacts. (Invalid JWT)" is a fix.
 *
 * Absent, empty, or merely repeating the message earns no parentheses — the
 * alternative renders "Could not read contacts. ()" or the same sentence twice,
 * both of which read as a bug rather than as a diagnosis.
 */
export function withDetail(message: string, detail: string | undefined): string {
  if (detail === undefined || detail === '' || detail === message) return message
  return `${message} (${detail})`
}

/** The sentence a failed surface shows, in order of how much we know. */
function messageFor(err: unknown): string {
  if (err instanceof ApiError) return withDetail(err.message, err.detail)
  if (err instanceof Error) return err.message
  return 'Could not reach HighLevel.'
}

function failureFor(err: unknown): SurfaceProbe {
  return {
    count: null,
    error: messageFor(err),
    reconnect: err instanceof ApiError && err.status === RECONNECT_STATUS,
  }
}

export interface HlStore {
  status: Ref<ConnectionStatus | null>
  loading: Ref<boolean>
  busy: Ref<boolean>
  error: Ref<string | null>
  lastError: Ref<string | null>
  isConnected: ComputedRef<boolean>
  needsReconnect: ComputedRef<boolean>
  label: ComputedRef<string | null>
  probe: Ref<ProbeState>
  probeResult: Ref<ProbeResult | null>
  refresh: () => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  checkDataAccess: () => Promise<void>
  noteCallbackError: (code: string) => void
  /** Forget everything fetched for the session that just ended. */
  reset: () => void
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
  /**
   * On demand, never on mount (D30). Three HighLevel calls on every dashboard
   * visit spends a rate-limit budget (§5) to answer a question nobody asked.
   */
  const probe = ref<ProbeState>('idle')
  const probeResult = ref<ProbeResult | null>(null)

  /**
   * Which session a request belongs to.
   *
   * **Every write that lands after an `await` is guarded by this.** Signing out
   * is a route change rather than a page load, so this store outlives the
   * session — `reset()` exists for exactly that reason — and a request still in
   * flight when the session ends resolves against the *next* person's screen.
   * For the probe that is not merely stale, it is the previous account's CRM
   * counts rendered under someone else's connection, with `probe` left at
   * `ready` so nothing ever clears them: the new user never ran a probe, so
   * nothing overwrites the old one's.
   *
   * A counter rather than a comparison against the uid, and not a `ref`:
   * nothing renders it, and making it reactive would invalidate every computed
   * that reads this store for no gain. `workspace.ts` carries the same
   * mechanism for the same reason.
   */
  let generation = 0

  function current(gen: number): boolean {
    return gen === generation
  }

  const isConnected = computed(() => status.value?.connected === true)
  // Narrowed rather than optional-chained: `needsReconnect` exists only on a
  // connected status, and the union is what makes that a compile error instead
  // of a silent `undefined`.
  const needsReconnect = computed(
    () => status.value?.connected === true && status.value.needsReconnect,
  )

  /**
   * What to call the connected location.
   *
   * Falls back to the id, which is what happens when `locations.readonly` is
   * absent or the lookup failed — a working connection with a worse label, not
   * a broken one.
   */
  const label = computed(() => {
    const current = status.value
    if (current?.connected !== true) return null
    // No `?? null` tail: the union guarantees a connected status has a
    // locationId, so there is no third case to invent a value for.
    return current.locationName ?? current.locationId
  })

  async function refresh(): Promise<void> {
    const gen = generation
    if (status.value === null) loading.value = true
    error.value = null
    try {
      const next = await getConnection()
      if (current(gen)) status.value = next
    } catch (err) {
      if (current(gen)) {
        error.value = err instanceof Error ? err.message : 'Could not load the connection status.'
      }
    } finally {
      if (current(gen)) loading.value = false
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

  /**
   * Can this user's token actually read their CRM?
   *
   * `allSettled`, not `all`: three surfaces are three independent outcomes, and
   * `all` would throw away two working counts because a third failed. The
   * section is only in an *error* state when every one of them failed — one
   * failure is a row-level outcome, which is the PRD's "one failure does not
   * blank the others".
   */
  async function checkDataAccess(): Promise<void> {
    const gen = generation
    probe.value = 'loading'
    probeResult.value = null

    const settled = await Promise.allSettled(
      SURFACES.map((surface) =>
        'payload' in surface
          ? hlProxy(surface.method, surface.path, surface.payload)
          : hlProxy(surface.method, surface.path),
      ),
    )

    const rows = SURFACES.map((surface, index) => {
      const outcome = settled[index]
      if (outcome === undefined || outcome.status === 'rejected') {
        return [surface.key, failureFor(outcome?.reason)] as const
      }
      return [
        surface.key,
        { count: surface.read(outcome.value), error: null, reconnect: false },
      ] as const
    })

    // The session that asked for this may have ended while it was in flight,
    // and these two lines are the ones that would show its data to whoever
    // signed in next.
    if (!current(gen)) return

    probeResult.value = Object.fromEntries(rows) as unknown as ProbeResult
    probe.value = rows.every(([, row]) => row.error !== null) ? 'error' : 'ready'
  }

  function noteCallbackError(code: string): void {
    lastError.value = code
  }

  /**
   * A connection belongs to one account, and signing out is a route change
   * rather than a page load — so without this the next person to sign in on the
   * same browser sees the last one's CRM location named in the panel until their
   * own refresh lands. `status` matters as much as the rest: left non-null, it
   * suppresses the loading state that would otherwise hide the stale value.
   *
   * Clearing the refs is only half of it: a request already in flight would
   * refill them a moment later. Bumping `generation` is the other half.
   */
  function reset(): void {
    generation += 1
    status.value = null
    loading.value = false
    busy.value = false
    error.value = null
    lastError.value = null
    probe.value = 'idle'
    probeResult.value = null
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
    probe,
    probeResult,
    refresh,
    connect,
    disconnect,
    checkDataAccess,
    noteCallbackError,
    reset,
  }
})
