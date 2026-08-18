# Slice 14 — Targeted edits · Technical plan

## Approach

Five authoring verbs, two wire shapes, one applier. The reply grammar grows from one tag family
to five (`file`, `append`, `after`, `before`, `edit`), which means the line splitter stops being
"file tags" and becomes "a table of known blocks" — so it moves out of `llm/fileops.ts` into a
new `llm/blocks.ts` that owns the grammar and nothing else, exactly the seam that file's own
header already claims (`createFileSplitter()` is *syntax only*). A second new module,
`llm/patch.ts`, owns the anchor matcher and the range arithmetic as pure functions over
`(content, step)`. `fileops.ts` keeps the collector: it drives the splitter, holds a **working
copy** of the project's files, resolves each block against it to get the `from`/`to` the browser
needs, and emits frames.

**Every verb resolves to a whole-file `FileOp` before it leaves the LLM layer**, so
`validateFileOps`, `stageFileWrites`, `mergeSnapshotFiles`, the batch and the snapshot are
untouched. The collector additionally returns the raw `steps` in reply order, and
`planFileWrites` re-runs the same applier against the files it *already re-reads* — the
stream-time resolution is advisory, the write-time one is authoritative (PRD D8). One pure
function, called twice, is what keeps those two from disagreeing.

The caching work (D13–D16) is independent of all of the above: it moves the project-state block
out of `system` into the last user message, puts a breakpoint on the last assistant turn, and
splits `projectState.ts`'s selection order from its render order. It is four files and is
sequenced last so it can be dropped or lifted into its own PR without touching the rest.

**Alternatives that lost.** Growing `fileops.ts` in place — it is 438 lines and the hold-back
predicate is the fiddliest code in the repo; a five-verb table wants its own tests.
Substring anchor matching — the grammar puts every delimiter alone on a line, so an anchor is
whole lines *by construction*, and line-wise matching makes `from`/`to` fall out for free
instead of needing an offset→line conversion. A separate `edit_apply` frame carrying the whole
resolved file — zero client work, and it throws away the in-place rendering the slice exists
for. Resolving anchors only at write time — then `edit_start` has no range and the browser
cannot show anything until `done`.

