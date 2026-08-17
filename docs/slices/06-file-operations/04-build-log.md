# Slice 06 — File operations · Build log

**Branch:** `slice/06-file-operations` · **Plan:** `03-plan.md` · **PRD:** `02-prd.md`
**Started:** 2026-08-17

Appended as the build runs, one section per task. A deviation from the plan is recorded here
with its reasoning at the moment it is taken, not reconstructed at the end.

## Baseline

Cut from `main` at `5bc7e54` (Slice 05 — Streaming generation). Before a line was written:

| Suite | Result |
|---|---|
| `typecheck` | pass |
| `lint` | pass |
| `test:unit` | pass |
| `test:rules` | 28 passed |
| `test:integration` | 232 passed |
| `test:e2e` | pass |

No pre-existing failure to surface.

## T1 — The filename, and what may not be one (AC-11)

`functions/src/files/schema.ts` + `schema.spec.ts`, 30 L1 cases. `filePathSchema` refuses by the
shape of a name — first character a letter or digit, no slash, no `..`, one allowlisted extension
over a non-empty base — plus `displayPath`'s control-character strip and 40-character truncation.

**Deviation.** The plan's red list writes the over-length case as `'a'.repeat(61)+'.js'`, which is
64 characters and therefore *accepted* under `PATH_MAX = 64`. The PRD's AC-11 says "a 65-character
name", so the test uses `'a'.repeat(62)+'.js'` and a 64-character name was added to the accepted
list, making the boundary a fact in both directions. The plan's arithmetic was the slip, not the
PRD's rule.

Commit: `d00c2bd`.

## T2 — The op set, refused whole (AC-12 – AC-15)

`functions/src/files/opset.spec.ts` (new, 42 cases) plus the rest of `files/schema.ts`.
`validateFileOps` runs P5's order and the first failure ends the whole set; `fileErrorCopy`
switches on a discriminated `FileRejection` so a new refusal reason cannot be added without a copy
line, and all seven sentences are asserted verbatim.

**Deviation (small).** The plan put these cases in `files/schema.spec.ts`. They live in a new
`files/opset.spec.ts` instead: `schema.spec.ts` is about what a *name* may be and `opset.spec.ts`
about what a *set* may be, which are the slice's two separate refusal boundaries, and one file of
72 cases reads worse than two of 30 and 42.

**Deviation.** `FileOp` is declared in `files/schema.ts` rather than in `llm/fileops.ts`. The plan
puts it in `fileops.ts`, but `fileops.ts` already imports `PATH_MAX` from `files/schema.ts` for its
hold-back bound, so declaring the type the other way round would be an import cycle. `fileops.ts`
re-exports it, so the plan's file map still reads true from the outside.

`putFileBodySchema` counts its cap with `superRefine` over `byteLength` rather than `.max()`, which
counts UTF-16 code units and would admit 60,000 three-byte characters at 180,000 bytes.

Commit: `3f78f72`.

## T3 — The splitter and the collector (AC-1, AC-2, AC-3)

`functions/src/llm/fileops.ts` + `fileops.spec.ts`, 18 L1 cases. Built exactly to the plan's
specification: a line-oriented state machine holding back only the trailing partial line, and only
while it could still become a delimiter.

**Amendment to the plan.** `CollectResult` gains a `frames: CollectorFrame[]` field, and `finish()`
returns it. The plan pins `finish(): { messageText, ops, unterminated }`, but P1 allows a delimiter
line to end at end of input as well as at a newline — so a reply whose last bytes are
`</genesis:file>` resolves its close *after* the final `push`. Without these frames that file's tail
chunk and its `file_end` would never reach the client, and AC-25's "the concatenated chunks equal
the stored content" would be false for exactly the shape a model most often produces. `generate.ts`
writes them before the terminal frame.

**Clarification.** The two line regexes are built with `new RegExp` from `MAX_INDENT`, `OPEN_HEAD`,
`OPEN_TAIL` and `CLOSE_TAG` rather than written out as literals. The plan shows literals; a literal
`{0,8}` beside a `MAX_INDENT = 8` is two sources for one rule, and D25 requires the prompt to be
interpolated from these same constants.

Commit: `cd9f72d`.

## T4 — Near-delimiters, tags in content, the line-start rule (AC-5, AC-6)

