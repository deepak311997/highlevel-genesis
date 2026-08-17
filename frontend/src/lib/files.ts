import type { FileMeta } from './filesApi'

/**
 * The file tree's decisions, made once and here.
 *
 * The store is one store (D24) and the components only reflect what it says, so
 * the sort, the merge, the byte count and the way a byte count is *said* live in
 * a pure module with their own tests rather than inside a `computed` or a
 * template. A rule that is testable in isolation is a rule that can be argued
 * with; the same rule spread across a `.vue` file is one that gets re-derived
 * slightly differently the next time.
 */

/** One row of the tree: a filename, and whether this turn is still writing it. */
export interface FileRow {
  path: string
  /** True while a `file_start` has arrived for this path and no `file_end` has. */
  writing: boolean
}

/** The generated app's entry point (D1) — the file a reader opens first. */
const ENTRY_POINT = 'index.html'

/**
 * `index.html` first, everything else alphabetical.
 *
 * The entry point is where you start reading an app, so it is where the eye
 * should land. Alphabetical after it because every other order available — size,
 * creation time, the order the model happened to emit — reorders the list between
 * generations for reasons that are invisible on screen.
 *
 * A plain `<` rather than `localeCompare`: filenames here are a known ASCII
 * subset (`filePathSchema` on the server), and a locale-sensitive comparison
 * would make the order depend on the browser's locale for no gain.
 */
export function compareFilePaths(a: string, b: string): number {
  if (a === b) return 0
  if (a === ENTRY_POINT) return -1
  if (b === ENTRY_POINT) return 1
  return a < b ? -1 : 1
}

/**
 * The tree the user sees: what is stored, plus what is arriving, as one list.
 *
 * A file being written for the first time has no stored document yet and must
 * still appear — that is the whole of "the tree fills in as the reply streams".
 * A file being *rewritten* is in both lists and must appear once, marked, or the
 * panel would show two rows for one file for the length of the generation.
 *
 * The union is taken over paths rather than over documents because a streaming
 * path has no document to take: `size` and the timestamps are the server's, and
 * they arrive at the refetch `done` triggers (D20).
 */
export function mergeFileTree(stored: FileMeta[], streaming: string[]): FileRow[] {
  const writing = new Set(streaming)
  const paths = new Set([...stored.map((file) => file.path), ...streaming])

  return [...paths].sort(compareFilePaths).map((path) => ({ path, writing: writing.has(path) }))
}

/*
 * One encoder for the module. `utf8Bytes` is called on every keystroke in the
 * editor, and a fresh `TextEncoder` per call is an allocation per character
 * typed for an object that holds no state.
 */
const encoder = new TextEncoder()

/**
 * The content's length **in bytes**, which is the unit the cap is in.
 *
 * `String.length` counts UTF-16 code units, so 60,000 three-byte characters
 * would look like 60,000 against a cap of 100,000 and be refused by the server
 * at 180,000 — a Save button that enables itself for a request that cannot
 * succeed. The server counts with `Buffer.byteLength`; this is the same number.
 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

/**
 * A byte count, as a screen says it — **decimal KB, matching the server** (P7).
 *
 * The unit is the one this codebase already speaks: `fileErrorCopy` renders the
 * cap as `FILE_BYTES_MAX / 1000`, so 100,000 bytes is "100 KB" in the refusal a
 * user reads when a save is rejected. Binary KiB here would call the same file
 * "98 KB" while the server called the limit "100 KB", and nothing on screen
 * would explain which number to believe.
 *
 * The `Math.max` is not decoration. `Math.round(1000 / 1000)` is 1, but
 * `Math.round(1200 / 1000)` is 1 and `Math.round(1400 / 1000)` is 1 while
 * anything the round sends below 1 — it cannot here, since the branch starts at
 * 1000, but it could the moment the threshold moves — would render as "0 KB"
 * for a file that plainly is not empty. The floor states the invariant rather
 * than leaving it to the boundary two lines above.
 *
 * Bytes below the threshold, because a 512-byte file is more usefully 512 bytes
 * than "1 KB". Counted in the same unit as {@link utf8Bytes}: both are UTF-8
 * bytes, which is what Firestore's limit and the server's `Buffer.byteLength`
 * count too.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} bytes`
  return `${String(Math.max(1, Math.round(bytes / 1000)))} KB`
}