## File map

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/llm/blocks.ts` | **New** | The five-verb grammar table, the line splitter, the bounded hold-back. `createFileSplitter` moves here as `createBlockSplitter`, generalised |
| `functions/src/llm/blocks.spec.ts` | **New** | Grammar, indent/line-start rules, chunking invariance over every verb |
| `functions/src/llm/patch.ts` | **New** | `findAnchor`, `resolveStep`, `applySteps`, `createWorkingCopy`. Pure |
| `functions/src/llm/patch.spec.ts` | **New** | One case per verb; the fallback; each typed failure; sequencing |
| `functions/src/llm/fileops.ts` | Edit | Collector only. Takes the project's files, holds the working copy, emits the new frames, returns `steps` alongside `ops` |
| `functions/src/llm/fileops.spec.ts` | Edit | Frame order per verb, `mode`, the markers, `messageText` equality |
| `functions/src/llm/schema.ts` | Edit | `mode` on `FileStartPayload`; `EditStartPayload`, `EditChunkPayload`, `EditEndPayload` |
| `functions/src/llm/index.ts` | Edit | Re-export the new payload types; `createFileCollector`'s new signature |
| `functions/src/llm/prompt.ts` | Edit | The verb table, one worked example each, and D17's policy — inside the cached prefix |
| `functions/src/llm/prompt.spec.ts` | Edit | The five verbs are documented; the delimiters come from the constants; prefix still ≥1,024 est. tokens |
| `functions/src/llm/projectState.ts` | Edit | Selection by size, **rendering** by `index.html`-then-path; the instruction paragraph names the verbs |
| `functions/src/llm/params.ts` | Edit | `system` is `SYSTEM_PROMPT` by identity, always; project state appended to the last user message; breakpoints |
| `functions/src/llm/context.ts` | Edit | `MessageParam.content` becomes a block array; `cache_control` on the last assistant turn |
| `functions/src/llm/fake.ts` | Edit | Six new markers |
| `functions/src/files/schema.ts` | Edit | Five `FileRejection` reasons and their copy |
| `functions/src/files/handlers.ts` | Edit | `planFileWrites` re-applies `steps` against the freshly-read files |
| `functions/src/generate.ts` | Edit | Collector construction, `encodeFrame`'s new cases, the `[error: …]` token frame |
| `tests/fixtures/llm/reply-edit.json` | **New** | One `edit` and one `append`, anchored in `reply.json`'s `styles.css` |
| `tests/fixtures/llm/reply-insert.json` | **New** | An `after` and a `before` in `index.html` |
| `tests/fixtures/llm/edit-no-match.json` | **New** | An anchor absent from the file |
| `tests/fixtures/llm/edit-ambiguous.json` | **New** | `}` alone — three occurrences |
| `tests/fixtures/llm/README.md` | Edit | Four rows, six markers, and the substring invariant |
| `tests/integration/generate-edits.spec.ts` | **New** | L4: the stored bytes, the snapshot, every refusal, the byte ratio |
| `frontend/src/lib/generateApi.ts` | Edit | Three event types, `mode` on `file_start` |
| `frontend/src/lib/generationSink.ts` | **New** | `GenerationSink` — one method per frame — and `dispatchGenerationEvent`, an exhaustive router. A new frame is a compile error, not a silently ignored event |
| `frontend/src/lib/generationSink.spec.ts` | **New** | Every frame reaches its method with the right arguments; an unknown frame cannot type-check |
| `frontend/src/lib/streamingDocuments.ts` | **New** | `StreamingDocuments` — the per-path streaming model: `begin` / `rebase` / `push` / `end` / `content` / `states` / `clear`. Owns prefix-suffix composition, the pending-base buffer and the row state |
| `frontend/src/lib/streamingDocuments.spec.ts` | **New** | Composition at every step, insertion vs replacement, the late rebase, clear |
| `frontend/src/lib/editorContent.ts` | Edit | The `splice` case |
| `frontend/src/lib/files.ts` | Edit | `FileRow.state` replaces `writing` |
| `frontend/src/lib/messageParts.ts` | Edit | `[edit: …]` and `[error: …]` markers |
| `frontend/src/stores/workspace.ts` | Edit | `streamingFiles` composition, `editAnchors`, the lazy fetch, `generateFileError` removed |
| `frontend/src/components/workspace/CodeEditor.vue` | Edit | Apply a splice as a ranged edit; reveal the range |
| `frontend/src/components/workspace/FileTree.vue` | Edit | Three row states |
| `frontend/src/components/workspace/MessageBody.vue` | Edit | The edit chip and the error chip |
| `frontend/src/components/workspace/ChatPanel.vue` | Edit | The `generate-file-error` block is deleted |
| `tests/e2e/edits.spec.ts` | **New** | L5: the demo walk |
| `tests/e2e/files.spec.ts` | Edit | The `generate-file-error` assertion moves into the bubble |

## Task list

### T1 — The grammar table → AC-2
- **Red:** `blocks.spec.ts` — *"recognises each of the five open tags only at a line start with at most eight leading spaces"*, plus *"a delimiter with trailing text on its line is content"*.
- **Green:** `blocks.ts` — `VERBS` as a `satisfies` table of `{ verb, open, close, separator }`, the `OPEN_LINE`/`CLOSE_LINE` regexes built from it, `MAX_LINE` computed over the longest head.
- **Refactor:** delete the single-verb constants from `fileops.ts`, re-export `OPEN_HEAD`/`CLOSE_TAG` names only where `prompt.ts` needs them.

### T2 — The splitter, three grammars → AC-1, AC-5, AC-6
- **Red:** `blocks.spec.ts` — one case per verb producing `open` → (`separator`) → `close` with the right `content` events between; a two-section verb closing with no separator produces a `close` whose `separator` never fired; a one-section verb that *does* carry a separator line treats it as content.
- **Green:** the state machine — `mode: 'prose' | { verb, path, section }`, live-delimiter set by section.
- **Refactor:** name the live set as one function so the hold-back predicate and `takeLine` read from the same place.

### T3 — Chunking invariance → AC-3
- **Red:** `blocks.spec.ts` — a fixture reply using all five verbs, pushed split at **every** offset, asserting identical event sequences.
- **Green:** generalise `couldBeDelimiter` over the live set: prefix-of-any, or complete-then-blank.
- **Refactor:** assert `MAX_LINE` is a real bound with an adversarial input (a megabyte after `path="`).

