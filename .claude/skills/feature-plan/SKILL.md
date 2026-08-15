---
name: feature-plan
description: Stage 3 of the vertical-slice workflow — turn an approved PRD into a file-by-file technical plan and an ordered red-green-refactor task list. Use after /feature-prd, or when the user asks how a slice will be implemented. Ends by stopping for approach approval.
---

# Stage 3 — Technical plan

Purpose: decide *how*, so the build stage is execution rather than invention. The output
is an ordered task list where every task starts with a failing test.

**Argument:** the slice number, e.g. `/feature-plan 2`.

## Do first

Read `02-prd.md` for this slice and `CLAUDE.md`. Then **read the actual code** you intend
to touch — the plan must reference real files, real function names, real existing
patterns. A plan written from imagination produces a build stage full of surprises.

## Write the plan

Write `docs/slices/<nn>-<slug>/03-plan.md`:

```markdown
# Slice <nn> — <name> · Technical plan

## Approach
Three to six sentences. The shape of the solution and why this one.
Alternatives considered and why they lost — one line each.

## File map
| File | New/Edit | What changes |
Include test files, rules files, and config.

## Task list
Ordered. Each task is one red-green-refactor cycle and one commit.

### T1 — <name>  → AC-1
- **Red:** `<test file>` — `<test name>` asserting <behaviour>
- **Green:** minimum implementation in `<file>`
- **Refactor:** what to tidy once green

### T2 — ...

## Firestore rules changes
The rule, plus the L3 tests that prove it — including the denial cases.

## Dependencies
New packages with a one-line justification each.

## Manual verification
The steps a human runs to confirm the demo, on emulators.

## Estimate
Per task, and a total. Flag anything over half a day.
```

## Ordering rules

- Dependencies first: types and pure logic, then data layer and rules, then functions,
  then UI, then the e2e that ties it together.
- Each task must leave the suite green. No task depends on a later one to compile.
- Every AC from the PRD maps to at least one task; note any AC that maps to none — that
  is a gap in the plan, not a gap in the PRD.
- If a task cannot be expressed as a failing test first, say so explicitly and explain why
  (some config and scaffolding genuinely cannot) rather than quietly skipping the red step.

## Hard stop

Write the doc, summarise the approach and task count, and **stop**. Do not create the
branch, do not write code. Tell the user to run `/feature-build <nn>` once approved.
