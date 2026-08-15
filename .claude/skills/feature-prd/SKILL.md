---
name: feature-prd
description: Stage 2 of the vertical-slice workflow — turn a discovery doc into a PRD with numbered acceptance criteria and a test matrix. Use after /feature-discovery, or when the user asks for a PRD or spec for a slice. Ends by stopping for scope approval.
---

# Stage 2 — PRD

Purpose: convert discovery decisions into **testable acceptance criteria**. This document
is what the build is graded against, and every test written later traces back to a
numbered criterion here.

**Argument:** the slice number, e.g. `/feature-prd 2`.

## Do first

Read `docs/slices/<nn>-<slug>/01-discovery.md`, the slice entry in
`docs/IMPLEMENTATION_PLAN.md` §4, and the referenced `docs/PRODUCT_SPEC.md` features.

## Write the PRD

Write `docs/slices/<nn>-<slug>/02-prd.md`:

```markdown
# Slice <nn> — <name> · PRD
**Spec:** <F-ids> · **Branch:** slice/<nn>-<slug>

## Problem
Two or three sentences. What the user cannot do today.

## In scope
## Out of scope
Each with the slice that picks it up.

## User flow
Numbered steps through the UI, ending in the demo.

## Data model
Collections, document shapes, ownership, indexes. Rules changes called out explicitly.

## API contracts
Per endpoint: method, path, auth, request, response, error codes.

## Acceptance criteria
AC-1 — Given <state>, when <action>, then <observable outcome>.
AC-2 — ...
Cover the happy path, every edge case and failure mode from discovery,
and the loading/empty/error state of every new screen.

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
- If discovery left something unresolved, do not paper over it. List it under **Blocked**
  and ask the user directly.
- If writing this reveals the slice is too big to review in one PR, say so and propose the
  split before continuing.

## Hard stop

Write the doc, list the ACs in your reply, and **stop**. No tech plan, no code. Tell the
user to run `/feature-plan <nn>` once the scope is approved.