### T4 — The anchor matcher → AC-10, AC-11, AC-12
- **Red:** `patch.spec.ts` — exact unique match returns its line window; zero returns `none`; two return `many`; a match found only after trailing whitespace and `\r` are stripped returns its window.
- **Green:** `findAnchor(lines, anchorLines)` — exact pass, then the normalised pass, both counting all windows.
- **Refactor:** one comparator parameterised by the normaliser, so the two passes cannot diverge.

### T5 — Range resolution per verb → AC-9, AC-9a, AC-9b, AC-7
- **Red:** `patch.spec.ts` — `append` gives `from === to === lines+1` and appends; `after` gives `from === to === end+1` and keeps the anchor; `before` gives `from === to === start`; `edit` spans the anchor; an empty replacement deletes.
- **Green:** `resolveStep(content, step)` returning `{ content, range }` or a `PatchFailure`.
- **Refactor:** the splice is one helper both branches call.

### T6 — The refusals → AC-6, AC-13
- **Red:** `patch.spec.ts` — an unknown path gives `edit-unknown-file` for each of the four verbs; an empty anchor and an empty payload give `edit-malformed`.
- **Green:** the guards, ordered path → shape → match, so the message a user sees names the first thing that is wrong.
- **Refactor:** —

### T7 — Sequencing → AC-14, AC-15
- **Red:** `patch.spec.ts` — three ops on one path, each anchored in the last one's output, all land; a `file` block followed by an `append` appends to the block's content.
- **Green:** `createWorkingCopy(files)` and `applySteps(files, steps)`, the second built on the first.
- **Refactor:** `applySteps` returns the ops in `path` order so `validateFileOps` sees a stable set.

### T8 — Rejection copy → AC-20, AC-16
- **Red:** `files/schema.spec.ts` — one assertion per new reason, each naming the path through `displayPath`; the union stays exhaustive (a `satisfies` check that fails to compile if a reason has no line).
- **Green:** five arms in `fileErrorCopy`, five members in `FileRejection`.
- **Refactor:** —

### T9 — The collector, file blocks → AC-24a
- **Red:** `fileops.spec.ts` — `createFileCollector([{path:'a.js',…}])` emits `file_start { path, mode:'rewrite' }` for `a.js` and `mode:'create'` for a new path.
- **Green:** the collector takes the project's files and seeds the working copy; `mode` from membership.
- **Refactor:** update every existing call site and spec to the new signature in this commit, so the suite stays green.

### T10 — The collector, located blocks → AC-21, AC-22, AC-24
- **Red:** `fileops.spec.ts` — an `edit` emits `edit_start` at the separator with the resolved range, then chunks, then `edit_end`; an `append` emits `edit_start` at the **open tag**; an unresolvable anchor emits none of the three and leaks no content into any `token` frame.
- **Green:** the anchor buffer, the resolve-at-separator branch, the swallow-on-failure branch, `CollectResult.steps` and `CollectResult.failure`.
- **Refactor:** one `emitLocated` so the four verbs share a path.

