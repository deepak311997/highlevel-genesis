/**
 * A message, split into the prose you read and the files it wrote (D29).
 *
 * The transcript stores marker lines where a change went, never the code itself:
 * the code lives in its own document and the bubble says which files a turn
 * touched. `[file: …]` is a file written whole, `[edit: …]` one changed in place,
 * and `[error: …]` is why a turn's files were refused — in the transcript rather
 * than in a banner, so it survives a reload and reaches the next turn.
 *
 * This is a splitter, **not a markdown renderer**. D6 and D29 both refuse one: the
 * reply's prose is prose, and a renderer would be a second parser over content the
 * model controls, with an injection surface, for a formatting nicety.
 *
 * The persisted bubble and the streaming placeholder are the same string (D7), so
 * they use this same function — which is why it has to behave sensibly on a
 * message cut off mid-marker.
 */

export type MessagePart =
  | { kind: 'text'; text: string }
  /** A file the turn wrote whole. */
  | { kind: 'file'; path: string }
  /** A file the turn changed in place. */
  | { kind: 'edit'; path: string }
  /** Why the turn's files were refused, written into the transcript so it lasts. */
  | { kind: 'error'; text: string }

/**
 * The whole line, or nothing.
 *
 * The same line-start rule the server's splitter uses, for the same reason: a
 * loose match would turn a sentence that merely mentions the marker into a chip
 * for a file that is not there. Leading and trailing spaces are tolerated —
 * the server emits none, but showing a user a raw marker because of one is a
 * worse failure than accepting it.
 */
const MARKER_LINE = /^[ \t]*\[(file|edit|error): ([^\]\n]+)\][ \t]*$/

/** The marker kinds, and what each one becomes. */
const MARKER_KINDS = { file: 'file', edit: 'edit', error: 'error' } as const

export function splitMessageContent(content: string): MessagePart[] {
  const parts: MessagePart[] = []
  let pending: string[] = []

  /*
   * Trimmed, and dropped when it is empty. The blank line the server puts either
   * side of a marker run belongs to the marker's spacing, not to the prose — kept
   * as a text part it would render as a gap under every chip.
   */
  function flush(): void {
    const text = pending.join('\n').trim()
    if (text !== '') parts.push({ kind: 'text', text })
    pending = []
  }

  for (const line of content.split('\n')) {
    const match = MARKER_LINE.exec(line)
    if (match === null) {
      pending.push(line)
      continue
    }
    flush()
    // The regex cannot match without capturing, but `noUncheckedIndexedAccess`
    // does not know that — checked rather than asserted past.
    const label = match[1]
    const value = match[2]
    if (label === undefined || value === undefined) continue
    const kind = MARKER_KINDS[label as keyof typeof MARKER_KINDS]
    parts.push(kind === 'error' ? { kind, text: value } : { kind, path: value })
  }
  flush()

  return parts
}
