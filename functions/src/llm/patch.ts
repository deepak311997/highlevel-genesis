import type { FileOp, FileRejection } from '../files/schema'
import type { ProjectFile } from './projectState'

/**
 * What each verb means, as pure functions over text.
 *
 * **The anchor is whole lines by construction**: every delimiter owns a line, so a
 * block's first section starts at a line start and ends at a line end. Matching
 * line-wise rather than by substring is therefore not a narrowing — and it is what
 * makes the `from`/`to` the browser needs fall out with no offset arithmetic.
 *
 * **Exact, and unique.** Zero matches and two matches are both refusals, never a
 * guess. One fallback pass ignores trailing whitespace, which cannot move where a
 * patch lands; there is no similarity matching, because a match that lands three
 * lines off writes a broken app and reports success.
 */

/** One thing the model asked for, as the grammar produced it. */
export type Step =
  | { verb: 'file'; path: string; content: string }
  | { verb: 'append'; path: string; text: string }
  | { verb: 'after' | 'before' | 'edit'; path: string; anchor: string; text: string }

/** Every step except the one that needs no anchor and no range. */
export type LocatedStep = Exclude<Step, { verb: 'file' }>

/** 1-based lines, `to` exclusive. `from === to` is an insertion. */
export interface LineRange {
  from: number
  to: number
}

export interface Resolved {
  path: string
  /** The file as it stands after this step. */
  content: string
  /** Where the new text goes, in the file as it stood *before* it. */
  range: LineRange
}

/** A verb's sections, whichever it has. `file` and `append` carry no anchor. */
function anchorOf(step: LocatedStep): string {
  return step.verb === 'append' ? '' : step.anchor
}

/**
 * Split into lines, keeping the artefact of a trailing newline: `"a\n"` is
 * `['a', '']`, and joining reverses it exactly.
 */
const toLines = (text: string): string[] => text.split('\n')

/** A section's lines, with the empty line its trailing newline produced dropped. */
function sectionLines(text: string): string[] {
  const lines = toLines(text)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const trimEnd = (line: string): string => line.replace(/[ \t\r]+$/, '')

/** Every window of `needle.length` lines in `haystack` that matches under `equal`. */
function windowsMatching(
  haystack: readonly string[],
  needle: readonly string[],
  equal: (a: string, b: string) => boolean,
): number[] {
  const found: number[] = []
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((line, offset) => equal(haystack[start + offset] ?? '', line))) {
      found.push(start)
    }
  }
  return found
}

type AnchorResult = { start: number; end: number } | 'none' | 'many'

/**
 * The one place the anchor is located. Exact first; the tolerant pass runs only
 * when the exact one found nothing, so two exact matches are ambiguous rather than
 * an invitation to look harder.
 */
export function findAnchor(lines: readonly string[], anchor: readonly string[]): AnchorResult {
  for (const equal of [
    (a: string, b: string): boolean => a === b,
    (a: string, b: string): boolean => trimEnd(a) === trimEnd(b),
  ]) {
    const found = windowsMatching(lines, anchor, equal)
    if (found.length === 1) {
      const start = found[0] ?? 0
      return { start, end: start + anchor.length }
    }
    if (found.length > 1) return 'many'
  }
  return 'none'
}

/** True when every line ending in the file is a CRLF, so written lines match. */
function usesCrlf(content: string): boolean {
  return content.includes('\r\n') && !content.replace(/\r\n/g, '').includes('\n')
}

/** Enough of a step to say where it lands — the payload has not arrived yet. */
export interface Anchoring {
  verb: LocatedStep['verb']
  path: string
  /** Empty for `append`, which needs none. */
  anchor: string
}

/**
 * Where a step will land, decided **before** its payload has streamed.
 *
 * The collector needs this: `edit_start` carries a range, and it goes out at the
 * separator so the browser can show the change growing in the right place. The
 * same function then decides the splice at `resolveStep`, so the range the client
 * was told and the range the server writes cannot differ.
 */
