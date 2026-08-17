# Slice 09 — HighLevel knowledge injection · Review

**Reviewed:** 2026-08-18 · **Branch:** `slice/09-highlevel-knowledge` · **Range:** `main...HEAD`
**Diff under review:** 34 files, +5,142 / −137 — of which 1,986 lines are the four slice
documents. Production code is ~1,100 lines across `functions/src/llm/`, `functions/src/generate.ts`,
`functions/src/files/handlers.ts`, `functions/src/lib/log.ts` and `functions/src/hl/proxyError.ts`.

Reviewed as another author's PR: the diff read in full first, then six independent axis
reviews dispatched concurrently — correctness, security, architecture, performance,
readability, and an acceptance-criteria audit instructed to open every test rather than
trust the matrix. Every finding below was reproduced against the code before being
recorded; findings that could not be reproduced were dropped and are listed at the end.

## Suite

Counts for the first six rows are from the orchestrator's gate run on this commit
(`.autopilot/logs/09/gate-post-build.1.log`), which is what gated this stage. The final
row is my own re-run after the fixes below.

| Check | Result |
|---|---|
| `npm run typecheck` | clean — root, functions, frontend |
| `npm run lint` | clean, zero warnings |
| `npm run test:unit` — functions | 43 files / **1,042** tests |
| `npm run test:unit` — frontend | 51 files / **684** tests |
| `npm run test:unit` — scripts | 3 files / **21** tests |
| `npm run test:rules` | 1 file / **38** tests — unchanged from `main`, as the slice intends |
| `npm run test:integration` | 16 files / **329** tests |
| `npm run test:e2e` | **14** passed |
| **After this review's fixes** | functions unit **43 files / 1,051 tests** (+9), typecheck clean, `eslint --max-warnings 0` clean, Prettier clean |

Rules, `.env.example`, `package.json` and `package-lock.json` are byte-identical to `main` —
verified, not assumed. No new collection, so the "rules and L3 tests in the same commit"
rule is satisfied vacuously and correctly.

## Findings

