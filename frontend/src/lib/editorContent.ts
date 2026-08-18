/**
 * How streamed bytes reach the document (D8) — **the slice's one real hazard**.
 *
 * The obvious implementation is `model.setValue(next)` once per chunk, and it is
 * wrong in three ways at once. `setValue` replaces the model wholesale: the
 * viewport snaps back to line 1, so a user watching a 300-line file stream in
 * stares at its first ten lines for the entire generation; the undo stack is
 * reset on every chunk; and the whole document is re-tokenized each time, which
 * is O(n²) over the file rather than O(delta).
 *
 * What makes it dangerous rather than merely bad is that it is **invisible below
 * L5**. jsdom computes no layout and runs no Monaco, so the `setValue` version
 * passes every L1 and L2 test in this repo. Hence this: the decision is a pure
 * function, in its own module, with its own tests, reviewable before any `.vue`
 * file changes.
 *
 * Both branches are applied through `model.applyEdits` by the caller — an append
 * as a zero-width range at the end, a splice over the range that actually changed.
 * Neither is a `setValue`, so AC-10's negative is provable outright: the fake
 * model records no `setValue` call at all, ever, rather than "none for this file
 * during this window". `applyEdits` also leaves the cursor and scroll where they
 * are, and it bypasses `readOnly` — which is exactly what a programmatic stream
 * write into an editor locked for the user needs.
 */

/**
 * A discriminated union rather than optional fields: the two mean different
 * things and `kind` is what the caller switches on.
 */
export type EditorEdit =
  | { kind: 'append'; text: string }
  /**
   * The minimal changed range: replace `length` characters at `offset` with
   * `text`. A whole-document replace is this with `offset: 0`, so the caller has
   * one branch instead of two — and a located change touches only its own lines,
   * which is the point of the slice made visible.
   */
  | { kind: 'splice'; offset: number; length: number; text: string }

/**
 * The edit that turns `current` into `next`, or `null` when there is nothing to do.
 *
 * `null` rather than a zero-length append: an equal pair is the common case
 * — the stream's own write bounces back through the wrapper's `update:value`,
 * and the store's echo of a keystroke arrives here too — and issuing an empty
 * edit for it would push an undo entry per keystroke.
 */
export function editorEdit(current: string, next: string): EditorEdit | null {
  if (current === next) return null
  // The streaming-tail case, kept apart because the viewport should follow it.
  if (next.startsWith(current)) return { kind: 'append', text: next.slice(current.length) }

  const shorter = Math.min(current.length, next.length)

  let start = 0
  while (start < shorter && current[start] === next[start]) start += 1

  // The suffix scan stops at the prefix, so the two can never overlap and
  // `length` can never go negative.
  let end = 0
  while (
    end < shorter - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1
  }

  return {
    kind: 'splice',
    offset: start,
    length: current.length - start - end,
    text: next.slice(start, next.length - end),
  }
}