export function locateStep(current: string | undefined, at: Anchoring): LineRange | FileRejection {
  if (current === undefined) return { reason: 'edit-unknown-file', path: at.path }

  const lines = toLines(current)

  // `append` needs no anchor at all, which is why nothing here can be matched
  // wrongly: the position is the end of the file.
  if (at.verb === 'append') {
    const line = lines[lines.length - 1] === '' ? lines.length : lines.length + 1
    return { from: line, to: line }
  }

  if (at.anchor.trim() === '') return { reason: 'edit-malformed', path: at.path }

  const found = findAnchor(lines, sectionLines(at.anchor))
  if (found === 'none') return { reason: 'edit-no-match', path: at.path }
  if (found === 'many') return { reason: 'edit-ambiguous', path: at.path }

  // `after` and `before` displace nothing, which is the whole difference between
  // adding and changing.
  if (at.verb === 'edit') return { from: found.start + 1, to: found.end + 1 }
  const line = (at.verb === 'after' ? found.end : found.start) + 1
  return { from: line, to: line }
}

/**
 * Resolve one located step against the file as it currently stands.
 *
 * `current` is `undefined` for a path the project does not hold — the four verbs
 * here are all defined by text that is already there, so that is a refusal rather
 * than a creation.
 */
export function resolveStep(
  current: string | undefined,
  step: LocatedStep,
): Resolved | FileRejection {
  // An insert that inserts nothing is a no-op the model did not mean; an empty
  // replacement is how a deletion is written.
  if (step.verb !== 'edit' && step.text === '' && current !== undefined) {
    return { reason: 'edit-malformed', path: step.path }
  }

  const range = locateStep(current, { verb: step.verb, path: step.path, anchor: anchorOf(step) })
  if ('reason' in range) return range

  const lines = toLines(current ?? '')
  const crlf = usesCrlf(current ?? '')
  const written = sectionLines(step.text).map((line) => (crlf ? `${line}\r` : line))

  const at = range.from - 1
  const next = [...lines.slice(0, at), ...written, ...lines.slice(range.to - 1)]
  // A file with no trailing newline gains one, so an append never runs the new
  // text onto the old last line.
  if (step.verb === 'append' && lines[lines.length - 1] !== '') next.push('')

  return { path: step.path, content: next.join('\n'), range }
}

export type ApplyResult =
  | { ok: true; ops: FileOp[] }
  /** `index` is the step that failed, so the caller can ask what it knew about it. */
  | { ok: false; error: FileRejection; index: number }

/**
 * Every step of a turn, applied in reply order to a working copy.
 *
 * In reply order because the model wrote each step while looking at the result of
 * the last one — so a second anchor means what it meant only against the first
 * one's output. The result is one op per path touched, which is what the rest of
 * the write path already knows how to handle.
 */
export function applySteps(files: readonly ProjectFile[], steps: readonly Step[]): ApplyResult {
  const working = new Map(files.map((file) => [file.path, file.content]))
  const touched = new Set<string>()
  const written = new Set<string>()

  for (const [index, step] of steps.entries()) {
    if (step.verb === 'file') {
      // The one op that may not repeat: two whole-file blocks for one path is a
      // reply that has not decided what the file is.
      if (written.has(step.path)) {
        return { ok: false, error: { reason: 'duplicate', path: step.path }, index }
      }
      written.add(step.path)
      working.set(step.path, step.content)
      touched.add(step.path)
      continue
    }

    const result = resolveStep(working.get(step.path), step)
    if ('reason' in result) return { ok: false, error: result, index }

    working.set(step.path, result.content)
    touched.add(step.path)
  }

  // Reply order, which a `Set` keeps: it is the order the client watched the
  // frames arrive in, and the order the old whole-file path already wrote in.
  const ops = [...touched].map((path) => ({ path, content: working.get(path) ?? '' }))
  return { ok: true, ops }
}
