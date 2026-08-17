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
