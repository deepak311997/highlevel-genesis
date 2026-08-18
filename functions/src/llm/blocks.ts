import { PATH_MAX } from '../files/schema'

/**
 * The reply grammar — **syntax only**. Which paths are allowed, whether an anchor
 * matches and what a block means are all somebody else's problem.
 *
 * Five verbs over three shapes: one section (`file`, `append`), two sections split
 * by `<genesis:add>` (`after`, `before`), two split by `<genesis:with>` (`edit`).
 * Every delimiter owns a whole line, so the splitter works in complete lines and
 * holds back only the trailing partial one, and only while it could still become a
 * delimiter. That hold-back is what makes the split chunking-invariant: a tag
 * arriving across two SDK deltas has to read the same as one arriving whole.
 */

export const VERBS = ['file', 'append', 'after', 'before', 'edit'] as const

export type Verb = (typeof VERBS)[number]

/** Separates the anchor from the text to add. */
export const SEPARATOR_ADD = '<genesis:add>'

/** Separates the anchor from the text to replace it with. */
export const SEPARATOR_WITH = '<genesis:with>'

const SEPARATORS = {
  file: null,
  append: null,
  after: SEPARATOR_ADD,
  before: SEPARATOR_ADD,
  edit: SEPARATOR_WITH,
} as const satisfies Record<Verb, string | null>

/** What closes an opening delimiter after the path. */
export const OPEN_TAIL = '">'

// Derived from the verb rather than tabulated, so a tag cannot drift from its name.
export const openTagFor = (verb: Verb): string => `<genesis:${verb} path="`
export const closeTagFor = (verb: Verb): string => `</genesis:${verb}>`
export const separatorFor = (verb: Verb): string | null => SEPARATORS[verb]

/** Leading whitespace allowed before a tag. Capped, because it bounds the hold-back. */
export const MAX_INDENT = 8

const LONGEST_OPEN = Math.max(...VERBS.map((verb) => openTagFor(verb).length))

/** The longest partial line the splitter will ever hold, in characters. */
export const MAX_LINE =
  MAX_INDENT + LONGEST_OPEN + PATH_MAX + OPEN_TAIL.length + MAX_INDENT + 1

const INDENT = `[ \\t]{0,${String(MAX_INDENT)}}`
const TRAILING = '[ \\t]*'

/** The path capture is bounded so the grammar and the hold-back give up together. */
const OPEN_LINE = new RegExp(
  `^${INDENT}<genesis:(${VERBS.join('|')}) path="([^"\\n]{0,${String(PATH_MAX)}})">${TRAILING}$`,
)

const lineFor = (tag: string): RegExp => new RegExp(`^${INDENT}${tag}${TRAILING}$`)

const CLOSE_LINE = Object.fromEntries(
  VERBS.map((verb) => [verb, lineFor(closeTagFor(verb))]),
) as Record<Verb, RegExp>

const SEPARATOR_LINE = Object.fromEntries(
  VERBS.map((verb) => {
    const separator = separatorFor(verb)
    return [verb, separator === null ? null : lineFor(separator)]
  }),
) as Record<Verb, RegExp | null>

/** Only spaces and tabs — a newline would have ended the line. */
const BLANK = /^[ \t]*$/

export type BlockEvent =
  | { kind: 'open'; verb: Verb; path: string }
  | { kind: 'separator'; verb: Verb; path: string }
  | { kind: 'close'; verb: Verb; path: string }
  | { kind: 'prose'; text: string }
  | { kind: 'content'; text: string }

export interface BlockSplitter {
  push: (text: string) => BlockEvent[]
  /** End of input: a delimiter may end there as well as at a newline. */
  finish: () => BlockEvent[]
}

/** The block currently open, and which of its sections we are in. */
interface OpenBlock {
  verb: Verb
  path: string
  section: 'first' | 'second'
}

