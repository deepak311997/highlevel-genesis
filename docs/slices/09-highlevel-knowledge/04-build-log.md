# Slice 09 — HighLevel knowledge injection · Build log

**Plan:** `03-plan.md` (approved) · **Branch:** `slice/09-highlevel-knowledge` · **Date:** 2026-08-18

Appended as the build runs, one entry per task. A session that dies mid-slice leaves this
log as the whole of the handoff, so it is written before the next task starts rather than
at the end.

## Parallelism analysis

The plan's fifteen tasks are not one chain. Reading the file map and the task list
together, four lanes touch disjoint sets of files once the two foundation tasks are in:

| Lane | Tasks | Files owned |
|---|---|---|
| *(mine, first)* | T1, T2 | `llm/budget.ts(.spec)`, `hl/proxyError.ts(.spec)` |
| A | T3, T4 | `llm/hlKnowledge.ts(.spec)`, `llm/prompt.ts(.spec)` |
| B | T5, T6, T7 | `llm/projectState.ts(.spec)`, `llm/params.ts(.spec)` |
| C | T8, T9 | `llm/context.ts(.spec)`, `files/handlers.ts(.spec)` |
| D | T10, T14 | `llm/hlCalls.ts(.spec)`, `tests/fixtures/llm/*`, `tests/e2e/files.spec.ts` |
| *(mine, after)* | T11, T12, T13, T15 | `lib/log.ts(.spec)`, `generate.ts(.spec)`, `llm/fake.ts(.spec)`, `llm/index.ts`, `tests/integration/generate-context.spec.ts`, `docs/IMPLEMENTATION_PLAN.md` |

**T1 and T2 are kept for myself and land first**, because three of the four lanes import
`budget.ts` and lane A imports `PROXY_ERROR_CODES`. They are twenty minutes between them,
so serialising them costs less than pinning a contract two lanes would otherwise guess at.

**T11–T13 stay with me** and stay a chain: T11 and T12 edit the same two files
(`generate.ts`, `generate.spec.ts`), T13 needs T12's wiring to have something to observe,
and all three depend on lanes B, C and D having landed. `llm/index.ts` is touched by
nothing but me for the same reason — four lanes re-exporting into one barrel file is a
conflict chosen in advance.

Lane A is the heavy one (the plan estimates T3 at three hours and flags it as the task to
watch), so it starts first and the lighter lanes finish underneath it.

---

## T1 — The budget module → AC-11 (support), AC-15, AC-18

**Red** — `functions/src/llm/budget.spec.ts`. Eight cases: `estimateTokens` over `''`, a
four-character string, one character over, and a 4,097-character one; `CHARS_PER_TOKEN` is
4; `PROJECT_FILE_BUDGET` is 120,000 and `TRANSCRIPT_BUDGET` is 80,000, each stated **twice**
— once in characters and once as its `estimateTokens` value (30,000 and 20,000). Failed on
the import: the module did not exist.

**Green** — `functions/src/llm/budget.ts`. `CHARS_PER_TOKEN = 4`, `Math.ceil(length / 4)`,
and the two constants, with D12's reason in the header: an exact count needs
`messages.count_tokens`, which is a network round trip and a charge on every generation, to
decide something a conservative estimate already decides safely.

**Refactor** — none. The module is four declarations and a paragraph, as the plan expected.

Stating each budget in both units is the part worth keeping: a re-tune is meant to be one
edit and a test, and without the token assertion an edit could silently change what the PRD
claims the budget costs while every character-level test stayed green.

- `27ebef7` test: state the two context budgets in characters and in tokens
- `332c9f4` feat: add the project-file and transcript budgets, and a token estimator

## T2 — The proxy error codes, as data → AC-7 (support)

**Red** — three cases appended to `functions/src/hl/proxyError.spec.ts`: `PROXY_ERROR_CODES`
is exactly the twelve codes the PRD's `hl()` contract lists; every member builds an
`HttpError` with non-empty copy and its own code; no duplicates.

