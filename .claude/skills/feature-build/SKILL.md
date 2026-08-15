---
name: feature-build
description: Stage 4 of the vertical-slice workflow — implement an approved technical plan strictly test-first, one red-green-refactor commit per task. Use after /feature-plan, or when the user says to start building or implementing a slice. Ends when every acceptance criterion has a passing test.
---

# Stage 4 — Build (test-driven)

Purpose: execute the approved plan. No design decisions here — if the plan is wrong, stop
and say so rather than improvising around it.

**Argument:** the slice number, e.g. `/feature-build 2`.

## Do first

1. Read `03-plan.md` and `02-prd.md` for this slice.
2. Confirm you are on `main` and it is clean, then create `slice/<nn>-<slug>`.
3. Confirm the suite is green *before* you start. A pre-existing failure is the user's to
   decide about — surface it, do not fix it silently inside this slice.

## The loop

For each task in the plan, in order:

**Red.** Write the test named in the plan. Run it. **Watch it fail, and confirm it fails
for the reason you expect** — a test that passes immediately is testing nothing, and a
test failing on a typo is not yet a red step.

**Green.** Write the minimum implementation that passes. Not the elegant version, not the
general version — the minimum. Run the test. Then run the full suite.

**Refactor.** Tidy with the tests green. Extract what repeats, name what is unclear. Run
the suite again.

**Commit.** Two commits per cycle, or one if the change is small: `test: <what it asserts>`
then `feat:`/`fix:` `<what it does>`. Never commit red.

Then append to `docs/slices/<nn>-<slug>/04-build-log.md`: the task, the tests added, any
deviation from the plan and why.

## Rules

- **No implementation without a failing test first.** The only exceptions are scaffolding
  and config the plan explicitly flagged as untestable.
- **Stay in scope.** Something worth doing that the plan does not cover goes in the build
  log under *Deferred*, not into this branch. Scope creep is what makes PRs unreviewable.
- **The plan is wrong sometimes.** When reality contradicts it — an API behaves
  differently, a dependency does not exist — stop, explain what you found, propose the
  amendment, and wait. Do not silently redesign.
- **Every new Firestore collection gets rules and L3 rules tests in the same commit** as
  the code that writes to it.
- **Never weaken a test to make it pass.** If a test is wrong, say why and fix it
  deliberately.
- **No secrets in source.** Config goes through env and `.env.example`.
- Every new screen ships with its loading, empty, and error states — they are ACs, so they
  have tests.

## Finishing

When every task is done: run the full suite (`typecheck`, `lint`, `test:unit`,
`test:rules`, `test:e2e`), then walk the PRD's acceptance criteria one by one and name the
test that proves each. Any AC without a passing test means the slice is not done.

Report: tasks completed, tests added by level, ACs covered, anything deferred, suite
status. Then **stop** and tell the user to run `/feature-review <nn>`. Do not open a PR.
