import { describe, expect, it } from 'vitest'

import { originLabel, snapshotSubtitle, versionLabel } from './snapshots'
import type { SnapshotOrigin } from './snapshotsApi'

/**
 * The words a version is rendered with (AC-29's label half).
 *
 * The sheet is the only screen that shows a snapshot, so it would be cheap to
 * write these three strings into its template. They live here instead for the
 * reason `lib/files.ts` exists: a label is a *decision* — that `seq` is what a
 * user calls a version, that `restore` is worth naming "Before restore" rather
 * than "Restore", that one file is not "1 files" — and a decision that has its
 * own test is one that can be argued with. The same string interpolated in a
 * `.vue` file is one that gets re-derived slightly differently next time.
 */

describe('versionLabel', () => {
  /**
   * The number the user sees is the stored `seq`, not the row's position.
   *
   * Position renumbers every remaining row the moment the prune drops the
   * oldest version (D5), so the version a user was looking at a minute ago
   * would silently become a different one.
   */
  it('names the version by its sequence number', () => {
    expect(versionLabel(1)).toBe('Version 1')
    expect(versionLabel(12)).toBe('Version 12')
  })
})

describe('originLabel', () => {
  /**
   * Two origins, two different things to say.
   *
   * A `generation` snapshot is the tree as some generation left it. A `restore`
   * snapshot is the safety copy taken *before* a restore overwrote the tree
   * (D9) — "Restore" would name what happened next rather than what the version
   * holds, and the whole point of that row is that it is the way back.
   */
  it('names a generation snapshot', () => {
    expect(originLabel('generation')).toBe('Generation')
  })

  it('names a safety snapshot by what it holds, not by what overwrote it', () => {
    expect(originLabel('restore')).toBe('Before restore')
  })

  /* Exhaustive over the union: a third origin has to be a type error here. */
  it('has a label for every origin the API can return', () => {
    const origins: SnapshotOrigin[] = ['generation', 'restore']

    for (const origin of origins) expect(originLabel(origin)).not.toBe('')
  })
})

describe('snapshotSubtitle', () => {
  /* The two facts that distinguish one version from another at a glance. */
  it('reads as a file count and a size', () => {
    expect(snapshotSubtitle(3, 11_240)).toBe('3 files · 11 KB')
  })

  /** One file is not "1 files" — the singular is the whole reason this is a function. */
  it('uses the singular for a single file', () => {
    expect(snapshotSubtitle(1, 512)).toBe('1 file · 512 bytes')
  })

  /* A snapshot of nothing cannot be taken, but the plural still has to hold. */
  it('uses the plural for none', () => {
    expect(snapshotSubtitle(0, 0)).toBe('0 files · 0 bytes')
  })

  /* The size half is `formatBytes` and not a second implementation of it. */
  it('formats the size in the same decimal KB the rest of the app uses', () => {
    expect(snapshotSubtitle(2, 1000)).toBe('2 files · 1 KB')
  })
})