**Green** — `export const PROXY_ERROR_CODES = Object.keys(MESSAGES) as readonly
ProxyErrorCode[]`, beside the type, which is derived from the same object.

**Refactor** — confirmed rather than changed: `ProxyErrorCode` was already
`keyof typeof MESSAGES`, so the array and the type cannot disagree. `MESSAGES` itself stays
private — its values are user-facing copy, which is that module's business.

- `2881139` feat: export PROXY_ERROR_CODES beside the code type

## T15 — The record → no AC (documentation)

Taken out of order, while the four lanes ran, because it touches only
`docs/IMPLEMENTATION_PLAN.md` and no lane owns that file. **This task has no failing test
and cannot have one**: it edits prose. §8's open-decisions row "HL knowledge: cheat-sheet vs
tool-calling · Slice 9 · 🟡 Open, leaning cheat-sheet" becomes Settled, naming this slice
and D1. Nothing else in that document changed.

- `51b73bf` docs: settle the HighLevel-knowledge decision as the cheat-sheet

---

## Lanes A–D — T3 to T10 and T14, built in parallel

The four lanes ran concurrently and landed within about eleven minutes of each other. I
verified every red claim myself before committing it rather than taking the lane's word:
for each task I reverted the implementation half (`git checkout`, or moving a new module
aside), ran the spec, and confirmed it failed on exactly the new cases — then restored the
implementation and committed the pair. What follows records that, per task.

**One deviation from strict plan order, stated plainly.** Commits are grouped by lane and
are in plan order *within* each lane, but the lanes themselves committed in completion
order — B (T5–T7), C (T8, T9), A (T3, T4), D (T10, T14) — so T5 precedes T3 in the history.
Re-ordering would have meant either holding every lane's work until the slowest finished or
rewriting history after the fact. The alternative was worse than the cosmetic cost, and the
red-green discipline is intact for every task.

### T3 — The cheat-sheet → AC-1, 2, 3, 5, 6, 7, 8, 9

**Red** — `functions/src/llm/hlKnowledge.spec.ts`, 49 cases, one `describe` per AC.
Verified red by moving `hlKnowledge.ts` aside: `Cannot find module './hlKnowledge'`.

**Green** — `functions/src/llm/hlKnowledge.ts`. `HL_KNOWLEDGE` renders to **7,454
characters**; the whole stable prefix is 10,120 characters, about **2,530 estimated
tokens** — 2.5× AC-11's floor and roughly 5× the model's 512-token cacheable minimum.

**Three amendments to the plan, all found by writing the tests:**

1. *Notes are keyed by `` `${method} ${pattern}` ``, not by pattern alone.* The plan says
   "notes keyed by pattern in a local record". `GET /contacts/:contactId` and
   `PUT /contacts/:contactId` are one pattern needing two different sentences, so a
   pattern-keyed record cannot describe the table it is describing. A row with no note
   still renders a visible gap rather than an empty dash.
2. *AC-2's scan makes prose dangerous, and the cheat-sheet is written around that.* In
   `/\b(GET|POST|PUT)\s+(\/\S+)/g` the `\s+` spans newlines and any punctuation directly
   after a path joins the capture. So `METHOD /path` appears **only** in the table, and
   prose refers to a route as `` `/calendars/events` `` with no verb in front of it. Worth
   knowing before anyone adds a sentence to that file.
3. *`VOLATILE`'s `\d{10,}` bites harder than the plan implies.* It rules out every recorded
   phone number, the `searchAfter`/`sort` cursors and `appoinmentPerDay` — not just
   timestamps. The response examples are shaped around it: the contacts and conversations
   records chosen are the ones whose `phone` is `null` in the fixture, and those four
   fields are omitted.

