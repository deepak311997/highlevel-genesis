# Slice 06 — File operations · PRD

**Spec:** F3.3, F4.2 (file boundaries), F5.1, F6.1 (the code panel), F8.1 ·
**Branch:** `slice/06-file-operations` · **Depends on:** 5 · **Date:** 2026-08-17

## Problem

Generation works and it produces **prose**. A user asks for a contact dashboard and gets a
paragraph describing one; there is no code, no file, and the middle panel of the workspace still
reads "Generated files arrive in Slice 6". Everything downstream — Monaco (7), the HighLevel
cheat-sheet that makes the code call real endpoints (9), the preview that runs it (10), the
snapshots that version it (11) — needs the same missing thing: the model's output cut into
**named files, validated, and stored**.

This slice adds the structure. The reply is parsed as it streams into file operations, the
completed set is validated at one boundary and committed atomically with the assistant message,
the code panel becomes a real screen with a file list and an editable file, and a manual edit
saves and survives a reload. Malformed output is refused whole rather than half-applied: F8.1's
"no corrupted project state" is the requirement this slice is mostly about.

## The demo

Type "build a contact dashboard", watch file names appear in the code panel while the reply
streams, click `index.html` to read what the model wrote, change a line, press **Save**, reload —
and the edit is still there.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below was
answered from `PRODUCT_SPEC.md` §4 (F3.3, F4.2, F5.1, F6.1, F6.3, F6.4, F8.1) and §6 items 2 and
5, `IMPLEMENTATION_PLAN.md` §4 (Slices 5, 6, 7, 9, 10, 11), §8's two open rows and §9,
`CLAUDE.md`'s non-negotiables, and the merged code of Slices 0–5. Load-bearing decisions carry
the alternative that was rejected, because a decision with no rejected alternative was not a
decision.

