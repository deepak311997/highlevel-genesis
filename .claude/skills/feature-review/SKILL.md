---
name: feature-review
description: Stage 4 of the vertical-slice workflow, and the general code-review skill. Conducts a multi-axis review — correctness, readability, architecture, security, performance — audits a slice against its PRD, runs the full suite, fixes what it finds, and writes a review record. Use before merging any change, whether written by you, another agent, or a human.
---

# Review

Every change gets reviewed before merge — no exceptions. In the slice workflow this is stage 5,
between `/feature-build` and `/feature-ship`; it also stands alone for reviewing any diff.

**The approval standard:** approve when the change definitely improves overall code health, even
if it isn't perfect. Perfect code doesn't exist. Don't block because it isn't how you'd have
written it — if it improves the codebase and follows project conventions, approve it.

**Argument:** the slice number (`/feature-review 2`), or nothing to review the working diff.

---

## Step 1 — Understand the context

Before reading code: what is this change trying to accomplish, what spec or acceptance criteria
does it implement, what behaviour should change? For a slice, that is `02-prd.md`.

## Step 2 — Review the tests first

Tests reveal intent and coverage.

- Do tests exist for the change?
- Do they test **behaviour**, not implementation details?
- Are edge cases covered — empty, boundary, concurrent, permission-denied?
- Would they actually catch a regression, or would they pass against a broken implementation?
- Do the names describe the behaviour?

## Step 3 — Run the suite

`typecheck`, `lint`, `test:unit`, `test:rules`, `test:e2e`. Everything green before anything
else, and record the counts. A review that reports findings without having run the suite is
guessing.

## Step 4 — The five-axis review

### 1. Correctness

- Does it match the spec / acceptance criteria?
- Edge cases: null, empty, boundary values.
- Error paths, not just the happy path.
- Off-by-one errors, race conditions, state inconsistencies.

### 2. Readability & simplicity

- Names descriptive and consistent with project conventions (no bare `temp`, `data`, `result`).
- Straightforward control flow — no nested ternaries, no deep callbacks.
- **Could this be done in fewer lines?** 1000 lines where 100 suffice is a failure.
- **Are abstractions earning their complexity?** Don't generalise until the third use case.
- Comments clarify non-obvious intent; they don't restate the code.
- No dead artifacts: no-op variables, back-compat shims, `// removed` comments.
- **Is a new conditional bolted onto an unrelated flow?** That's a design smell, not a nit — push
  it into its own helper, state, or policy.
- **Repeated conditionals on the same shape** signal a missing model or dispatcher. A "temporary"
  branch is usually permanent debt.

### 3. Architecture

- Follows existing patterns, or introduces a new one with justification.
- Clean module boundaries; dependencies flow one way.
- Duplication that should be shared.
- **Does this refactor reduce complexity or relocate it?** Count the concepts a reader must hold.
  If a "cleaner" version leaves that count unchanged, it isn't cleaner. Prefer restructurings that
  make whole branches or layers disappear; prefer deleting an abstraction to polishing it.
- **Feature-specific logic leaking into a shared module** — keep logic in its owning layer, reuse
  the canonical helper rather than a near-duplicate, don't normalise architectural drift.
- **Explicit type boundaries.** Question gratuitous `any` / `unknown` / optional / casts and
  silent fallbacks that paper over an unclear invariant.

### 4. Security

- User input validated and sanitised at the boundary.
- Secrets out of code, logs, and version control.
- Authentication and authorisation checked where needed.
- Outputs encoded; external data (APIs, LLM output, config, user content) treated as untrusted.
- Dependencies from trusted sources with no known vulnerabilities.

### 5. Performance

- N+1 query patterns.
- Unbounded loops or unconstrained fetching; missing pagination.
- Synchronous work that should be async.
- Unnecessary re-renders; large objects allocated in hot paths.

## Step 5 — Language and framework specifics

Read **[`references/typescript-vue.md`](references/typescript-vue.md)** and apply it. It covers
the judgement calls the linter can't make: discriminated unions over optional-field soup,
`satisfies` over `as`, parse-don't-validate at boundaries, Vue's Priority A and B rules, reactivity
choices, and the two Genesis-specific traps (stream accumulation and the Monaco instance).

## Step 6 — Genesis-specific checks

These are the ones that bite in this codebase.

- **Firestore rules:** does an L3 test prove a **non-owner is denied** on every new collection?
  Denial tests are the ones people skip, and an allow-only test passes against wide-open rules.
- **Token boundary:** no OAuth token reaches the client, the preview iframe, or a log line. The
  `hlConnections` collection stays unreadable by every client.
- **Proxy routes are allowlisted** and scoped to the calling user. This is the one place a mistake
  leaks another tenant's CRM.
- **Streaming:** no buffering middleware on the SSE path, headers flushed before the body,
  disconnect handled with partial results preserved.
- **Nothing partial is persisted.** A malformed generation must not leave a project half-written.
- **Secrets:** nothing in source, `.env.example` current, `defineSecret` used for deploys.
- **States:** loading, empty, and error exist for every new screen.
- **Scope:** does the diff contain anything the PRD didn't ask for?

## Step 7 — Categorise findings

Label every comment so the author knows what's required.

