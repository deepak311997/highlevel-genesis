# Slice 08 — HighLevel API proxy · Build log

**Branch:** `slice/08-highlevel-proxy` · **Plan:** `03-plan.md` · **PRD:** `02-prd.md` ·
**Started:** 2026-08-17

Appended task by task, as each red-green-refactor cycle closes.

## Baseline

`typecheck`, `lint` and `test:unit` green before the first change — 424 functions unit tests,
514 frontend, 15 scripts. `test:rules` and `test:integration` could not be started at that
moment: another checkout on this machine (`~/Documents/Projects/highlevel-genesis`) was
holding the test emulator ports (5101 / 8180 / 9199 / 4700 / 4800 / 5273), which
`package.json` fixes by convention rather than reading from the environment. Recorded here
rather than worked around; the emulator-backed suites are run before the slice is called
done.

---

## T1 — The allowlist table and the matcher → AC-1, AC-2, AC-3, AC-4, AC-5, AC-7

**Tests added** (L1, `functions/src/hl/routes.spec.ts`, 48 cases):

- every one of the thirteen rows matches a legal concrete path with its `version`, `scope`
  and `locationIn` intact (AC-1), and the table itself carries none of D4's four exclusions
- the six not-on-the-table refusals (AC-2) and three wrong-method refusals (AC-3)
- literal-beats-parameter, run twice — against `HL_ROUTES` and against a reversed copy
  (AC-4)
- the parameter grammar, both as refused paths and as `isLegalParam` over the six raw
  values (AC-5)
- trailing-slash normalisation on `/calendars` and `/contacts` (AC-7, first half)

**Implementation:** `functions/src/hl/routes.ts` — `HlRoute`, `HL_ROUTES`, `RouteMatch`,
`isLegalParam`, `matchRoute(method, path, table = HL_ROUTES)`.

### Amendment 1 — specificity is ranked across every method, not within one

The plan's matcher (T1, *Green*) says: "take candidates whose `method` matches **and** whose
segment count matches …". Written that way, the red step failed on AC-3's own example:
`GET /contacts/search` matched `GET /contacts/:contactId` with the parameter `search`,
because `search` is a perfectly legal id shape. The PRD requires `403 route_not_allowed`
there, and forwarding a lookup for a contact nobody has is the worse behaviour besides.

**Corrected route:** gather candidates by *shape* across every method, rank by specificity,
keep the class tied with the winner, and only then pick the row whose method matches. A
segment some row spells out as a literal can therefore never be swallowed by another row's
parameter. This makes AC-3 pass as written and adds a third case to it,
`GET /conversations/messages`, which is the same hazard on the conversations rows.

### Clarification — AC-5's `a/b`

Five of AC-5's six values sit in a single segment and are refused by the grammar as
`invalid_path`. `a/b` cannot: a slash makes it *two* segments, so `/contacts/a/b` is a shape
no row has and is refused one step earlier as `not_allowed` — before any Firestore read,
which is the stronger refusal. AC-5's operative property ("never a row") holds for all six.
Both facts are asserted: `isLegalParam` rejects all six raw values, and `/contacts/a/b` has
its own named case saying why its kind differs.
