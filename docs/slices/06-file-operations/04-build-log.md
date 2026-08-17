# Slice 06 — File operations · Build log

**Branch:** `slice/06-file-operations` · **Plan:** `03-plan.md` · **PRD:** `02-prd.md`
**Started:** 2026-08-17

Appended as the build runs, one section per task. A deviation from the plan is recorded here
with its reasoning at the moment it is taken, not reconstructed at the end.

## Baseline

Cut from `main` at `5bc7e54` (Slice 05 — Streaming generation). Before a line was written:

| Suite | Result |
|---|---|
| `typecheck` | pass |
| `lint` | pass |
| `test:unit` | pass |
| `test:rules` | 28 passed |
| `test:integration` | 232 passed |
| `test:e2e` | pass |

No pre-existing failure to surface.

## T1 — The filename, and what may not be one (AC-11)

`functions/src/files/schema.ts` + `schema.spec.ts`, 30 L1 cases. `filePathSchema` refuses by the
shape of a name — first character a letter or digit, no slash, no `..`, one allowlisted extension
over a non-empty base — plus `displayPath`'s control-character strip and 40-character truncation.

**Deviation.** The plan's red list writes the over-length case as `'a'.repeat(61)+'.js'`, which is
64 characters and therefore *accepted* under `PATH_MAX = 64`. The PRD's AC-11 says "a 65-character
name", so the test uses `'a'.repeat(62)+'.js'` and a 64-character name was added to the accepted
list, making the boundary a fact in both directions. The plan's arithmetic was the slip, not the
PRD's rule.

Commit: `d00c2bd`.

## T2 — The op set, refused whole (AC-12 – AC-15)

`functions/src/files/opset.spec.ts` (new, 42 cases) plus the rest of `files/schema.ts`.
`validateFileOps` runs P5's order and the first failure ends the whole set; `fileErrorCopy`
switches on a discriminated `FileRejection` so a new refusal reason cannot be added without a copy
line, and all seven sentences are asserted verbatim.

**Deviation (small).** The plan put these cases in `files/schema.spec.ts`. They live in a new
`files/opset.spec.ts` instead: `schema.spec.ts` is about what a *name* may be and `opset.spec.ts`
about what a *set* may be, which are the slice's two separate refusal boundaries, and one file of
72 cases reads worse than two of 30 and 42.

**Deviation.** `FileOp` is declared in `files/schema.ts` rather than in `llm/fileops.ts`. The plan
puts it in `fileops.ts`, but `fileops.ts` already imports `PATH_MAX` from `files/schema.ts` for its
hold-back bound, so declaring the type the other way round would be an import cycle. `fileops.ts`
re-exports it, so the plan's file map still reads true from the outside.

`putFileBodySchema` counts its cap with `superRefine` over `byteLength` rather than `.max()`, which
counts UTF-16 code units and would admit 60,000 three-byte characters at 180,000 bytes.

Commit: `3f78f72`.

## T3 — The splitter and the collector (AC-1, AC-2, AC-3)

`functions/src/llm/fileops.ts` + `fileops.spec.ts`, 18 L1 cases. Built exactly to the plan's
specification: a line-oriented state machine holding back only the trailing partial line, and only
while it could still become a delimiter.

**Amendment to the plan.** `CollectResult` gains a `frames: CollectorFrame[]` field, and `finish()`
returns it. The plan pins `finish(): { messageText, ops, unterminated }`, but P1 allows a delimiter
line to end at end of input as well as at a newline — so a reply whose last bytes are
`</genesis:file>` resolves its close *after* the final `push`. Without these frames that file's tail
chunk and its `file_end` would never reach the client, and AC-25's "the concatenated chunks equal
the stored content" would be false for exactly the shape a model most often produces. `generate.ts`
writes them before the terminal frame.

**Clarification.** The two line regexes are built with `new RegExp` from `MAX_INDENT`, `OPEN_HEAD`,
`OPEN_TAIL` and `CLOSE_TAG` rather than written out as literals. The plan shows literals; a literal
`{0,8}` beside a `MAX_INDENT = 8` is two sources for one rule, and D25 requires the prompt to be
interpolated from these same constants.

Commit: `cd9f72d`.

## T4 — Near-delimiters, tags in content, the line-start rule (AC-5, AC-6)

33 further L1 cases, driven against the **splitter** rather than the collector, because what is
being asserted is the grammar and the two normalisers would sit between the assertion and the thing
it is about. `MAX_LINE` is asserted rather than argued.

The implementation these cover landed with T3 — the three-block case could not pass without the
mode split — so the tests were verified meaningful by mutation instead of by an empty module:
uncapping `INDENT` fails the two nine-space cases, and removing the mode split fails ten.

Commit: `0d49c74`.

## T5 — Unterminated blocks and the D16 repairs (AC-7, AC-8)

14 further L1 cases. Verified by mutation: removing the CRLF repair fails two, recording the
unterminated block as an op fails two.

Commit: `769f4b8`.

## T6 — The message invariant and the marker-only reply (AC-9, AC-10)

`FIXTURES` — 21 shapes including every malformed one — with the invariant asserted over all of
them, plus "no file content in the message" and "no empty text frame". Verified by mutation:
accumulating `messageText` from the input rather than from the emitted frames fails 26 cases.

Commit: `bcbb132`.

## T7 — Chunking invariance (AC-4, R1) — **it found a real bug**

The property is every fixture driven split at every single offset, one UTF-16 code unit at a time,
and with empty pushes interleaved. The plan expected this task to be "green on arrival". It was not.

**The bug.** Once a partial line has been emitted — because it could not be a delimiter, or because
it grew past `MAX_LINE` — the rest of that line arrives in a later push and is *not* at a line
start. Untreated, the tail `</genesis:file>\n` of the prose line `x</genesis:file>` read as a close
tag when the two halves arrived in separate deltas, and as prose when they arrived together. Every
one of the 65 hand-written cases above passed, because a hand-written test chunks on whole tags.
This is R1's failure mode precisely, one level in from where the risk register expected it.

**The fix.** `atLineStart` replaces `holding` and now gates *both* the delimiter test in the line
loop and the hold predicate, and `finish()` respects it too.

Commits: `bcbb132` (corpus), `fa41798` (property + fix).
