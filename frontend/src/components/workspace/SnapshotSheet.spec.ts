import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { toast } from 'vue-sonner'

import type { Snapshot } from '@/lib/snapshotsApi'

/**
 * Version history — the sheet.
 *
 * The store is stubbed rather than instantiated, `EditorPanel.spec.ts`'s shape: plain reactive
 * values, not refs, because Pinia auto-unwraps refs on the store object and a component
 * therefore reads `workspace.generating` as a boolean. Mocking it as `{ value: false }` would
 * make every guard truthy.
 */
const store = reactive({
  snapshots: [] as Snapshot[],
  snapshotsLoading: false,
  snapshotsLoaded: false,
  snapshotsError: null as string | null,
  restoringId: null as string | null,
  restoreError: null as string | null,
  generating: false,
  loadSnapshots: vi.fn(),
  restoreSnapshot: vi.fn(),
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

/**
 * The toast region is mounted once at the app root, so the notice never renders
 * inside this component's tree — what is asserted here is the call, which is the
 * whole of the sheet's part in it. The bare `toast` is a function *and* the
 * namespace its variants hang off, so the double is both.
 */
vi.mock('vue-sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

const SnapshotSheet = (await import('./SnapshotSheet.vue')).default

const snapshot = (seq: number, over: Partial<Snapshot> = {}): Snapshot => ({
  id: `snap-${String(seq)}`,
  seq,
  createdAt: '2026-08-18T09:30:00.000Z',
  origin: 'generation',
  fileCount: 3,
  totalBytes: 11_240,
  ...over,
})

function all(testid: string): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll(`[data-testid="${testid}"]`)].map(
    (element) => new DOMWrapper(element),
  )
}

function el(testid: string): DOMWrapper<Element> | null {
  return all(testid)[0] ?? null
}

function must(testid: string): DOMWrapper<Element> {
  const found = el(testid)
  if (found === null) throw new Error(`no element with data-testid="${testid}"`)
  return found
}

/** The row for one snapshot id, so a per-row assertion cannot read another row's. */
function row(id: string): DOMWrapper<Element> {
  const found = all('snapshot-row').find((element) => element.attributes('data-id') === id)
  if (found === undefined) throw new Error(`no row for snapshot ${id}`)
  return found
}

function within(scope: DOMWrapper<Element>, testid: string): DOMWrapper<Element> | null {
  const found = scope.element.querySelector(`[data-testid="${testid}"]`)
  return found === null ? null : new DOMWrapper(found)
}

function mountSheet(): VueWrapper<InstanceType<typeof SnapshotSheet>> {
  return mount(SnapshotSheet, { attachTo: document.body })
}

async function open(): Promise<VueWrapper<InstanceType<typeof SnapshotSheet>>> {
  const wrapper = mountSheet()
  await wrapper.find('[data-testid="snapshot-trigger"]').trigger('click')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  store.snapshots = []
  store.snapshotsLoading = false
  store.snapshotsLoaded = false
  store.snapshotsError = null
  store.restoringId = null
  store.restoreError = null
  store.generating = false
  vi.clearAllMocks()
  store.loadSnapshots.mockResolvedValue(undefined)
  store.restoreSnapshot.mockResolvedValue('restored')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the trigger', () => {
  /** AC-29 — the sheet is opened from the code panel, and it does not fetch until it is. */
  it('renders a History trigger', () => {
    const wrapper = mountSheet()

    expect(wrapper.find('[data-testid="snapshot-trigger"]').text()).toContain('History')
  })

  it('issues no snapshot request while it is closed', async () => {
    mountSheet()
    await flushPromises()

    expect(store.loadSnapshots).not.toHaveBeenCalled()
    expect(el('snapshot-sheet')).toBeNull()
  })

  it('loads the list when it is opened', async () => {
    await open()

    expect(must('snapshot-sheet').exists()).toBe(true)
    expect(store.loadSnapshots).toHaveBeenCalledTimes(1)
  })
})

