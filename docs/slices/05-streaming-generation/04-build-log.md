# Slice 05 — Streaming generation · Build log

**Plan:** `03-plan.md` (approved) · **PRD:** `02-prd.md` · **Branch:** `slice/05-streaming-generation`
· **Date:** 2026-08-17

Appended as each task lands, not at the end — if this session dies at task 9, this file is what lets
a fresh one pick it up.

## Baseline

`main` at `aaa91bb`, clean. Full suite green before any change:

| Suite | Result |
|---|---|
| `typecheck` | pass |
| `lint` | pass (0 warnings) |
| `test:unit` | 286 functions + 451 frontend + 11 scripts |
| `test:rules` | 26 |
| `test:integration` | 198 |
| `test:e2e` | 9 |

## T1 — `truncated` on the message schema

**Commit:** `72845dc`

**Tests added**

| Level | File | What |
|---|---|---|
| L1 | `functions/src/messages/schema.spec.ts` | A Slice-4-shaped document (no `truncated` key) parses to `truncated: false`; `true` round-trips; `'yes'`, `1` and `null` all fail the parse; `toMessage` carries the flag and still omits `seq` |
| L4 | `tests/integration/messages.spec.ts` | The wire key list is now the five, every message carries `truncated: false`, and the seeded document is Slice-4-shaped — so the default is proven over the wire, not only in a unit |

**Green:** `truncated: z.boolean().default(false)` on `storedMessageSchema`, the field on `Message`,
`toMessage` carrying it.

**Deviation from the plan.** The plan put the integration wire-key edit in T2. It has to be in T1:
the moment `toMessage` gains a key, `messages.spec.ts`'s `Object.keys(...).sort()` assertions fail,
and a task that leaves a suite red so a later one can fix it is a task that cannot be reviewed on
its own — which is the plan's own argument for handling R9 inside T2. Same rule, applied one task
earlier. Nothing else moved.

