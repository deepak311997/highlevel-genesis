import { createBlockSplitter, separatorFor, type BlockEvent, type Verb } from './blocks'
import { locateStep, resolveStep, type LineRange, type Step } from './patch'
import type { ProjectFile } from './projectState'

/**
 * The model's reply, split into chat text and located changes **as it streams**.
 *
 * `blocks.ts` is the grammar and validates nothing. This is the layer that gives a
 * block meaning: it holds a working copy of the project's files, resolves each
 * block's anchor against it, and turns the result into the frames the browser
 * receives.
 *
 * **The resolution here is advisory.** Its only job is to put a line range on
 * `edit_start` early enough for the browser to render the change in place. Every
 * block becomes a `Step` whatever happens, and the write path re-applies the whole
 * list against the files it re-reads — so a block that fails here fails there too,
 * for the same reason, and the two cannot disagree about what was stored.
 */

/** What the collector emits, one frame per SSE frame `generate.ts` writes. */
export type CollectorFrame =
  | { kind: 'token'; text: string }
  | { kind: 'file_start'; path: string; mode: FileWriteMode }
  | { kind: 'file_chunk'; path: string; text: string }
  | { kind: 'file_end'; path: string }
  | { kind: 'edit_start'; path: string; from: number; to: number }
  | { kind: 'edit_chunk'; path: string; text: string }
  | { kind: 'edit_end'; path: string }

/** Whether a whole-file block makes a file or replaces one. */
export type FileWriteMode = 'create' | 'rewrite'

export interface CollectResult {
  /**
   * Exactly the concatenation of the `token` frames emitted — accumulated *from*
   * those frames and nowhere else, so the invariant holds by construction.
   */
  messageText: string
  /** Every block the reply wrote, in reply order. The write path applies these. */
  steps: Step[]
  /**
   * Whether each step was placed while streaming, parallel to `steps`.
   *
   * The write path needs it to tell two failures apart: an anchor that never
   * resolved, and one that resolved here and had gone by the time the turn was
   * written — which is a file that changed underneath, and says so.
   */
  placed: boolean[]
  /** The path of a block that was never closed, or `null`. */
  unterminated: string | null
  /**
   * The frames the end-of-input flush produced — empty for any text ending in a
   * newline. A delimiter may end at end of input as well as at a newline.
   */
  frames: CollectorFrame[]
}

export interface FileCollector {
  push: (text: string) => CollectorFrame[]
  finish: () => CollectResult
}

/**
 * Everything the model wrote *inside* blocks this turn.
 *
 * The HighLevel call counter reads this rather than the chat text: a call
 * described in prose is not one the app will ever run.
 */
export function writtenText(steps: readonly Step[]): string {
  return steps.map((step) => (step.verb === 'file' ? step.content : step.text)).join('\n')
}

/** Three or more newlines in a whitespace run collapse to exactly two. */
function collapseRun(run: string): string {
  let newlines = 0
  for (const character of run) {
    if (character === '\n') newlines += 1
  }
  return newlines >= 3 ? '\n\n' : run
}

