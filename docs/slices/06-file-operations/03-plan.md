# Slice 06 — File operations · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/06-file-operations` · **Date:** 2026-08-17

## Approach

The reply is split into files **as it streams**, by one pure line-oriented state machine in
`functions/src/llm/fileops.ts` that sits between `mapStream` and the SSE framing: it consumes
text deltas and emits `token` / `file_start` / `file_chunk` / `file_end` frames, then answers
`finish()` with the chat text, the ops, and the path of any block left open. Because every
delimiter occupies a whole line, the splitter processes complete lines and holds back only the
trailing partial one — and only while that partial could still become a delimiter — which makes
D4's chunking invariance a property of the shape rather than a patch on top of it. Validation is
a second, separate step: `functions/src/files/schema.ts` parses the whole op set once at the
terminal event with Zod, and `finishTurn` either stages every file into the same `WriteBatch` as
the assistant message or stages none of them and names the refusal in `done.fileError`. Three
routes (`GET` list, `GET` one, `PUT` one) expose the collection; the frontend gets a typed
client, three new pure helpers, an extended `useWorkspaceStore`, and two new components inside
the code panel.

**Alternatives considered.** A character-scanning splitter with a byte-counted hold-back —
rejected: the hold-back bound is then an arithmetic argument rather than a structural one, and
the failure it protects against is invisible in review. Parsing the completed string once at the
end — rejected by D3: F4.2 needs live boundaries, and a second terminal parse is a second
implementation of one grammar. A `files` store of its own — rejected by D24: the generation fans
out into both the transcript and the files, so a second store needs the same generation counter
and the same reset. Reading existing file documents inside a transaction — rejected: the union
cap is a guard-rail read immediately before the write, exactly as `liveProjectCount` and
`messageCount` already are, and last-write-wins is D23's stated rule.

## Plan decisions

These refine the PRD where it left an implementation choice open. Each is a decision made here,
recorded so the build does not have to re-make it.

| # | Question the PRD left open | Decision | Why |
|---|---|---|---|
| **P1** | May a delimiter line carry trailing text after the tag? | **No.** A delimiter line is `[ \t]{0,8}` + the tag + `[ \t]*` + end of line (or end of input). Anything else on the line makes it prose. | D2 says "on its own line". Allowing a trailing suffix would make `<genesis:file path="a.js"> and here is why` open a file *and* eat the sentence, which is the wrong-but-plausible outcome D16 refuses. Leading whitespace is capped at 8 so the hold-back is bounded (`MAX_INDENT`); unbounded indentation would mean an unbounded held-back tail. |
| **P2** | AC-2 writes the marker frame as `token("[file: index.html]\n")`. | The marker's text enters the **same chat-text normaliser** as everything else, so the trailing `\n` is held back with the following whitespace run and may arrive glued to the next frame. Tests assert **frame order** and **the concatenation** (`messageText`), not per-frame text. | D7 requires all D16 normalisation to happen *in the emitted stream*, and D16 requires runs of 3+ newlines to collapse — which is only decidable once the run ends. Emitting the marker's newline eagerly would make the collapse rule inapplicable at exactly the boundary it matters at. Every substantive clause of AC-2 (order, one op, tags and adjoining breaks removed, exactly one trailing `\n`) is asserted. |
| **P3** | How is "content ends with exactly one `\n`" reconciled with AC-25 ("concatenated chunks equal the stored content")? | The collector **holds back trailing newline runs inside file content too**. At `file_end` the held run is emitted as a final `file_chunk` of exactly `"\n"` (or nothing, if the file is empty). | Trimming at `finish()` instead would make the streamed chunks disagree with the stored bytes — a silent drift of exactly the kind R5 names, one layer down. With the hold-back, AC-25's equality holds by construction rather than by luck. |
| **P4** | Which delimiters are recognised in which mode? | In prose mode only the **open** tag is a delimiter; inside a block only the **close** tag is. A stray `</genesis:file>` in prose is prose; a nested `<genesis:file …>` inside a block is content. | AC-5 requires content preserved verbatim including a `<genesis:` line. It also halves the candidate set the hold-back predicate has to consider. |
| **P5** | Order of refusal inside `validateFileOps`. | Per op, in the order written: path shape → duplicate-against-earlier-ops → byte cap. After the loop: the union file cap. First failure wins. | Deterministic, so `fileError` is reproducible from a fixture. Path first because a path we cannot name is the one whose *identity* the other two messages depend on. |
| **P6** | Does `done.fileError` fire on a truncated turn that contained no file blocks? | **No** — `null`. The cut-short copy is emitted only when the turn produced at least one op or an unterminated block. | D17: a prose-only reply is a legitimate turn, and a *truncated* prose-only reply is still one. AC-22 remains satisfied because `max-tokens.json` gains a file block (T10). |
| **P7** | Where does the batch live? | `appendAssistantMessage` gains a fifth parameter, `fileWrites: FileWrite[]`, builds one `WriteBatch`, calls `stageFileWrites()` from `files/handlers.ts`, commits, then re-reads the message ref. | D11 wants one commit per turn, and the message is the thing that must be re-read for its `serverTimestamp()`. Import direction is `messages/ → files/`, matching the fact that the message is the turn's anchor and the files hang off it. |
| **P8** | `done.files` ordering. | Sorted ascending by path. | AC-16 only asks that the paths be carried; a deterministic order makes the L4 assertion an equality rather than a set comparison, and it matches the list route's `orderBy('path')`. |
| **P9** | Which existing assertions change, and why. | `frontend/src/views/WorkspaceView.spec.ts:221` and `tests/e2e/workspace.spec.ts:87` both assert the code panel contains "Slice 6". Both are **deleted and replaced** with assertions that the tree and the editor render. `functions/src/llm/prompt.spec.ts`'s "belongs to a later slice" case keeps its needles (` ``` `, `FILE:`, `file_start`) and gets a new comment: they now assert the sentinel format was kept, not that the block is absent. | AC-47 forbids the placeholder text anywhere in the app. Changing a test to match new behaviour is legitimate here because the behaviour change *is* the acceptance criterion; nothing is weakened. |

