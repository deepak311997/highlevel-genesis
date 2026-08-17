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
 * as a zero-width range at the end, a replace over `getFullModelRange()` (P4).
 * Neither is a `setValue`, so AC-10's negative is provable outright: the fake
 * model records no `setValue` call at all, ever, rather than "none for this file
 * during this window". `applyEdits` also leaves the cursor and scroll where they
 * are, and it bypasses `readOnly` — which is exactly what a programmatic stream
 * write into an editor locked for the user needs.
 */

/**
 * A discriminated union rather than `{ append?: string; replace?: string }`.
 *
 * The two carry the same type and mean opposite things — one is a suffix, the
 * other a whole document — so an optional-field shape would let a caller apply
 * the wrong one with no complaint from the compiler. `kind` is what the caller
 * switches on, and what `exhaustive` narrowing keeps honest.
 */
export type EditorEdit = { kind: 'append'; text: string } | { kind: 'replace'; text: string }

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
  if (next.startsWith(current)) return { kind: 'append', text: next.slice(current.length) }
  return { kind: 'replace', text: next }
}