33 further L1 cases, driven against the **splitter** rather than the collector, because what is
being asserted is the grammar and the two normalisers would sit between the assertion and the thing
it is about. `MAX_LINE` is asserted rather than argued.

The implementation these cover landed with T3 — the three-block case could not pass without the
mode split — so the tests were verified meaningful by mutation instead of by an empty module:
uncapping `INDENT` fails the two nine-space cases, and removing the mode split fails ten.

Commit: `0d49c74`.

## T5 — Unterminated blocks and the D16 repairs (AC-7, AC-8)

14 further L1 cases. Verified by mutation: removing the CRLF repair fails two, recording the
unterminated block as an op fails two.

Commit: `769f4b8`.

## T6 — The message invariant and the marker-only reply (AC-9, AC-10)

`FIXTURES` — 21 shapes including every malformed one — with the invariant asserted over all of
them, plus "no file content in the message" and "no empty text frame". Verified by mutation:
accumulating `messageText` from the input rather than from the emitted frames fails 26 cases.

Commit: `bcbb132`.

## T7 — Chunking invariance (AC-4, R1) — **it found a real bug**

The property is every fixture driven split at every single offset, one UTF-16 code unit at a time,
and with empty pushes interleaved. The plan expected this task to be "green on arrival". It was not.

**The bug.** Once a partial line has been emitted — because it could not be a delimiter, or because
it grew past `MAX_LINE` — the rest of that line arrives in a later push and is *not* at a line
start. Untreated, the tail `</genesis:file>\n` of the prose line `x</genesis:file>` read as a close
tag when the two halves arrived in separate deltas, and as prose when they arrived together. Every
one of the 65 hand-written cases above passed, because a hand-written test chunks on whole tags.
This is R1's failure mode precisely, one level in from where the risk register expected it.

**The fix.** `atLineStart` replaces `holding` and now gates *both* the delimiter test in the line
loop and the hold predicate, and `finish()` respects it too.

Commits: `bcbb132` (corpus), `fa41798` (property + fix).

## T8 — The collection's rules, before anything writes to it (AC-32, AC-33)

`firestore.rules` gains the deny-all block for
`users/{uid}/projects/{projectId}/files/{fileId}`, and `tests/rules/firestore.spec.ts` gains eight
cases: five for the owner, one for a verified stranger, one for an anonymous client, and AC-33's
one-pass re-assertion over every collection. 28 → 36 L3 cases.

The tests pass against the *unedited* rules too, because an unmatched path is denied by default —
which the plan predicted. Verified meaningful by mutation: an
`allow if request.auth.uid == uid` block for files fails six of them.

Commit: `1e3a1b1`.

## T9 — One batch per turn (D11, P7)

`functions/src/files/handlers.ts` + `handlers.spec.ts` (24 L1 cases), and
`appendAssistantMessage` rewritten around a `WriteBatch`. `messages/handlers.spec.ts`'s `fakeDb`
grew `batch()` and every existing call gained the fifth argument.

**Deviation.** The fifth parameter is `FileWritePlan[]`, not the plan's `FileWrite[]` —
`FileWrite` plus an `exists` flag. `stageFileWrites` needs create-versus-update to preserve
`createdAt` (AC-19), and `readFilePaths` has already answered that question for the cap check;
re-reading it inside the write path would be a second answer to it.

`generate.ts` passes `[]` at this point, replaced in T11.

Commit: `e278ff7`.

## T10 — The fake grows files (D26, R8)

`reply.json` becomes prose + `index.html` + `styles.css` + `app.js` + closing prose, with its
**prose byte-identical** and each block split across several deltas. `max-tokens.json` gains an
opened block before its cut-off (P6). Four new fixtures and four new markers.

`fake.spec.ts` pins the five recorded prose deltas, so R8's promise is asserted rather than
trusted. Integration stayed at 232 passing and e2e at 12 — the existing assertions are about prose
that has not moved.

Commit: `d1cbb35`.

## T11 — The write path, over the wire (AC-16 – AC-25)

`tests/integration/generate-files.spec.ts`, 17 L4 cases, red before a line of the wiring existed.
`lib/sse.ts`, `llm/schema.ts`, `llm/index.ts`, `files/handlers.ts`'s `planFileWrites` and
`generate.ts` are the green step.

