## T4–T8 — the matcher, the ranges, the copy

Consolidated for the same reason as T1–T3: `resolveStep` is one function and the four verbs
share every guard before the match.

- **New:** `functions/src/llm/patch.ts` — `Step` / `LocatedStep`, `findAnchor`, `resolveStep`,
  `applySteps`. Pure; no Firestore, no I/O.
- **Edit:** `functions/src/files/schema.ts` — five `FileRejection` members and their copy, behind
  a second lead-in (`Genesis could not apply the change…`) because a located change failing is
  not "could not save the generated files".
- **Tests:** `patch.spec.ts` 44 cases, `opset.spec.ts` +10.

**Three decisions the plan left open, made here:**

- **`applySteps` returns `{ ok, ops } | { ok, error }`**, matching `validateFileOps`'s existing
  shape rather than a bare union — the call sites read the same way.
- **`patch.ts` returns `FileRejection`, not a private failure type.** The reasons need
  user-facing copy anyway, and one rejection type means one exhaustive `switch`.
- **A CRLF file stays CRLF in the lines the model writes**, not only the ones it does not.
  Mixed endings in one file are the kind of thing nobody notices until a diff.

## T9–T16 — the collector, the write path, the wire, the prompt

- **Rewritten:** `llm/fileops.ts` is the collector and nothing else. It takes the project's files,
  holds a working copy, resolves each block against it, and emits the frames. `CollectResult.ops`
  is gone: it returns **`steps`** (what the model asked for) and **`placed`** (whether each was
  positioned while streaming).
- **Edit:** `files/handlers.ts` — `planFileWrites` re-applies `steps` against the files it already
  re-reads, and `staleAware()` renames a write-time no-match into `edit-stale` **only** when the
  same step was placed during the stream. That distinction is the whole of D8: the model getting
  an anchor wrong and a second tab saving over the file are different sentences.
- **Edit:** `generate.ts` — three new frames, `mode` on `file_start`, and the refusal written into
  the transcript as an `[error: …]` marker emitted **as a `token` frame first**, so the stored
  content stays exactly the concatenation of frames the client received.
- **Edit:** `llm/prompt.ts` — the five verbs, one worked example each, and the choose-by-intent
  policy. Every delimiter is interpolated from `blocks.ts`, so the prompt and the parser cannot
  drift.
- **Edit:** `lib/sse.ts`, `llm/index.ts`, and the specs that named the old splitter.

**Two things the plan did not anticipate:**

- **`writtenText(steps)`** replaces `collected.ops.map(op => op.content)` for the HighLevel call
  counter. With five verbs "what the model wrote" is a section, not a file.
- **Ops keep reply order, not path order.** `applySteps` collapses several ops on one path into
  one at its first appearance. Sorting looked tidier and would have changed the order the writes
  are staged in for no reason; reply order is what the client watched arrive.

**Suite after this step:** functions 1303 unit cases green, typecheck 0, lint 0.

## T22–T26 — the client, abstracted

Deepak asked mid-build for the UI side to be interfaced out — "a class with multiple methods…
abstract it in a way that this would scale" — so the plan gained two modules before this step
and the store was rewired through them rather than growing a ninth `if`.

- **New:** `lib/generationSink.ts` — `GenerationSink`, one method per frame, and
  `dispatchGenerationEvent`, an exhaustive `switch` returning `'open' | 'closed'`. A frame added
  to the protocol is now a compile error in two places rather than a branch nobody wrote. The
  store's `for await` body is three lines.
- **New:** `lib/streamingDocuments.ts` — `StreamingDocuments`, a class over a
  `reactive(new Map())`, with `beginFile` / `beginEdit` / `rebase` / `push` / `content` /
  `states` / `clear`, plus `splitAtRange`. It owns the one composition rule the whole feature
  turns on: **`prefix + body + suffix`**, where a whole-file write is the degenerate case with
  neither half. The lazy fetch and its late rebase live here too, not in the store.
- **Edit:** `lib/editorContent.ts` — `replace` becomes `splice { offset, length, text }`, the
  minimal changed range. `CodeEditor.vue` converts it through `getPositionAt` and reveals the
  change rather than the tail.
- **Edit:** `lib/files.ts` — `FileRow.writing: boolean` becomes `state: 'idle' | StreamMode`, so
  the tree says *Creating* / *Rewriting* / *Editing* rather than one word for three things.
- **Edit:** `lib/messageParts.ts` — `[edit: …]` and `[error: …]` beside `[file: …]`.
  `MessageBody.vue` renders a changed chip and puts the refusal **in the bubble**;
  `ChatPanel.vue`'s separate banner is deleted, and `generateFileError` with it.

**One store member added that production code does not use:** `streamingContent(path)`. It is
the read side of the documents model, and it kept the existing per-path routing assertions
meaningful instead of weakening them to "the active tab looks right".

**Suite:** frontend 1235 · functions 1303 · typecheck 0 · lint 0.