### T11 — The markers → AC-23
- **Red:** `fileops.spec.ts` — a resolved located block emits exactly one `[edit: <path>]` token; `messageText` equals the concatenation of `token` frames for a reply using all five verbs.
- **Green:** the marker beside the existing `[file: …]`.
- **Refactor:** —

### T12 — Unterminated and truncated → AC-4
- **Red:** `fileops.spec.ts` — a block of each verb left open reports `unterminated` with its path and contributes no step.
- **Green:** extend the existing `unterminated` handling to carry the verb's path from the block state.
- **Refactor:** —

### T13 — The write path re-applies → AC-17, AC-19
- **Red:** `files/handlers.spec.ts` — `planFileWrites` given steps and a *different* `existing` set resolves against the new content; a step whose anchor no longer resolves returns `edit-stale`.
- **Green:** `planFileWrites` calls `applySteps(existing, collected.steps)` and maps a `PatchFailure` to `edit-stale` when the stream-time resolution had succeeded, or to the failure's own reason when it had not.
- **Refactor:** the stream-time `ops` stop being read by the write path at all — delete the field if nothing else wants it.

### T14 — Frames on the wire → AC-21 (encoding)
- **Red:** `generate.spec.ts` (functions) — `encodeFrame` maps each new collector frame to its SSE event and refuses to compile if a frame kind is unhandled.
- **Green:** three `case`s and the `mode` field.
- **Refactor:** —

### T15 — The refusal into the transcript → AC-20, AC-29
- **Red:** `generate.spec.ts` — a turn with a file rejection writes one extra `token` frame carrying `[error: …]` before `done`, and the stored content equals the concatenation of the token frames.
- **Green:** build the marker from `fileErrorCopy`, strip `]` and newlines, emit the frame, append to the content passed to `appendAssistantMessage`.
- **Refactor:** —

### T16 — The system prompt → AC-38 (prompt half)
- **Red:** `prompt.spec.ts` — the prompt names all five verbs, each delimiter string comes from the `blocks.ts` constants, the policy sentence is present, and the cached prefix still estimates over 1,024 tokens with no interpolated value.
- **Green:** the new block text in `SYSTEM_PROMPT[1]`, plus `projectState.ts`'s instruction paragraph.
- **Refactor:** —

### T17 — Fixtures and markers → AC-36 (input side)
- **Red:** `fake.spec.ts` — each new marker selects its fixture; `reply-edit.json`'s anchor is a **literal substring** of `reply.json`'s `styles.css` block.
- **Green:** the four fixtures, six `MARKERS` entries, six `planFor` arms, and the README rows.
- **Refactor:** —

### T18 — L4, the happy paths → AC-17, AC-18, AC-9a, AC-9b, AC-36
- **Red:** `tests/integration/generate-edits.spec.ts` — generate with `reply.json`, then `__edit`: `styles.css` is byte-identical outside the changed rule, `index.html` and `app.js` are untouched, one snapshot holds all three, and the bytes emitted inside blocks are under a tenth of the resulting file. Then `__insert`: the anchor survives byte for byte.
- **Green:** — (wiring already done; this is the end-to-end proof)
- **Refactor:** —

### T19 — L4, the refusals → AC-11, AC-12, AC-13, AC-19, AC-22
- **Red:** same file — `__edit_missing`, `__edit_ambiguous`, `__edit_unknown_file`, `__edit_unterminated` each leave every file document byte-identical and name their reason; a `PUT` between the read and the write produces `edit-stale`.
- **Green:** — (the stale case needs a test seam: a hook the emulator honours to write a file mid-stream, or a `__slow` variant plus a concurrent `PUT` from the test)
- **Refactor:** —

### T20 — Project state: selection vs rendering → AC-34
- **Red:** `projectState.spec.ts` — a file whose length changes does not move any other file's section; selection under budget is still by ascending size.
- **Green:** split `orderForReading` into `selectForBudget` and `orderForRender`.
- **Refactor:** —

