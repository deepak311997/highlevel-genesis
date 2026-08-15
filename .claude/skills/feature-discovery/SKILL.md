---
name: feature-discovery
description: Stage 1 of the vertical-slice workflow — interview the user to close scope gaps on one slice before any PRD or code exists. Use when starting a new slice ("let's start slice 2", "begin the auth feature", "discovery for the proxy") or when invoked as /feature-discovery. Ends by writing a discovery doc and stopping for the PRD stage.
---

# Stage 1 — Discovery

Purpose: surface everything ambiguous about **one slice** before a line of code or a PRD
exists. You are interviewing a colleague who knows the product better than you do. The
output is a decisions document, not a design.

**Argument:** the slice number or name, e.g. `/feature-discovery 2` or
`/feature-discovery highlevel-connection`. Optional `--fast`.

## Do first

1. Read `docs/IMPLEMENTATION_PLAN.md` §4 for this slice — scope, spec IDs, dependencies, mode, risks.
2. Read the referenced sections of `docs/PRODUCT_SPEC.md` and, if the slice touches HighLevel,
   the relevant section of `docs/HIGHLEVEL_PLATFORM.md`.
3. Read any merged slice docs this one depends on, under `docs/slices/`.
4. Check the current code for what already exists. Do not ask about things you can read.

## Then interview

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

**`--fast` mode:** skip the interview unless something is genuinely unresolved. Ask at
most one round of questions, then write the doc.

## Output

Write `docs/slices/<nn>-<slug>/01-discovery.md`:

```markdown
# Slice <nn> — <name> · Discovery
**Spec:** <F-ids> · **Depends on:** <slices> · **Date:** <today>

## The demo
One sentence: what we show a human when this merges.

## Decisions
| # | Question | Decision | Rationale |

## Explicitly out of scope
- <thing> → picked up in Slice <nn>

## Edge cases to handle
## Failure modes and what the user sees
## Data shape
## Open risks
```

## Hard stop

Write the doc, summarise the decisions in a few lines, and **stop**. Do not write a PRD,
do not touch code, do not create a branch. Tell the user to run `/feature-prd <nn>` when
they are happy with the decisions.