describe('the four states', () => {
  /* In flight, or not started: `snapshotsLoading` alone cannot say the second. */
  it('renders the loading state while the list is in flight', async () => {
    store.snapshotsLoading = true
    await open()

    expect(must('snapshot-loading').exists()).toBe(true)
    expect(el('snapshot-empty')).toBeNull()
  })

  /*
   * AC-2. The two row placeholders are the shared `Skeleton`, not hand-rolled
   * pulsing divs — the testid still resolves to the same element, and what
   * it holds carries the primitive's slot attribute.
   */
  it('renders Skeleton placeholders while loading', async () => {
    store.snapshotsLoading = true
    await open()

    const loading = must('snapshot-loading')
    expect(loading.findAll('[data-slot="skeleton"]')).toHaveLength(2)
  })

  it('renders the empty state once a request has answered with nothing', async () => {
    store.loadSnapshots.mockImplementation(() => {
      store.snapshotsLoaded = true
      return Promise.resolve()
    })
    await open()

    expect(must('snapshot-empty').text()).toContain('No versions yet.')
    expect(el('snapshot-loading')).toBeNull()
  })

  /**
   * The error branch is first, `FileTree.vue`'s rule and for its reason: a failed first request
   * leaves `snapshotsLoaded` false, so a loading branch ahead of it would render a skeleton that
   * never resolves and never show the failure at all.
   */
  it('renders the failure and a Try again that retries', async () => {
    store.snapshotsError = 'Could not load version history.'
    await open()

    expect(must('snapshot-error').text()).toContain('Could not load version history.')
    expect(el('snapshot-loading')).toBeNull()

    await must('snapshot-retry').trigger('click')

    expect(store.loadSnapshots).toHaveBeenCalledTimes(2)
  })

  /*
   * The store keeps the list when a refetch fails, and says why: an emptied history under a
   * Restore button claims "this project has no versions", which is a different thing from "we
   * could not reach the server".
   */
  it('keeps a loaded list on screen when a refetch fails', async () => {
    store.snapshots = [snapshot(1), snapshot(2)]
    store.snapshotsLoaded = true
    store.snapshotsError = 'Could not load version history.'
    await open()

    expect(must('snapshot-error').text()).toContain('Could not load version history.')
    expect(all('snapshot-row')).toHaveLength(2)
    expect(el('snapshot-empty')).toBeNull()
    expect(el('snapshot-loading')).toBeNull()
  })

  it('shows no list and no empty state when the first load fails', async () => {
    store.snapshotsError = 'Could not load version history.'
    await open()

    expect(must('snapshot-error').exists()).toBe(true)
    expect(all('snapshot-row')).toHaveLength(0)
    expect(el('snapshot-empty')).toBeNull()
    expect(el('snapshot-loading')).toBeNull()
  })

  /*
   * A failed restore is about one attempt on one visit. Left in the store it outlives the visit:
   * close the sheet, generate successfully, reopen — and the banner for the abandoned attempt is
   * still sitting above a list that is now correct.
   */
  it('drops a stale restore failure when the sheet is closed', async () => {
    store.snapshotsLoaded = true
    await open()

    // While it is open the banner is the only report the user gets, so it stays.
    store.restoreError = 'That version could not be restored. Try again.'
    await flushPromises()
    expect(must('snapshot-restore-error').exists()).toBe(true)

    // Closed the way a user closes it: the sheet's own X, which the vendored
    // `SheetContent` gives an `sr-only` label so it is nameable at all.
    const close = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Close'),
    )
    close?.click()
    await flushPromises()
    expect(el('snapshot-sheet')).toBeNull()

    expect(store.restoreError).toBeNull()
  })

  /**
   * AC-29's list half. The store is handed the versions in *ascending* order
   * here on purpose: the server returns them newest-first and the component
   * sorts anyway, so this is what pins the sort rather than the fixture.
   */
  it('renders a row per version, newest first', async () => {
    store.snapshots = [
      snapshot(1, { origin: 'generation', fileCount: 1, totalBytes: 512 }),
      snapshot(2, { origin: 'restore', createdAt: '2026-08-18T14:05:00.000Z' }),
      snapshot(3),
    ]
    store.snapshotsLoaded = true
    await open()

    const rows = all('snapshot-row')
    expect(rows.map((element) => element.attributes('data-id'))).toEqual([
      'snap-3',
      'snap-2',
      'snap-1',
    ])
  })

  it('shows each version’s number, origin, file count, size, date and time', async () => {
    store.snapshots = [
      snapshot(2, { origin: 'restore', createdAt: '2026-08-18T14:05:00.000Z' }),
      snapshot(1, { origin: 'generation', fileCount: 1, totalBytes: 512 }),
    ]
    store.snapshotsLoaded = true
    await open()

    const first = row('snap-2').text()
    expect(first).toContain('Version 2')
    expect(first).toContain('Before restore')
    expect(first).toContain('3 files · 11 KB')
    expect(first).toContain('18 Aug 2026')
    expect(first).toContain('14:05')

    const second = row('snap-1').text()
    expect(second).toContain('Version 1')
    expect(second).toContain('Generation')
    expect(second).toContain('1 file · 512 bytes')
  })
})