Two claims were **softened as unverified** against `HIGHLEVEL_PLATFORM.md` §6.1 / §10 item
4, which is D6's "verified minimum only" applied to the prose as well as the parameters:
"newest first" dropped from the `/contacts/search` note, and "a hundred is the most worth
asking for" dropped from the `pageLimit` guidance. Teaching a guessed fact here is the R5
failure mode — the model writes it confidently.

- `367bd47` test: scan the cheat-sheet against the allowlist, the codes and the fixtures
- `5624b21` feat: render the HighLevel cheat-sheet from the allowlist at module load

### T4 — The cheat-sheet in the prompt, and the breakpoint on it → AC-4, 10, 11, 12

**Red** — `prompt.spec.ts` gains `describe('the HighLevel cheat-sheet block')`; the
needle list swaps `leadconnectorhq` and `/contacts` (both now legitimately present) for
`services.leadconnectorhq.com` and `/api/hl/proxy`. Verified red against the two-block
prompt: 6 failures.

**Green** — a third block whose text is `HL_KNOWLEDGE`, carrying the only `cache_control`;
the second block loses it. The header's "silent no-op until Slice 9" paragraph is now a
record of what changed and why (D18).

- `6757249` test: the cheat-sheet is the third block and carries the only breakpoint
- `5fd4c8b` feat: put the cheat-sheet in the prompt and move the breakpoint onto it

### T5 — The project-state block → AC-14, 15, 16, 17

**Red** — `projectState.spec.ts`, 14 cases. Verified red on the missing module.

**Green** — `projectState.ts`: `ProjectFile`, `buildProjectState`, `PROJECT_FILE_OPEN`,
`PROJECT_FILE_CLOSE`, with the ordering extracted into `orderForReading` (the refactor,
folded into the same pass because the rule is three clauses each with its own reason).

Two shape decisions the plan did not anticipate, both forced by trying to assert it:

- **Manifest entries render as `- path (n characters)`.** Without the `- ` prefix a
  manifest entry is a *substring* of an included file's opening delimiter
  (`===== FILE app.js (100 characters) =====`), so "was this file omitted?" would be
  unassertable. The plan's "manifest line" is therefore a sentence plus one list item per
  omitted file.
- **Test fillers are unique repeated markers, not `'x'.repeat(n)`.** With `x` every file is
  a substring of every larger one, and AC-17 — "no fragment of the over-budget file appears
  anywhere" — would pass against a *truncating* implementation. That is the one assertion
  in this task that has to be able to fail.

The "loop continues rather than breaks" property is only observable through an oversized
`index.html`: ascending order otherwise puts the oversized file last, where continue and
break agree. That is the shape the test uses.

- `97c6d7c` test: pin the project-state block's ordering, budget and whole-file rule
- `e44baa6` feat: build the project-state system block, whole files only, within a budget

### T6 — Files in the request → AC-12, AC-13

**Red** — three cases in `params.spec.ts`: exactly one block appended and it is last; the
breakpoint sits on `blocks.at(-2)`, which is `SYSTEM_PROMPT.at(-1)`; the appended block
carries no `cache_control` of its own. Every assertion is written against
`SYSTEM_PROMPT.length` and `.at(-1)` — **never a literal block count** — because how many
blocks the prefix splits into is `prompt.ts`'s business and changed under this very slice.

**Green** — `buildParams(context, files = [])`; `system` is `SYSTEM_PROMPT` itself when
`buildProjectState` returns `null`, `[...SYSTEM_PROMPT, block]` otherwise.

- `7bf4e80` test: the project state is appended after the breakpoint, never before it
- `a450c92` feat: take the project's files into buildParams, appended past the breakpoint

### T7 — Effort → AC-22

Committed as its own cycle rather than folded into T6, even though the plan assigns both
tasks to the same two files: the intermediate state (files parameter in, effort still
`low`) is coherent and green, so the split costs nothing and keeps one commit per task.
Verified red — `expected 'low' to be 'high'`, that case alone.

