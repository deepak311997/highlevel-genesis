import { PATH_MAX, type FileOp } from '../files/schema'

/**
 * The model's reply, split into chat text and files **as it streams**.
 *
 * `createFileSplitter()` is **syntax only**: the tag grammar, the line-start rule
 * and the hold-back, and it validates nothing — `../secrets.js` and a
 * 200-character name both open a block here and are refused at the terminal by
 * `validateFileOps`. One site answers "is this path allowed".
 * `createFileCollector()` wraps it with the normalisers and the marker.
 *
 * **Every delimiter occupies a whole line**, so the splitter processes complete
 * lines and holds back only the trailing partial one, and only while it could
 * still become a delimiter. Chunking invariance is then a property of the shape:
 * `<genesis:fi` + `le path="a.js">` is an ordinary pair of SDK deltas, and a naive
 * per-delta scan leaks the first half into the chat bubble, never opens the file,
 * and passes every hand-written test — because those chunk on whole tags.
 *
 * The hold-back is bounded by `MAX_LINE`, so no adversarial output can make the
 * splitter buffer without limit.
 */

/** The opening delimiter, up to the path. */
export const OPEN_HEAD = '<genesis:file path="'

/** What closes the opening delimiter after the path. */
export const OPEN_TAIL = '">'

/** The closing delimiter, whole. */
export const CLOSE_TAG = '</genesis:file>'

/**
 * Leading whitespace allowed before a tag — capped, and the cap is what bounds
 * the hold-back: with `[ \t]*` a delimiter-shaped line of a million spaces would
 * have to be held before it could be ruled out.
 */
export const MAX_INDENT = 8

/**
 * The longest partial line the splitter will ever hold, in characters. Asserted
 * in a test, so the bound is a fact rather than a claim in a comment.
 */
export const MAX_LINE = MAX_INDENT + OPEN_HEAD.length + PATH_MAX + OPEN_TAIL.length + MAX_INDENT + 1

/**
 * The two line grammars, **built from the constants above** so the tag the parser
 * recognises and the tag the system prompt documents cannot drift.
 *
 * The path capture is syntax only, with one exception that is not validation: its
 * **length** is bounded here, because the hold-back gives up on a path past
 * `PATH_MAX` and a grammar that accepted what the hold-back had abandoned would
 * open the block when the tag arrived in one delta and not when it arrived in two.
 */
const INDENT = `[ \\t]{0,${String(MAX_INDENT)}}`
const TRAILING = '[ \\t]*'
const OPEN_LINE = new RegExp(
  `^${INDENT}${OPEN_HEAD}([^"\\n]{0,${String(PATH_MAX)}})${OPEN_TAIL}${TRAILING}$`,
)
const CLOSE_LINE = new RegExp(`^${INDENT}${CLOSE_TAG}${TRAILING}$`)

/** Only spaces and tabs — a newline would have ended the line. */
const BLANK = /^[ \t]*$/

/** What the splitter emits. Text events carry the line's own newline. */
export type SplitEvent =
  | { kind: 'open'; path: string }
  | { kind: 'close'; path: string }
  | { kind: 'prose'; text: string }
  | { kind: 'content'; text: string }

export interface FileSplitter {
  push: (text: string) => SplitEvent[]
  /** End of input: a delimiter may end there as well as at a newline (P1). */
  finish: () => SplitEvent[]
}

/**
 * The line-oriented state machine, and nothing else.
 *
 * **Which delimiters are live depends on the mode**: in prose only the open tag,
 * inside a block only the close tag. A stray `</genesis:file>` in prose is prose
 * and a nested open tag inside a block is content, which also halves the candidate
 * set the hold-back predicate has to consider.
 */