describe('restoring', () => {
  async function openWithTwo(): Promise<VueWrapper<InstanceType<typeof SnapshotSheet>>> {
    store.snapshots = [snapshot(2), snapshot(1)]
    store.snapshotsLoaded = true
    return open()
  }

  /** AC-30 — the confirm is two states of *one row*, not a dialog over the sheet. */
  it('turns the row into a confirm rather than opening a second overlay', async () => {
    await openWithTwo()

    await must('snapshot-restore').trigger('click')

    const confirming = row('snap-2')
    expect(within(confirming, 'snapshot-confirm')).not.toBeNull()
    expect(within(confirming, 'snapshot-cancel')).not.toBeNull()
    expect(within(confirming, 'snapshot-restore')).toBeNull()

    // The other row is untouched, and there is exactly one confirm on screen.
    expect(within(row('snap-1'), 'snapshot-restore')).not.toBeNull()
    expect(all('snapshot-confirm')).toHaveLength(1)
  })

  it('returns the row unchanged on Cancel, and issues nothing', async () => {
    await openWithTwo()

    await must('snapshot-restore').trigger('click')
    await must('snapshot-cancel').trigger('click')

    expect(within(row('snap-2'), 'snapshot-restore')).not.toBeNull()
    expect(el('snapshot-confirm')).toBeNull()
    expect(store.restoreSnapshot).not.toHaveBeenCalled()
  })

  it('restores the confirmed version, by id', async () => {
    await openWithTwo()

    await must('snapshot-restore').trigger('click')
    await must('snapshot-confirm').trigger('click')
    await flushPromises()

    expect(store.restoreSnapshot).toHaveBeenCalledWith('snap-2')
  })

  /**
   * One restore at a time, and the row says which. The guard is the store's
   * too (AC-26) — this is the half a user can see, so a second click has
   * nothing to aim at rather than being silently swallowed.
   */
  it('disables every Restore while one is in flight, and says which row', async () => {
    store.restoringId = 'snap-2'
    await openWithTwo()

    const buttons = all('snapshot-restore')
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button.attributes('disabled')).toBeDefined()

    expect(within(row('snap-2'), 'snapshot-restoring')).not.toBeNull()
    expect(within(row('snap-1'), 'snapshot-restoring')).toBeNull()
  })

  it('renders a failed restore inside the sheet', async () => {
    store.restoreError = 'That version could not be read.'
    await openWithTwo()

    expect(must('snapshot-sheet').text()).toContain('That version could not be read.')
    // The list is still there: the failure is about one attempt, not the history.
    expect(all('snapshot-row')).toHaveLength(2)
  })

  /**
   * AC-30's last clause. A generation is writing the very files a restore would overwrite, so
   * the button is off — **and the list still renders**, because "come back when this finishes"
   * is a different message from "there is no history", and a blanked sheet says the second.
   */
  it('disables every Restore during a generation, with the reason on screen', async () => {
    store.generating = true
    await openWithTwo()

    expect(all('snapshot-row')).toHaveLength(2)
    for (const button of all('snapshot-restore')) {
      expect(button.attributes('disabled')).toBeDefined()
    }
    expect(must('snapshot-generating').text()).not.toBe('')
  })
  /** AC-4 — a restore that worked says so, and **the sheet stays open**. */
  it('confirms a successful restore with a toast naming the version', async () => {
    store.restoreSnapshot.mockResolvedValue('restored')
    await openWithTwo()

    await must('snapshot-restore').trigger('click')
    await must('snapshot-confirm').trigger('click')
    await flushPromises()

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining('Version 2'))
    expect(el('snapshot-sheet')).not.toBeNull()
  })

  /** AC-5, E8 — the restore of the version the project already is. */
  it('says so when the restore changed nothing', async () => {
    store.restoreSnapshot.mockResolvedValue('unchanged')
    await openWithTwo()

    await must('snapshot-restore').trigger('click')
    await must('snapshot-confirm').trigger('click')
    await flushPromises()

    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining('Version 2'))
    expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining('Nothing changed'))
    expect(el('snapshot-restore-error')).toBeNull()
  })

  /** The seq is read from the row the user confirmed and never sent to the store. */
  it('still calls the store with the snapshot id alone', async () => {
    await openWithTwo()

    await must('snapshot-restore').trigger('click')
    await must('snapshot-confirm').trigger('click')
    await flushPromises()

    expect(store.restoreSnapshot).toHaveBeenCalledTimes(1)
    expect(store.restoreSnapshot).toHaveBeenCalledWith('snap-2')
  })
  /** AC-6, E9, D4 — a failure stays where it can be read. */
  it('renders a failed restore inline and toasts nothing', async () => {
    store.restoreSnapshot.mockImplementation(() => {
      store.restoreError = 'That version could not be restored. Try again.'
      return Promise.resolve('failed')
    })
    await openWithTwo()

    await must('snapshot-restore').trigger('click')
    await must('snapshot-confirm').trigger('click')
    await flushPromises()

    expect(must('snapshot-restore-error').text()).toContain('could not be restored')
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })
})