### T21 — The request reshaped → AC-32, AC-33, AC-35
- **Red:** `params.spec.ts` — `system` is `SYSTEM_PROMPT` **by identity** on every request including one with files; exactly two `cache_control` breakpoints, on the last system block (`ttl: '1h'`) and the last assistant message; no breakpoint on the project-state block. `context.spec.ts` — two consecutive turns share a byte-identical prefix up to the breakpoint.
- **Green:** `buildContext` emits block-array content and marks the last assistant turn; `buildParams` appends the project-state block to the final user message.
- **Refactor:** `buildProjectState` returns a `TextBlockParam` still — only its destination changes.

### T22 — The editor splice → AC-30
- **Red:** `editorContent.spec.ts` — a mid-file change returns `{ kind:'splice', offset, length, text }` covering the minimal range; an append still returns `append`; equal inputs still return `null`; the fake model records no `setValue`.
- **Green:** common-prefix / common-suffix scan.
- **Refactor:** —

### T23a — `StreamingDocuments` → AC-25
- **Red:** `streamingDocuments.spec.ts` — `begin('a.css','editing',{prefix,suffix})` then two `push`es gives `prefix + body + suffix` at every step; an insertion (`from === to`) keeps the whole original around the body; `begin(...,'creating',null)` gives the body alone; `states()` reports one mode per open path; `end` leaves the content readable and `clear` empties everything.
- **Green:** the class, over a `reactive(new Map())` so per-path mutation stays granular — the property the store's current in-place `streamingFiles[path] +=` was written for.
- **Refactor:** `content()` is the only read path; nothing outside reaches a field.

### T23b — `GenerationSink` → AC-25, AC-26
- **Red:** `generationSink.spec.ts` — a stub sink recording calls receives exactly one call per frame with the frame's fields; `dispatchGenerationEvent` reports `'closed'` for `done` and `error` and `'open'` otherwise.
- **Green:** the interface and the `switch`, exhaustive over `GenerateEvent['type']` so a new frame fails to compile.
- **Refactor:** `runGeneration`'s `for await` body becomes `if ((await dispatch(sink, event)) === 'closed') return` — the seven-branch `if` chain goes.

### T23c — The store implements the sink → AC-25, AC-26
- **Red:** `workspace.spec.ts` — `edit_start` for a path the store holds composes around the change; for a path it does not, it fetches once, buffers chunks meanwhile, and rebases when the fetch lands; a rejected fetch shows the new text alone without throwing.
- **Green:** `createWorkspaceSink()` inside the store, holding the `StreamingDocuments` instance and the generation guard.
- **Refactor:** —

### T24 — The store, refusal in the bubble → AC-29
- **Red:** `workspace.spec.ts` — `generateFileError` no longer exists; the refusal arrives in the message content. `ChatPanel.spec.ts` — no `generate-file-error` node.
- **Green:** delete the ref and the template block; update `WorkspaceView.spec.ts` and `tests/e2e/files.spec.ts`.
- **Refactor:** —

### T25 — Tree and chips → AC-27, AC-28
- **Red:** `files.spec.ts` — `FileRow.state` is `creating` / `rewriting` / `editing` / `idle`. `messageParts.spec.ts` — the two new markers parse; a marker with a `]` in it does not. `FileTree.spec.ts`, `MessageBody.spec.ts` — the rendered words.
- **Green:** the union, the regexes, the templates.
- **Refactor:** —

### T26 — Monaco applies the splice → AC-31 (unit half)
- **Red:** `CodeEditor.spec.ts` — a splice becomes one `applyEdits` over the computed range and one `revealLineInCenterIfOutsideViewport`, not a full-range replace.
- **Green:** the third branch in `syncModel`, converting offset→position through the model.
- **Refactor:** —

### T27 — L5, the demo → AC-31
- **Red:** `tests/e2e/edits.spec.ts` — generate, then `__edit`: the tree row reads *Editing*, the lines above the anchor hold their screen position, the changed range is revealed, and the file afterwards contains both the original rules and the new ones.
- **Green:** —
- **Refactor:** —