## File map

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/llm/fileops.ts` | **New** | `OPEN_HEAD`, `OPEN_TAIL`, `CLOSE_TAG`, `MAX_INDENT`; `createFileSplitter()` (pure, syntax-only); `createFileCollector()` wrapping it with the marker, the chat normaliser and the content normaliser; `CollectorFrame`, `FileOp`, `CollectResult` |
| `functions/src/llm/fileops.spec.ts` | **New** | L1 — AC-1 to AC-10, including the AC-4 property |
| `functions/src/files/schema.ts` | **New** | `FILES`, `FILE_LIMIT`, `FILE_BYTES_MAX`, `PATH_MAX`, `FILE_EXTENSIONS`, `filesPath()`, `filePathSchema`, `putFileBodySchema`, `storedFileSchema`, `storedFileMetaSchema`, `toFile()`, `toFileMeta()`, `byteLength()`, `validateFileOps()`, `fileErrorCopy()`, `displayPath()`, `FileMeta`, `FileContent`, `FileWrite` |
| `functions/src/files/schema.spec.ts` | **New** | L1 — AC-11 to AC-15, plus the copy table |
| `functions/src/files/handlers.ts` | **New** | `readFilePaths()`, `stageFileWrites()`, `planFileWrites()`, `readFileList()`, `requireFilePath()`, `handleListFiles`, `handleGetFile`, `handlePutFile`, `parseStoredFile()` |
| `functions/src/files/handlers.spec.ts` | **New** | L1 — `stageFileWrites` document shape and the create-vs-update split; `requireFilePath`; `parseStoredFile`'s `id === path` fail-closed |
| `functions/src/files/index.ts` | **New** | `filesRouter` — the three routes, middleware per route |
| `functions/src/api/index.ts` | Edit | Mount `filesRouter` at `/` and `/api`, after `messagesRouter` |
| `functions/src/generate.ts` | Edit | Collector wired between `mapStream` and the framing; the three new frames; `finishTurn` rewritten around `planFileWrites` + one batch; `done` gains `files` and `fileError` |
| `functions/src/generate.spec.ts` | Edit | The existing L1 cases keep passing; add the client-gone-still-writes-files case (D10) |
| `functions/src/messages/handlers.ts` | Edit | `appendAssistantMessage(uid, projectId, content, truncated, fileWrites)` — one `WriteBatch`, then the re-read |
| `functions/src/messages/handlers.spec.ts` | Edit | `fakeDb` grows a `batch()`; existing cases pass `[]`; new case asserts files and message stage into one batch |
| `functions/src/llm/schema.ts` | Edit | `FileStartPayload`, `FileChunkPayload`, `FileEndPayload`; `DonePayload` gains `files: string[]` and `fileError: string \| null` |
| `functions/src/llm/index.ts` | Edit | Re-export the collector and the three payload types |
| `functions/src/lib/sse.ts` | Edit | `SseEventName` gains `'file_chunk'` |
| `functions/src/lib/sse.spec.ts` | Edit | The new name is encodable |
| `functions/src/llm/prompt.ts` | Edit | Second block: the file-format instructions, interpolated from the constants; `cache_control` moves to it |
| `functions/src/llm/prompt.spec.ts` | Edit | AC-34 — breakpoint on the last block, text derived from constants, nothing volatile |
| `functions/src/llm/fake.ts` | Edit | Four markers: `__no_files`, `__bad_path`, `__unterminated`, `__dup_files` |
| `functions/src/llm/fake.spec.ts` | Edit | The four markers select their fixtures |
| `functions/src/index.spec.ts` | Edit | AC-31's structural half — the file router's guard table |
| `firestore.rules` | Edit | Deny-all block for `users/{uid}/projects/{projectId}/files/{fileId}` |
| `tests/rules/firestore.spec.ts` | Edit | AC-32, AC-33 — every client operation on `files` denied |
| `tests/fixtures/llm/reply.json` | Edit | Prose byte-identical; three file blocks and a closing prose delta appended |
| `tests/fixtures/llm/max-tokens.json` | Edit | An open file block before the cut-off, so AC-22 has something to be cut short |
| `tests/fixtures/llm/prose-only.json` | **New** | Prose, no blocks |
| `tests/fixtures/llm/bad-path.json` | **New** | One block with path `../secrets.js` |
| `tests/fixtures/llm/unterminated.json` | **New** | One block never closed |
| `tests/fixtures/llm/duplicate-files.json` | **New** | Two blocks, both `app.js` |
| `tests/integration/generate-files.spec.ts` | **New** | L4 — AC-16 to AC-25 |
| `tests/integration/files.spec.ts` | **New** | L4 — AC-26 to AC-31 |
| `tests/integration/generate.spec.ts` | Edit | Comment only where `reply.json` now streams files; assertions unchanged (R8) |
| `frontend/src/lib/filesApi.ts` | **New** | `FileMeta`, `FileContent`, `listFiles`, `getFile`, `saveFile`, mirrored `FILE_BYTES_MAX` / `FILE_LIMIT` |
| `frontend/src/lib/filesApi.spec.ts` | **New** | L1 — AC-35 |
| `frontend/src/lib/files.ts` | **New** | `utf8Bytes()`, `compareFilePaths()`, `mergeFileTree()`, `FileRow` |
| `frontend/src/lib/files.spec.ts` | **New** | L1 — the comparator, the merge, the byte count |
| `frontend/src/lib/messageParts.ts` | **New** | `splitMessageContent()`, `MessagePart` |
| `frontend/src/lib/messageParts.spec.ts` | **New** | L1 — AC-46's pure half |
| `frontend/src/lib/generateApi.ts` | Edit | Three file events; `done` gains `files` and `fileError` |
| `frontend/src/lib/generateApi.spec.ts` | Edit | AC-36 |
| `frontend/src/stores/workspace.ts` | Edit | File list, selection, buffer, save, streaming fan-out, refetch, replacement notice, reset |
| `frontend/src/stores/workspace.spec.ts` | Edit | AC-37 to AC-43 |
| `frontend/src/components/workspace/FileTree.vue` | **New** | Loading, empty, error + Retry, rows, selection, writing marker |
| `frontend/src/components/workspace/FileTree.spec.ts` | **New** | L2 — AC-44 |
| `frontend/src/components/workspace/FileEditor.vue` | **New** | Empty, textarea, byte count, Save, dirty, read-only, save error, replaced notice |
| `frontend/src/components/workspace/FileEditor.spec.ts` | **New** | L2 — AC-45 |
| `frontend/src/components/workspace/EditorPanel.vue` | Edit | Placeholder replaced by the two components |
| `frontend/src/components/workspace/ChatPanel.vue` | Edit | File chips in bubbles and in the placeholder; the generation's `fileError` |
| `frontend/src/components/workspace/ChatPanel.spec.ts` | Edit | AC-46's component half |
| `frontend/src/views/WorkspaceView.spec.ts` | Edit | AC-47 — both layouts render the tree and the editor; the "Slice 6" assertion goes |
| `tests/e2e/files.spec.ts` | **New** | L5 — AC-48 |
| `tests/e2e/workspace.spec.ts` | Edit | Line 87's "Slice 6" assertion replaced (P9) |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §0 status, §4 Slice 6, §8's two settled rows, §9's four rows |
| `docs/PRODUCT_SPEC.md` | Edit | §6 items 2 and 5 marked settled, pointing at this PRD |

No `firestore.indexes.json` change (D30). No new package (see **Dependencies**). No new vendored
shadcn component.

## The splitter, specified

The build follows this literally; `fileops.spec.ts` is what proves it.

```ts
export const OPEN_HEAD = '<genesis:file path="'
export const OPEN_TAIL = '">'
export const CLOSE_TAG = '</genesis:file>'
/** Leading whitespace allowed before a tag. Bounds the hold-back (P1, D4). */
export const MAX_INDENT = 8
```

**State:** `mode: 'prose' | 'file'`, `path: string | null`, `pending: string` (the held-back
partial line), `holding: boolean` (whether `pending` may still become a delimiter).

**`push(text)`**, returning `SplitEvent[]`:

1. `buffer = pending + text`. If `buffer` ends with a lone `\r`, hold that character back too —
   a CRLF split across two deltas is the same hazard one character wide.
2. While `buffer` contains `\n`: take the line up to and including it, strip a trailing `\r\n`
   → `\n` (D16's CRLF repair), and hand the line to `takeLine()`.
3. What remains has no `\n`. If `holding` and `couldBeDelimiter(remainder)` and
   `remainder.length <= MAX_LINE`, keep it in `pending`. Otherwise emit it (as `prose` or
   `content` per `mode`), set `holding = false`, and clear `pending`.
4. `holding` becomes `true` again the moment a line is completed.

**`takeLine(line)`** — `line` includes its `\n`. Let `body = line.slice(0, -1)`.

- If `mode === 'prose'` and `OPEN_LINE.test(body)` → emit `{ kind: 'open', path: <capture> }`,
  set `mode = 'file'`. The line itself produces no text.
- If `mode === 'file'` and `CLOSE_LINE.test(body)` → emit `{ kind: 'close', path }`, set
  `mode = 'prose'`.
- Otherwise emit `{ kind: 'prose' | 'content', text: line }` — the whole line, newline included.

```ts
const OPEN_LINE = /^[ \t]{0,8}<genesis:file path="([^"\n]*)">[ \t]*$/
const CLOSE_LINE = /^[ \t]{0,8}<\/genesis:file>[ \t]*$/
```

The path capture is `[^"]*` — **syntax only**. `assets/app.js`, `../x` and the empty string all
open a block here and are refused at the terminal (D8).

**`couldBeDelimiter(partial)`** — mode-dependent (P4). With `indent` = the leading run of
spaces/tabs:

- `indent.length > MAX_INDENT` → `false`.
- `rest = partial.slice(indent.length)`.
- In `file` mode: `CLOSE_TAG.startsWith(rest)`, or `rest.startsWith(CLOSE_TAG)` and the
  remainder is all spaces/tabs.
- In `prose` mode: `OPEN_HEAD.startsWith(rest)`; or `rest.startsWith(OPEN_HEAD)` and, with
  `after = rest.slice(OPEN_HEAD.length)`: no `"` yet and `after.length <= PATH_MAX`; or a `"` at
  index `≤ PATH_MAX` whose remainder is a prefix of `">` followed by spaces/tabs.

`MAX_LINE = MAX_INDENT + OPEN_HEAD.length + PATH_MAX + OPEN_TAIL.length + MAX_INDENT + 1`
(≈ 103) is the hard ceiling on the held-back tail, asserted in a test so the bound is a fact
rather than a claim.

## The collector, specified

```ts
export interface FileOp { path: string; content: string }
export type CollectorFrame =
  | { kind: 'token'; text: string }
  | { kind: 'file_start'; path: string }
  | { kind: 'file_chunk'; path: string; text: string }
  | { kind: 'file_end'; path: string }
export interface CollectResult {
  messageText: string
  ops: FileOp[]
  /** The path of a block that was never closed, or null. */
  unterminated: string | null
}
export function createFileCollector(): {
  push(text: string): CollectorFrame[]
  finish(): CollectResult
}
```

It owns two normalisers, both built on "hold back the trailing run":

**Chat text.** Leading whitespace is dropped until the first non-whitespace character. A run of
whitespace is held; when non-whitespace follows, the run is emitted — verbatim if it contains
fewer than three `\n`, as exactly `"\n\n"` if it contains three or more (D16). At `finish()` the
held run is discarded, which is the trailing trim. `messageText` is accumulated as **exactly the
concatenation of the `token` frames emitted**, so AC-9 holds by construction and its test is a
regression guard rather than an argument.

**File content.** Trailing `\n` runs are held (spaces and tabs are not — they can be meaningful
in code). At `close`, the held run is replaced by a single `"\n"` and emitted as one last
`file_chunk`; if the file's content is empty, nothing is emitted and the op's content is `''`.
So the concatenated chunks equal the op's content byte for byte (P3, AC-25).

**On `open`:** emit `file_start`, then push `[file: <path>]\n` into the chat normaliser (which
may emit it as one or more `token` frames — P2). On `close`: flush the content tail, emit
`file_end`, record the op. At `finish()` with a block still open: the op is **not** recorded,
`unterminated` is its path, no `file_end` was emitted, and its content appeared in no `token`
frame (AC-7). Its marker token was already emitted, which is correct — the message says a file
was attempted, and the tree says by omission that none was stored (D7's rejected alternative).

## Firestore rules changes

`firestore.rules`, appended after the `messages` block:

```
    // --- generated files ----------------------------------------------
    // A subcollection of a project, so both the owner's uid and the
    // project id are part of the document path and the API scopes by the
    // uid from the token alone. The document id *is* the filename (D13).
    // Written only by /generate's batch and PUT /api/projects/:id/files/:path.
    //
    // Rules do not cascade into subcollections, so neither the users block
    // nor the projects block says anything about this path. Required, not
    // decorative.
    match /users/{uid}/projects/{projectId}/files/{fileId} {
      allow read, write: if false;
    }
```

**L3 tests** in `tests/rules/firestore.spec.ts`, a new `describe` mirroring the `messages`
block's shape. `file()` returns exactly what `stageFileWrites` writes —
`{ path, content, size, createdAt, updatedAt }` — so the denial is on the rule and not on the
payload. `seedFile()` writes past the rules with `withSecurityRulesDisabled`. Cases, all
`assertFails`:

- verified owner: `getDoc` one file; `getDocs` the collection; `setDoc` a new file;
  `updateDoc` its `content`; `deleteDoc` it. (Five — the owner is the most privileged client
  there is, and the browser has `lib/filesApi.ts` and nothing else.)
- a verified stranger (`mallory`): the same five against alice's path.
- an anonymous client: read, list, create.
- AC-33 re-assertion: one case walking `users/{uid}`, the project document, its `messages`,
  `hlConnections/{uid}` and `authThrottle/{key}` — the existing cases already cover these
  individually, so this is a single `it` that re-runs one operation per collection, added because
  the rules file changed.

## Dependencies

**None.** `zod` is already a dependency of `functions`; the frontend adds no package (D29's
chip renderer is a pure helper plus ten lines of template, and `filesApi` uses the existing
`request`). The e2e and integration harnesses are unchanged.

## Task list

Ordered. Each task is one red-green-refactor cycle and one commit, and each leaves the whole
suite green.

### T1 — The filename, and what may not be one → AC-11

- **Red:** `functions/src/files/schema.spec.ts` — `it.each` over `['../secrets.js', '/etc/passwd',
  'assets/app.js', '..', '.env', 'Index.html', 'app', 'app.ts', 'a..b.js', 'a'.repeat(61)+'.js',
  '']` asserting `filePathSchema.safeParse(p).success === false`, and over
  `['index.html','styles.css','app.js','data.json','notes.md','a-b_c.2.js']` asserting success.
  Plus `displayPath()` strips control characters and truncates at 40.
- **Green:** `functions/src/files/schema.ts` — `FILES`, `FILE_LIMIT = 20`,
  `FILE_BYTES_MAX = 100_000`, `PATH_MAX = 64`, `FILE_EXTENSIONS`, `filesPath(uid, projectId)`
  built from `projectsPath` (never a second `'users'` literal), `filePathSchema` =
  `z.string().max(PATH_MAX).regex(/^[a-z0-9][a-z0-9._-]*$/).refine(no '..').refine(allowlisted
  extension with a non-empty base)`, `displayPath()`.
- **Refactor:** one exported message per refusal reason, so the copy table has one home.
- **Estimate:** 1.5 h

### T2 — The op set, refused whole → AC-12, AC-13, AC-14, AC-15

- **Red:** `functions/src/files/schema.spec.ts` — content of exactly 100,000 UTF-8 bytes accepted
  and 100,001 refused; a multi-byte string counted in bytes not characters; 21 ops refused; 15 ops
  against 10 existing paths refused naming the file cap; 20 ops of which 5 rewrite existing paths
  accepted; two ops sharing a path refused naming it; a valid set parsing to writes whose `size`
  is the UTF-8 byte length and whose `path` equals the intended document id. Each refusal's
  `fileError` string asserted **verbatim** against the PRD's copy table.
- **Green:** `byteLength()`, `FileWrite`, `validateFileOps(ops, existingPaths)` returning
  `{ ok: true, writes } | { ok: false, error }` in P5's order; `fileErrorCopy()`;
  `putFileBodySchema` = `z.object({ content: z.string() }).strict().superRefine(byte cap)`;
  `storedFileSchema`, `storedFileMetaSchema`, `toFile()`, `toFileMeta()`.
- **Refactor:** `fileErrorCopy` takes a discriminated `FileRejection` rather than a string, so a
  new reason cannot be added without a copy line.
- **Estimate:** 2 h

### T3 — The splitter: prose, one block, three blocks → AC-1, AC-2, AC-3

- **Red:** `functions/src/llm/fileops.spec.ts` — pushing a delimiter-free text emits only `token`
  frames whose concatenation is the trimmed, collapsed text, with `finish()` reporting no ops and
  `unterminated: null`; prose + one `index.html` block + prose emits `token`, `file_start`, the
  marker token, `file_chunk`+, `file_end`, `token`, and `finish()` reports one op whose content is
  the body with tags and adjoining breaks gone and exactly one trailing `\n`; three blocks
  separated by prose produce ops in written order, each file's chunks concatenating to its own
  content, no chunk carrying another file's text.
- **Green:** `functions/src/llm/fileops.ts` — the constants, `createFileSplitter()` and
  `createFileCollector()` as specified above.
- **Refactor:** pull the two hold-back normalisers into one small internal helper parameterised by
  its flush rule.
- **Estimate:** 4 h — **the largest task in the slice.** Flagged.

### T4 — Near-delimiters, tags in content, the line-start rule → AC-5, AC-6

- **Red:** a fixture whose file body contains `<`, `>`, a triple-backtick fence, a literal
  `<genesis:` line and a line that is *nearly* the close tag (`</genesis:file >`,
  `x</genesis:file>`) — content preserved verbatim, the block closing only on the real tag, and
  prose frames plus chunks reconstructing the input minus the tags and the D16 repairs. Tags
  indented by spaces and by a tab are delimiters; a tag preceded by any non-whitespace character,
  or by nine spaces, is prose. A tag with trailing text on its line is prose (P1). An unquoted or
  malformed open tag is prose.
- **Green:** `couldBeDelimiter`'s mode split and the two line regexes, as specified.
- **Refactor:** name `MAX_LINE` and assert its value in a test, so the bound is checked rather
  than asserted in a comment.
- **Estimate:** 2 h

### T5 — Unterminated blocks and the D16 repairs → AC-7, AC-8

- **Red:** a block that is never closed → `finish()` reports `unterminated` with that path, the
  block is not an op, its content appears in no `token` frame, and no `file_end` was emitted.
  CRLF content with no trailing newline → the op's content is LF-only and ends with exactly one
  `\n`. A block whose body is empty → the op's content is `''` and no `file_chunk` was emitted.
- **Green:** the CRLF normalisation with its lone-`\r` hold-back; the content tail rule.
- **Refactor:** —
- **Estimate:** 1.5 h

### T6 — The message invariant and the marker-only reply → AC-9, AC-10

- **Red:** for every fixture in the suite's corpus, including the malformed ones,
  `finish().messageText` is byte-identical to the concatenation of every `token` frame emitted.
  A reply that is a single block with no prose gives `messageText === '[file: index.html]'` —
  non-empty, so `storedMessageSchema` can hold it.
- **Green:** accumulate `messageText` from the emitted frames and from nowhere else.
- **Refactor:** the corpus becomes an exported `FIXTURES` array reused by T7.
- **Estimate:** 1 h

### T7 — Chunking invariance → AC-4 (R1)

- **Red:** for each fixture text, drive the collector split at **every** single offset and as one
  string; assert the emitted frame sequence (after concatenating adjacent same-kind frames) and
  `finish()`'s result are identical for every chunking. Include a fixture whose delimiter is split
  mid-tag (`<genesis:fi` | `le path="a.js">`) and one whose CRLF is split (`…\r` | `\n…`).
- **Green:** whatever the property exposes. If the shape above is right, this task is expected to
  be green on arrival — **the red step is still written first**, because a property test that has
  never failed proves nothing about the mechanism it guards.
- **Refactor:** —
- **Estimate:** 2 h

### T8 — The collection's rules, before anything writes to it → AC-32, AC-33 (R7)

- **Red:** the new `describe` in `tests/rules/firestore.spec.ts`, as specified above. It fails
  against today's `firestore.rules` only for the "unknown collection" default — which is why the
  block matters: this task makes the denial explicit and proven, and it lands **before** any code
  can write to the collection, which over-satisfies the definition of done's "same commit".
- **Green:** the `firestore.rules` block.
- **Refactor:** —
- **Estimate:** 1 h

### T9 — One batch per turn → supports AC-16, AC-19

- **Red:** `functions/src/files/handlers.spec.ts` — `stageFileWrites` writes
  `{ path, content, size, createdAt, updatedAt }` for a path that does not exist and
  `{ path, content, size, updatedAt }` with `{ merge: true }` for one that does, at document id
  `= path` under `users/{uid}/projects/{id}/files`; `parseStoredFile` returns `null` and logs when
  the stored `path` disagrees with the document id. `functions/src/messages/handlers.spec.ts` —
  `appendAssistantMessage` with a non-empty `fileWrites` stages the message and every file into
  **one** batch and commits once; with `[]` it still commits exactly one batch carrying one
  document.
- **Green:** `readFilePaths()` (`.limit(FILE_LIMIT).select()`, ids only); `stageFileWrites()`;
  `appendAssistantMessage`'s fifth parameter and its `WriteBatch`; `fakeDb` grows `batch()`
  returning a recorder with `set()` and `commit()`.
- **Refactor:** `readBackOrFail` unchanged and still the only re-read.
- **Estimate:** 2.5 h

### T10 — The fake grows files → supports AC-18, AC-20, AC-22, AC-23, AC-24 (R8)

- **Red:** `functions/src/llm/fake.spec.ts` — each of `__no_files`, `__bad_path`,
  `__unterminated`, `__dup_files` selects its fixture; the default still selects `reply.json`;
  `reply.json`'s **prose deltas are byte-identical to what they were** (asserted by pinning the
  first five text deltas), and its later deltas carry `<genesis:file` .
- **Green:** the four new fixtures; `reply.json` gains three blocks (`index.html`, `styles.css`,
  `app.js`) and a closing prose delta, with the model's existing prose untouched;
  `max-tokens.json` gains an *opened* block before its cut-off (P6, AC-22); `MARKERS` and
  `planFor` gain four entries.
- **Refactor:** the block text is split across several deltas per file, so the streamed path is
  exercised rather than delivered whole.
- **Estimate:** 2 h

### T11 — The write path, over the wire → AC-16 to AC-25 (D9, D10, D11)

- **Red:** `tests/integration/generate-files.spec.ts`, modelled on `generate.spec.ts`'s helpers
  (`postGenerate`, `framesOf`, `adminDb`, `seedProject`, `seedMessage`):
  - three documents with ids equal to their paths, content equal to the repaired bodies, correct
    `size`; `done.files` carries the three sorted paths with `fileError: null` (AC-16)
  - the persisted message is the prose with one `[file: <path>]` line per file, contains no code,
    and equals the concatenated `token` frames (AC-17)
  - `__bad_path`: no file document exists, the message is still written, `done.files` is empty,
    `done.fileError` names the path (AC-18)
  - a second generation over the same paths updates in place — same ids, `createdAt` preserved,
    `updatedAt` advanced, content replaced, no duplicates (AC-19)
  - `__no_files`: nothing written, `files: []`, `fileError: null` (AC-20)
  - `__fail_midstream` after a block closed: terminal is `error`, the partial is persisted
    `truncated: true`, **no file document exists** (AC-21)
  - `__max_tokens`: terminal is `done`, `truncated: true`, no file written, `fileError` says the
    reply was cut short (AC-22)
  - `__unterminated` and `__dup_files`: nothing written, `fileError` names the file / the path
    (AC-23, AC-24)
  - frame ordering: per path, `file_start` precedes every `file_chunk` and `file_end` follows
    them; the concatenated chunks equal the stored content; **no `token` frame contains file
    content** (AC-25)
- **Green:** `functions/src/lib/sse.ts` gains `'file_chunk'`; `functions/src/llm/schema.ts` gains
  the three payloads and `DonePayload`'s two fields; `generate.ts` feeds every `token` event's
  text through the collector and writes the resulting frames, and `finishTurn` becomes:
  compute `truncated` → log → `collector.finish()` → `planFileWrites(uid, projectId, collected,
  completed)` where `completed = event.kind === 'end' && !truncated` → `appendAssistantMessage(…,
  plan.writes)` → return early if `clientGone` (the files are already committed — D10) → write
  `done { message, files, fileError }` or `error { error, code, message }`.
- **Refactor:** `planFileWrites` lives in `files/handlers.ts` and takes `CollectResult`, so
  `generate.ts` stays composition.
- **Estimate:** 4 h — **flagged.**

### T12 — The three routes → AC-26 to AC-31 (D19)

- **Red:** `tests/integration/files.spec.ts` — the list ordered by path with `path`, `size`,
  `createdAt`, `updatedAt` and **no `content`** on any entry; `{ files: [] }` for a project that
  never generated; a read by path returning content and size; `404` for an unknown path; `400
  invalid_path` for `../x`, `A.html` and `a.ts` with no Firestore read; `PUT` returning 200 with
  the new content, a recomputed `size`, `updatedAt` advanced and `createdAt` unchanged, and a
  fresh `GET` agreeing; `PUT` on an unknown path → `404` and nothing created; `PUT` with an extra
  key, a non-string `content`, or content over the cap → `400 invalid_body` and the stored
  document byte-identical; alice listing/reading/writing bob's project → `404` on all three with
  bob's file unchanged, same for a soft-deleted and a never-existing project; no
  `Authorization` → `401`; `email_verified: false` → `403`. Plus `functions/src/index.spec.ts` —
  a source scan asserting `files/index.ts` names `withVerifiedUser` on all three routes and
  `attested` on the `PUT` alone (AC-31's structural half).
- **Green:** `requireFilePath()`; `readFileList()`; `handleListFiles`, `handleGetFile`,
  `handlePutFile`; `filesRouter`; the mount in `api/index.ts` after `messagesRouter`.
- **Refactor:** every handler's first statements are `requireProjectId` → `requireFilePath` →
  `parseBody` → `readProject`, so a refusal costs no Firestore call — `handleCreateProject`'s
  rule, restated.
- **Estimate:** 3.5 h

### T13 — The system prompt learns the format → AC-34 (D25)

- **Red:** `functions/src/llm/prompt.spec.ts` — the last block carries
  `cache_control: { type: 'ephemeral' }` and there is exactly one breakpoint; the assembled text
  contains `OPEN_HEAD`, `CLOSE_TAG`, every member of `FILE_EXTENSIONS`, `String(FILE_LIMIT)` and
  a rendering of `FILE_BYTES_MAX` — each read from the modules the parser and the schema use, so
  a constant changing on one side fails here; nothing volatile anywhere; still no `leadconnectorhq`,
  no `/contacts`, no triple-backtick fence, no `FILE:`, no `file_start`.
- **Green:** a second `TextBlockParam` describing the format — flat filenames only, the extension
  allowlist, the caps, the tag pair on its own line, that prose outside the tags is the reply, and
  that answering without files is fine when the request calls for it. `cache_control` moves from
  the first block to this one. The text is assembled with template interpolation from the imported
  constants; no literal restates a value.
- **Refactor:** the existing "belongs to a later slice" case keeps its needles and gains the new
  comment (P9).
- **Estimate:** 1.5 h

### T14 — The typed file client → AC-35

- **Red:** `frontend/src/lib/filesApi.spec.ts` — `listFiles` issues `GET
  /api/projects/<id>/files`; `getFile` issues `GET /api/projects/<id>/files/<path>` with the
  filename percent-encoded; `saveFile` issues `PUT` with a body of exactly `{ content }` and
  `Content-Type: application/json`; each attaches the Authorization and App Check headers (the
  `fetch`-stubbing pattern `projectsApi.spec.ts` uses). `no-firestore.spec.ts` is unchanged and
  still green with the new files present.
- **Green:** `frontend/src/lib/filesApi.ts`, built on `request` from `apiClient.ts`, with
  `FILE_BYTES_MAX` and `FILE_LIMIT` mirrored and a comment saying why they are duplicated rather
  than imported (`messagesApi.ts`'s `MESSAGE_LIMIT` precedent).
- **Refactor:** —
- **Estimate:** 1 h

### T15 — The stream client learns three events → AC-36

- **Red:** `frontend/src/lib/generateApi.spec.ts` — `file_start`, `file_chunk` and `file_end`
  yield typed events; a `done` carrying `files` and `fileError` yields them; frames missing `path`
  or `text` are skipped rather than thrown; a `done` with neither new field yields `files: []` and
  `fileError: null`.
- **Green:** `GenerateEvent` gains the three variants and `done` its two fields; `toEvent` gains
  the three branches and a tolerant `asFiles`/`asFileError` reader.
- **Refactor:** —
- **Estimate:** 1 h

### T16 — The pure client helpers → AC-44's and AC-45's and AC-46's L1 halves

- **Red:** `frontend/src/lib/files.spec.ts` — `compareFilePaths` puts `index.html` first and the
  rest alphabetically; `mergeFileTree(stored, streaming)` returns the union with streaming paths
  marked `writing`, a stored path also streaming appearing once, and the order the comparator
  gives; `utf8Bytes` counts bytes and not characters for a multi-byte string.
  `frontend/src/lib/messageParts.spec.ts` — `splitMessageContent` over mixed prose and
  `[file: app.js]` lines, a marker-only message, a marker-free message, and a line that only looks
  like a marker (`prefix [file: a.js]`) which stays text.
- **Green:** `frontend/src/lib/files.ts` and `frontend/src/lib/messageParts.ts`.
- **Refactor:** —
- **Estimate:** 1.5 h

### T17 — The store: the list, the selection, the save → AC-37, AC-38

- **Red:** `frontend/src/stores/workspace.spec.ts` — opening a project fetches the list, with
  `filesLoading` and `filesLoaded` following it and a failure setting `filesError` while leaving
  any existing list in place; selecting a file fetches its content, the buffer equals it and
  `fileDirty` is false; editing the buffer makes `fileDirty` true; `saveFile()` succeeding
  replaces the buffer with the stored content and clears `fileDirty`; failing leaves the buffer
  untouched, `fileDirty` true and `saveError` set.
- **Green:** `files`, `filesLoading`, `filesLoaded`, `filesError`, `selectedPath`, `fileContent`,
  `savedContent`, `fileDirty` (computed), `fileLoading`, `fileError`, `saving`, `saveError`;
  `loadFiles()`, `selectFile(path)`, `saveFile()`; `open()` calls `loadFiles()` after
  `loadMessages()`. Every write after an `await` is guarded by `current(gen)`.
- **Refactor:** —
- **Estimate:** 3 h

### T18 — The store: the generation fan-out → AC-39 to AC-43 (D20, D21, D22, R4)

- **Red:** a stream emitting `file_start` / `file_chunk` / `file_end` gives a tree that is the
  union of stored and streaming paths with the streaming ones marked, each streaming buffer
  growing to the concatenation of its own chunks, and the first streamed file selected **only** if
  nothing was selected; `done` with a non-empty `files` refetches the list, re-reads the open file
  and clears the streaming buffers; `done` with an empty `files` issues **no** file request and
  still clears them; a dirty buffer for a rewritten file is replaced and `fileReplaced` is true,
  a clean one leaves it false; `done.fileError` sets `generateFileError` and the next generation
  clears it; `saveFile()` issues no request while `generating`; `reset()` and opening another
  project return every file field to its initial value and a response in flight cannot
  repopulate it.
- **Green:** `streamingFiles` (a mutated `Record<string,string>`, so a chunk triggers one targeted
  update rather than replacing the object), `streamingPaths`, `fileTree`, `editorContent`,
  `fileReplaced`, `generateFileError`; the three new branches in `runGeneration`'s loop; the
  `done` branch's refetch; the reset paths.
- **Refactor:** the `done` handling moves into one `applyGenerationFiles()` so `runGeneration`
  stays readable.
- **Estimate:** 3.5 h

### T19 — `FileTree.vue` → AC-44

- **Red:** `frontend/src/components/workspace/FileTree.spec.ts` (the `reactive` mocked-store
  pattern `ChatPanel.spec.ts` uses) — loading renders a skeleton; loaded-and-empty renders
  "No files yet."; failed renders the message and a **Try again** that calls `loadFiles()`;
  with files, one row per file with `index.html` first, the selected row marked, a click calling
  `selectFile`, and a streaming row carrying a *writing* marker.
- **Green:** the component, with `data-testid`s `file-tree`, `file-tree-loading`,
  `file-tree-empty`, `file-tree-error`, `file-tree-retry`, `file-row` (`data-path`,
  `data-selected`, `data-writing`).
- **Refactor:** —
- **Estimate:** 2 h

### T20 — `FileEditor.vue` → AC-45

- **Red:** no selection renders the empty state; a selection puts the content in the textarea and
  shows its byte count; **Save** is disabled unless the buffer is dirty and within the cap; an
  open stream makes the textarea `disabled` and Save unavailable, with a reason on screen; a save
  error renders beside Save; `fileReplaced` renders the "Replaced by the latest generation"
  notice.
- **Green:** the component, with `data-testid`s `file-editor`, `file-editor-empty`,
  `file-editor-input`, `file-editor-bytes`, `file-editor-save`, `file-editor-error`,
  `file-editor-readonly`, `file-editor-replaced`.
- **Refactor:** —
- **Estimate:** 2 h

### T21 — The code panel becomes a screen → AC-47

- **Red:** `frontend/src/views/WorkspaceView.spec.ts` — both layouts render `file-tree` and
  `file-editor` inside `editor-panel`; the "Slice 6" assertion is deleted and replaced with a scan
  asserting no component under `frontend/src` contains the string (built by concatenation, as
  `ChatPanel.spec.ts` scans for "Echo mode"). The view spec's mocked store gains the new fields.
- **Green:** `EditorPanel.vue` renders `FileTree` above `FileEditor` with the panel's existing
  header, and the placeholder paragraph goes.
- **Refactor:** —
- **Estimate:** 1.5 h

### T22 — Chips in the transcript → AC-46 (D29)

- **Red:** `frontend/src/components/workspace/ChatPanel.spec.ts` — a bubble whose content mixes
  prose and `[file: app.js]` lines renders the prose as text and each marker as a chip; the
  streaming placeholder with the same text renders the same way; a message with no marker renders
  no chip; `generateFileError` renders its own notice.
- **Green:** the bubble and the placeholder both render `splitMessageContent(...)`;
  `data-testid`s `file-chip` and `generate-file-error`.
- **Refactor:** the part rendering is one small sub-template used by both, so the two cannot
  drift.
- **Estimate:** 1.5 h

### T23 — The demo line, in a browser → AC-48 (D32)

- **Red:** `tests/e2e/files.spec.ts` — sign up, create a project, open it, send `__slow build a
  contact dashboard`; **while the reply is still streaming** a file row is visible in the code
  panel and the bubble shows chips and no code; when the stream ends the list holds the generated
  files; open `index.html`, edit the textarea, press **Save**, reload, and the edited content is
  what comes back.
- **Green:** whatever the walk exposes. Also: `tests/e2e/workspace.spec.ts:87`'s "Slice 6"
  assertion is replaced with `await expect(page.getByTestId('file-tree')).toBeVisible()` (P9).
- **Refactor:** the project-creation preamble reuses `openNewProject`'s shape; if it is copied a
  third time it moves to `tests/e2e/helpers.ts`.
- **Estimate:** 2.5 h

### T24 — The documents catch up

**No failing test first, and the reason is that there is nothing behavioural to assert** — these
are prose records, and inventing a string-matching test over a markdown table would be a test
that fails on a reword. Stated rather than skipped.

- `docs/IMPLEMENTATION_PLAN.md`: §0 status row for Slice 6 and the suite counts; §4's Slice 6
  entry marked shipped; §8's **two** rows — generated app format and the file-op wire format —
  moved from 🟡 to ✅ with D1 and D2's decisions and a pointer to this PRD; §9's rows for F3.3
  (validated file ops), F4.2 (file boundaries), F5.1 (tree/read/save) and F8.1 (malformed output).
- `docs/PRODUCT_SPEC.md` §6 items 2 and 5 marked settled, pointing at `02-prd.md`.
- **Estimate:** 0.5 h

## Acceptance-criterion coverage

Every AC in the PRD maps to at least one task:

| AC | Task |
|---|---|
| AC-1, AC-2, AC-3 | T3 |
| AC-4 | T7 |
| AC-5, AC-6 | T4 |
| AC-7, AC-8 | T5 |
| AC-9, AC-10 | T6 |
| AC-11 | T1 |
| AC-12, AC-13, AC-14, AC-15 | T2 |
| AC-16 – AC-25 | T11 (with T9 and T10 as its prerequisites) |
| AC-26 – AC-30 | T12 |
| AC-31 | T12 (both the L4 auth cases and the L1 router scan) |
| AC-32, AC-33 | T8 |
| AC-34 | T13 |
| AC-35 | T14 |
| AC-36 | T15 |
| AC-37, AC-38 | T17 |
| AC-39 – AC-43 | T18 |
| AC-44 | T19 (component) + T16 (comparator and merge) |
| AC-45 | T20 (component) + T16 (byte count) |
| AC-46 | T22 (component) + T16 (`splitMessageContent`) |
| AC-47 | T21 |
| AC-48 | T23 |

**No AC is unmapped.** Two notes on how coverage is achieved rather than claimed:

- **AC-2's frame text** is asserted as order-plus-concatenation, not per-frame bytes (P2). Every
  other clause of AC-2 is asserted literally.
- **AC-22 depends on a fixture change.** `max-tokens.json` today contains no file block, so the
  criterion is unsatisfiable against it; T10 gives it an opened block. Without that change AC-22
  would be a test asserting `fileError === null` while claiming to prove the opposite.

## Manual verification

On emulators, from a clean checkout:

1. `npm run install:all && npm run dev` — the emulators come up and Vite serves in emulator mode.
2. Sign up, verify through the link the Auth emulator issues, land on the dashboard.
3. Create a project and open it. The code panel shows its loading state, then
   **"No files yet. Describe the app you want."**
4. Send `build a contact dashboard`. While the reply streams: file names appear in the code panel
   marked *writing*, the chat bubble grows with chips rather than code, and the textarea is
   disabled.
5. On completion: three rows in the list, the chat bubble carrying three chips and no HTML, and
   the panel editable again.
6. Click `index.html`, change the heading. The byte count moves and **Save** enables. Press Save;
   the button settles and the file is no longer dirty.
7. Reload the page. The transcript, the file list and the edited content all come back.
8. Send `__bad_path build something` — the reply arrives, the file list is untouched, and the
   panel names the refused path.
9. Send `__unterminated build something` — same, naming the unterminated file.
10. Confirm in the Firestore emulator UI that `users/{uid}/projects/{id}/files` holds documents
    whose ids are the filenames, and that the project document's `updatedAt` did **not** move
    (D31).

## Estimate

| Task | Hours |
|---|---|
| T1 filename schema | 1.5 |
| T2 op-set validation | 2 |
| **T3 splitter core** | **4** ⚑ |
| T4 near-delimiters | 2 |
| T5 unterminated + repairs | 1.5 |
| T6 message invariant | 1 |
| T7 chunking invariance | 2 |
| T8 rules + L3 | 1 |
| T9 one batch per turn | 2.5 |
| T10 fixtures + fake | 2 |
| **T11 write path (L4)** | **4** ⚑ |
| T12 the three routes | 3.5 |
| T13 system prompt | 1.5 |
| T14 filesApi | 1 |
| T15 generateApi | 1 |
| T16 pure helpers | 1.5 |
| T17 store: list/select/save | 3 |
| T18 store: fan-out | 3.5 |
| T19 FileTree | 2 |
| T20 FileEditor | 2 |
| T21 code panel | 1.5 |
| T22 chat chips | 1.5 |
| T23 e2e | 2.5 |
| T24 docs | 0.5 |
| **Total** | **~47.5 h** |

⚑ **Two tasks are at or above half a day**, and both are named hazards rather than surprises:

- **T3, the splitter core (4 h)** — R1. It carries the whole grammar, both normalisers and the
  hold-back. It is deliberately the first non-trivial task, so the highest-risk code is written
  when the suite is smallest and the feedback loop shortest, and T7's property test is what
  certifies it afterwards.
- **T11, the write path over the wire (4 h)** — D9, D10, D11 and R7 all land in one integration
  suite of ten cases against five fixtures. It is large because the all-or-nothing rule is only
  provable end to end: an L1 test of `planFileWrites` would assert intent, and what F8.1 needs is
  the assertion that **no document exists**.

The slice as a whole is a day and a half of focused work above a normal one, which D33 anticipated
and mitigated with the build order this task list follows: the pure boundary (T1–T7), then the
rules (T8), then the write path (T9–T11), then the routes (T12), then the prompt (T13), then the
client (T14–T18), then the components (T19–T22). Every security-relevant and hazard-bearing
decision — D4, D8, D9, D10, D12 — is reviewable before a `.vue` file changes.