| Prefix | Meaning | Author action |
|---|---|---|
| *(none)* | Required | Must address before merge |
| **Critical:** | Blocks merge | Security hole, data loss, broken functionality |
| **Optional:** / **Consider:** | Suggestion | Worth weighing, not required |
| **Nit:** | Minor | May be ignored — formatting, taste |
| **FYI** | Informational | No action |

**Lead with what matters.** Order by leverage: correctness and security, then structural
regressions and missed simplifications, then everything else. A few high-conviction comments beat
a long list. **If you have one structural problem and ten nits, the structural problem is the
review.**

### Propose the move, not just the problem

"This is complex" leaves the author guessing. Name the restructuring:

- Replace a chain of conditionals with a typed model or explicit dispatcher.
- Collapse duplicate branches into one flow.
- Separate orchestration from business logic.
- Move feature logic out of a shared module into the package that owns it.
- Reuse the canonical helper instead of a bespoke near-duplicate.
- Make a type boundary explicit so downstream branching disappears.
- Delete a pass-through wrapper that adds indirection without clarifying the API.
- Extract a helper; split a large file into focused modules.

Prefer the remedy that removes moving pieces over one that spreads the same complexity around.

## Step 8 — Change sizing

```
~100 lines changed   → good, reviewable in one sitting
~300 lines changed   → acceptable for a single logical change
~1000 lines changed  → too large, split it
```

**Watch file size, not just diff size.** Around 1000 total lines in one file is an inspection
signal. When a change materially grows an already-large file, ask whether to extract first, then
add.

Splitting strategies: **stack** (sequential dependencies) · **by file group** (different
reviewers) · **horizontal** (shared code first, then consumers) · **vertical** (smaller full-stack
slices). Large changes are fine when they're deletions or mechanical refactors where the reviewer
verifies intent rather than every line.

**Separate refactoring from feature work.** A change that refactors *and* adds behaviour is two
changes.

## Step 9 — Dead code hygiene

After any refactor, list what is now unreachable and **ask before deleting**:

```
DEAD CODE IDENTIFIED:
- formatLegacyDate() in src/lib/date.ts — replaced by formatDate()
- LEGACY_API_URL in src/config.ts — no remaining references
→ Safe to remove these?
```

Don't leave dead code lying around; don't silently delete what you're unsure about.

## Step 10 — Dependencies

**Before adding one:** does the existing stack solve this? How large is it? Actively maintained?
Known vulnerabilities (`npm audit`)? License compatible? Prefer the standard library and existing
utilities — every dependency is a liability.

**Upgrading is a code change.** Read the changelog rather than the version number — semver is a
promise the maintainer may not have kept. One dependency per change, so a break is attributable
and the revert is clean. Let a green suite before *and* after decide, not "it installed". Review
the lockfile diff, never hand-edit it, always commit it.

## Step 11 — Fix, then record

Fix what you found, test-first where the fix is behavioural, and re-run the suite. Write
`docs/slices/<nn>-<slug>/05-review.md`:

```markdown
# Slice <nn> — <name> · Review
## Suite
| Check | Result |
## AC coverage
| AC | Test | Verified |
## Findings
| # | Severity | Finding | Action taken |
## Manual verification
## Deliberately deferred
```

---

## Honesty

- **Don't rubber-stamp.** "LGTM" without evidence helps no one.
- **Don't soften real issues.** "This might be a minor concern" about a production bug is
  dishonest.
- **Quantify.** "This N+1 adds ~50ms per row" beats "this could be slow."
- **Push back on approaches with clear problems.** Sycophancy is a failure mode in review.
- **Accept override gracefully.** If the author has full context and disagrees, defer. Comment on
  code, not people.
- A review that finds nothing is plausible only for a genuinely small change. If you found nothing
  on a large one, look harder before saying so.

## Common rationalisations

| Rationalisation | Reality |
|---|---|
| "It works, that's good enough" | Working but unreadable, insecure, or wrong code compounds. |
| "I wrote it, so I know it's correct" | Authors are blind to their own assumptions. |
| "We'll clean it up later" | Later never comes. The review is the gate. |
| "AI-generated code is probably fine" | It needs more scrutiny, not less — confident and plausible even when wrong. |
| "The tests pass, so it's good" | Tests don't catch architecture, security, or readability problems. |
| "The refactor makes it cleaner" | Relocating complexity isn't reducing it. |
| "It's only a small addition to this file" | Judge the resulting structure, not the diff size. |
| "It's just a version bump" | A bump is a behaviour change you didn't write. |

## Red flags

Merged without review · review that only checks that tests pass · "LGTM" with no evidence ·
security-sensitive change with no security pass · PRs too big to review properly · bug fix with no
regression test · comments with no severity labels · accepting "I'll fix it later" · a refactor
that moves code without reducing concepts · a change that grows an already-large file · new
conditionals scattered into unrelated paths · a bespoke duplicate of a canonical helper · a bulk
"bump deps" PR · a hand-edited or uncommitted lockfile.

**Presumptive blockers** — surface these and propose the simpler design; escalate to Required only
when the change actively worsens structure: a refactor that relocates complexity; a change pushing
a file past the size boundary with no decomposition; feature logic added to a shared module; a
near-duplicate of a canonical helper; a silent fallback hiding an unclear invariant.

---

## Hard stop

Stop when the review doc is written and the suite is green. Report findings by severity, most
severe first. Tell the user to run `/feature-ship <nn>`.