**Amendment to the plan.** The plan's green step writes
`completed = event.kind === 'end' && !truncated`, using the *forced* `truncated` — which is
`clientGone || …`. That would make a client disconnect suppress the file write, and D10 says the
opposite in as many words: "`clientGone` does not suppress the write: the files belong to the
project, not to the connection", which the PRD's edge-case table repeats ("The client disconnects
after a clean `end` → Message and files still commit"). The implementation reads the **mapper's
own** `event.truncated` instead. There is an L1 case for it in `generate.spec.ts`, because the
functions emulator never propagates a disconnect to the runtime.

**One existing assertion changed.** `generate.spec.ts`'s client-gone case expected `'one two '` and
now expects `'one two'`: the collector is the single producer of the chat text and D16 trims it in
the emitted stream. The invariant that case actually guards — persisted content equals the token
frames — is unchanged and still asserted, at L1 over 21 fixtures and at L4 over the wire.

`tests/integration/generate.spec.ts` gained a comment only; its assertions are untouched (R8).

Commit: `cc2b05c`.

## T12 — The three routes (AC-26 – AC-31)

`tests/integration/files.spec.ts` (26 L4 cases), `functions/src/index.spec.ts`'s router scan, and
`files/handlers.ts` + `files/index.ts` + the mount.

**A finding, recorded because it changed a test.** A whole path segment of `..` — encoded or not —
never reaches the file handler: URL normalisation collapses `/files/..` and `/files/%2E%2E` before
routing, so the request resolves one segment up to the project route. This was measured, not
assumed. It is safe rather than lucky, since the segment is gone before anything could compose a
document path from it, so the case asserts the negative that matters (**no file is reachable that
way**) instead of the 400 the plan expected. The encoded traversals that *do* arrive —
`%2e%2e%2fsecrets.js`, `%2fetc%2fpasswd`, `%2e%2e%5csecrets.js` — are refused `400 invalid_path`
for failing to be filenames.

The "no Firestore read before a refusal" clause of AC-27 is made observable: a `400 invalid_path`
against a project id that does not exist could only be a 404 if the lookup had happened first.

Commit: `cf755ce`.

## T13 — The system prompt learns the format (AC-34, D25)

A second `TextBlockParam` describing the tag pair, the flat-filename rule, the extension
allowlist, both caps, and that a reply with no files is a complete answer rather than a failure
(D17). `cache_control` moves to it, so the breakpoint is still the last element of the stable
prefix.

Every value in it is interpolated from the module that decides it — the tag pair from
`fileops.ts`, the extensions and the caps from `files/schema.ts` — and the spec imports the same
constants to assert it. That is the assertion that catches the silent failure: a prompt
documenting a grammar the parser no longer speaks has no symptom except the model producing
output we reject.

Slice 5's "belongs to a later slice" case keeps its needles and changes what it asserts (P9): a
triple-backtick fence is the delimiter D2 rejected, and `FILE:` and `file_start` are two
spellings it is not, so their absence now pins the sentinel format rather than the block's
absence.

Commit: `d424356`.

## Interruption — the session that built T1–T13 ended at a usage limit

The build session was cut off mid-T14 at 22:35. T1–T13 were committed; T14, T15 and T16's spec
files survived in a stash and were restored here. `main` had not moved, and HEAD (`d424356`) was
re-verified green — typecheck, lint, 514 unit tests — before the stash was applied. The three
tasks below were then finished and committed one at a time, each with the working tree green,
rather than as one recovery commit.

## T14 — The typed file client (AC-35)

`frontend/src/lib/filesApi.ts` + `filesApi.spec.ts`, 10 L1 cases. `listFiles`, `getFile` and
`saveFile` over `apiClient.request`, so each carries the ID token and the App Check header the
way every other typed client does. No path names a user. The filename is percent-encoded into
the URL — the two sides agreeing, rather than the client relying on the server's refusal.

`FILE_BYTES_MAX` and `FILE_LIMIT` are mirrored rather than imported, the precedent
`messagesApi.ts` set with `MESSAGE_LIMIT`: `frontend/` cannot reach `functions/`, and the editor
needs them to disable **Save** before issuing a request that would be refused.

Commit: `9bb34cd`.

## T15 — The stream client learns three events (AC-36)

`generateApi.ts` gains `file_start`, `file_chunk`, `file_end`, and `done` gains `files` and
`fileError`, with 12 further L1 cases. The new `done` fields are read tolerantly — a malformed
one defaults rather than rejecting the frame, because a `done` that fails to parse leaves the
placeholder bubble on screen forever.

