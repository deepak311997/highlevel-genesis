# Slice 09 — HighLevel knowledge injection · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/09-highlevel-knowledge` · **Date:** 2026-08-18

## Approach

The cheat-sheet is a **rendered module**, not prose: `functions/src/llm/hlKnowledge.ts`
builds one string at module load from `HL_ROUTES` (filtered by `isRouteEnabled(row,
process.env)`), from `proxyError.ts`'s code set, and from hand-authored per-surface notes and
trimmed response examples — so the allowlist has one source and three consumers, as
`HIGHLEVEL_PLATFORM.md` §8 asks (D2). That string becomes `SYSTEM_PROMPT`'s third block and
the `cache_control` breakpoint moves onto it, which is the move `prompt.ts`'s own header has
been promising since Slice 5.

Context assembly splits into two pure functions with two independent budgets (D12):
`buildProjectState(files)` in a new `projectState.ts` returns one `TextBlockParam` or `null`,
and `buildContext(messages)` in the existing `context.ts` gains oldest-end trimming plus the
leading-assistant guard. `buildParams` gains a second parameter — the project's files — and
appends the state block *after* the breakpoint, so a volatile block can never invalidate the
cached prefix. When the project holds no files, `system` is still the `SYSTEM_PROMPT` array
itself, by identity, which is what keeps AC-13 a one-line assertion.

Observability is a pure `extractHlCalls(code)` in `hlCalls.ts`, run over the turn's file
contents in `finishTurn` and reduced to two integers on `generation.complete`. Nothing user-
or model-written joins it, which keeps `GenerationLogContext`'s existing guarantee intact.

Alternatives considered and rejected: **tool-calling** for HighLevel knowledge — non-determinism
and latency for an artefact that runs later, in a browser (D1); **a hand-written endpoint list**
— drifts on the first allowlist change, and the drift is invisible until a generated app gets a
403 (D2); **one pooled context budget** — a long conversation would evict the code F3.2 exists
to preserve (D12); **widening `readFileList`** to carry `content` — ships 20 × 100 KB to every
workspace that opens a file tree (D26); **a synthetic leading `user` message** for the project
state — invents a turn in a transcript whose value is being a true record (D11).