Two rows of `IMPLEMENTATION_PLAN.md` §8 are settled here — **generated app format** (D1) and
**the file-op wire format** (D2) — and D2 departs from the leaning recorded there. The departure
is argued rather than assumed.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | **Generated app format: single-file or multi-file?** | **Multi-file plain HTML + CSS + JS**, entry point `index.html`, no build step, no module imports, no framework. Settles §8's open row. | The brief offers both and §6.2 leans this way. Multi-file is what makes F5.1 (a *file tree*, a *read*, a *save*) mean anything — a single-file app gives a tree with one row in it and a 40 KB textarea. Plain HTML/CSS/JS is what keeps Slice 10 trivial: a `srcdoc` iframe has no bundler, no server and no module resolution, so anything needing a build step could be generated but never *run*, which would be a worse failure than not generating it. Rejected: **single-file HTML** — it makes the editor and the tree decorative; rejected: **a Vue or React app** — it needs a bundler in the browser, which the `srcdoc` decision already refused, and the brief's own note (§6.2) says the same. |
| D2 | **How does the LLM delimit a file?** | **A sentinel tag pair on its own line:** `<genesis:file path="index.html">` … `</genesis:file>`. Both may be preceded on their line only by whitespace. Everything outside a pair is prose. | The leaning in §8 was markdown fences with a path header, and it is the wrong choice **because the model writes prose about code**: ``` appears in ordinary explanation, and a fence's info string is a *language*, not a path. Under D9's all-or-nothing rule a single illustrative fence in the prose becomes a file with a garbage path and kills every real file in the turn. The sentinel is also *robust to being wrapped*: if the model helpfully puts the tags inside a markdown fence, the fence lines are prose and the tags still parse — the reverse arrangement has no such escape. Rejected: **markdown fences** (above); rejected: **tool-use JSON** — the whole app arrives as one JSON string, so no file boundary can be emitted until the JSON closes, which kills F4.2's live boundaries and Slice 7's live editor, and every byte of code is doubly escaped on the way through. |
| D3 | When is the output parsed? | **Incrementally, as it streams** — not only at the end. A pure splitter is fed each text delta and emits prose, file-open, file-chunk and file-close events. | F3.3 says "parse final LLM output", and if that were the whole requirement a single parse of the finished string would do. F4.2 asks for **file boundaries as stream events**, and Slice 7 asks for tokens appearing live *in the editor*: both need to know a file has opened while it is still being written. Parsing once, incrementally, is also strictly less code than parsing twice — the terminal parse would be a second implementation of the same grammar, and the two would disagree eventually. |
| D4 | **The delimiter will arrive split across two deltas. What then?** | **The splitter holds back any tail that could be the start of a delimiter** and decides once it has enough bytes. Its contract: for a given text, the emitted event sequence is **identical for every possible chunking**. | **This is the slice's one real hazard.** `<genesis:` is nine characters and a text delta is whatever the SDK felt like sending; `<genesis:fi` + `le path="a.js">` is an ordinary pair of deltas. A naive per-delta scan misses the tag, leaks it into the chat bubble as prose, and never opens the file — and it passes every hand-written test, because a hand-written test chunks on whole tags. The hold-back is bounded (the longest delimiter plus the longest path), so no latency is visible. Asserted as a property: every fixture is driven split at **every** offset and compared against the whole-string result — the same technique `frontend/src/lib/sse.ts` already uses for the frame parser one layer down. |
| D5 | Which SSE events does the file half use? | **`file_start { path }`, `file_chunk { path, text }`, `file_end { path }`**, added to `SseEventName`. `token` keeps its meaning and **carries chat text only**. | F4.2 names `file_start`/`file_end` "at minimum", so `file_chunk` is a permitted addition and it is what keeps `token` honest: one frame type per destination, rather than a `token` whose meaning depends on a mode the client has to track. `file_chunk` repeats the path so **every frame is self-describing** — a client that drops or fails to understand a `file_start` cannot then misroute code into the chat bubble, which is precisely the failure a mode flag invites. Rejected: reusing `token` between the boundaries (a client state machine, and a silent corruption when it desyncs). |
| D6 | What is stored as the assistant **message**? | **The prose, with each file block replaced in place by a marker line `[file: <path>]`.** The code is not in the message. | Three reasons, and the third is the strongest. (1) There is no markdown renderer in this app and there will not be one; 300 lines of HTML in a `whitespace-pre-wrap` bubble is not a chat. (2) The files *are* the record of the code — a second copy in the transcript is a second source of truth. (3) **The transcript is the model's context.** Slice 9 assembles context from project files *and* chat history; if the code were in the history too, every later turn would re-send the entire app twice and the token budget would be spent on a duplicate. Rejected: storing the raw text with tags intact; rejected: a `files: string[]` field on the message document — a per-turn record of what a generation wrote is Slice 11's snapshot, which is read, where this would not be. |
| D7 | Then does the stored message still equal what the client received? | **Yes, exactly.** The stored `content` is byte-identical to the concatenation of the turn's `token` frames — Slice 5's AC-2 invariant, kept. The marker is emitted as a `token` frame at the boundary, and all whitespace normalisation (D16) happens **in the emitted stream**, not afterwards. | The invariant is what makes Slice 5's placeholder swap safe: whatever the client accumulated, the server's persisted copy is the same string, so replacing the bubble at `done` cannot change what is on screen. Normalising after the fact — trimming the text before the write — would break it invisibly, in whitespace, which is the hardest kind of disagreement to notice. So the collector is the single producer of the chat text and `finish()` returns exactly what it emitted. Rejected: rewriting the markers to `[file not saved: …]` when the ops are refused (truer-looking, and it breaks the one invariant that makes the swap safe, for a fact the tree already states by omission). |
| D8 | Where does validation happen? | **Once, at the terminal event, in Zod, over the whole op set.** The splitter is *syntax only* and validates nothing. | Parse-don't-validate at one boundary, which is what `zod` is in this project for (§7.3). One site means one answer to "is this path allowed", so a path cannot be accepted by the streamer and refused by the writer. The visible consequence is deliberate: an invalid path **does** get `file_start` frames and **does** appear in the tree while it streams, and is gone the moment the tree refetches at `done`. A transient entry that corrects itself is a better trade than two validators that can disagree. |
| D9 | One bad op — what happens to the good ones? | **Nothing is written. The turn's file ops are all-or-nothing.** `done` carries a `fileError` naming what was refused. | F8.1: "no corrupted project state". A generated app is a *set* of files that reference each other — `index.html` names `app.js` in a `<script src>` — so writing two of three produces an app that is broken in a way the user cannot see until the preview fails, and cannot fix without knowing which file is missing. Refusing the set keeps the project exactly as it was, and **Retry** already exists. Rejected: applying the valid ops and reporting the rest (half an app, silently). |
| D10 | Does an **interrupted** generation write files? | **No. Files are written only when the turn completed** — the mapper's terminal is `end` **and** its `truncated` is `false`. A refusal, a mid-stream failure, `stop_reason: 'max_tokens'` and the 800 KB byte cap all write no files, and `done`'s `fileError` says so where a `done` is sent. | Same argument as D9, from the other direction: a cut-off turn's last file block is unterminated by construction, and its earlier blocks describe an app whose remaining parts were never written. One rule — *completed, or nothing* — is impossible to get subtly wrong, where "keep the blocks that closed" is a half-app that looks fine in the tree. F8.2 is not weakened: the partial **text** is still preserved and marked `truncated`, exactly as in Slice 5. **`clientGone` does not suppress the write**: the files belong to the project, not to the connection, and a model that finished cleanly produced a complete app whether or not anyone was still listening. |
| D11 | How are the message and the files written? | **One `WriteBatch` per turn.** The assistant message and every file document commit together or not at all. | The message contains `[file: index.html]`; if that commits and the file does not, the transcript is lying about the project's contents. One commit makes the turn atomic. It costs the read-back that `appendAssistantMessage` used for `serverTimestamp()` — recovered by re-reading the message document after `commit()`, which is what that function already does. 21 writes at the cap (one message, twenty files), far inside Firestore's 500. A batch resolves every `serverTimestamp()` to one commit timestamp, which was Slice 4's hazard — harmless here, because the message keeps its `seq: 1` and the files live in a different collection ordered by name. |
| D12 | What may a path be? | **A flat filename. No directories.** `^[a-z0-9][a-z0-9._-]*$` with a total length ≤ 64, no `..` anywhere, and exactly one allowlisted extension: `html`, `css`, `js`, `json`, `md`. | Traversal is refused by the *shape of a name* rather than by a sanitiser that has to be right about every encoding — `../secrets.js`, `/etc/passwd`, `a/b.js`, `..` and `.env` all simply fail to be filenames. Directories buy nothing: the `srcdoc` preview has no server and resolves no paths, Slice 10 inlines what `index.html` references, and a `/` cannot appear in a Firestore document id anyway (D13), so they would need encoding on top. Extensions are allowlisted because a file the preview can never run is a file that lies to the user: no `.ts`, no `.vue`, no `.php`. Rejected: one level of directory "for tidiness" — it adds an encoding, a traversal surface and a tree component, for a twenty-file app. |
| D13 | What is a file document's id? | **The path itself.** `users/{uid}/projects/{projectId}/files/index.html`. | Create-or-update per path is then a plain `set()` with no query and no chance of two documents claiming one filename — which is what a generation rewriting the same three files every turn actually needs. The path is *also* stored as a field, so the collection is legible in a console and `orderBy('path')` has something to order by; **`id === path` is an invariant asserted on parse**, and a document where they disagree is unreadable and logged, following `parseStored`'s fail-closed precedent. Rejected: an auto-id with a `path` field — a query for every read, and two documents for one path the first time a write races. |
| D14 | Where does the collection live? | **`users/{uid}/projects/{projectId}/files/{path}`** — a subcollection of the project, like `messages`. Deny-all in `firestore.rules`, with L3 tests in the same commit. | The path is the ownership: the owner's uid comes from the verified token and the project id is checked for ownership before the collection is addressed, so there is no `ownerUid` field and no equality check. `PRODUCT_SPEC.md` §3 lists `files` beside `projects` and `messages` in a flat enumeration of collection *names*; that is a naming list, not a hierarchy — the same reading Slice 4 applied to `messages`. |
| D15 | What are the caps? | **20 files per project** and **100,000 UTF-8 bytes per file.** The union of a turn's ops with the project's existing files must also be ≤ 20. | 100 KB leaves an order of magnitude of headroom under Firestore's 1,048,576-byte document limit for a file that is realistically 5–40 KB, and it is the same number the manual-save route enforces, so no path exists to a document the reader cannot parse. Twenty files is several times what a single-purpose CRM mini-app needs and keeps the batch, the tree and the Slice 11 snapshot all trivially bounded. The 800 KB accumulation cap (Slice 5, D22) is independent and binds first in practice: it is about one stream, these are about one document and one project. |
| D16 | F3.3 says "reject **or repair**". What is repaired? | **A closed list, applied in the splitter:** CRLF → LF; the line break immediately after the open tag and immediately before the close tag is dropped; file content ends with exactly one `\n`; the chat text is trimmed at both ends and runs of three or more newlines collapse to two. **Everything else is a rejection.** | Every repair here is a normalisation that cannot change meaning — nobody's HTML depends on its trailing newline count. The temptation to go further is worth naming: **flattening `assets/app.js` to `app.js` is not a repair**, because the `<script src="assets/app.js">` the model also wrote would still name the directory, so the "repaired" app is a broken one. A repair that can produce a wrong-but-plausible result is a rejection wearing a disguise. |
| D17 | A reply with no file blocks at all? | **Not an error.** No files are written, `done.files` is empty, `fileError` is `null`, and the tree keeps whatever it had. | The system prompt (Slice 5, D17) tells the model to answer plainly when a request is outside what a small CRM app can do, and to say what it assumed rather than producing nothing. A clarifying answer is a legitimate turn. Treating it as malformed output would make F8.1's error fire on the model's *good* behaviour. |
| D18 | Does a generation delete files it did not mention? | **No. Generations create and update; they never delete.** | F3.3 says "create/update files" in as many words. A turn that only rewrites `app.js` must not wipe `index.html`, and once Slice 9 puts the current files in the model's context that becomes the *normal* shape of a follow-up turn. A stale file nobody references is inert — Slice 10 inlines what `index.html` asks for — and rollback is Slice 11's snapshot, which is the feature that actually owns "put the project back". Rejected: making each generation the project's whole file set (one lazy turn erases the app). |
| D19 | What routes exist? | **`GET /api/projects/:projectId/files`** (metadata only, no content), **`GET /api/projects/:projectId/files/:path`** (one file with content), **`PUT /api/projects/:projectId/files/:path`** (save an edit). No `POST`, no `DELETE`; `PUT` on a path that does not exist is **404, not a create**. | F5.1 is exactly three verbs: list the tree, read a file, save an edit. Splitting list from read is what keeps opening a workspace from shipping 20 × 100 KB of code nobody has clicked on yet. `PUT` refusing to create is the honest shape of "save an edit": creating files by hand is not in F5.1, and refusing it keeps the write surface to documents the generator made. No user identifier appears in any of them — the uid comes from the token. |
| D20 | How does the client learn what a generation wrote? | **`done` gains `files: string[]` and `fileError: string \| null`.** A non-empty `files` makes the store **refetch** the list and re-read the open file; the streamed buffers are then dropped. | Liveness is refetch-after-mutation (`CLAUDE.md`), and here it is load-bearing rather than dogmatic: the server *repairs* content (D16) and computes `size` and the timestamps, so the bytes the client watched arrive are not necessarily the bytes that were stored. Slice 4's append-the-response argument does not transfer — a message is exactly what the server returned, a file is a transformed version of what streamed. Rejected: applying the streamed text locally (a copy that disagrees with the server invisibly until a reload). |
| D21 | The user is editing a file when a generation rewrites it. | **The editor is read-only while a stream is open** — the textarea is `disabled` and **Save** is unavailable. Slice 7 restates this as Monaco's `readOnly`. | Without it, the sequence is: the user types, the generation's batch commits, the refetch replaces the buffer, and the edit is gone with no message and nothing to blame. Making the panel read-only for the seconds a stream is open closes the window at its source rather than detecting the collision afterwards, and it is a behaviour Slice 7 has to ship anyway (`IMPLEMENTATION_PLAN.md` §4). |
| D22 | And an edit typed *before* the send and never saved? | **The server's content wins, and the panel says so**: the buffer is replaced and a visible "replaced by the latest generation" notice appears until the user selects another file. | The window is narrow by D21 — sending a prompt is a deliberate "rebuild my app" — and the alternative is a merge UI, which is a slice of its own. What is not acceptable is silence, so the discard is announced. Rejected: keeping the dirty buffer and offering a choice (a conflict dialog in a slice whose editor is a textarea). |
| D23 | Optimistic concurrency on `PUT`? | **No. Last write wins.** No version token, no `If-Match`. | Two tabs editing one file is a case a user has to work at, and Slice 5's D27 already set this project's rule for exactly that shape: a lock is a document to write, contend on and expire. The realistic collision — a generation against an editor — is closed by D21 instead, where it actually happens. |
| D24 | Where does the file state live on the client? | **`useWorkspaceStore`**, extended. Not a second store. | Slice 4's D24 upheld rather than reopened: the project, its transcript and its files share one lifecycle and one `projectId`, are loaded together and reset together, and the generation stream fans out into *both* the transcript and the files — so a second store would need the same generation counter, the same reset, and one more place for them to drift out of lockstep. The size cost is real and is paid down by keeping the pure parts (the tree merge, the byte count, the sort) in `frontend/src/lib/files.ts` with their own L1 tests. |
| D25 | Does the system prompt change? | **Yes — a second stable block describing the file format**, and the `cache_control` breakpoint moves to it so it stays the last element of the stable prefix. The tag syntax, the extension list and the caps in the prompt are **interpolated from the same constants the parser and the schema use**. | Slice 5's D17 deliberately withheld file-format instructions "until Slice 6" because they would have described a parser that did not exist; it does now. Deriving the text from constants is what stops the prompt from documenting a grammar the parser no longer speaks — the classic drift, and invisible, because the only symptom is the model producing output we reject. It is still stable (no per-request value), so D16 of Slice 5 holds; it also pushes the prefix toward `claude-opus-5`'s 512-token minimum, so `cache_read_input_tokens` in `generation.complete` may stop being `0` — which is where that gets observed rather than assumed. |
| D26 | How is the fake LLM extended? | **`reply.json` becomes a multi-file reply** (prose, `index.html`, `styles.css`, `app.js`, prose), and four markers are added: `__no_files`, `__bad_path`, `__unterminated`, `__dup_files`. | The default fixture is what `__slow`, `__long`, `__fail_midstream` and the e2e all build on, so making it the realistic shape means the file path is exercised by every existing case rather than by one new one. Its **prose is unchanged**, so Slice 5's assertions about progressive text and `truncated` still hold — R9. The malformed cases are fixtures rather than L1-only inputs because F8.1 is a *user-facing* requirement: the error has to be provable over the wire. Oversize and too-many-files stay L1, because a fixture carrying 100 KB × 21 is a fixture nobody can read. |
| D27 | Effort, thinking, model? | **Unchanged** — `claude-opus-5`, `messages.stream()`, `max_tokens: 64000`, `output_config: { effort: 'low' }`. | Slice 5's D15 assigned generation *quality* to Slice 9, which re-tunes effort against real HighLevel prompts. Re-tuning it here would be tuning against a fake. Recorded so an unchanged parameter reads as a decision rather than an omission. |
| D28 | Are project files in the model's context yet? | **No.** Context is still the transcript alone (Slice 5, D5). Slice 9 owns bounded context assembly from project files. | The consequence is worth stating because it is visible: a second prompt **rewrites** the app rather than patching it, since the model cannot see what it wrote last turn. That is F10.1 / Slice 9 territory, and D18's never-delete rule is what keeps a rewrite from being destructive in the meantime. |
| D29 | Does the chat render the `[file: …]` markers as text? | **No — as a small file chip.** A pure `splitMessageContent()` turns a message into text and file parts, and the same helper renders the streaming placeholder, because the marker arrives as an ordinary `token`. | It is ten lines of template over a pure function with an L1 test, and it is the difference between a transcript that reads like a build log and one with `[file: index.html]` sitting in it looking like a bug. One helper for both the persisted bubble and the live one falls out of D7: the live text and the stored text are the same string. |
| D30 | Does the file list need an index? | **No.** `orderBy('path')` on a single field is served by Firestore's automatic index; `select()` adds no requirement. | Stated rather than assumed, because Slices 3 and 4 both paid for a missing composite index and the emulator does not enforce them. `firestore.indexes.json` is unchanged and the review should check that claim against the query rather than against this sentence. |
| D31 | Does anything about the project document change? | **No.** A file write does not touch `updatedAt` on the project. | Slice 3's D15: `updatedAt` means "the project's own fields changed", which is what the dashboard's ordering and its "Updated" line both claim. A generation reordering the dashboard is a side effect nobody asked for. |
| D32 | Which L5 test covers this? | **A new `tests/e2e/files.spec.ts`**, one test walking the demo line. | Slice 5's D36 argued against a second spec that walks the *same* path to assert one more thing; this walks a different one — the code panel, an edit, a save, a reload. Slice 5's `workspace.spec.ts` is left alone, which also keeps the two failures distinguishable when one breaks. |
| D33 | Is this one reviewable PR? | **Yes, and it is at the edge.** One new pure module (the splitter/collector), one new functions module (`files/`: schema, handlers, router), one changed terminal handler, one prompt block, one rules block, one client library, one store extension, two new components plus one rewritten panel, fixtures and tests. No new index, no new vendored shadcn component. | Checked deliberately, and the mitigation is build order: **the boundary first** — the splitter and the schema as pure L1 units, then the batch write, then the routes and their rules, then the client library, then the store, then the components. Everything security-relevant or hazard-bearing (D4, D8, D9, D10, D12) is reviewable before a `.vue` file changes. What would have pushed it over is out of scope below: Monaco, tabs, the preview, snapshots, and any use of the files in the model's context. |

## In scope

- `functions/src/llm/fileops.ts` — **new.** The pure incremental splitter (D3, D4) and the
  collector that wraps it: chat-text frames with `[file: …]` markers substituted and whitespace
  normalised in the emitted stream (D6, D7, D16), file boundaries and chunks, and
  `finish()` → `{ messageText, ops, unterminated }`
- `functions/src/files/schema.ts` — **new.** `FILE_LIMIT`, `FILE_BYTES_MAX`, the filename schema
  (D12), the extension allowlist, the file-op set schema with its rejection reasons (D8, D9), the
  stored document schema with the `id === path` invariant (D13), the wire shapes, `filesPath()`
- `functions/src/files/handlers.ts` — **new.** `writeGeneratedFiles()` (the batch, D11),
  `readFileList()`, `handleListFiles`, `handleGetFile`, `handlePutFile`, `requireFilePath()`
- `functions/src/files/index.ts` — **new.** `filesRouter`, mounted at `/` and `/api`
- `functions/src/api/index.ts` — the new router mounted after `messagesRouter`
- `functions/src/generate.ts` — the collector wired between `mapStream` and the framing; the new
  frame types; the terminal rewritten around one batch (D10, D11) and the extended `done` payload
- `functions/src/messages/handlers.ts` — `appendAssistantMessage` becomes batch-aware so the
  message and the files commit together
- `functions/src/llm/schema.ts` — `FileStartPayload`, `FileChunkPayload`, `FileEndPayload`;
  `DonePayload` gains `files` and `fileError`
- `functions/src/lib/sse.ts` — `SseEventName` gains `file_chunk`
- `functions/src/llm/prompt.ts` — the file-format block and the moved breakpoint (D25)
- `firestore.rules` — a deny-all block for `users/{uid}/projects/{projectId}/files/{fileId}`
- `tests/fixtures/llm/` — `reply.json` becomes multi-file; `prose-only.json`, `bad-path.json`,
  `unterminated.json`, `duplicate-files.json` added
- `functions/src/llm/fake.ts` — the four new markers (D26)
- `frontend/src/lib/filesApi.ts` — **new.** `listFiles`, `getFile`, `saveFile`, the mirrored caps
- `frontend/src/lib/files.ts` — **new.** the tree merge, the entry-first comparator, the UTF-8
  byte count
- `frontend/src/lib/messageParts.ts` — **new.** `splitMessageContent()` (D29)
- `frontend/src/lib/generateApi.ts` — the three file events, and `done`'s two new fields
- `frontend/src/stores/workspace.ts` — the file list, the selected file and its buffer, the
  streaming buffers, the save path, the generation fan-out and the refetch (D20, D22, D24)
- `frontend/src/components/workspace/FileTree.vue` — **new.** loading, empty, error + Retry, rows,
  selection, streaming markers
- `frontend/src/components/workspace/FileEditor.vue` — **new.** textarea, byte count, Save, dirty
  state, read-only while streaming, save error, the replaced notice
- `frontend/src/components/workspace/EditorPanel.vue` — the placeholder replaced by the two
- `frontend/src/components/workspace/ChatPanel.vue` — file chips in bubbles and in the
  placeholder; the generation's `fileError`
- `tests/e2e/files.spec.ts` — **new** (D32)
- `docs/IMPLEMENTATION_PLAN.md`, `docs/PRODUCT_SPEC.md` — §0/§4/§8/§9 status and the two settled
  §8 rows

## Out of scope

| Not here | Picked up by |
|---|---|
| Monaco, tabbed editing, syntax highlighting, live tokens *in the editor component* | Slice 7 — this slice ships the textarea and the frames it will consume |
| Project files in the LLM's context; token-budget truncation; the HighLevel cheat-sheet (D28) | Slice 9 |
| Running the files — the `srcdoc` preview, the runtime shim, `index.html` being required | Slice 10 |
| Snapshotting the file set per generation; listing and restoring versions | Slice 11 |
| Creating a file by hand, renaming one, deleting one (D19) | Not planned — the generator writes files; the editor edits them |
| Deleting files a generation did not mention (D18) | Not planned |
| Directories or nested paths (D12) | Not planned |
| A diff of what a generation changed | Stretch S3 (F10.3) |
| Iterative refinement — a second prompt patching rather than rewriting (D28) | Stretch S1 (F10.1) / Slice 9 |
| Optimistic concurrency or a lock on `PUT` (D23) | Not planned |
| A conflict/merge UI for unsaved edits (D22) | Not planned |
| Markdown or syntax rendering inside a chat bubble (D6, D29) | Not planned — chips, not a renderer |
| Per-user rate limiting on `/generate` | Stretch S4 (F10.4) |
| Writing files from an interrupted or truncated turn (D10) | Not planned |

## User flow

1. The user opens a project. The code panel shows its loading state, then the file list — empty
   on a new project: "No files yet. Describe the app you want."
2. They type "build a contact dashboard" and send. The composer disables itself, the chat shows
   `Generating…`, and **the code panel goes read-only**.
3. Prose tokens grow the placeholder bubble. When the model opens `index.html`, a chip
   `index.html` appears in the bubble and a row appears in the file list marked *writing*; if
   nothing is selected, that file is selected so its content is visible as it arrives.
4. `styles.css` and `app.js` follow the same way. The code panel shows each file's text growing;
   the textarea stays read-only.
5. On `done` the placeholder is replaced by the persisted message — prose with three chips — the
   file list refetches from the server, the streaming buffers are dropped, and the panel becomes
   editable again.
6. The user clicks `index.html`, changes the heading, and the byte count and **Save** enable.
   **Save** issues `PUT`, the button settles, and the file is no longer dirty.
7. Reload. The transcript, the file list and the edited content all come back from the server.
8. If the model's output was malformed — a path we cannot store, a file left unterminated, more
   files or bytes than the caps allow — **no file is written at all**, the reply is still there,
   and the code panel shows what was refused with the file list untouched.
9. If the generation was interrupted, the partial reply is preserved with its Interrupted marker
   exactly as in Slice 5, no files are written, and the panel says the reply was cut short.

## Data model

**New collection: `users/{uid}/projects/{projectId}/files/{fileId}`, where `fileId` *is* the
path** (D13).

| Field | Type | Note |
|---|---|---|
| `path` | string | The filename, equal to the document id. `^[a-z0-9][a-z0-9._-]*$`, ≤ 64 chars, no `..`, one of `.html` `.css` `.js` `.json` `.md` (D12). A document whose `path` disagrees with its id is unreadable — omitted from the list, 404 by id, and logged |
| `content` | string | 0 – 100,000 UTF-8 bytes (D15). Empty is legal: a user may blank a file |
| `size` | number | UTF-8 byte length of `content`, computed server-side. Stored so the list can be a projection that never reads `content` |
| `createdAt` | Timestamp | `serverTimestamp()`. Preserved when a later generation rewrites the file |
| `updatedAt` | Timestamp | `serverTimestamp()`, advanced by a generation write and by `PUT` |

**Wire shapes.** `FileMeta` = `{ path, size, createdAt, updatedAt }` — what the list returns.
`FileContent` = `FileMeta & { content }` — what a read and a save return. Timestamps are ISO-8601
strings, the project's convention since Slice 2.

**Caps.** 20 files per project, counted as the union of a turn's ops with the paths already
stored; 100,000 UTF-8 bytes per file, enforced identically by the generator's validation and by
`PUT`.

**Rules.** One new deny-all block, with L3 tests in the same commit:

```
match /users/{uid}/projects/{projectId}/files/{fileId} {
  allow read, write: if false;
}
```

Rules do not cascade into subcollections, so the `projects` block says nothing about this path —
the block is required, not decorative, exactly as `messages` was. Nothing else in the file
changes.

**Indexes.** Unchanged. The list is `orderBy('path').limit(FILE_LIMIT).select(…)`, a single-field
order served by Firestore's automatic index (D30). `messages` keeps its `createdAt`+`seq`
composite.

**The project document is not touched by a file write** (D31).

## API contracts

Every error body is the existing envelope: `{ "error": "<user-facing message>", "code": "<machine
code>" }`. All three routes require an ID token with `email_verified`; the project is
ownership-checked before the collection is addressed, so absent, soft-deleted, unreadable and
someone else's project all collapse into one **404 `not_found`** (Slice 3, D14).

### `GET /api/projects/:projectId/files` — new

Not attested (a plain authenticated read, the rule since Slice 2).

- **200** → `{ "files": [ { "path": "app.js", "size": 4210, "createdAt": "…", "updatedAt": "…" } ] }`
  — ordered by `path`, **no `content` field on any entry**, at most `FILE_LIMIT` entries
- **200** → `{ "files": [] }` for a project that has never generated
- **400** `invalid_id` · **404** `not_found` · **401** `unauthenticated` · **403** `email_unverified`

### `GET /api/projects/:projectId/files/:path` — new

Not attested. `:path` is validated against the filename schema **before any Firestore call**.

- **200** → `{ "file": { "path": "index.html", "content": "<!doctype html>…", "size": 1204,
  "createdAt": "…", "updatedAt": "…" } }`
- **400** `invalid_path` — not a storable filename. No Firestore read
- **404** `not_found` — no such file, or the project is gone
- **401** / **403** as above

### `PUT /api/projects/:projectId/files/:path` — new

**Attested** (a mutation). Body `.strict()`: `{ "content": string }`, 0 – 100,000 UTF-8 bytes.

- **200** → `{ "file": { … } }` — the stored document re-read, with `size` recomputed and
  `updatedAt` advanced; `createdAt` unchanged
- **400** `invalid_body` — an extra key, a missing or non-string `content`, or one over the cap.
  Nothing written
- **400** `invalid_path` · **404** `not_found` — the file does not exist; `PUT` does not create (D19)
- **401** `unauthenticated` · **403** `email_unverified` · **401** `app_check_failed`

### `POST /generate` — changed

Body, auth and every pre-flush refusal are unchanged (Slice 5). The **event protocol grows**:

```
event: token
data: {"text":"Here is a contact dashboard.\n\n"}

event: file_start
data: {"path":"index.html"}

event: token
data: {"text":"[file: index.html]\n"}

event: file_chunk
data: {"path":"index.html","text":"<!doctype html>\n"}

event: file_end
data: {"path":"index.html"}

event: done
data: {"message":{…},"files":["app.js","index.html","styles.css"],"fileError":null}
```

- `token` → `{ text }` — **chat text only** (D5). Its concatenation is byte-identical to the
  persisted message's `content` (D7)
- `file_start` → `{ path }` — a block opened, emitted before any chunk for that path
- `file_chunk` → `{ path, text }` — content for that path, tags excluded, repairs applied
- `file_end` → `{ path }` — the block closed cleanly. An unterminated block never gets one
- `done` → `{ message, files, fileError }` — `files` is the paths **written** (empty when none
  were), `fileError` a user-facing sentence or `null`
- `error` → `{ error, code, message }` — unchanged. No files are written on this path (D10)

**`fileError` copy**, one sentence each:

| Cause | Copy |
|---|---|
| A path we cannot store | `Genesis could not save the generated files: "<path>" is not a file name we can store. Nothing was changed.` |
| The same path twice | `Genesis could not save the generated files: "<path>" was written twice. Nothing was changed.` |
| A file over the byte cap | `Genesis could not save the generated files: "<path>" is larger than 100 KB. Nothing was changed.` |
| Over the file cap | `Genesis could not save the generated files: a project can hold at most 20 files. Nothing was changed.` |
| An unterminated block | `The reply ended in the middle of "<path>", so nothing was saved. Try again.` |
| The turn did not complete | `The reply was cut short, so no files were saved. Try again.` |
| The batch failed | `The generated files could not be saved. Try again.` |

`<path>` goes through `displayPath()` — control characters stripped, 40 characters maximum — so a
pathological path cannot smuggle anything into the copy or blow up the panel.

## Edge cases and failure modes

| Situation | Behaviour | User sees | Retry? |
|---|---|---|---|
| Happy path, three files | Boundaries and chunks stream; one batch commits message + files; `done` lists three paths | Chips in the bubble, three rows in the list, content in the panel | n/a |
| Prose-only reply (D17) | No files, `fileError: null` | A normal reply; the list unchanged | n/a |
| A delimiter split across two deltas (D4) | The splitter holds back and resolves it | Nothing — invisible when correct | n/a |
| The model wraps the tags in a markdown fence | The fence lines are prose; the tags still parse (D2) | A stray ``` line in the bubble, and the files | n/a |
| An unquoted or malformed open tag | Not a delimiter; emitted as prose | The tag as text in the bubble, no file | Retry |
| A path with `..`, `/`, uppercase, no extension, or a disallowed one | Frames stream (D8), the whole set is refused at the terminal, **nothing is written** | The reply, the list untouched, `fileError` naming the path | Retry |
| The same path twice in one turn | Refused whole | As above | Retry |
| A file over 100,000 bytes, or more than 20 files (with existing ones counted) | Refused whole | As above, with the cap named | Retry |
| An unterminated final block | Its content is discarded, **nothing is written** | `fileError` naming the file | Retry |
| `stop_reason: 'max_tokens'`, or the 800 KB byte cap | `done`, message `truncated: true`, **no files** (D10) | The long reply with Interrupted, and "the reply was cut short" | Retry |
| Mid-stream upstream failure after a file closed | `error` frame as Slice 5, partial text persisted, **no files** | The partial with Interrupted, an error, **Retry** | Retry |
| Refusal (`stop_reason: 'refusal'`) | No message, no files | Slice 5's refusal copy | Retry after rephrasing |
| The client disconnects mid-stream | The SDK stream is aborted; the mapper reports `upstream`; no files | On return, the partial in the transcript, no new files | Retry |
| The client disconnects after a clean `end` | Message and files still commit (D10) | On return, the reply and its files | n/a |
| The batch commit fails | Nothing is written — message included; `error` `internal` with `message: null` | "Something went wrong. Please try again." | Retry |
| A generation rewrites the file being viewed, buffer clean | Buffer replaced by the server's copy on refetch | The new content | n/a |
| …buffer dirty (D22) | Buffer replaced; a notice is shown | "Replaced by the latest generation" | n/a |
| The user tries to edit while a stream is open (D21) | The textarea is disabled and Save is unavailable | A read-only panel with a reason | n/a |
| `PUT` for a path that does not exist | **404**, nothing created | "That file no longer exists." | n/a |
| `PUT` with content over the cap | **400**, nothing written; the UI disables Save before this | A byte count over the limit and a disabled Save | n/a |
| Two tabs saving one file | Last write wins (D23) | The later content on refresh | n/a |
| Two tabs generating for one project | Two atomic batches; per path, the later one wins | A longer transcript; a coherent file set | n/a |
| Another user's project id on any file route | **404** — the path composed from the token's uid names nothing | "That project no longer exists." | n/a |
| A stored file document whose `path` ≠ its id, or which fails to parse | Omitted from the list, 404 by id, one log line (D13) | The file simply is not there | n/a |
| The file list request fails | The existing list is kept, not emptied | An error with **Try again** in the panel | Retry |
| A file read fails | The selection stays, the buffer is not replaced | An error above the textarea, with **Try again** | Retry |
| A save fails | The buffer is kept exactly as typed, still dirty | The server's message beside **Save** | Re-save |
| A client tries the `files` collection directly | Denied by `firestore.rules`; there is no Firestore SDK in the frontend to try with | n/a | n/a |

## Acceptance criteria

**The splitter and the collector — pure (D3, D4, D16)**

- **AC-1** — Given a text with no delimiters, when it is pushed to the collector, then every
  emitted frame is a `token`, their concatenation is the text trimmed with runs of 3+ newlines
  collapsed to 2, and `finish()` reports no ops and `unterminated: false`.
- **AC-2** — Given prose, one `<genesis:file path="index.html">` block, and trailing prose, then
  the emitted sequence is `token`(prose), `file_start`, `token("[file: index.html]\n")`,
  `file_chunk`+, `file_end`, `token`(prose), and `finish()` reports one op whose `path` is
  `index.html` and whose content is the block body with the tags and their adjoining line breaks
  removed and exactly one trailing `\n`.
- **AC-3** — Given three blocks separated by prose, then the ops are in the order written, each
  file's chunks concatenate to its own content, and no chunk carries another file's text.
- **AC-4** — **Chunking invariance.** Given each fixture text, when it is pushed split at every
  single offset — and as one string — then the emitted frame sequence and `finish()`'s result are
  identical for every chunking.
- **AC-5** — Given a text where the file content contains `<`, `>`, ``` ``` ```, `<genesis:` and a
  line that is *nearly* the close tag, then the content is preserved verbatim, the block closes
  only on the real close tag, and no text is lost or duplicated: prose frames plus file chunks
  reconstruct the input minus the tags and the D16 repairs.
- **AC-6** — Given an open or close tag preceded on its line only by spaces or a tab, then it is a
  delimiter; given one preceded by any non-whitespace character, then it is prose.
- **AC-7** — Given a block that is never closed, then `finish()` reports `unterminated` with that
  path, the block is **not** an op, its content appears in no `token` frame, and no `file_end` was
  emitted for it.
- **AC-8** — Given content written with CRLF line endings and no trailing newline, then the op's
  content uses LF only and ends with exactly one `\n`.
- **AC-9** — **The message invariant (D7).** For every fixture, including the malformed ones,
  `finish().messageText` is byte-identical to the concatenation of every `token` frame the
  collector emitted.
- **AC-10** — Given a reply that is a single file block with no prose at all, then `messageText`
  is `[file: index.html]` — non-empty, so it can be persisted.

**Validation — pure (D8, D9, D12, D15)**

- **AC-11** — Given the paths `../secrets.js`, `/etc/passwd`, `assets/app.js`, `..`, `.env`,
  `Index.html`, `app`, `app.ts`, `a..b.js`, a 65-character name, and the empty string, then each
  is refused with a reason naming the path; given `index.html`, `styles.css`, `app.js`,
  `data.json`, `notes.md`, `a-b_c.2.js`, then each is accepted.
- **AC-12** — Given content of exactly 100,000 UTF-8 bytes, then it is accepted; given 100,001,
  then the set is refused; given multi-byte characters, then the count is bytes and not
  characters.
- **AC-13** — Given 21 ops in one turn, and given 15 ops against a project already holding 10
  files, then both are refused naming the file cap; given 20 ops where 5 rewrite existing files,
  then it is accepted.
- **AC-14** — Given two ops with the same path, then the set is refused naming that path.
- **AC-15** — Given a valid set, then it parses to stored documents whose `path` equals the
  intended document id and whose `size` equals the UTF-8 byte length of the content.

**The write path — over the wire (D10, D11, D20)**

- **AC-16** — Given a completed generation that writes three files, when the stream ends, then
  three documents exist under `users/{uid}/projects/{projectId}/files` with ids equal to their
  paths, content equal to the repaired block bodies, correct `size`, and the `done` frame carries
  those three paths with `fileError: null`.
- **AC-17** — Given the same turn, then the persisted assistant message's `content` is the prose
  with a `[file: <path>]` line per file and **no code**, and it is byte-identical to the
  concatenation of the turn's `token` frames.
- **AC-18** — Given a generation whose ops are refused (`__bad_path`), then **no file document
  exists or changes**, the assistant message is still written, `done.files` is empty and
  `done.fileError` names the refused path.
- **AC-19** — Given a project whose files were written by an earlier generation, when a second
  generation writes the same paths, then the same documents are updated — no duplicates, ids
  unchanged, `createdAt` preserved, `updatedAt` advanced, content replaced.
- **AC-20** — Given `__no_files`, then no file document is written, `done.files` is empty and
  `done.fileError` is `null`.
- **AC-21** — Given `__fail_midstream` where a file block closed before the failure, then the
  terminal is an `error` frame, the partial text is persisted `truncated: true`, and **no file
  document exists**.
- **AC-22** — Given `__max_tokens`, then the terminal is `done` with `truncated: true`, no file is
  written, and `fileError` says the reply was cut short.
- **AC-23** — Given `__unterminated`, then no file is written and `fileError` names the
  unterminated file.
- **AC-24** — Given `__dup_files`, then no file is written and `fileError` names the duplicated
  path.
- **AC-25** — Given any of the above, then for each streamed file the `file_start` frame precedes
  every `file_chunk` for that path, `file_end` follows them, the concatenated chunks equal the
  file's stored content where one was stored, and **no `token` frame contains file content**.

**The routes (D19)**

- **AC-26** — Given a project with files, when the caller `GET`s the list, then the entries are
  ordered by path, each carries `path`, `size`, `createdAt` and `updatedAt`, and **none carries
  `content`**; given a project with no files, then `{ files: [] }`.
- **AC-27** — Given a stored file, when the caller `GET`s it by path, then the response carries its
  content and size; given an unknown path, then `404`; given `../x`, `A.html` or `a.ts`, then
  `400 invalid_path` and no Firestore read.
- **AC-28** — Given a stored file, when the caller `PUT`s new content, then the response is 200
  with the new content and a recomputed `size`, `updatedAt` has advanced, `createdAt` has not, and
  a fresh `GET` returns the new content.
- **AC-29** — Given a `PUT` with an unknown path, then `404` and nothing is created; given a body
  with an extra key, a non-string `content`, or content over the cap, then `400 invalid_body` and
  the stored document is unchanged.
- **AC-30** — Given verified users alice and bob and a project of bob's holding a file, when alice
  lists, reads or writes that project's files, then every answer is `404 not_found` and bob's file
  is unchanged; the same for a soft-deleted project and a never-existing one.
- **AC-31** — Given no `Authorization` header, then every file route answers `401 unauthenticated`;
  given `email_verified: false`, then `403 email_unverified`; and the router table shows `PUT`
  carrying the App Check guard while the two `GET`s do not.

**Rules — the backstop**

- **AC-32** — Given any client — the owner, another signed-in user, an anonymous one — when it
  reads, lists, creates, updates or deletes
  `users/{uid}/projects/{projectId}/files/{fileId}`, then every operation is denied.
- **AC-33** — Given any client, when it touches `users/{uid}`, `users/{uid}/projects/{projectId}`,
  that project's `messages`, `hlConnections/{uid}` or `authThrottle/{key}`, then it is denied —
  re-asserted.

**The prompt (D25)**

- **AC-34** — Given the assembled system prompt, then the last block carries
  `cache_control: { type: 'ephemeral' }`, the file-format instructions appear at or above that
  breakpoint, no project name, uid, message content or timestamp appears anywhere in it, and the
  tag syntax, every allowed extension and both caps in the text are produced from the same
  constants the splitter and the schema use.

**The client library**

- **AC-35** — Given `listFiles`, `getFile` and `saveFile`, then each issues the documented method
  and path with the filename percent-encoded, `saveFile` sends exactly `{ content }`, and no
  `firebase/firestore` import exists anywhere under `frontend/src`.
- **AC-36** — Given a stream carrying `file_start`, `file_chunk`, `file_end` and a `done` with
  `files` and `fileError`, then `generateApi` yields each as a typed event; given frames missing
  `path` or `text`, or a `done` with no `files`/`fileError` at all, then the malformed frames are
  skipped and `done` yields `files: []` and `fileError: null` rather than throwing.

**The store (D20, D21, D22, D24)**

- **AC-37** — Given a project is opened, then the file list is fetched, `filesLoading` and
  `filesLoaded` follow it, and a failure sets `filesError` while leaving any existing list in
  place.
- **AC-38** — Given a file is selected, then its content is fetched, the buffer equals it and
  `fileDirty` is false; when the buffer is edited then `fileDirty` is true; when `saveFile()`
  succeeds then the stored content replaces the buffer and `fileDirty` is false; when it fails
  then the buffer is untouched, `fileDirty` stays true and `saveError` is set.
- **AC-39** — Given a stream emitting `file_start` / `file_chunk` / `file_end`, then the tree shows
  the union of stored and streaming paths with the streaming ones marked, each streaming buffer
  grows to the concatenation of its own chunks, and the first streamed file is selected only if
  nothing was selected.
- **AC-40** — Given `done` with a non-empty `files`, then the list is refetched, the open file is
  re-read, and the streaming buffers are cleared; given `done` with an empty `files`, then **no
  file request is issued** and the buffers are still cleared.
- **AC-41** — Given a dirty buffer for a file the generation rewrote, then the server's content
  replaces it and `fileReplaced` is true; given a clean buffer, then `fileReplaced` is false.
- **AC-42** — Given `done` with a `fileError`, then `generateFileError` is set; when the next
  generation starts, then it is cleared.
- **AC-43** — Given a stream is open, then `saveFile()` issues no request; given `reset()` or
  another project being opened, then every file field returns to its initial value and a response
  in flight cannot repopulate it.

**The components — loading, empty and error on a new screen**

- **AC-44** — Given the file list is loading, then `FileTree` renders a skeleton; given it is empty
  and loaded, then it renders "No files yet."; given it failed, then it renders the message and a
  **Try again** that calls `loadFiles()`; given files, then one row per file with `index.html`
  first and the rest alphabetical, the selected row marked, a click selecting a file, and a
  streaming row carrying a *writing* marker.
- **AC-45** — Given no selection, then `FileEditor` renders its empty state; given a selection,
  then the textarea holds the content and shows its byte count; **Save** is disabled unless the
  buffer is dirty and within the cap; given a stream is open, then the textarea is `disabled` and
  **Save** is unavailable; given a save error, then it renders beside **Save**; given
  `fileReplaced`, then the notice renders.
- **AC-46** — Given a message whose content mixes prose and `[file: app.js]` lines, then the bubble
  renders the prose as text and each marker as a file chip; given the streaming placeholder with
  the same text, then it renders the same way; given a message with no marker, then no chip is
  rendered.
- **AC-47** — Given the workspace at any width, then the code panel renders the tree and the editor
  and contains no "arrives in Slice 6" text anywhere in the app.

**End to end**

- **AC-48** — Given a verified account with a project, when the user sends a prompt, then file
  names appear in the code panel while the reply is still streaming, the chat bubble shows file
  chips and no code, and when the stream ends the file list holds the generated files; then when
  the user opens `index.html`, edits it, presses **Save** and reloads the page, the edited content
  is what the server returns.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1, AC-2, AC-3 | L1 | `functions/src/llm/fileops.spec.ts` | Prose-only, one block, three blocks: frames and ops |
| AC-4 | L1 | `functions/src/llm/fileops.spec.ts` | Chunking invariance, driven split at every offset |
| AC-5, AC-6 | L1 | `functions/src/llm/fileops.spec.ts` | Near-delimiters, tags in content, line-start rule |
| AC-7, AC-8 | L1 | `functions/src/llm/fileops.spec.ts` | Unterminated block; CRLF and trailing-newline repair |
| AC-9, AC-10 | L1 | `functions/src/llm/fileops.spec.ts` | `messageText` equals the token frames; the marker-only reply |
| AC-11, AC-12, AC-13, AC-14, AC-15 | L1 | `functions/src/files/schema.spec.ts` | Paths, byte caps, file caps, duplicates, stored shape |
| AC-16, AC-17 | L4 | `tests/integration/generate-files.spec.ts` | Three documents and the message the frames describe |
| AC-18 | L4 | `tests/integration/generate-files.spec.ts` | `__bad_path`: nothing written, message written, `fileError` |
| AC-19 | L4 | `tests/integration/generate-files.spec.ts` | A second generation updates in place |
| AC-20 | L4 | `tests/integration/generate-files.spec.ts` | `__no_files`: no writes, no error |
| AC-21, AC-22 | L4 | `tests/integration/generate-files.spec.ts` | Interrupted and truncated turns write no files |
| AC-23, AC-24 | L4 | `tests/integration/generate-files.spec.ts` | `__unterminated`, `__dup_files` |
| AC-25 | L4 | `tests/integration/generate-files.spec.ts` | Frame ordering, and `token` frames free of code |
| AC-26, AC-27, AC-28, AC-29 | L4 | `tests/integration/files.spec.ts` | The three routes, their bodies and their refusals |
| AC-30, AC-31 | L4 | `tests/integration/files.spec.ts` | Cross-tenant, soft-deleted, unauthenticated, unverified |
| AC-31 | L1 | `functions/src/index.spec.ts` | The deployment surface: which file routes are attested |
| AC-32, AC-33 | L3 | `tests/rules/firestore.spec.ts` | Every client operation on `files` denied; prior denials re-asserted |
| AC-34 | L1 | `functions/src/llm/prompt.spec.ts` | Breakpoint placement; format text derived from constants |
| AC-35 | L1 | `frontend/src/lib/filesApi.spec.ts` | Method, path, encoding, body |
| AC-35 | L1 | `frontend/src/lib/no-firestore.spec.ts` | Existing scan, unchanged |
| AC-36 | L1 | `frontend/src/lib/generateApi.spec.ts` | The three file events; a `done` missing its new fields |
| AC-37, AC-38 | L1 | `frontend/src/stores/workspace.spec.ts` | List and read lifecycles; save success and failure |
| AC-39, AC-40, AC-41 | L1 | `frontend/src/stores/workspace.spec.ts` | Streaming buffers, the refetch, the dirty replacement |
| AC-42, AC-43 | L1 | `frontend/src/stores/workspace.spec.ts` | `fileError` lifecycle; the read-only guard; reset and staleness |
| AC-44 | L2 | `frontend/src/components/workspace/FileTree.spec.ts` | Loading, empty, error + Retry, rows, selection, writing marker |
| AC-44 | L1 | `frontend/src/lib/files.spec.ts` | The entry-first comparator and the tree merge |
| AC-45 | L2 | `frontend/src/components/workspace/FileEditor.spec.ts` | Empty, content, byte count, Save states, read-only, notice |
| AC-45 | L1 | `frontend/src/lib/files.spec.ts` | The UTF-8 byte count, multi-byte included |
| AC-46 | L2 | `frontend/src/components/workspace/ChatPanel.spec.ts` | Chips in a bubble and in the placeholder |
| AC-46 | L1 | `frontend/src/lib/messageParts.spec.ts` | `splitMessageContent()` over mixed, marker-only and marker-free text |
| AC-47 | L2 | `frontend/src/views/WorkspaceView.spec.ts` | The code panel renders both components in both layouts |
| AC-48 | L5 | `tests/e2e/files.spec.ts` | Files appear while streaming → open → edit → Save → reload |

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`,
      `test:e2e`
- [ ] `users/{uid}/projects/{projectId}/files/{fileId}` has rules **and** L3 rules tests in the
      same commit as the collection's first write
- [ ] `firestore.indexes.json` is unchanged, and the review checks that claim against the list
      query rather than against D30
- [ ] F8.1 discharged for this surface: every row of the malformed-output table has a user-facing
      sentence and a test, and **no path exists that writes some of a turn's files**
- [ ] The code panel ships with loading, empty and error states (both components), and the chat
      panel's four existing states still pass
- [ ] The message invariant holds: the persisted `content` is byte-identical to the concatenation
      of the turn's `token` frames, asserted at L1 over every fixture and at L4 over the wire
- [ ] `messages.stream()` is still the only LLM call shape; `messages.create` appears nowhere in
      `functions/src`
- [ ] The system prompt's file-format text is interpolated from the parser's and schema's own
      constants — no second copy of the grammar
- [ ] No `firebase/firestore` import anywhere under `frontend/src`; every file read and write goes
      through a Cloud Function route scoped by the token's uid
- [ ] No secrets in source; no configuration added, so `.env.example` is unchanged — stated rather
      than assumed
- [ ] Runs clean on `npm run dev` (emulators) from a fresh clone: a generated file appears in the
      tree, opens, saves and survives a reload
- [ ] `IMPLEMENTATION_PLAN.md` §0 status, §4 Slice 6, §8's **two** now-settled rows (generated app
      format, file-op wire format) and §9's rows for F3.3, F4.2, F5.1 and F8.1 updated
- [ ] `PRODUCT_SPEC.md` §6 items 2 and 5 marked settled with a pointer to this PRD
- [ ] Hand-check owed to Slice 13 and recorded there: **the real `claude-opus-5` actually emits
      `<genesis:file>` tags** for a real prompt (R2) — every automated test drives the fake
- [ ] PR opened with demo evidence: files appearing while streaming, an edit saved, a reload;
      **human approves before merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **A delimiter split across two text deltas.** The naive splitter passes every hand-written test, because a hand-written test chunks on whole tags, and fails in production by leaking `<genesis:fi` into the chat and never opening the file. | D4's bounded hold-back, asserted as a **property**: every fixture is driven split at every offset and compared to the whole-string result (AC-4). The same technique the client's SSE parser already uses one layer down, for the same class of bug. |
| R2 | **The model may not follow the format.** Every automated test drives the fake, so "does `claude-opus-5` reliably emit `<genesis:file>` tags?" is unproven by construction — and if it does not, the feature produces prose-only turns and looks broken while every test is green. | Three things, and the third is the honest one: the instructions are explicit and derived from the parser's constants (D25); the splitter is deliberately tolerant — whitespace before a tag is allowed, a tag wrapped in a markdown fence still parses, and a prose-only turn is a legitimate outcome rather than an error (D17); and a **hand-check against the real model is in the definition of done and Slice 13's checklist**, not pretended into a test. |
| R3 | **All-or-nothing rejection (D9) makes one bad path cost a whole generation.** A model that habitually writes `assets/app.js` would make the feature unusable while every test passes. | `fileError` names the offending path, so the failure is diagnosable from the UI rather than the logs, and it is exactly what the R2 hand-check will surface. The prompt states the flat-filename rule and the extension list. A *repair* is deliberately refused (D16): flattening the path would leave the HTML referencing a directory that does not exist, which is a broken app instead of a refused one. If the hand-check shows the model wants directories, the decision to revisit is D12, in Slice 9, with the preview's requirements known. |
| R4 | **Two writers for one file document** — a generation's batch and the editor's `PUT`. Silently overwriting what a user is typing is the worst failure in this slice, because nothing reports it. | D21 closes the window where it actually happens: the panel is read-only while a stream is open. D22 covers the residue — a buffer dirty from before the send is replaced *and announced*. Both are ACs (AC-43, AC-41), and the store-level test is the one that matters, since the component only reflects it. |
| R5 | **The stored message and the `token` frames could drift** the moment any normalisation happens after the fact — and the drift would be in whitespace, which nobody notices until the placeholder swap makes the bubble twitch. | D7 makes the collector the single producer and normalises **inside** the emitted stream; AC-9 asserts equality at L1 over every fixture, AC-17 over the wire. Stated as an invariant rather than a habit, so a later slice adding a `.trim()` before the write fails a test instead of shipping. |
| R6 | **A missing composite index is this project's recurring production-only failure** — Slices 3 and 4 both paid for one, and the emulator does not enforce them. | D30: the list query orders by one field, which Firestore indexes automatically, and `select()` adds nothing. The claim is in the definition of done as something the review verifies against the query. If a later slice adds a `where` beside the `orderBy`, that is the moment `firestore.indexes.json` changes. |
| R7 | **The new collection could ship without rules.** It is the project's standing rule precisely because it is the easy thing to forget, and here the collection's first write lives inside a streaming handler where attention is elsewhere. | The rules block and its L3 tests are in the same commit as `writeGeneratedFiles`, and the build order puts them before the routes that read the collection. AC-32 is an `assertFails` for every operation, matching the `messages` block's shape. |
| R8 | **Changing `reply.json` changes the fixture five other suites already depend on** — Slice 5's integration cases, `__slow`, `__long`, `__fail_midstream`, and its e2e. Turning green tests red reads like a regression. | D26 keeps the prose of `reply.json` byte-for-byte and *appends* file blocks, so the existing assertions — progressive text, `truncated`, the accumulated content — are about text that has not moved. The one deliberate consequence is that those suites now also exercise the file path, which is the point. Anything that genuinely must change is changed in the same commit as the behaviour that requires it. |
| R9 | **This is a wide slice** — a parser, a collection, three routes, a store extension and three components — and a wide slice is where a review misses something. | D33's build order: the pure boundary first (splitter, schema), then the batch write with its rules, then the routes, then the client, then the components. Every security-relevant decision is reviewable before a `.vue` file changes, and every scope temptation is a named out-of-scope row rather than a judgement call at the keyboard. |

## Blocked

Nothing. Every question this slice raises is answered above.
