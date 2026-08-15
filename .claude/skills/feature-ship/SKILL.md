---
name: feature-ship
description: Stage 6 of the vertical-slice workflow — push the slice branch and open a pull request with demo evidence, then stop for human review. Use after /feature-review. Never merges; the merge is always the human's decision.
---

# Stage 6 — Ship

Purpose: hand a reviewable pull request to a human, then get out of the way.

**Argument:** the slice number, e.g. `/feature-ship 2`.

## Preflight

Refuse to continue, and say why, if any of these fail:

- The full suite is green (re-run it — do not trust the last run)
- `05-review.md` exists and its findings are resolved or explicitly deferred
- Every PRD acceptance criterion has a passing test
- The branch is `slice/<nn>-<slug>` and is rebased on current `main`
- The working tree is clean and no secrets are staged

## Open the PR

Push the branch, then open the PR with `gh pr create`:

**Title:** `Slice NN — Name`

**Body:**

```markdown
## What
Two or three sentences. What a user can now do that they could not before.

## Why
Link the slice in docs/IMPLEMENTATION_PLAN.md and the spec feature IDs.

## Acceptance criteria
| AC | Behaviour | Test |
Every AC with the test name that proves it.

## Test evidence
Counts by level and the suite result.

## How to verify locally
The exact commands, ending in the demo from the PRD.

## Deliberately out of scope
What was deferred and which slice picks it up.

## Review focus
Where you most want a human's eyes — the risky call, the thing you were unsure about.
```

Link the slice docs (`docs/slices/<nn>-<slug>/`) at the bottom.

## Then stop — this is the gate

Post the PR URL and **stop completely**. Specifically, do not:

- merge the PR, or approve it
- start the next slice, or read ahead into it
- push further commits unless the user asks for a change

Close by telling the user what to review, in priority order — the risky call first, the
mechanical parts last — and remind them that once they merge, the next slice starts with
`/feature-discovery <nn+1>`.

If the user comes back with review comments: fix them on the same branch, test-first,
re-run the suite, push, and stop again. The gate does not move.