**Deviation.** `asFiles` narrows entry by entry instead of the plan's `value as string[]`, which
ESLint's `no-unnecessary-type-assertion` rejects and `CLAUDE.md` would reject anyway. One
non-string member makes the whole list untrustworthy rather than partly usable: the store
refetches by exactly these paths.

**One existing file changed, minimally.** `stores/workspace.ts`'s terminal handling read as the
generation loop's fall-through while `GenerateEvent` had three members. With six, the three file
frames would have fallen into it and had a `path` read as an error message, so the `error` case
became an explicit branch. The file frames are not consumed yet — that is T18 — and the compiler
is what forced the question here rather than at runtime.

Commit: `25b0808`.

## T16 — The pure client helpers (AC-44, AC-45, AC-46's L1 halves)

`frontend/src/lib/files.ts` and `messageParts.ts`, 27 L1 cases. Three decisions made once, so
the components reflect them rather than re-derive them: `compareFilePaths` (entry point first,
then alphabetical, plain `<` rather than `localeCompare` over a known ASCII subset),
`mergeFileTree` (the union, so a first write appears and a rewrite appears once), `utf8Bytes`
(the cap's unit — `String.length` would enable a Save the server refuses), and
`splitMessageContent` (whole-line marker match only, and it has to behave on a message cut off
mid-marker because the streaming placeholder is the same string).

Commit: `280ef0b`.

## T17 — The store: the list, the selection, the save (AC-37, AC-38)

`useWorkspaceStore` grows the file half — 19 further L1 cases, and the existing 43 kept passing
with one mechanical change: `open` now issues a third request, so every fixture that queued two
responses queues three.

`fileDirty` is **derived** (`fileContent !== savedContent`) rather than maintained as a flag. A
flag has to be set on every edit path and cleared on every load and save path, and the first one
anybody forgets either offers Save for an unchanged file or withholds it over a real edit.

`open` loads the files after the transcript, unconditionally — a failed transcript is the chat
panel's error state and has no business emptying the code panel, which is its own case. A failed
list leaves the existing list alone, because emptying the tree claims "this project has no code"
rather than "we could not reach the server".

**Deviation (small, additive).** `saveFile` also refreshes that file's entry in `files` from the
save response. The plan did not name it; the list carries `size` and `updatedAt` and the
response is the server's own word for both, so the alternative is a stale row or a second `GET`.

Commit: `5c44fe6`.

## T18 — The store: the generation fan-out (AC-39 – AC-43) — **the plan was wrong here**

17 further L1 cases. `streamingFiles` is a mutated `Record` keyed by each frame's own path (D5);
`fileTree` is `mergeFileTree` over stored ∪ streaming; `editorContent` prefers the streaming
buffer; `done` refetches and re-reads.

**Amendment to the plan.** AC-40 reads "given `done` with a non-empty `files`, then the list is
refetched, **the open file is re-read**", and the plan's task list repeats it. Taken literally
that re-reads a file the generation never touched — silently discarding an unsaved edit to it,
which is R4's failure arrived at from the other side, with no AC blessing it and nothing on
screen to explain it. The implementation re-reads the open file **when it is in `done.files`**.
A file this turn did not write keeps its buffer, dirty included, and has its own case. AC-41 is
then exactly the criterion it says it is — a dirty buffer *for a file the generation rewrote* —
and `fileReplaced` announces the discard (D22).

**A consequence the ACs did not cover, handled here.** `file_start` auto-selects the first
streamed file, so a turn whose op set is refused (`__bad_path`) leaves the selection pointing at
a file that was never stored. It is dropped at `done`, so the editor shows its empty state
rather than a filename with no file behind it. Its own case.

`saveFile` refuses to issue while `generating` — D21 at the store rather than only in the
component, because a keyboard shortcut does not go through the button. The streaming buffers are
dropped in `finally`, so done, error, abort and a thrown request all end the same way, and
*after* the `done` branch's refetch, so the tree does not flash empty for the length of the list
request.

Two ESLint findings were taken rather than suppressed: `selectedPath.value ??= event.path`, and
the terminal `error` branch back to a fall-through now that the other five variants are handled
above — exhaustion, so the compiler is what keeps it honest if a seventh event is ever added.

Commit: `2dd95cb`.
