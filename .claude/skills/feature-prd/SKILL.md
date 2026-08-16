---
name: feature-prd
description: Stage 1 of the vertical-slice workflow — interview the user to close every scope gap on one slice, then turn those decisions into a PRD with numbered acceptance criteria and a test matrix. Use when starting a new slice ("let's start slice 2", "begin the auth feature", "discovery for the proxy"), when the user asks for a PRD or spec for a slice, or when invoked as /feature-prd. Ends by stopping for scope approval.
---

# Stage 1 — Discovery & PRD

Purpose: surface everything ambiguous about **one slice**, then convert those decisions
into **testable acceptance criteria**. The PRD is what the build is graded against, and
every test written later traces back to a numbered criterion in it.

Two halves, one skill, one hard stop at the end: **interview → PRD**. Do not write the PRD
until the interview is done — a PRD written over unanswered questions is a guess with
formatting.

**Argument:** the slice number or name, e.g. `/feature-prd 2` or
`/feature-prd highlevel-connection`. Optional `--fast`.

## Do first

1. Read `docs/IMPLEMENTATION_PLAN.md` §4 for this slice — scope, spec IDs, dependencies, mode, risks.
2. Read the referenced sections of `docs/PRODUCT_SPEC.md` and, if the slice touches HighLevel,
   the relevant section of `docs/HIGHLEVEL_PLATFORM.md`.
3. Read the merged slice docs this one depends on, under `docs/slices/`.
4. Check the current code for what already exists. Do not ask about things you can read.

## Half one — the interview

Ask **only what the documents do not already answer.** Every question you ask that the
spec answers costs the user trust and time.

Batch questions with `AskUserQuestion` where the answers are enumerable (3–4 options with
a recommendation first); ask open questions in plain text when they are not. Aim for 3–6
question groups, delivered in at most two rounds. Cover:

- **Scope boundary** — what is explicitly *not* in this slice, and which slice picks it up
- **The demo** — what exactly do we show when this merges, in one sentence
- **Edge cases** — empty, first-run, concurrent, offline, permission-denied
- **Failure modes** — what breaks, what the user sees when it does, whether we retry
- **Data shape** — collections, documents, fields, ownership, indexes
- **Contracts** — request and response shapes for any new endpoint
- **Anything in `docs/IMPLEMENTATION_PLAN.md` §8** this slice is the first to need

Push back when an answer creates a problem — a data shape that will not scale to the next
slice, a scope that makes the PR unreviewable. Say so in a sentence and propose the
alternative; if the user reaffirms, take the decision and record it.

Before moving on, check that nothing needed for an acceptance criterion is still open. If
something is, ask it now — that is cheaper than a **Blocked** section in the PRD.

**`--fast` mode:** skip the interview unless something is genuinely unresolved. Ask at
most one round of questions, then write the PRD.

## Half two — the PRD

Write `docs/slices/<nn>-<slug>/02-prd.md`:

```markdown
# Slice <nn> — <name> · PRD
**Spec:** <F-ids> · **Branch:** slice/<nn>-<slug> · **Depends on:** <slices> · **Date:** <today>

## Problem
Two or three sentences. What the user cannot do today.

## The demo
One sentence: what we show a human when this merges.

## Decisions
| # | Question | Decision | Rationale |
Every question answered in the interview, so the build can be re-derived from this doc alone.

## In scope
## Out of scope
Each with the slice that picks it up.

## User flow
Numbered steps through the UI, ending in the demo.

## Data model
Collections, document shapes, ownership, indexes. Rules changes called out explicitly.

## API contracts
Per endpoint: method, path, auth, request, response, error codes.

## Edge cases and failure modes
What breaks, what the user sees, whether we retry. Each one must show up in an AC below.

## Acceptance criteria
AC-1 — Given <state>, when <action>, then <observable outcome>.
AC-2 — ...
Cover the happy path, every edge case and failure mode above, and the loading/empty/error
state of every new screen.

## Test matrix
| AC | Level | Test file | What it asserts |
Every AC appears at least once. L5 is reserved for the demo path.

## Definition of done
The checklist from docs/IMPLEMENTATION_PLAN.md §3, plus anything slice-specific.

## Risks
```

## Quality bar

- An AC a test cannot be written against is not an AC — rewrite it until it is observable.
- "Fast", "intuitive", "robust" are not outcomes. Name the measurable behaviour.
- Every decision in the interview shows up either as an AC or as an explicit out-of-scope
  line. A decision that survives in neither was not worth asking about.
- If something is still unresolved, do not paper over it. List it under **Blocked** and ask
  the user directly.
- If writing this reveals the slice is too big to review in one PR, say so and propose the
  split before continuing.

## Hard stop

Write the doc, list the ACs in your reply, and **stop**. No tech plan, no code, no branch.
Tell the user to run `/feature-plan <nn>` once the scope is approved.