**Green** — `EFFORT = 'high' as const` and the header rewritten to D17. The spec's comment
now says the no-`thinking` case is *load-bearing* for this one: `thinking: { type:
'disabled' }` is rejected outright above effort `high` on `claude-opus-5`, so D14 and D17
hold each other up.

- `1ebf0e6` test: effort is high, and thinking must stay on for it to be legal
- `10a4a98` feat: re-tune output_config.effort from low to high

### T8 — Transcript trimming → AC-18, 19, 20, 21

**Red** — five cases added, every existing Slice 5 case kept. Verified red against the old
`buildContext`: exactly the three new budget cases failed.

**Green** — `dropLeadingAssistants(trimToBudget(dropTrailingAssistants(messages)))`, three
named local functions. D16's floor is `if (index < newest && total + length >
TRANSCRIPT_BUDGET) break` — the newest turn is taken *before* the budget is consulted.

The non-emptiness argument is written into `dropLeadingAssistants`'s header, because it is
the claim that reconciles AC-19 with AC-21: step one leaves a user message last or leaves
nothing, step two always keeps that last message, so a non-empty array always ends in a
user turn and step three stops there at the latest.

**AC-20's new case is about the *order* of the three steps**, and passes at red by
construction — it is a Slice 5 regression. It is built as `u(1,000) → a(200,000)` rather
than reused from a fixture because reversing steps one and two is the one refactor that
breaks it: run backwards, the floor would protect the *assistant* turn, the user turn
behind it would not fit beside 200,000 characters, and the result would be empty — a
permanent `400 empty_context` on the Retry path.

- `c1409e0` test: trim the transcript from the oldest end, and never lead with an assistant
- `dd33712` feat: trim the transcript to budget and drop leading assistant turns

### T9 — Reading the files → AC-14, AC-27 (support)

**Red** — a `readProjectFiles` describe with five cases and a `fakeFileQuery` that answers
`collection().orderBy().limit().get()`. The fake deliberately has **no `select`**, so a
projection creeping in fails as a missing method rather than as a silently thinner
document. Verified red: five failures, `readProjectFiles is not a function`.

**Green** — the same query as `readFileList` with no projection, parsed with
`storedFileSchema`. The two readers' parse-and-log bodies had converged, so one helper —
`parseQueriedFile<T extends { path: string }>(doc, schema)` — was extracted, taking the
schema, since the schema is the entire difference between them. **The queries are not
merged**, and `readFileList`'s projection is unchanged.

- `36342fe` test: readProjectFiles returns content in path order, capped, skipping the corrupt
- `8307e56` feat: add readProjectFiles beside readFileList, content and all

### T10 — Extracting `hl()` calls, and the golden reply → AC-23, AC-25

**Red** — `hlCalls.spec.ts`, 14 cases. Verified in two stages, which is what makes the
fixture edit a real assertion rather than a decoration: first against the missing module
(`Cannot find module './hlCalls'`), then with the module present but the **old** fixture
still in place — 12 passed and exactly the two AC-25 cases failed, proving they read the
fixture rather than the extractor.

**Green** — `extractHlCalls` over
`/\bhl\s*\(\s*(['"])([A-Z]+)\1\s*,\s*(['"])(\/[^'"\n]*)\3/g`, plus `countHlCalls`. The
header states D19 in full, including what the extractor cannot see. The plan's phrasing
"a commented-out call is *not* excluded" is implemented as an explicit **positive**
assertion, since a negative phrasing inside an `it.each` of near-misses would read as
exactly the opposite of what it means.

The fixture edit is surgical: only `app.js`'s three body deltas changed — prose, the three
paths, the block count, the recorded thinking delta, `index.html`, `styles.css` and the
closing line are untouched (3 open and 3 close tags, 33 events, JSON parses). The new
`app.js` keeps `document.getElementById`, which `generate-files.spec.ts:174` pins; carries
no `locationId` and no `leadconnectorhq`; wraps both calls in one `try`/`catch` that shows
`err.message`; filters the page in the browser per D6; and uses only field names that exist
in `tests/fixtures/highlevel/`. It yields exactly `{ known: 2, unknown: 0 }`, which is what
manual-verification step 3 expects to see on the log line.

It retires the `fetch('/api/hl/contacts')` call the fixture carried, which named a route
Slice 8 D1 explicitly rejected.

`tests/fixtures/llm/README.md` records D20's provenance: hand-authored, not recorded, with
the blunt sentence that the L1 prompt tests assert what the model is *told* and no
automated test in this repository can assert what the model *does*.

- `710e52c` test: extract hl() calls, and hold the golden reply to the allowlist
- `b388401` feat: extract hl() calls, and make the golden reply HighLevel-shaped

### T14 — The demo, in a browser → AC-26

**Red** — `tests/e2e/files.spec.ts` gains `HL_CALL` beside `GENERATED` (the refactor, folded
in: both are facts about the same fixture) and a new movement three inside the existing
walk — click the `app.js` row, assert the editor's value matches `hl(` and matches neither
`locationId` nor `leadconnectorhq`. Placed after the stream completes and **before** the
`index.html` edit, so the save-and-reload movements behind it are undisturbed.

**Green** — nothing to implement; T10's fixture is what makes it pass. Not yet run: the e2e
suite needs `firebase emulators:exec` and a built functions bundle, and it runs at the end
of this build with the rest of the suite.

- `7c07051` test: the walk opens app.js and reads an hl() call in the editor

**After all four lanes:** `functions` unit suite 43 files / 1031 tests green, `typecheck`
clean, `lint` clean at zero warnings.

---

## T11 — The two counters → AC-24

Back to a single chain from here: T11, T12 and T13 all edit `generate.ts` /
`generate.spec.ts` or depend on the wiring the one before it added, so they were never
lane candidates.

**Red** — `generate.spec.ts`. `OUTCOME` gains `hlCallsKnown` and `hlCallsUnknown`, the
`it.each` gains both, and the exact-key assertion grows from nine keys to eleven. Two
handler cases were added beyond the plan, because the projection alone leaves the
interesting half untested: **the counters must be computed from the turn's file blocks, not
from its chat text.** A wiring that counted the prose would emit two perfectly plausible
integers and be wrong about what they mean, and nothing in the plan's red would notice. So
the stream writes one file holding an allowlisted call and one the proxy would refuse, and
*mentions a third call in the prose* — which is what tells the two wirings apart. Five
failures.

**Green** — `GenerationLogContext` gains the two integer fields, `logGeneration` projects
them (the "eight fields" note in its comment is now ten), and `log.spec.ts`'s literal gains
them. In `finishTurn`, `collector.finish()` moved **above** the `logGeneration` call; it
emits no frames of its own and the frame loop stayed where it was, so the only thing the
reordering changes is that `collected` exists in time to be counted.

The interface header now carries the argument for admitting anything to a deliberately
body-less context, because it will be needed again: the bar is not "is it useful?" but
"can it hold user content?" — and an integer cannot carry a contact id, a path or a
sentence somebody wrote.

`llm/index.ts` also gained this slice's re-exports here: `estimateTokens` and the two
budgets, `extractHlCalls`/`countHlCalls`, and `buildProjectState` with
`PROJECT_FILE_OPEN`/`PROJECT_FILE_CLOSE` and the `ProjectFile` type. **`hlKnowledge` is
deliberately not re-exported** — it is `prompt.ts`'s input and nobody else's, exactly as
the plan's file map says. `PROJECT_FILE_OPEN` is there because T13's fake reads it back out
of the assembled block, so the delimiter keeps one definition.

- `95613ee` test: generation.complete carries the hl() counters, read from the file blocks
- `ab22d61` feat: count the generated hl() calls onto generation.complete

## T12 — The handler reads the project's files → AC-13, AC-14 (wiring), AC-28

**Red** — three cases: the files reach `buildParams` as one extra block that is last and
names them; a project with no files sends `SYSTEM_PROMPT` by identity; and the file read
failing rejects with `headersSent === false`, `openStream` never called, and no frame
written.

The `getDb` stubs in this file were three separate inline literals answering only
`readFilePaths`'s `.limit().select().get()`. They became one `fakeFilesDb` helper answering
**both** reads and telling them apart **by call shape** — `.limit(n).select().get()` for the
cap check, `.orderBy('path').limit(n).get()` for the context. That is what lets
`rejectProjectFiles` fail exactly one of the two; a fake that could only fail both would
not tell us which read the handler was waiting on, which is the whole of AC-28. Two
failures, and every pre-existing case still green.

**Green** — `readProjectFiles(uid, projectId)` between the empty-context check and
`openStream`, its result passed to `buildParams`. The numbered order comment above
`handleGenerate` grew a sixth step.

**AC-28 is at L1, and the plan says why.** There is no honest way to make an Admin SDK read
fail against the Firestore emulator: a corrupt document is *parsed and skipped*, not a read
failure, and forcing a real one would mean a fault-injection path in production code — a
backdoor whose only purpose is to prove an error message. At L1 `getDb` is already mocked
and `res.headersSent` is directly observable. The neighbouring real behaviour is asserted
at L4 instead (T13's third case).

- `e771864` test: the handler reads the project's files, and fails before the flush
- `abd451b` feat: read the project's files into the request, before the flush

## T13 — The `__context` marker → AC-27

**Red** — `fake.spec.ts` gains four cases driving the fake with real `buildParams` output,
and `tests/integration/generate-context.spec.ts` is new with five. Three L1 failures
(`Unexpected token 'H', "Here is a "... is not valid JSON` — the fake was still replaying
the recorded reply).

**Green** — `FakeParams` widens to `{ messages, system? }`, `planFor` takes the whole
params, and `__context` joins `MARKERS` and the marker table in the module header. Its plan
is built programmatically like `longEvents()` rather than from a fixture, because the answer
depends on the input — a recorded sequence could only describe a request somebody typed out
by hand, which is the opposite of what this is for.

Two properties worth stating, both in the code:

- **The paths are recovered with `PROJECT_FILE_OPEN`, the builder's own exported
  delimiter.** A literal `'===== FILE '` in the fake would be a second definition of the
  format, and the first one to change would go unnoticed — which is precisely the class of
  drift this marker exists to catch elsewhere. The omitted-files manifest renders as
  `- path (n characters)` and so does not match, which is correct: what is reported is what
  the model was actually *shown*.
- **The report is counts and paths, never content.** A fake that echoed the blocks back
  would push the whole project's code through the SSE stream and into every failure dump,
  and would turn this marker into a way to read a prompt rather than a way to check a
  wiring.

The L4 suite covers AC-27 (three files ⇒ four blocks and the three paths in the *builder's*
order, not Firestore's), AC-13 over the wire (no files ⇒ three blocks, no paths), the
corrupt-document case the AC-28 deviation owes (a file document whose id and `path`
disagree is skipped, the generation still completes, and the other two files still reach the
model), and the transcript half (a trailing assistant turn is dropped before the request
goes out, so the fake counts one message where the collection holds two).

`STABLE_BLOCKS = 3` is written out rather than imported: these tests run against the built
bundle and share no module with it, the *relationship* between the counts is
`params.spec.ts`'s business, and what this file owns is the number that actually went over
the wire.

- `4b064f1` test: the fake reports the blocks, messages and paths it was sent
- `d3e9f66` feat: add the __context marker, reporting what the request carried

---

## Definition of done

### Every acceptance criterion maps to a named, passing test

| AC | Level | Test file |
|---|---|---|
| AC-1, 2, 3, 5, 6, 7, 8, 9 | L1 | `functions/src/llm/hlKnowledge.spec.ts` |
| AC-4, 10, 11 | L1 | `functions/src/llm/prompt.spec.ts` |
| AC-12, 13, 22 | L1 | `functions/src/llm/params.spec.ts` |
| AC-14, 15, 16, 17 | L1 | `functions/src/llm/projectState.spec.ts` (AC-14's wiring also in `params.spec.ts`) |
| AC-18, 19, 20, 21 | L1 | `functions/src/llm/context.spec.ts` |
| AC-23, 25 | L1 | `functions/src/llm/hlCalls.spec.ts` |
| AC-24, 28 | L1 | `functions/src/generate.spec.ts` |
| AC-27 | L4 | `tests/integration/generate-context.spec.ts` |
| AC-26 | L5 | `tests/e2e/files.spec.ts` |

AC-28 is at L1 rather than L4 — the plan's first recorded deviation, restated under T12.
AC-25's "golden reply fixture" is `tests/fixtures/llm/reply.json` rather than a new file —
the plan's second, and what lets AC-25 and AC-26 assert the same artefact.

### The full suite, green

| Target | Result |
|---|---|
| `npm run typecheck` | clean (root, functions, frontend) |
| `npm run lint` | clean, zero warnings |
| `npm run test:unit` | functions 43 files / **1,042** tests · frontend 51 / **684** · scripts 3 / **21** |
| `npm run test:rules` | passed, **unchanged** — no rules diff in this slice, which is the point |
| `npm run test:integration` | 16 files / **329** tests |
| `npm run test:e2e` | **14** passed |

### The rest of the checklist

- **No new Firestore collection, so no new rules.** This slice reads
  `users/{uid}/projects/{projectId}/files`, which Slice 6 created and whose L3 denial tests
  already exist. `firestore.rules` and `tests/rules/` are byte-identical to `main` — a diff
  there would have been a mistake, not a feature.
- **F8 error paths.** The file read's failure is a pre-flush JSON error with a real status
  (AC-28), and the `hl()` error contract is taught in full — all twelve codes read from
  `PROXY_ERROR_CODES`, `try`/`catch`, show `message`, reconnect on `hl_reconnect_required`
  (AC-7).
- **No new screen**, so the loading/empty/error requirement is vacuous. Recorded in D21
  rather than skipped; not one frontend file changed, and the frontend suite is untouched
  at 684 tests.
- **No secrets in source.** `.env.example` unchanged — `HL_ALLOW_MESSAGE_SEND` was already
  documented by Slice 8.
- **No new dependency** in any package, and no `firestore.indexes.json` entry owed: the one
  new read is `orderBy('path')` on a single field, served by Firestore's automatic index.

### Owed to the PR, and not dischargeable here

Three manual checks need credentials this session does not have. They are the PRD's own,
and they go in the PR as named, unticked items rather than being quietly dropped — R1 says
the whole slice is judged on model behaviour no automated test can observe, and D20 says it
plainly: **the L1 prompt tests assert what the model is told, and no automated test in this
repository can assert what the model does.**

1. One real generation of "build a contact dashboard with a list of upcoming appointments",
   with the generated `app.js` pasted into the PR.
2. Two generations in one session, showing `cacheCreationInputTokens > 0` on the first and
   `cacheReadInputTokens > 0` on the second — which is what retires Slice 5 D16 (D18).
3. An effort sweep at `high` versus `xhigh`, recording time-to-first-token, and a note on
   whether D17 should change.

The emulator-only checks in the plan's *Manual verification* section are all discharged by
automated tests instead: the two `hl(...)` calls in `app.js` (AC-25, AC-26), the
`generation.complete` counters reading 2 and 0 for that fixture (`hlCalls.spec.ts`), the
`__context` block count of 4 with files and 3 without (`generate-context.spec.ts`), and
`POST /conversations/messages` appearing only under `HL_ALLOW_MESSAGE_SEND=true` (AC-3).

<!-- build-complete -->
