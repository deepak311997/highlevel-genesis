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
