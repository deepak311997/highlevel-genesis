import type { FileMeta } from './filesApi'
import type { StreamMode } from './streamingDocuments'

/**
 * The file tree's decisions, made once and here.
 *
 * The components only reflect what the store says, so the sort, the merge, the
 * byte count and the way a byte count is *said* live in a pure module with their
 * own tests rather than inside a `computed` or a template.
 */

/** One row of the tree: a filename, and what this turn is doing to it. */
export interface FileRow {
  path: string
  /**
   * What the reply is doing to this file right now, or `idle`.
   *
   * Three words rather than a boolean, because the three mean different things to
   * a reader watching: a file appearing, a file being replaced, and a file being
   * changed in place.
   */
  state: 'idle' | StreamMode
}

/** The generated app's entry point — the file a reader opens first. */
const ENTRY_POINT = 'index.html'

/**
 * `index.html` first, everything else alphabetical. The entry point is where you
 * start reading an app; alphabetical after it, because every other order available
 * reorders the list between generations for reasons invisible on screen.
 *
 * A plain `<` rather than `localeCompare`: filenames are a known ASCII subset, and
 * a locale-sensitive comparison would make the order depend on the browser's.
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
 * still appear; one being changed is in both and must appear once, marked. The
 * union is over paths rather than documents because a streaming path may have no
 * document to take.
 */
export function mergeFileTree(
  stored: FileMeta[],
  streaming: Record<string, StreamMode>,
): FileRow[] {
  const paths = new Set([...stored.map((file) => file.path), ...Object.keys(streaming)])

  return [...paths]
    .sort(compareFilePaths)
    .map((path) => ({ path, state: streaming[path] ?? 'idle' }))
}

/**
 * What a file *is*, which is the only hierarchy a flat namespace has.
 *
 * `filePathSchema` refuses slashes outright, so a generated project has no
 * directories for the panel to draw — every path is a bare filename. The kind is
 * what is left to group by, and it is a real grouping rather than an invented
 * one: markup, styles, scripts, data, notes.
 *
 * `other` exists for the same reason `PLAINTEXT` does in `editorLanguage.ts`: an
 * extension the allowlist does not know still has to render, as a row with a
 * generic icon rather than as a throw.
 */
export type FileKind = 'markup' | 'style' | 'script' | 'data' | 'doc' | 'other'

/**
 * Extension → kind, over the server's `FILE_EXTENSIONS` allowlist.
 *
 * The same table shape as `EDITOR_LANGUAGES`, and for the same reason: one map
 * with its own test, rather than a `v-if` chain repeated in every surface that
 * renders a filename.
 */
const KIND_BY_EXTENSION = {
  html: 'markup',
  css: 'style',
  js: 'script',
  json: 'data',
  md: 'doc',
} as const satisfies Record<string, FileKind>

/**
 * The kinds in the order the tree shows them, with the words it shows.
 *
 * Markup leads for `compareFilePaths`' reason — `index.html` is where a reader
 * starts, and a grouping that buried the entry point under an alphabetised kind
 * would undo the one ordering decision this module has already made. `other`
 * last, because it is the bucket for things nothing else claimed.
 */
const KIND_ORDER = [
  { kind: 'markup', label: 'Markup' },
  { kind: 'style', label: 'Styles' },
  { kind: 'script', label: 'Scripts' },
  { kind: 'data', label: 'Data' },
  { kind: 'doc', label: 'Notes' },
  { kind: 'other', label: 'Other' },
] as const satisfies readonly { kind: FileKind; label: string }[]

/** One kind's rows, as the tree renders them — never empty. */
export interface FileGroup {
  kind: FileKind
  /** The section heading, decided here so two surfaces cannot word it differently. */
  label: string
  rows: FileRow[]
}

/**
 * A path's kind, by its last extension.
 *
 * Lower-cased because case is not part of an extension, and read through a
 * bracket with a `??` — which `noUncheckedIndexedAccess` requires anyway, and
 * which is the same expression that makes the miss land on `other`.
 */
export function fileKind(path: string): FileKind {
  const dot = path.lastIndexOf('.')
  if (dot <= 0) return 'other'

  const extension = path.slice(dot + 1).toLowerCase()
  return (KIND_BY_EXTENSION as Record<string, FileKind>)[extension] ?? 'other'
}

/**
 * The tree, in sections — the flat list `mergeFileTree` returns, grouped.
 *
 * The row order inside a group is the one it arrived in, so `compareFilePaths`
 * stays the single authority on ordering and this only decides where the
 * partitions fall. Empty kinds are dropped: a heading over nothing tells a
 * project with no JSON that it has a Data section.
 */
export function groupFileTree(rows: FileRow[]): FileGroup[] {
  return KIND_ORDER.map(({ kind, label }): FileGroup => ({
    kind,
    label,
    rows: rows.filter((row) => fileKind(row.path) === kind),
  })).filter((group) => group.rows.length > 0)
}
/*
 * One encoder for the module: `utf8Bytes` is called on every keystroke in the
 * editor, and a fresh `TextEncoder` per call is an allocation per character typed.
 */
const encoder = new TextEncoder()

/**
 * The content's length **in bytes**, which is the unit the cap is in.
 *
 * `String.length` counts UTF-16 code units, so 60,000 three-byte characters would
 * look like 60,000 against a cap of 100,000 and be refused by the server at
 * 180,000 — a Save button that enables itself for a request that cannot succeed.
 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

/**
 * A byte count, as a screen says it — **decimal KB, matching the server**.
 *
 * The server renders the cap as `FILE_BYTES_MAX / 1000`, so binary KiB here would
 * call a file "98 KB" while the server called the limit "100 KB", with nothing on
 * screen to explain which number to believe.
 *
 * The `Math.max` states the invariant rather than leaving it to the boundary above:
 * a rounding that fell below 1 would render "0 KB" for a file that is not empty.
 * Bytes below the threshold, because a 512-byte file is more usefully 512 bytes.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} bytes`
  return `${String(Math.max(1, Math.round(bytes / 1000)))} KB`
}