export function createBlockSplitter(): BlockSplitter {
  let block: OpenBlock | null = null
  /** The held-back partial line. Never longer than `MAX_LINE` plus a `\r`. */
  let pending = ''
  /**
   * Once a partial line has been emitted, the rest of it arrives later and is not
   * at a line start — so it can never be a delimiter, and is never held.
   */
  let atLineStart = true

  /** The delimiters that can end the current line, given where we are. */
  function liveTags(): string[] {
    if (block === null) return VERBS.map(openTagFor)
    const tags = [closeTagFor(block.verb)]
    const separator = separatorFor(block.verb)
    if (separator !== null && block.section === 'first') tags.push(separator)
    return tags
  }

  function textEvent(line: string): BlockEvent {
    return { kind: block === null ? 'prose' : 'content', text: line }
  }

  /** Match a whole delimiter line, or `null`. `body` carries no line ending. */
  function delimiterOf(body: string): BlockEvent | null {
    if (block === null) {
      const open = OPEN_LINE.exec(body)
      if (open === null) return null
      // The capture group is one of `VERBS` by construction of the pattern.
      const verb = open[1] as Verb
      const path = open[2] ?? ''
      block = { verb, path, section: 'first' }
      return { kind: 'open', verb, path }
    }

    const { verb, path } = block

    if (CLOSE_LINE[verb].test(body)) {
      block = null
      return { kind: 'close', verb, path }
    }

    const separator = SEPARATOR_LINE[verb]
    if (separator !== null && block.section === 'first' && separator.test(body)) {
      block.section = 'second'
      return { kind: 'separator', verb, path }
    }

    return null
  }

  /** One complete line, its `\n` included, known to start at a line start. */
  function takeLine(line: string): BlockEvent {
    return delimiterOf(line.slice(0, -1)) ?? textEvent(line)
  }

  /**
   * Could this partial line still turn into one of the live delimiters?
   *
   * Generous on an open tag's tail only while the path could still be stored,
   * which is what keeps the bound at `MAX_LINE` when the model writes
   * `<genesis:file path="` and then a megabyte.
   */
  function couldBeDelimiter(partial: string): boolean {
    const indent = /^[ \t]*/.exec(partial)?.[0] ?? ''
    if (indent.length > MAX_INDENT) return false
    const rest = partial.slice(indent.length)

    if (block !== null) {
      return liveTags().some(
        (tag) =>
          tag.startsWith(rest) || (rest.startsWith(tag) && BLANK.test(rest.slice(tag.length))),
      )
    }

    for (const verb of VERBS) {
      const head = openTagFor(verb)
      if (head.startsWith(rest)) return true
      if (!rest.startsWith(head)) continue

      const after = rest.slice(head.length)
      const quote = after.indexOf('"')
      // Still inside the path: hold while it could still be a storable length.
      if (quote === -1) return after.length <= PATH_MAX
      if (quote > PATH_MAX) return false

      const tail = after.slice(quote)
      if (OPEN_TAIL.startsWith(tail)) return true
      return tail.startsWith(OPEN_TAIL) && BLANK.test(tail.slice(OPEN_TAIL.length))
    }

    return false
  }

  return {
    push(text: string): BlockEvent[] {
      const events: BlockEvent[] = []
      let buffer = pending + text
      pending = ''

      // A CRLF split across two deltas is the same hazard one character wide.
      let carry = ''
      if (buffer.endsWith('\r')) {
        carry = '\r'
        buffer = buffer.slice(0, -1)
      }

      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break

        const raw = buffer.slice(0, newline + 1)
        buffer = buffer.slice(newline + 1)
        // CRLF repair on the line rather than the buffer, so a `\r` that is not
        // part of a line ending survives untouched.
        const line = raw.endsWith('\r\n') ? `${raw.slice(0, -2)}\n` : raw
        events.push(atLineStart ? takeLine(line) : textEvent(line))
        atLineStart = true
      }

      if (atLineStart && buffer.length <= MAX_LINE && couldBeDelimiter(buffer)) {
        pending = buffer + carry
        return events
      }

      if (buffer !== '') {
        events.push(textEvent(buffer))
        atLineStart = false
      }
      pending = carry
      return events
    },

    finish(): BlockEvent[] {
      const line = pending
      pending = ''
      if (line === '') return []
      // The tail of a line already partly emitted is text, not a delimiter.
      if (!atLineStart) return [textEvent(line)]
      return [delimiterOf(line) ?? textEvent(line)]
    },
  }
}
