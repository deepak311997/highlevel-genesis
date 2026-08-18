import { reactive } from 'vue'

/**
 * What the editor shows while a reply is writing — one document per path.
 *
 * The server sends four verbs as one shape: *this file, these lines, this text*.
 * A whole-file write is the degenerate case where the lines are the whole file.
 * So there is one model here and one composition rule — `prefix + body + suffix` —
 * and the only thing that varies between a creation, a rewrite and a located
 * change is what the prefix and suffix are.
 *
 * **A class over a reactive `Map`, deliberately.** The state has invariants across
 * four fields and one owner, which is what a class is for; the `Map` is reactive so
 * a chunk mutates one path's document rather than replacing a record and
 * invalidating every computed reading any other path.
 */

/** How a path is being written, which is also what its tree row says. */
export type StreamMode = 'creating' | 'rewriting' | 'editing'

/** The file either side of the change. A whole-file write has neither. */
export interface DocumentBase {
  prefix: string
  suffix: string
}

interface StreamingDocument {
  mode: StreamMode
  prefix: string
  suffix: string
  /** Everything that has arrived for this change so far. */
  body: string
  /**
   * True while the surrounding file has not arrived — the browser did not hold it
   * and went to fetch it. Chunks still accumulate; they simply have nothing to sit
   * between yet.
   */
  awaitingBase: boolean
}

/**
 * Split a file at a 1-based line range, `to` exclusive.
 *
 * `from === to` is an insertion, and gives back the whole file in two halves.
 */
export function splitAtRange(content: string, from: number, to: number): DocumentBase {
  const lines = content.split('\n')
  const before = lines.slice(0, Math.max(0, from - 1))
  const after = lines.slice(Math.max(0, to - 1))

  return {
    prefix: before.length > 0 ? `${before.join('\n')}\n` : '',
    suffix: after.join('\n'),
  }
}

export class StreamingDocuments {
  private readonly docs = reactive(new Map<string, StreamingDocument>())

  /** A whole file arriving: everything that comes is the file. */
  beginFile(path: string, mode: 'create' | 'rewrite'): void {
    this.docs.set(path, {
      mode: mode === 'create' ? 'creating' : 'rewriting',
      prefix: '',
      suffix: '',
      body: '',
      awaitingBase: false,
    })
  }

  /**
   * A located change. `base` is `null` when the browser does not hold the file —
   * the chunks still accumulate and {@link rebase} puts them in place later.
   */
  beginEdit(path: string, base: DocumentBase | null): void {
    this.docs.set(path, {
      mode: 'editing',
      prefix: base?.prefix ?? '',
      suffix: base?.suffix ?? '',
      body: '',
      awaitingBase: base === null,
    })
  }

  /** The file arrived after the change started. Ignored if it is no longer wanted. */
  rebase(path: string, base: DocumentBase): void {
    const doc = this.docs.get(path)
    if (doc?.awaitingBase !== true) return
    doc.prefix = base.prefix
    doc.suffix = base.suffix
    doc.awaitingBase = false
  }

  /** One chunk of new text. Silently dropped for a path nothing opened. */
  push(path: string, text: string): void {
    const doc = this.docs.get(path)
    if (doc === undefined) return
    doc.body += text
  }

  /** The document as it stands, or `undefined` if this path is not being written. */
  content(path: string): string | undefined {
    const doc = this.docs.get(path)
    return doc === undefined ? undefined : doc.prefix + doc.body + doc.suffix
  }

  /** Whether this path's surrounding file is still on its way. */
  awaitingBase(path: string): boolean {
    return this.docs.get(path)?.awaitingBase ?? false
  }

  /** Every path being written, and how — what the file tree marks its rows with. */
  states(): Record<string, StreamMode> {
    return Object.fromEntries([...this.docs].map(([path, doc]) => [path, doc.mode]))
  }

  paths(): string[] {
    return [...this.docs.keys()]
  }

  /** Between turns. What streamed was never the stored bytes. */
  clear(): void {
    this.docs.clear()
  }
}