/** A block that is currently open, and everything its sections have said so far. */
interface OpenBlock {
  verb: Verb
  path: string
  /** Which section the content events belong to. */
  section: 'first' | 'second'
  /** The first section of a two-section verb, raw. Never emitted as chunks. */
  anchor: string
  /** Every chunk emitted for the payload, concatenated — which *is* the step. */
  chunks: string
  /** A trailing run of `\n`, held so the tail can become exactly one. */
  heldNewlines: string
  /**
   * Where this block lands, once known — `null` while the anchor has not been
   * reached, and for a block whose anchor did not resolve.
   *
   * It gates the frames and nothing else: an unresolved block still becomes a
   * step, and the write path still refuses the turn over it.
   */
  range: LineRange | null
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
 * - **Payload text.** Trailing `\n` runs are held (spaces and tabs are not, since
 *   they can be meaningful in code) and replaced at the close by a single `"\n"`,
 *   so the streamed bytes and the stored bytes are equal by construction.
 */
export function createFileCollector(files: readonly ProjectFile[] = []): FileCollector {
  const splitter = createBlockSplitter()
  /** The project's files as this reply has left them so far. */
  const working = new Map(files.map((file) => [file.path, file.content]))

  let messageText = ''
  const steps: Step[] = []
  const placed: boolean[] = []
  let open: OpenBlock | null = null

  /** The chat normaliser's state: whether anything has been emitted, and the run. */
  let started = false
  let heldWhitespace = ''

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
      // Before the first non-whitespace character the run is simply dropped.
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

  /**
   * Feed payload text through the newline hold-back, and frame whatever may be
   * emitted now. A block whose anchor did not resolve accumulates but emits
   * nothing: its content must not reach a client that will never see the change.
   */
  function payloadFrames(block: OpenBlock, text: string): CollectorFrame[] {
    const buffer = block.heldNewlines + text
    let end = buffer.length
    while (end > 0 && buffer[end - 1] === '\n') end -= 1

    block.heldNewlines = buffer.slice(end)
    const emitted = buffer.slice(0, end)
    if (emitted === '') return []

    block.chunks += emitted
    if (block.verb === 'file') return [{ kind: 'file_chunk', path: block.path, text: emitted }]
    if (block.range === null) return []
    return [{ kind: 'edit_chunk', path: block.path, text: emitted }]
  }

  /** The step a finished block becomes, whatever became of its frames. */
  function stepFor(block: OpenBlock): Step {
    if (block.verb === 'file') return { verb: 'file', path: block.path, content: block.chunks }
    if (block.verb === 'append') return { verb: 'append', path: block.path, text: block.chunks }
    return { verb: block.verb, path: block.path, anchor: block.anchor, text: block.chunks }
  }

  /**
   * Close the open block: one last chunk of exactly `"\n"`, then the end frame. A
   * block that emitted nothing stays empty, so a blank one does not become a file
   * containing one newline.
   */
  function closeBlock(block: OpenBlock): CollectorFrame[] {
    const frames: CollectorFrame[] = []
    const live = block.verb === 'file' || block.range !== null

    if (block.chunks !== '') {
      block.chunks += '\n'
      if (live) {
        frames.push(
          block.verb === 'file'
            ? { kind: 'file_chunk', path: block.path, text: '\n' }
            : { kind: 'edit_chunk', path: block.path, text: '\n' },
        )
      }
    }

    if (live) {
      frames.push(
        block.verb === 'file'
          ? { kind: 'file_end', path: block.path }
          : { kind: 'edit_end', path: block.path },
      )
    }

    const step = stepFor(block)
    steps.push(step)
    placed.push(live)

    // Keep the working copy in step, so a later block in the same reply resolves
    // against what this one produced.
    if (step.verb === 'file') {
      working.set(step.path, step.content)
    } else {
      const applied = resolveStep(working.get(step.path), step)
      if (!('reason' in applied)) working.set(step.path, applied.content)
    }

    return frames
  }

  /** The marker the transcript keeps, so a reply says which files it touched. */
  function marker(block: OpenBlock): CollectorFrame[] {
    const label = block.verb === 'file' ? 'file' : 'edit'
    return chatFrames(`[${label}: ${block.path}]\n`)
  }

  /**
   * Try to place the block, and open its frames if it lands. Called at the open tag
   * for the verbs that need no anchor, and at the separator for the ones that do.
   */
  function locate(block: OpenBlock): CollectorFrame[] {
    if (block.verb === 'file') return []

    const where = locateStep(working.get(block.path), {
      verb: block.verb,
      path: block.path,
      anchor: block.anchor,
    })
    if ('reason' in where) return []

    block.range = where
    // The boundary first, then the marker: a client that renders the tree off the
    // start frame shows the row before the bubble mentions it.
    return [
      { kind: 'edit_start', path: block.path, from: where.from, to: where.to },
      ...marker(block),
    ]
  }

  function onOpen(event: Extract<BlockEvent, { kind: 'open' }>): CollectorFrame[] {
    const block: OpenBlock = {
      verb: event.verb,
      path: event.path,
      section: 'first',
      anchor: '',
      chunks: '',
      heldNewlines: '',
      range: null,
    }
    open = block

    if (block.verb === 'file') {
      const mode: FileWriteMode = working.has(block.path) ? 'rewrite' : 'create'
      return [{ kind: 'file_start', path: block.path, mode }, ...marker(block)]
    }

    // `append` has no anchor, so it can be placed the moment it opens.
    if (block.verb === 'append') return locate(block)

    return []
  }

  function apply(events: BlockEvent[]): CollectorFrame[] {
    const frames: CollectorFrame[] = []

    for (const event of events) {
      if (event.kind === 'prose') {
        frames.push(...chatFrames(event.text))
        continue
      }

      if (event.kind === 'open') {
        frames.push(...onOpen(event))
        continue
      }

      if (event.kind === 'separator') {
        if (open !== null) {
          open.section = 'second'
          frames.push(...locate(open))
        }
        continue
      }

      if (event.kind === 'content') {
        if (open === null) continue
        // The first section of a two-section verb is the anchor: accumulated, never
        // emitted, because it is a claim about the file rather than new text.
        if (open.section === 'first' && separatorFor(open.verb) !== null) {
          open.anchor += event.text
          continue
        }
        frames.push(...payloadFrames(open, event.text))
        continue
      }

      if (open !== null) {
        frames.push(...closeBlock(open))
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
       * A block still open at the end of the stream is **not** a step, gets no end
       * frame, and keeps its content out of every `token` frame. Its marker was
       * already emitted, which is correct: the message says a change was attempted,
       * and the tree says by omission that none was stored.
       */
      const unterminated = open?.path ?? null
      open = null
      // The held whitespace run is dropped rather than emitted — the trailing trim.
      heldWhitespace = ''

      return { messageText, steps, placed, unterminated, frames }
    },
  }
}