export function createFileSplitter(): FileSplitter {
  let mode: 'prose' | 'file' = 'prose'
  let path: string | null = null
  /** The held-back partial line. Never longer than `MAX_LINE` plus a `\r`. */
  let pending = ''
  /**
   * Whether what comes next begins a line.
   *
   * Once a partial line has been emitted — because it could not be a delimiter, or
   * because it grew past `MAX_LINE` — the rest of that line arrives later and is
   * *not* at a line start. Without this flag the tail `</genesis:file>\n` of the
   * prose line `x</genesis:file>` reads as a close tag when the halves arrive
   * separately and as prose when they arrive together.
   *
   * It is also the hold predicate's precondition: a partial that is not at a line
   * start can never become a delimiter, so it is never held.
   */
  let atLineStart = true

  /** Whatever a line is when it is not a delimiter. */
  function textEvent(line: string): SplitEvent {
    return { kind: mode === 'file' ? 'content' : 'prose', text: line }
  }

  /** One complete line, its `\n` included, known to start at a line start. */
  function takeLine(line: string): SplitEvent {
    const body = line.slice(0, -1)

    if (mode === 'prose') {
      const open = OPEN_LINE.exec(body)
      if (open !== null) {
        mode = 'file'
        path = open[1] ?? ''
        // The delimiter line itself produces no text, which drops the line break
        // immediately after the open tag for free.
        return { kind: 'open', path }
      }
      return textEvent(line)
    }

    if (CLOSE_LINE.test(body)) {
      const closed = path ?? ''
      mode = 'prose'
      path = null
      return { kind: 'close', path: closed }
    }

    return textEvent(line)
  }

  /**
   * Could this partial line still turn into a delimiter?
   *
   * Mode-dependent, and generous on the open tag's tail only while the path is
   * still short enough to be storable — which is what keeps the bound at
   * `MAX_LINE` when the model writes `<genesis:file path="` and then a megabyte.
   */
  function couldBeDelimiter(partial: string): boolean {
    const indent = /^[ \t]*/.exec(partial)?.[0] ?? ''
    if (indent.length > MAX_INDENT) return false
    const rest = partial.slice(indent.length)

    if (mode === 'file') {
      if (CLOSE_TAG.startsWith(rest)) return true
      return rest.startsWith(CLOSE_TAG) && BLANK.test(rest.slice(CLOSE_TAG.length))
    }

    if (OPEN_HEAD.startsWith(rest)) return true
    if (!rest.startsWith(OPEN_HEAD)) return false

    const after = rest.slice(OPEN_HEAD.length)
    const quote = after.indexOf('"')
    // Still inside the path: hold while it could still be a storable length.
    if (quote === -1) return after.length <= PATH_MAX
    if (quote > PATH_MAX) return false

    const tail = after.slice(quote)
    if (OPEN_TAIL.startsWith(tail)) return true
    return tail.startsWith(OPEN_TAIL) && BLANK.test(tail.slice(OPEN_TAIL.length))
  }

  return {
    push(text: string): SplitEvent[] {
      const events: SplitEvent[] = []
      let buffer = pending + text
      pending = ''

      /*
       * A CRLF split across two deltas is the same hazard one character wide, so a
       * trailing lone `\r` is held back too — carried past the decision below
       * rather than through it.
       */
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
        // Only a line that began at a line start can be a delimiter.
        events.push(atLineStart ? takeLine(line) : textEvent(line))
        // A completed line puts us back at a line start.
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

    finish(): SplitEvent[] {
      const line = pending
      pending = ''
      if (line === '') return []
      // The tail of a line already partly emitted is text, not a delimiter.
      if (!atLineStart) return [textEvent(line)]

      if (mode === 'prose') {
        const open = OPEN_LINE.exec(line)
        if (open !== null) {
          mode = 'file'
          path = open[1] ?? ''
          return [{ kind: 'open', path }]
        }
        return [textEvent(line)]
      }

      if (CLOSE_LINE.test(line)) {
        const closed = path ?? ''
        mode = 'prose'
        path = null
        return [{ kind: 'close', path: closed }]
      }

      return [textEvent(line)]
    },
  }
}

/** What the collector emits, one frame per SSE frame `generate.ts` writes. */
export type CollectorFrame =
  | { kind: 'token'; text: string }
  | { kind: 'file_start'; path: string }
  | { kind: 'file_chunk'; path: string; text: string }
  | { kind: 'file_end'; path: string }

export interface CollectResult {
  /**
   * Exactly the concatenation of the `token` frames emitted — accumulated *from*
   * those frames and nowhere else, so the invariant holds by construction.
   */
  messageText: string
  ops: FileOp[]
  /** The path of a block that was never closed, or `null`. */
  unterminated: string | null
  /**
   * The frames the end-of-input flush produced — empty for any text ending in a
   * newline.
   *
   * A delimiter line may end at end of input as well as at a newline, so a reply
   * whose last bytes are `</genesis:file>` resolves its close *after* the final
   * `push`. Without these, that file's tail chunk and its `file_end` would never
   * reach the client.
   */
  frames: CollectorFrame[]
}

export interface FileCollector {
  push: (text: string) => CollectorFrame[]
  finish: () => CollectResult
}

/** Three or more newlines in a whitespace run collapse to exactly two. */
function collapseRun(run: string): string {
  let newlines = 0
  for (const character of run) {
    if (character === '\n') newlines += 1
  }
  return newlines >= 3 ? '\n\n' : run
}

/** A file that is currently open, and everything its chunks have said so far. */
interface OpenFile {
  path: string
  /** Every chunk emitted for this file, concatenated — which *is* the op. */
  chunks: string
  /** A trailing run of `\n`, held so the tail can become exactly one. */
  heldNewlines: string
}

/**
 * The stream the client actually receives.
 *
 * Two normalisers, both built on the same idea — **hold back the trailing run,
 * because what it becomes is only decidable once it ends**:
 *
 * - **Chat text.** Leading whitespace is dropped; a whitespace run is held and
 *   emitted when non-whitespace follows, verbatim below three newlines and as
 *   exactly `"\n\n"` at three or more; at `finish()` the held run is discarded.
 *   All of it happens *in the emitted stream*, or the stored message would
 *   disagree with what the client accumulated — in whitespace, which nobody
 *   notices.
 * - **File content.** Trailing `\n` runs are held (spaces and tabs are not, since
 *   they can be meaningful in code) and replaced at the close by a single `"\n"`,
 *   so the streamed bytes and the stored bytes are equal by construction.
 */
export function createFileCollector(): FileCollector {
  const splitter = createFileSplitter()

  let messageText = ''
  const ops: FileOp[] = []
  let open: OpenFile | null = null

  /** The chat normaliser's state: whether anything has been emitted, and the run. */
  let started = false
  let heldWhitespace = ''

  /** Feed chat text through the normaliser and return what may be emitted now. */
  function normaliseChat(text: string): string {
    let out = ''
    let rest = text

    while (rest !== '') {
      const solid = /\S/.exec(rest)
      if (solid === null) {
        heldWhitespace += rest
        return out
      }

      heldWhitespace += rest.slice(0, solid.index)
      // Before the first non-whitespace character the run is simply dropped —
      // the leading trim, without a `.trim()` anywhere.
      if (started) out += collapseRun(heldWhitespace)
      heldWhitespace = ''
      started = true

      rest = rest.slice(solid.index)
      const space = /\s/.exec(rest)
      const end = space?.index ?? rest.length
      out += rest.slice(0, end)
      rest = rest.slice(end)
    }

    return out
  }

  /** One `token` frame, or none — an empty frame would be a lie about progress. */
  function chatFrames(text: string): CollectorFrame[] {
    const emitted = normaliseChat(text)
    if (emitted === '') return []
    messageText += emitted
    return [{ kind: 'token', text: emitted }]
  }

  function contentFrames(file: OpenFile, text: string): CollectorFrame[] {
    const buffer = file.heldNewlines + text
    let end = buffer.length
    while (end > 0 && buffer[end - 1] === '\n') end -= 1

    file.heldNewlines = buffer.slice(end)
    const emitted = buffer.slice(0, end)
    if (emitted === '') return []

    file.chunks += emitted
    return [{ kind: 'file_chunk', path: file.path, text: emitted }]
  }

  /**
   * Close the open file: one last chunk of exactly `"\n"`, then `file_end`. A file
   * that emitted nothing stays empty, so a blank block does not become a file
   * containing one newline.
   */
  function closeFile(file: OpenFile): CollectorFrame[] {
    const frames: CollectorFrame[] = []
    if (file.chunks !== '') {
      file.chunks += '\n'
      frames.push({ kind: 'file_chunk', path: file.path, text: '\n' })
    }
    frames.push({ kind: 'file_end', path: file.path })
    ops.push({ path: file.path, content: file.chunks })
    return frames
  }

  function apply(events: SplitEvent[]): CollectorFrame[] {
    const frames: CollectorFrame[] = []

    for (const event of events) {
      if (event.kind === 'prose') {
        frames.push(...chatFrames(event.text))
        continue
      }

      if (event.kind === 'open') {
        open = { path: event.path, chunks: '', heldNewlines: '' }
        // The boundary first, then the marker: a client that renders the tree off
        // `file_start` shows the row before the bubble mentions it.
        frames.push({ kind: 'file_start', path: event.path })
        frames.push(...chatFrames(`[file: ${event.path}]\n`))
        continue
      }

      if (event.kind === 'content') {
        if (open !== null) frames.push(...contentFrames(open, event.text))
        continue
      }

      if (open !== null) {
        frames.push(...closeFile(open))
        open = null
      }
    }

    return frames
  }

  return {
    push(text: string): CollectorFrame[] {
      return apply(splitter.push(text))
    },

    finish(): CollectResult {
      const frames = apply(splitter.finish())

      /*
       * A block still open at the end of the stream is **not** an op, gets no
       * `file_end`, and keeps its content out of every `token` frame. Its marker
       * token was already emitted, which is correct: the message says a file was
       * attempted, and the tree says by omission that none was stored.
       */
      const unterminated = open?.path ?? null
      open = null
      // The held whitespace run is dropped rather than emitted — the trailing trim.
      heldWhitespace = ''

      return { messageText, ops, unterminated, frames }
    },
  }
}
