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