### T28 — The measured negative → AC-38
- **Not a test.** `git diff main...HEAD --stat -- firestore.rules tests/rules` must list nothing; the output goes in `04-build-log.md`. Stated as a task because Slice 12 proved that an unmeasured "we changed no rules" is a claim rather than a fact.

## Firestore rules changes

**None.** No collection, no document shape and no field changes — an op of any verb resolves to
a whole-file write before it reaches `stageFileWrites` (PRD D4/D19). T28 measures the negative
rather than asserting it. The existing L3 suite is re-run unchanged and its 52 cases must stay
at 52.

## Dependencies

**None.** No new package on either side. The five verbs are string handling, the matcher is
array comparison, and the caching change is two fields on objects the SDK already types.

## Manual verification

On emulators (`npm run dev`), with the fake model:

1. New project → prompt anything → three files appear, tree rows read **Creating**.
2. Prompt `__edit` → `styles.css` opens, the `body` rule changes **in place**, the rules below it
   do not move on screen, and the new dark-theme block appears at the end of the file.
3. Prompt `__insert` → `index.html`'s heading stays exactly as it was and the button appears
   directly after it.
4. Prompt `__edit_missing` → nothing changes in the tree, and the refusal is **inside the
   assistant bubble**; reload the page and it is still there.
5. Open **History** → the version written by step 2 restores to the pre-edit state.

With the real model (`GENESIS_LOCAL_REAL_LLM=1`, a key in `functions/.secret.local`) — this is
the half no automated test can reach:

6. Build a dashboard, then "add a dark theme": confirm the reply uses `append` / `after` / `edit`
   rather than `<genesis:file>`, and record the output-token count from `generation.complete`
   against the same prompt on `main`.
7. Send a third prompt within five minutes: confirm `cacheReadInputTokens` is non-zero.

## Estimate

| Tasks | Work | Estimate |
|---|---|---|
| T1–T3 | The grammar and the splitter | **4 h** — the hold-back predicate over five verbs is the riskiest code in the slice |
| T4–T8 | The matcher, the ranges, the copy | 3 h |
| T9–T12 | The collector | 3 h |
| T13–T15 | The write path and the wire | 2 h |
| T16–T17 | Prompt and fixtures | 2 h |
| T18–T19 | L4 | **3 h** — T19's stale case needs a test seam that does not exist yet |
| T20–T21 | Caching | 2 h |
| T22–T26 | Frontend | 4 h |
| T27 | L5 | 1 h |
| T28 | The measurement | 10 min |
| | | **≈ 24 h** |

**Over half a day, flagged:** T1–T3 (the splitter generalisation — Slice 6 found a real bug in
exactly this code, and the property test is the only thing that will find the next one) and
T18–T19 (L4, where the concurrent-`PUT` case needs a seam invented). If the clock bites, T20–T21
lift out into their own PR without touching anything above them (PRD R7).

## Coverage check

Every AC maps to a task: AC-1/T2 · AC-2/T1 · AC-3/T3 · AC-4/T12 · AC-5,6/T2,T6 · AC-7/T5 ·
AC-8/T2 · AC-9,9a,9b/T5 · AC-10,11,12/T4 · AC-13/T6 · AC-14,15/T7 · AC-16,20/T8,T15 ·
AC-17,18/T13,T18 · AC-19/T13,T19 · AC-21,22,24/T10 · AC-23/T11 · AC-24a/T9 · AC-25,26/T23 ·
AC-27/T25 · AC-28/T25 · AC-29/T24 · AC-30/T22 · AC-31/T26,T27 · AC-32,33,35/T21 · AC-34/T20 ·
AC-36/T17,T18 · AC-37 — **already true on `main`** and re-asserted in T18 rather than
implemented · AC-38/T28.
