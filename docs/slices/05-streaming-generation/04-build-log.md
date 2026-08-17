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


## T2 — One document per `POST`, and the echo deleted

**Commit:** `bc9f3a0`

**Tests added / changed**

| Level | File | What |
|---|---|---|
| L1 | `functions/src/messages/handlers.spec.ts` | The `echoFor` and `messagePair` describes are deleted. `appendAssistantMessage` writes `{ role: 'assistant', seq: 1, truncated }` under the right path, stamps a `serverTimestamp()` sentinel, returns the committed document in wire shape with no `seq`, and fails closed on a document it cannot read back |
| L1 | `frontend/src/lib/messagesApi.spec.ts` | `sendMessage` resolves to **one** `Message`; an empty `messages` envelope rejects; `listMessages` carries `truncated` through |
| L1 | `frontend/src/stores/workspace.spec.ts` | `send()` appends the one returned message |
| L4 | `tests/integration/messages.spec.ts` | `POST` answers 201 with exactly one message and writes exactly one document, `seq: 0`, `truncated: false`; no `"You said:"` text reaches Firestore; each turn gets its own commit timestamp; the cap accepts at 198 → 199 and refuses at 199 |
| L5 | `tests/e2e/workspace.spec.ts` | The transcript is one bubble and no reply — the placeholder T19 replaces |

**Green:** `readTranscript` extracted (one definition of "what is in this transcript", shared by the
list route and `/generate`); `appendAssistantMessage` added; `echoFor`/`messagePair` deleted;
`handleCreateMessage` writes one document via a shared `readBackOrFail`; `messagesApi.sendMessage`
returns `Message`; the store appends one.

**Note.** The cap check stays `count + 2 > MESSAGE_LIMIT` even though one document is written, per
D4 — the reply needs room. `frontend/src/stores/auth.spec.ts` needed a `truncated` on its inline
message fixture; that is a type consequence of T1, not a behaviour change.