Severity is mine, and each was checked against the PRD's decisions table before being
called Required — a deliberate trade-off recorded in a decision is not a defect.

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | **Critical** | `extractHlCalls` reads a **concatenated** path as its literal head, so `hl('GET', '/calendars/' + id + '/events')` extracts as `/calendars/` — which `matchRoute` resolves to a real enabled row. `countHlCalls` scored it `known: 1, unknown: 0`. The app's actual request, `/calendars/<id>/events`, is on no allowlist and the proxy answers `403 route_not_allowed`. The one metric D19 exists to provide reported a **clean** generation for exactly the failure it was built to surface — and the module's own doc claimed concatenation was already a miss. | **Fixed, test-first.** Two failing near-miss cases plus a dedicated case, then a `(?=\s*[,)])` lookahead requiring the closing quote to end the argument. Doc comment corrected to describe the lookahead as load-bearing. |
| 2 | **Critical** | AC-1 could pass with a route **silently missing** from the cheat-sheet. `toContain('POST /contacts/')` is satisfied by a different row's line, because several patterns are prefixes of others (`POST /contacts/` of `POST /contacts/search`; `GET /calendars/` of `GET /calendars/:calendarId`). Proven by mutation: deleting both rows from the rendered table left all 49 tests green. `GET /calendars/` is the route `PARAMETER_NOTES` tells the model to use to obtain a `calendarId` — its silent loss breaks the slice's own demo. This is precisely the drift D2 exists to prevent and R5 calls "the worst failure mode available". | **Fixed, test-first.** AC-1 now matches the whole rendered `- METHOD PATTERN — ` line and asserts exactly one; a new converse case asserts the table names **no** route the allowlist lacks. Re-ran the mutation: 3 failures where there were 0. |
| 3 | Required | AC-2 does not scan the hand-written half — the exact residual exposure R5 names. Both scanners only find verb-prefixed paths or `hl(` calls, i.e. the derived half that cannot be wrong. `RESPONSE_EXAMPLES[].surface` renders as a bare `` `/x/y` responds with: `` heading, so a typo there teaches a route the proxy refuses. | **Partly fixed.** Every `surface` is now validated through `matchRoute` against the enabled rows. Verified by mutation (`/opportunities/search` fails). The wider prose scan is deferred — see *Deliberately deferred*. |
| 4 | Required | AC-7's instruction half asserted nothing. `it.each(['try','catch','message'])` with bare `toContain`: `'try'` is satisfied by `country` in the contacts example, `'catch'` by the worked `} catch (err) {`, `'message'` by `showMessage`. Deleting the whole "wrap every one of them in try / catch" sentence left the suite green. | **Fixed.** Replaced with phrase-level regexes. Verified by mutation: deleting the sentence now fails. |
| 5 | Required | `functions/src/llm/index.ts` re-exported 8 names this slice added that **nothing imports** (`estimateTokens`, `PROJECT_FILE_BUDGET`, `TRANSCRIPT_BUDGET`, `HlCall`, `buildProjectState`, `PROJECT_FILE_CLOSE`, `PROJECT_FILE_OPEN`, `ProjectFile`) — the barrel has exactly two consumers, `generate.ts` and `generate.spec.ts`. The comment justifying one of them was **false**: it claimed `PROJECT_FILE_OPEN` is exported "because the emulator-only fake reads it back", but `fake.ts` imports it from `./projectState` directly, and always did. | **Fixed** — see *Dead code* below for the decision and its reasoning. |
| 6 | Required | The stated safety justification for D17 is wrong at the effort the slice actually ships. `params.ts` said `thinking: {type:'disabled'}` "is rejected outright above effort `high`… disabling thinking would now be an API error". The premise is right; the conclusion is not, because `EFFORT` **is** `high`, where the API still accepts it — the `400` starts at `xhigh`. So D14 and D17 do not in fact hold each other up today. Same paragraph also claimed 64,000 is "the floor for `high` and above"; the documented floor is for `xhigh`/`max`. Verified against the `claude-api` reference. Comment-only, but it is the justification the scheduled effort sweep would rely on, and the sweep is exactly what would move effort past the boundary. | **Fixed** in `params.ts` and the mirrored claim in `params.spec.ts`, restated as a constraint the sweep inherits. The same wording in PRD **D23** is left as written — a decision record is not rewritten after the fact; the correction is here. |
| 7 | Required | `budget.ts` and `context.ts` both justified their design with an invariant that is false: "`CONTENT_MAX` caps one stored message at 4,000 characters". It caps a **user** turn only — `storedMessageSchema` deliberately carries no maximum on `content` (Slice 6 D11, stated in that file). An assistant turn is bounded only by `MAX_OUTPUT_BYTES` at 800,000. So `context.ts`'s "it cannot arise today" about D16's floor is wrong: one long generation exceeds the whole 80,000-character budget by itself, and the floor is a live path. The behaviour is correct; the comments told a reviewer to discount a guard that really runs. | **Fixed.** Both comments corrected, and a new AC-21 case added driving the floor with a 150,000-character **assistant** turn — values the routes can really store, unlike the existing synthetic 200,000-character user turn (which is kept, relabelled as the extreme). |
| 8 | Consider | Project-file content is written into the state block verbatim with no delimiter escaping, so a file whose own text contains `===== END FILE =====` / `===== FILE x (n characters) =====` forges a file boundary. Reproduced: a hostile `notes.js` makes a reader see three open lines and a second, fabricated `index.html`. | **Recorded, not fixed** — deliberate. D24 chose byte-for-byte passthrough and **AC-14 asserts it**, so escaping would contradict a tested PRD decision. The exposure is self-injection: every writer to the collection is uid-scoped, so a file reaches only its own owner's prompt, and there is no privilege gain. Accidental collision is implausible (the close delimiter is an exact-line match). **Constraint recorded below for Slice 10/11.** |
| 9 | Consider | `readProjectFiles` is the third **sequential** Firestore round trip before `flushHeaders()`. It is independent of `readTranscript` — different collections, both scoped by the already-verified uid, neither feeds the other — so `Promise.all` would remove an estimated 50–200 ms from time-to-first-byte on every generation, while preserving D9 in full. | **Not fixed.** It is an optimisation, not a defect, and it lands on the one path R6 flags. Left for a decision with a real measurement rather than an estimate made here. |
| 10 | Consider | `readProjectFiles`'s doc claims it shares "the collection, the `orderBy('path')`, the `FILE_LIMIT` cap and the fail-closed handling" with `readFileList`. Only the last is shared; the other three are copy-pasted. The *function* is a justified sibling (the `select()` argument is real). | **Not fixed** — a 6-line `filesQuery()` extraction would make the comment true, but it touches a shared reader outside this slice's own additions for no behavioural gain. Recorded. |
| 11 | Nit | `PROJECT_FILE_BUDGET` measures file contents only; the block's header prose, per-file delimiters and omission manifest are unbudgeted, so the emitted block runs ~1.6 KB over the documented 120,000 at `FILE_LIMIT`. | Recorded. The budget is a soft cost control and the overrun is 1.3%. |
| 12 | Nit | `RESPONSE_EXAMPLES.example` is typed `unknown` for a compile-time-known literal, forcing the spec to re-narrow with a hand-rolled `isRecord`. `Record<string, unknown>` states what is true. | Recorded. |
| 13 | FYI | The cheat-sheet ships real sandbox record ids (contact, calendar, event, conversation) to every tenant. Not exploitable — the sandbox `locationId` is **not** included and the proxy attaches each caller's own, so a copied id is a dead read in the caller's account, and the values are `(Example)`-prefixed seed data. | Recorded so the acceptance is conscious. |
| 14 | FYI | The PRD's test matrix maps AC-28 to `tests/integration/generate-context.spec.ts`; the test is actually at L1 in `functions/src/generate.spec.ts:731`. The move is a **recorded** deviation (`03-plan.md:377`, `04-build-log.md:426`) with an honest reason — an Admin SDK read cannot be made to fail against the emulator without a fault-injection backdoor in production code. Only the PRD's matrix is stale. The L1 test asserts the property that matters (`headersSent === false`, `openStream` never called, no frames); the AC's literal "JSON 500 with the existing envelope" is covered by composition rather than assertion. | Recorded. The PRD is not edited after approval. |

