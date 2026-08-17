/**
 * A message, split into the prose you read and the files it wrote (D29).
 *
 * The transcript stores marker lines — `[file: index.html]` — where a file went,
 * never the code itself (D6): the code lives in its own document and the bubble
 * says which files a turn produced. Rendered raw, those markers read like a build
 * log with a bug in it; rendered as chips, they read like what they are.
 *
 * This is a splitter, **not a markdown renderer**. D6 and D29 both refuse one: the
 * reply's prose is prose, and a renderer would be a second parser over content the
 * model controls, with an injection surface, for a formatting nicety.
 *
 * The persisted bubble and the streaming placeholder are the same string (D7), so
 * they use this same function — which is why it has to behave sensibly on a
 * message cut off mid-marker.
 */

export type MessagePart = { kind: 'text'; text: string } | { kind: 'file'; path: string }

/**
 * The whole line, or nothing.
 *
 * The same line-start rule the server's splitter uses, for the same reason: a
 * loose match would turn a sentence that merely mentions the marker into a chip
 * for a file that is not there. Leading and trailing spaces are tolerated —
 * the server emits none, but showing a user a raw marker because of one is a
 * worse failure than accepting it.
 */
const MARKER_LINE = /^[ \t]*\[file: ([^\]\n]+)\][ \t]*$/

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
    const path = match[1]
    if (path !== undefined) parts.push({ kind: 'file', path })
  }
  flush()

  return parts
}