## File map

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/llm/budget.ts` | New | `CHARS_PER_TOKEN`, `estimateTokens`, `PROJECT_FILE_BUDGET` (120,000), `TRANSCRIPT_BUDGET` (80,000) — D13's "one edit and a test" |
| `functions/src/llm/budget.spec.ts` | New | The estimator's arithmetic and both constants' values |
| `functions/src/llm/hlKnowledge.ts` | New | `HL_KNOWLEDGE: string`, rendered at module load; `RESPONSE_EXAMPLES` exported as data for AC-9 |
| `functions/src/llm/hlKnowledge.spec.ts` | New | AC-1, 2, 3, 5, 6, 7, 8, 9 |
| `functions/src/llm/projectState.ts` | New | `buildProjectState(files): TextBlockParam \| null`, the delimiters, the manifest line |
| `functions/src/llm/projectState.spec.ts` | New | AC-14 to AC-17 |
| `functions/src/llm/hlCalls.ts` | New | `extractHlCalls(code)`, `countHlCalls(calls, env)` |
| `functions/src/llm/hlCalls.spec.ts` | New | AC-23, AC-25 |
| `functions/src/hl/proxyError.ts` | Edit | Export `PROXY_ERROR_CODES` (the keys of `MESSAGES`) so AC-7 reads the set rather than restating it |
| `functions/src/hl/proxyError.spec.ts` | Edit | One case: the exported array is exactly the keys of the copy table |
| `functions/src/llm/prompt.ts` | Edit | Third block = `HL_KNOWLEDGE`; `cache_control` moves onto it; header rewritten (the "no-op until Slice 9" paragraph is now history) |
| `functions/src/llm/prompt.spec.ts` | Edit | AC-4, AC-10, AC-11; the Slice 5 needle list drops `leadconnectorhq`/`/contacts` and gains `/api/hl/proxy` |
| `functions/src/llm/params.ts` | Edit | `buildParams(context, files = [])`; appends the project-state block; `EFFORT` becomes `high` |
| `functions/src/llm/params.spec.ts` | Edit | AC-12, AC-13, AC-22 |
| `functions/src/llm/context.ts` | Edit | Budget trim from the oldest end, newest-user-message floor, leading-assistant drop |
| `functions/src/llm/context.spec.ts` | Edit | AC-18 to AC-21 (AC-20 is the Slice 5 regression, kept) |
| `functions/src/llm/index.ts` | Edit | Re-export `buildProjectState`, `extractHlCalls`, `countHlCalls`, `estimateTokens`; `hlKnowledge` stays internal to `prompt.ts` |
| `functions/src/llm/fake.ts` | Edit | `FakeParams` gains `system`; `__context` marker (D25) |
| `functions/src/llm/fake.spec.ts` | Edit | `__context` reports blocks, message count and paths; the marker table doc line |
| `functions/src/files/handlers.ts` | Edit | `readProjectFiles(uid, projectId): Promise<StoredFile[]>` beside `readFileList` |
| `functions/src/files/handlers.spec.ts` | Edit | Ordering, the `FILE_LIMIT` cap, and the unreadable/id-mismatch skip |
| `functions/src/lib/log.ts` | Edit | `GenerationLogContext` gains `hlCallsKnown`, `hlCallsUnknown` |
| `functions/src/lib/log.spec.ts` | Edit | Its `GenerationLogContext` literal gains the two fields (typecheck) |
| `functions/src/generate.ts` | Edit | Reads the files before the flush; passes them to `buildParams`; `collector.finish()` moves above `logGeneration`; the two counters |
| `functions/src/generate.spec.ts` | Edit | AC-24 (the key list grows by two), AC-28 at L1 — see *Deviations* |
| `tests/fixtures/llm/reply.json` | Edit | `app.js`'s block body only: `fetch('/api/hl/contacts')` → two `hl(...)` calls. Prose, paths and block count untouched (Slice 6 R8) |
| `tests/fixtures/llm/README.md` | New | Provenance: the LLM fixtures are hand-authored, not recorded from the model (D20) |
| `tests/integration/generate-context.spec.ts` | New | AC-27, plus the corrupt-file-document case |
| `tests/e2e/files.spec.ts` | Edit | AC-26: the walk opens `app.js` and asserts `hl(` in the editor |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §8's open-decisions row "HL knowledge: cheat-sheet vs tool-calling" → Settled (D1) |

No `firestore.rules` change, no index, no `.env.example` change, no new dependency, and no
frontend file at all (D21).

## Task list

Ordered so every task leaves `npm test` green and nothing depends on a later one to compile.

### T1 — The budget module  → AC-11 (support), AC-15, AC-18
- **Red:** `functions/src/llm/budget.spec.ts` — `estimateTokens` returns `Math.ceil(length / 4)`
  for `''`, a 4-character string and a 4,097-character one; `PROJECT_FILE_BUDGET` is 120,000 and
  `TRANSCRIPT_BUDGET` is 80,000, with `estimateTokens` of each equal to 30,000 and 20,000 (D13's
  numbers stated in both units, so a re-tune cannot silently change the token claim).
- **Green:** `functions/src/llm/budget.ts` with the two constants, `CHARS_PER_TOKEN = 4` and the
  estimator. Characters, not tokens, and the module header carries D12's reason: an exact count
  needs `messages.count_tokens`, a round trip and a charge per generation.
- **Refactor:** nothing expected; the module is four lines and a paragraph.

### T2 — The proxy error codes, as data  → AC-7 (support)
- **Red:** `functions/src/hl/proxyError.spec.ts` — a case asserting `PROXY_ERROR_CODES` equals
  `Object.keys(MESSAGES)` as read through `proxyError()` (i.e. every code in the array builds an
  `HttpError` whose message is non-empty), and that it contains all twelve names the PRD's
  contract lists.
- **Green:** `export const PROXY_ERROR_CODES = Object.keys(MESSAGES) as readonly ProxyErrorCode[]`
  in `functions/src/hl/proxyError.ts`, beside the type.
- **Refactor:** derive `ProxyErrorCode` from the same place it already is (`keyof typeof MESSAGES`)
  — no change, but confirm the array and the type cannot disagree.

### T3 — The cheat-sheet  → AC-1, AC-2, AC-3, AC-5, AC-6, AC-7, AC-8, AC-9
- **Red:** `functions/src/llm/hlKnowledge.spec.ts`, one describe per AC:
  - AC-1 — for every row of `HL_ROUTES` with no `flag`, `HL_KNOWLEDGE` contains
    `` `${row.method} ${row.pattern}` `` exactly.
  - AC-2 — extract every route reference from `HL_KNOWLEDGE` two ways (the table lines, via
    `/\b(GET|POST|PUT)\s+(\/\S+)/g`, and the prose examples, via `extractHlCalls` once T8 lands —
    until then the same regex covers both); substitute a legal sample id for each `:param`
    segment; assert `matchRoute(method, concrete)` is `matched` **and** `isRouteEnabled(row, {})`.
    Plus the negative that makes the scan meaningful: `HL_KNOWLEDGE` contains no `DELETE` and no
    `PATCH`.
  - AC-3 — `HL_ALLOW_MESSAGE_SEND` unset ⇒ `POST /conversations/messages` absent; `'true'` ⇒
    present. Driven with `vi.resetModules()` + `vi.stubEnv` and a dynamic `await import`, because
    the render happens at module load (D3).
  - AC-5 — contains `locationId` and a sentence forbidding sending it.
  - AC-6 — contains `startTime`, `endTime`, the words for epoch milliseconds, and the ISO trap
    ("returns an empty success, not an error").
  - AC-7 — every member of `PROXY_ERROR_CODES` appears; so do `try`, `catch`, `message` and
    `hl_reconnect_required`'s reconnect instruction.
  - AC-8 — contains `100` and `10 seconds`, and a sentence forbidding one request per row.
  - AC-9 — for each entry of `RESPONSE_EXAMPLES`, every field name reachable in its `example`
    object appears as a key somewhere in `JSON.parse(readFileSync(tests/fixtures/highlevel/<fixture>))`.
    Field names are collected recursively; the fixture's keys likewise. `hl/schema.spec.ts`'s
    `join(__dirname, '../../../tests/fixtures/highlevel')` is the path idiom.
- **Green:** `functions/src/llm/hlKnowledge.ts`. Structure:
  1. the calling convention — `await hl(method, path, payload?)`, payload as query on `GET` and
     JSON body on `POST`/`PUT`, resolving with HighLevel's own body unwrapped;
  2. the two rules — never send `locationId` (naming the key), never one request per row (naming
     100 requests / 10 seconds);
  3. the route table, rendered from the enabled rows as `- METHOD /pattern — <note>`, notes keyed
     by pattern in a local record so a new row without a note is a visible gap;
  4. the per-surface parameter notes — `/contacts/search` takes `{ pageLimit, page }` only, the
     filter grammar is undocumented here and a page should be filtered in the browser (D6);
     `/calendars/events` takes `startTime`/`endTime` as **epoch milliseconds** plus one of
     `calendarId`/`userId`/`groupId`, and ISO-8601 returns `{"events":[]}` with HTTP 200 (D7);
     response timestamps come back as ISO strings, which is the other half of that trap;
  5. the response examples, `JSON.stringify(example, null, 2)` per surface;
  6. the error contract — the twelve codes from `PROXY_ERROR_CODES`, `try`/`catch`, show
     `message`, and on `hl_reconnect_required` tell the user to reconnect HighLevel.
  **Three things the file must not contain**, each of which is a failing test elsewhere: the
  HighLevel origin and `/api/hl/proxy` (AC-4); the rows' `version` values, because `2021-07-28`
  matches `prompt.spec.ts`'s `VOLATILE` date pattern and the proxy attaches the header anyway;
  any literal timestamp or 10-digit run inside an example — temporal values are replaced by a
  short description (`"epoch milliseconds"`, `"an ISO 8601 timestamp"`) while every other value
  is copied from the fixture, so AC-9 stays a field-name check and AC-10 stays mechanical.
- **Refactor:** collapse the per-pattern note record and the row renderer into one pass; confirm
  the module exports only `HL_KNOWLEDGE` and `RESPONSE_EXAMPLES`.

### T4 — The cheat-sheet in the prompt, and the breakpoint on it  → AC-4, AC-10, AC-11, AC-12
- **Red:** `functions/src/llm/prompt.spec.ts` —
  - the array has three blocks; exactly one carries `cache_control`; it is the last one;
  - `SYSTEM_PROMPT` joined contains `hl('` and contains neither `services.leadconnectorhq.com`
    nor `/api/hl/proxy` (AC-4) — the Slice 5 needle list loses `leadconnectorhq` and `/contacts`,
    which now legitimately appear, and gains the proxy path;
  - the existing `VOLATILE` scan runs unchanged over all three blocks (AC-10);
  - `estimateTokens(SYSTEM_PROMPT.map(b => b.text).join('\n')) >= 1024` (AC-11);
  - the identity case (`JSON.stringify` equal on two reads) still passes.
- **Green:** `prompt.ts` gains a third element whose `text` is `HL_KNOWLEDGE`, carrying
  `cache_control: { type: 'ephemeral' }`; the second block loses it. Rewrite the header: the
  breakpoint is real from here, and the "silent no-op" paragraph becomes a record of what changed
  and why (D18), including the 2× margin over the 512-token minimum and the note that the real
  confirmation is `cache_read_input_tokens > 0` on a second generation.
- **Refactor:** none expected. Do **not** try to make the cheat-sheet a fourth block or split it —
  one block keeps "the breakpoint is the last element of the stable prefix" a one-line assertion.

### T5 — The project-state block  → AC-14, AC-15, AC-16, AC-17
- **Red:** `functions/src/llm/projectState.spec.ts` —
  - no files ⇒ `null`;
  - three files ⇒ one `TextBlockParam` whose text contains each path and each content **byte for
    byte**, including a file whose content contains a line reading `</genesis:file>` (AC-14, D24);
  - files whose combined length exceeds `PROJECT_FILE_BUDGET` ⇒ the included contents sum to no
    more than the budget, and every omitted file appears in a manifest line with its size (AC-15);
  - `index.html` plus a larger and a smaller file ⇒ `index.html` first, the rest ascending by size
    (AC-16);
  - one file longer than the whole budget ⇒ **no substring of it appears anywhere in the block** —
    asserted on a distinctive 200-character slice taken from its middle (AC-17), and the manifest
    line still names it;
  - the block carries no `cache_control` of its own.
- **Green:** `functions/src/llm/projectState.ts`.
  - `export interface ProjectFile { path: string; content: string }` — the two fields the block
    needs, so a caller cannot pass a stale `size` that disagrees with the content.
  - Order: `index.html` first when present, then ascending `content.length`, ties broken by path
    so the block is deterministic.
  - Take whole files while the running total plus the next file's length is within
    `PROJECT_FILE_BUDGET`; **never truncate** — a skipped file goes to the manifest and the loop
    continues, so a single huge file does not starve the smaller ones behind it.
  - Delimiters are exported constants and deliberately not the `<genesis:file>` pair (D24):
    `PROJECT_FILE_OPEN = '===== FILE '`, rendered as `===== FILE <path> (<n> characters) =====`,
    and `PROJECT_FILE_CLOSE = '===== END FILE ====='`. Sizes are in characters, the same unit as
    the budget, so the block cannot quote a number the budget did not measure.
  - The manifest line, present only when something was omitted: a sentence saying these files
    exist in the project and were not included, then `path (n characters)` per file (D14).
  - A lead-in sentence saying this is the project's current content and that a file the model does
    not intend to change should not be rewritten.
- **Refactor:** extract the "order" step so the ordering rule is readable on its own.

### T6 — Files in the request  → AC-12, AC-13
- **Red:** `functions/src/llm/params.spec.ts` —
  - `buildParams([])` — `system` is `SYSTEM_PROMPT` **by identity** (`toBe`), which is AC-13 and
    also the cache guarantee;
  - `buildParams([], files)` — `system` has one more element than `SYSTEM_PROMPT`, the extra one
    is last, and the element carrying `cache_control` is the one before it (AC-12);
  - exactly one block in the whole array carries `cache_control`;
  - the parameter-key list is still the same five.
- **Green:** `buildParams(context: MessageParam[], files: readonly ProjectFile[] = [])`; when
  `buildProjectState(files)` returns a block, `system` becomes `[...SYSTEM_PROMPT, block]`,
  otherwise it stays `SYSTEM_PROMPT` itself. Header note: the copy is made **only** when there is
  something volatile to append, and it is appended *after* the breakpoint, which is the whole of
  D11.
- **Refactor:** none expected.

### T7 — Effort  → AC-22
- **Red:** `params.spec.ts` — `EFFORT` is `'high'` and `buildParams([]).output_config?.effort` is
  `'high'`; `max_tokens` is still 64,000; there is still no `thinking` key.
- **Green:** `EFFORT = 'high' as const` in `params.ts`, and rewrite the header paragraph to D17:
  `low` was chosen when this slice generated prose, `high` is the documented minimum for
  intelligence-sensitive work and the API default, `xhigh` was rejected because the visible thing
  in this demo is tokens appearing and R2 is argued rather than measured, and the sweep is a named
  manual check. State that this is only safe because D14 left thinking on —
  `thinking: { type: 'disabled' }` is rejected outright above effort `high` on `claude-opus-5`.
- **Refactor:** none.

### T8 — Transcript trimming  → AC-18, AC-19, AC-20, AC-21
- **Red:** `functions/src/llm/context.spec.ts`, added to the existing cases —
  - a transcript whose content sums past `TRANSCRIPT_BUDGET` ⇒ the newest messages survive, the
    oldest are gone, and the kept content sums to at most the budget (AC-18);
  - a transcript built so the budget cut lands on an assistant turn ⇒ the first element has role
    `user` (AC-19). Built explicitly — `u a a a … u` with the sizes chosen so the boundary is
    known — because R3 is exactly the case a fixture-sized test never reaches;
  - the existing trailing-assistant cases still pass and the result is non-empty (AC-20);
  - a single newest user message longer than the whole budget ⇒ it is returned, alone, and the
    result is not empty (AC-21);
  - purity: the caller's array is unmodified.
- **Green:** `buildContext` becomes three steps in this order — drop trailing assistants (Slice 5
  D6, unchanged); walk from the newest backwards accumulating `content.length`, stopping at
  `TRANSCRIPT_BUDGET` but **always keeping the newest surviving message** (D16); drop leading
  assistants. The last step cannot empty the result, because step one leaves a user message last
  and step two always keeps it — state that as a comment, since it is the argument that AC-19 and
  AC-21 do not contradict each other.
- **Refactor:** name the three steps as local functions if the body passes ~30 lines; otherwise
  leave one function with three commented movements.

### T9 — Reading the files  → AC-14 (support), AC-27 (support)
- **Red:** `functions/src/files/handlers.spec.ts` — `readProjectFiles` returns files ordered by
  path with their `content`; caps at `FILE_LIMIT`; skips a document that fails `storedFileSchema`
  and one whose id and `path` disagree, logging `file.unreadable` once each and returning the
  rest. (The existing suite's `getDb` mock shape is the pattern to follow.)
- **Green:** `readProjectFiles(uid, projectId)` in `functions/src/files/handlers.ts` — the same
  query as `readFileList` with **no** `select(...)`, parsed with `storedFileSchema`, sharing the
  ordering, the cap and the unreadable-document logging. A short header saying why it is a second
  reader rather than a widening of the first (D26).
- **Refactor:** if the two readers' parse-and-log bodies converge, extract one helper taking the
  schema; do not merge the queries.

### T10 — Extracting `hl()` calls, and the golden reply  → AC-23, AC-25
- **Red:** `functions/src/llm/hlCalls.spec.ts` —
  - a corpus with two calls returns both, in order, as `{ method, path }`;
  - text with no call returns `[]`;
  - near misses return nothing: `hl` inside an identifier (`myhl('GET', '/x')`), a template
    literal path, a variable path (`hl(method, path)`), a commented-out call is *not* excluded
    (state that: the extractor is a metric, not a parser);
  - `countHlCalls` splits an allowlisted call from an unknown route and from a disabled row;
  - AC-25 — every call `extractHlCalls` finds in `tests/fixtures/llm/reply.json`'s file blocks
    resolves through `matchRoute` to an enabled row.
- **Green:** `functions/src/llm/hlCalls.ts` — a global regex over
  `hl(` `'METHOD'` `,` `'/path'`, single or double quoted, tolerant of whitespace, capturing
  `[A-Z]+` for the method so a `DELETE` is counted as unknown rather than missed; plus
  `countHlCalls(calls, env)` returning `{ known, unknown }` via `matchRoute` and `isRouteEnabled`.
  With `noUncheckedIndexedAccess`, guard every capture group.
  Then edit `tests/fixtures/llm/reply.json`: **only** the `app.js` block's deltas change, to a
  dashboard that calls `hl('POST', '/contacts/search', { pageLimit: 20 })` and
  `hl('GET', '/calendars/events', { startTime, endTime, calendarId })` inside `try`/`catch`. The
  prose deltas, the three paths, the block count and the recorded thinking delta are untouched,
  so `fake.spec.ts`'s pinned prose, `generate.spec.ts` and both integration suites stay green
  (Slice 6 R8's rule, applied again). Add `tests/fixtures/llm/README.md` recording that these
  sequences are hand-authored to the shape the prompt specifies and are **not** evidence about
  what the model does (D20) — the fixtures are JSON and cannot carry the note themselves.
- **Refactor:** none expected.

### T11 — The two counters  → AC-24
- **Red:** `functions/src/generate.spec.ts` — `logGeneration` emits `hlCallsKnown` and
  `hlCallsUnknown`, and the exact-key assertion grows to eleven keys and no more; the
  "no part of the reply in the line" case still passes when handed an extra `text` field.
- **Green:** `GenerationLogContext` in `functions/src/lib/log.ts` gains the two numeric fields
  (with a note that they are integers and carry no user content, which is why they may join a
  context that deliberately has no free-form body); `logGeneration` projects them; `log.spec.ts`'s
  literal gains them. In `generate.ts`'s `finishTurn`, move `const collected = collector.finish()`
  **above** the `logGeneration` call — it emits no frames, and the frame loop stays where it is —
  then compute `countHlCalls(extractHlCalls(collected.ops.map(op => op.content).join('\n')),
  process.env)` and pass both counts. State in a comment why the source is the file blocks and not
  the chat text: the metric is about generated code.
- **Refactor:** none.

### T12 — The handler reads the project's files  → AC-28 (see *Deviations*)
- **Red:** `functions/src/generate.spec.ts` — with `getDb` mocked so the files query rejects,
  `handleGenerate` rejects, `res.headersSent` is `false`, and `openStream` was never called; and
  a companion case where the read resolves with two documents and `buildParams` is reached with
  them (assert via the fake's params or by spying on `openStream`'s argument: `system` has four
  blocks).
- **Green:** in `handleGenerate`, after the empty-context check and before `openStream`, call
  `readProjectFiles(uid, projectId)` and pass the result to `buildParams`. It sits before the
  flush, so a failure is an ordinary JSON 500 with a real status (D9, R8). Extend the numbered
  order comment above the function to include the file read.
- **Refactor:** none.

### T13 — The `__context` marker  → AC-27
- **Red:** `functions/src/llm/fake.spec.ts` — `__context` yields one token whose text parses as
  JSON carrying `systemBlocks`, `messages` and `paths`, with `paths` read out of the project-state
  block; and `tests/integration/generate-context.spec.ts` —
  - a project holding three files, generated with `__context`: the reported `systemBlocks` is 4
    and `paths` is the three paths (AC-27);
  - a project holding none: `systemBlocks` is 3 and `paths` is empty;
  - a project holding a corrupt file document (id/`path` mismatch): the generation still
    completes and that path is absent from `paths`.
- **Green:** `FakeParams` widens to `{ messages, system? }`; `planFor(params)` takes the whole
  params; `__context` joins `MARKERS` and the doc table. Its plan is built programmatically, like
  `longEvents()` — `message_start`, one text delta carrying
  `JSON.stringify({ systemBlocks, messages, paths })`, `message_delta`, `message_stop`. Paths are
  read from the last system block with the exported `PROJECT_FILE_OPEN` delimiter, so the fake and
  the builder cannot drift.
- **Refactor:** none.

### T14 — The demo, in a browser  → AC-26
- **Red:** `tests/e2e/files.spec.ts` — in the existing walk, after the tree fills, open `app.js`
  and assert the editor's value contains `hl(`; assert it contains neither `locationId` nor
  `leadconnectorhq`.
- **Green:** nothing to implement — T10's fixture is what makes it pass. If it fails, the fixture
  is wrong, which is the point of asserting it here as well as at L1.
- **Refactor:** move the `hl(` needle to a named constant beside `GENERATED` so the two fixtures
  facts sit together.

### T15 — The record  → no AC (documentation)
**This task has no failing test and cannot have one**: it edits prose. `docs/IMPLEMENTATION_PLAN.md`
§8's open-decisions row — "HL knowledge: cheat-sheet vs tool-calling · Slice 9 · 🟡 Open, leaning
cheat-sheet" — becomes Settled, naming this slice and D1. Nothing else in that document changes.

## Firestore rules changes

**None.** This slice creates no collection. It reads
`users/{uid}/projects/{projectId}/files`, which Slice 6 created; `firestore.rules` already denies
that collection to every client including its owner, and `tests/rules/` already proves the denial.
The rules file and the rules suite are untouched, and `npm run test:rules` must stay green
unchanged — a diff there in this slice is a mistake, not a feature.

The one new read is `readProjectFiles`: at most `FILE_LIMIT` (20) documents ordered by `path`,
served by Firestore's automatic single-field index, so no `firestore.indexes.json` entry is owed
(the same argument `readFileList` records).

## Dependencies

**None.** No new package in `functions/`, `frontend/` or the root. Everything this slice needs —
`@anthropic-ai/sdk` types, Zod, Vitest, Playwright — is already installed.

## Manual verification

On emulators, from a fresh clone (`npm run install:all`, then `npm run emulators`, then
`npm --prefix frontend run dev:emulator`):

1. Sign up, verify, open a project. Send `build a contact dashboard`. Watch the files stream in;
   open `app.js` and read the two `hl(...)` calls — an allowlisted route, no token, no
   `locationId`.
2. Send a second prompt in the same project (`add a search box`). Confirm the reply still streams
   and nothing 400s — this is the path where the project-state block and the trimmed transcript
   both exist.
3. In the functions emulator log, find `generation.complete` and confirm `hlCallsKnown` is 2 and
   `hlCallsUnknown` is 0, and that no message or file content appears on the line.
4. `curl` a generation with the `__context` prompt and confirm the reported block count is 4 for a
   project holding files and 3 for an empty one.
5. Run `HL_ALLOW_MESSAGE_SEND=true` against the emulator and confirm `POST /conversations/messages`
   appears in the rendered cheat-sheet (a one-line node script importing `hlKnowledge` is enough).

The three checks that need real credentials are the PRD's, and are **not** dischargeable here —
they go in the PR as named, unticked items: one real generation with the generated `app.js`
pasted in; two generations in one session showing `cacheCreationInputTokens > 0` then
`cacheReadInputTokens > 0`; and an effort sweep at `high` versus `xhigh` recording
time-to-first-token.

## Deviations from the PRD

Two, both recorded rather than quietly absorbed.

- **AC-28 moves from L4 to L1.** The PRD assigns "the file read fails ⇒ a JSON 500 and no
  `text/event-stream` headers" to `tests/integration/generate-context.spec.ts`. There is no honest
  way to make an Admin SDK read fail against the Firestore emulator: a corrupt document is
  *parsed* and skipped, not a read failure, and forcing one would mean adding a fault-injection
  path to production code — a backdoor to prove an error message. So the assertion runs at L1 in
  `generate.spec.ts`, where `getDb` is already mocked and where `res.headersSent === false` is
  directly observable (T12), and the *neighbouring* real behaviour — a corrupt file document does
  not break a generation — is asserted at L4 in T13. This is a stronger assertion on the property
  that matters and a weaker one on the wiring; the wiring is covered by AC-27 on the same file.
- **AC-25's "golden reply fixture" is `tests/fixtures/llm/reply.json`**, not a new file. It is
  already the fixture the e2e walk and five suites drive, so making *it* HighLevel-shaped is what
  lets AC-25 and AC-26 assert the same artefact — and it retires the `fetch('/api/hl/contacts')`
  call it currently carries, which names a route Slice 8 D1 explicitly rejected. D20's "says so in
  its own file" is honoured by `tests/fixtures/llm/README.md`, since a JSON fixture cannot carry a
  comment.

Every other acceptance criterion maps to at least one task above, and no AC maps to none.

## Estimate

| Task | Estimate |
|---|---|
| T1 budget module | 20 min |
| T2 proxy error codes | 15 min |
| T3 the cheat-sheet | **3 h** — the writing is the work, and AC-2/AC-9 are two scanners |
| T4 prompt wiring | 40 min |
| T5 project-state block | 2 h |
| T6 files in the request | 30 min |
| T7 effort | 15 min |
| T8 transcript trimming | 1 h 15 min |
| T9 readProjectFiles | 40 min |
| T10 extractor + golden fixture | 1 h 30 min |
| T11 the two counters | 45 min |
| T12 handler wiring | 45 min |
| T13 `__context` + L4 | 1 h 30 min |
| T14 e2e | 30 min |
| T15 the record | 10 min |
| **Total** | **≈ 14 h 15 min** |

Nothing here is over half a day on its own. **T3 is the one to watch**: it is the slice's whole
value, its content is hand-written prose that two scanners then police, and the failure mode is
silent — a sentence that is merely wrong rather than absent. If it runs long, the overrun is in
the response examples (AC-9), and the honest reduction is fewer surfaces with examples, never
examples with unchecked field names.