## AC coverage

All 28 criteria have a named passing test. Every one was audited by opening the test rather
than reading the matrix; the column below records what that audit found, after my fixes.

| AC | Test | Verified |
|---|---|---|
| AC-1 | `llm/hlKnowledge.spec.ts` — whole-line match, one per enabled row, plus the converse | ✅ **strengthened** (finding 2) |
| AC-2 | `llm/hlKnowledge.spec.ts` — table + call scan, now also every `surface` | ✅ **strengthened** (finding 3), residual noted |
| AC-3 | `llm/hlKnowledge.spec.ts` — real module reload, both directions | ✅ |
| AC-4 | `llm/prompt.spec.ts`, `llm/hlKnowledge.spec.ts` | ✅ |
| AC-5 | `llm/hlKnowledge.spec.ts` | ✅ |
| AC-6 | `llm/hlKnowledge.spec.ts` — pins the literal `{"events":[]}` | ✅ |
| AC-7 | `llm/hlKnowledge.spec.ts` — 12 codes + phrase-level instruction | ✅ **strengthened** (finding 4) |
| AC-8 | `llm/hlKnowledge.spec.ts` | ✅ |
| AC-9 | `llm/hlKnowledge.spec.ts` — recurses nested fields, non-vacuous | ✅ (name-set, not shape — matches the AC's wording) |
| AC-10 | `llm/prompt.spec.ts` | ⚠️ weak — see *Deliberately deferred* |
| AC-11 | `llm/prompt.spec.ts` — measured 2,517 est. tokens vs the 1,024 floor | ✅ not marginal |
| AC-12 | `llm/params.spec.ts`, `llm/prompt.spec.ts` — positional, with and without files | ✅ |
| AC-13 | `llm/params.spec.ts` — identity (`toBe`), plus L4 | ✅ |
| AC-14 | `llm/projectState.spec.ts` — byte-for-byte, close-tag trap | ✅ |
| AC-15 | `llm/projectState.spec.ts` — exact-fit at 120,000, guarded against vacuity | ✅ |
| AC-16 | `llm/projectState.spec.ts` — entry point deliberately the largest | ✅ |
| AC-17 | `llm/projectState.spec.ts` | ✅ (the "middle slice" framing is illusory — see deferred) |
| AC-18 | `llm/context.spec.ts` — 155,800 chars vs an 80,000 budget | ✅ genuinely trims |
| AC-19 | `llm/context.spec.ts` | ✅ arithmetic checked: the cut really lands on an assistant turn |
| AC-20 | `llm/context.spec.ts` | ✅ |
| AC-21 | `llm/context.spec.ts` — synthetic extreme **plus** a reachable assistant turn | ✅ **strengthened** (finding 7) |
| AC-22 | `llm/params.spec.ts` | ✅ |
| AC-23 | `llm/hlCalls.spec.ts` — near-misses now include concatenation | ✅ **strengthened** (finding 1) |
| AC-24 | `generate.spec.ts` — exact key-set assertion with a `text: secret` forced in | ✅ strongest in the slice |
| AC-25 | `llm/hlCalls.spec.ts` — golden fixture, `{ known: 2, unknown: 0 }` | ✅ |
| AC-26 | `tests/e2e/files.spec.ts` — `hl(` present, `locationId` and origin absent | ✅ |
| AC-27 | `tests/integration/generate-context.spec.ts` — block count and builder path order | ✅ |
| AC-28 | `generate.spec.ts:731` (L1, recorded deviation) | ✅ property; envelope by composition — finding 14 |

## Dead code

Step 9's question, decided here rather than asked, per this stage's standing instruction.

```
DEAD CODE IDENTIFIED (all added by this slice, all in functions/src/llm/index.ts):
- estimateTokens, PROJECT_FILE_BUDGET, TRANSCRIPT_BUDGET   re-exported from './budget'
- HlCall                                                    re-exported from './hlCalls'
- buildProjectState, PROJECT_FILE_CLOSE, PROJECT_FILE_OPEN  re-exported from './projectState'
- ProjectFile                                               re-exported from './projectState'
```

**Decision: removed.** The barrel has exactly two consumers — `generate.ts` (13 names) and
`generate.spec.ts` (2) — and none of them imports any of the eight. Every in-package
consumer already goes to the sibling directly (`params.ts`, `fake.ts`, `context.ts`,
`projectState.ts`, `prompt.spec.ts`). The barrel's own stated rule is that "the shortest
import is the one somebody reaches for by accident", and an export nobody consumes is
exactly that hazard; the file was applying the rule to `fake` and `hlKnowledge` while
breaking it for `budget` and `projectState`. The comment justifying one of the eight was
additionally false about the code beneath it.

`countHlCalls` / `extractHlCalls` were kept — `generate.ts` imports both. Pre-existing
exports were left alone: they are outside this slice's diff, and auditing them is a
separate change. `tsc --noEmit` is clean with the eight removed, specs included.

## Manual verification

- Rendered `HL_KNOWLEDGE` in full and read it against `docs/HIGHLEVEL_PLATFORM.md` §5/§6 —
  the hand-written half that R5 names as the residual exposure. Every factual claim checks
  out: the 100-requests-per-10-seconds burst ceiling (§5); `/contacts/search` taking
  `{pageLimit, page}` with the filter grammar undocumented (§6.1); `/calendars/events`
  taking epoch milliseconds plus exactly one of `calendarId`/`userId`/`groupId`, and ISO-8601
  returning `200` with `{"events":[]}` (§6.3, measured).
- Checked the response examples' date claims against the recorded fixtures directly: contact
  `dateAdded` is ISO-8601 (`2026-08-16T09:58:16.388Z`), event `startTime`/`endTime` are ISO-8601
  with a UTC offset (`2026-08-17T08:00:00-04:00`), conversation `lastMessageDate` is epoch
  milliseconds (`1786874296920`, a number). The prompt's "conversations are the exception"
  note is correct.
- Confirmed 12 rows render and `POST /conversations/messages` is absent with the flag unset;
  confirmed exactly one `cache_control`, on the last stable block; measured the stable prefix
  at 10,067 chars ≈ 2,517 estimated tokens against `claude-opus-5`'s 512-token minimum.
- Reproduced findings 1, 2, 3, 4 and 8 against the running code before recording them, and
  re-ran each mutation after fixing to confirm the new assertions bite.
- Traced the uid path end to end: token → `withVerifiedUser` → `handleGenerate(uid)` →
  `readProject` ownership check → `readProjectFiles(uid, projectId)`. No user identifier in
  any route, no uid in any body (`generateBodySchema` is `.strict()`), and the file read sits
  after the ownership check and before the flush. `hlConnections` and the files collection
  remain `allow read, write: if false`.
- Confirmed the `__context` marker is double-gated (`client.ts` and again inside
  `buildFakeStream`) on `FUNCTIONS_EMULATOR === 'true'`, and that it reports counts and paths
  only — it echoes no block text and cannot be used to read a prompt back.
- Confirmed no OAuth token, secret, origin or proxy path appears anywhere in the rendered
  prompt, and that the two new log fields are integers on a context that still names every
  field explicitly.

## Deliberately deferred

- **AC-2's prose scan.** `surface` is now validated, but a HighLevel-shaped path invented in
  free prose inside `PARAMETER_NOTES` still escapes both scanners. A token-level scan over the
  whole block would close it; it needs a path-shaped grammar that does not fire on ordinary
  English, which is more design than this review should land unreviewed.
- **AC-10's constancy assertions.** `expect(SYSTEM_PROMPT).toEqual([...SYSTEM_PROMPT])` and
  `JSON.stringify(X) === JSON.stringify(X)` are tautologies — true of any value. Only the
  `VOLATILE` regex does work, and it would not catch an interpolated project name, which the
  AC names explicitly. The prompt *is* structurally a module constant, so there is no live
  defect; the test is weaker than it reads.
- **AC-17's framing.** The test does catch truncation, but not for the reason its comment
  gives: `filler` is periodic with period 5 and the sampling offset is a multiple of 5, so the
  "middle" slice is byte-identical to the head. It works because any ≥200-char truncation
  reproduces the same bytes.
- **Findings 9–12** above: the `Promise.all` latency win, the `filesQuery` extraction, the
  budget's unmeasured framing bytes, and `example: unknown`.
- **The three credentialed checks the PRD owes** — one real generation with the generated
  `app.js` pasted into the PR, a two-generation cache confirmation
  (`cacheCreationInputTokens > 0` then `cacheReadInputTokens > 0`), and the `high` vs `xhigh`
  effort sweep. This session has no `ANTHROPIC_API_KEY`. Per D20, no automated test in this
  repository can assert what the model *does*; these remain unticked in the PR.
  **When the sweep runs, finding 6 applies:** moving effort to `xhigh` or `max` makes
  `thinking: {type:'disabled'}` a `400`, and the sweep should record `outputTokens` from the
  existing `generation.complete` line so the cost of each level is priced rather than guessed.

## Constraints later slices inherit

Added to the PRD's own list, from this review:

- **Slice 10/11 — the project-state delimiter argument is first-party-only.** D24's case for
  not sanitising rests on file content reaching only its own owner's prompt. Finding 8 shows a
  crafted file *can* forge a block boundary; that is acceptable while the injector and the
  victim are the same principal. If any later slice feeds **third-party** text into the
  prompt — proxied HighLevel contact names, message bodies, calendar titles are all
  attacker-influenceable — the argument stops holding and the delimiter needs escaping before
  that content lands in the block.

## Verdict

**Approve.** The slice does what its PRD says, the architecture is right — the cheat-sheet is
derived from `HL_ROUTES` rather than restated, which is the decision the whole slice turns on —
and the two defects that would have cost money or shipped a silently wrong signal are fixed
with tests that fail without the fix. Both were the kind this stage exists to catch: a green
suite either side of them.

Run `/feature-ship 09`.
