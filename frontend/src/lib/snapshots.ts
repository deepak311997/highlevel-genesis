import { formatBytes } from './files'
import type { SnapshotOrigin } from './snapshotsApi'

/**
 * How a version is worded (AC-29's label half).
 *
 * Pure, and outside the sheet, for `lib/files.ts`'s reason: each of these is a
 * *decision* the product has made — that a version is named by its stored `seq`
 * and never by its position in the list (D5), that the safety copy taken before
 * a restore is named by what it holds rather than by what overwrote it (D9),
 * that one file is not "1 files". Decisions with tests can be argued with; the
 * same strings interpolated into a template get re-derived slightly differently
 * every time a second screen needs them.
 */

/**
 * The version number is the stored `seq`, not the row's index.
 *
 * The prune drops the oldest version once the limit is reached (D5), and
 * numbering by position would renumber every remaining row when it does — the
 * version a user was reading about a moment ago would quietly become a
 * different one. `seq` is allocated once on the server and never reused.
 */
export function versionLabel(seq: number): string {
  return `Version ${String(seq)}`
}

/**
 * What made this version — **exhaustive over `SnapshotOrigin` by construction.**
 *
 * A `switch` with no `default`, so a third origin added to the API type is a
 * compile error here rather than a blank cell on screen. The `restore` wording
 * is deliberate: that snapshot is the tree as it stood *before* a restore
 * overwrote it (D9), so "Restore" would name the event that followed rather
 * than the content it holds — and the whole value of the row is that it is the
 * way back from that event.
 */
export function originLabel(origin: SnapshotOrigin): string {
  switch (origin) {
    case 'generation':
      return 'Generation'
    case 'restore':
      return 'Before restore'
  }
}

/**
 * The one line under a version's name: how much of the project it holds.
 *
 * The singular is the only reason this is a function rather than a template
 * expression — a first generation that writes `index.html` alone is the common
 * case, and "1 files" in the very first row of the very first history sheet is
 * the kind of detail that makes the rest of a screen look unfinished.
 *
 * The size half delegates to {@link formatBytes} rather than restating it, so
 * the sheet cannot drift into a different unit from the editor's byte counter
 * or the server's refusal copy (P7).
 */
export function snapshotSubtitle(fileCount: number, totalBytes: number): string {
  const files = `${String(fileCount)} ${fileCount === 1 ? 'file' : 'files'}`
  return `${files} · ${formatBytes(totalBytes)}`
}
