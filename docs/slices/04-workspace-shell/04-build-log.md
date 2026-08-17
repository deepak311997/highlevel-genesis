# Slice 04 — Workspace shell & chat persistence · Build log

**Plan:** `03-plan.md` (approved) · **PRD:** `02-prd.md` · **Branch:** `slice/04-workspace-shell`
· **Started:** 2026-08-17

## Baseline

Branch cut from `main` at `7376c00`, which matched `origin/main`. Full suite green before the
first line of this slice was written: `typecheck`, `lint`, `test:unit` (36 files / 353 tests
frontend, 20 / 272 functions, 2 / 11 scripts), `test:rules` (19), `test:integration`, `test:e2e`.
No pre-existing failure to surface.

## T1 — Message schemas

**Red.** `functions/src/messages/schema.spec.ts` — 29 cases. `createMessageBodySchema` refuses
each of `role`, `id`, `seq`, `createdAt` as an unknown key, and `{ role: 'assistant', content }`
explicitly on its own line (R3, AC-11's named body); refuses missing / `''` / `'   '` /
non-string / `null` / 4,001-character `content` and accepts one at exactly 4,000; trims
`'  hi  '`. `storedMessageSchema` rejects a document missing any of the four fields, a blank
content, and each of `system` / `tool` / `''` / `'User'` as a role; accepts stored content
longer than `CONTENT_MAX` (D11) and rejects a fractional or negative `seq`. `toMessage` returns
exactly `{content, createdAt, id, role}` with an ISO string, and no `seq`. Failed for the
expected reason — `Cannot find module './schema'`.

**Green.** `functions/src/messages/schema.ts` as the plan specifies: `MESSAGES`,
`MESSAGE_LIMIT = 200`, `CONTENT_MAX = 4000`, `messagesPath()` composed from `projectsPath`,
`createMessageBodySchema` (`.strict()`), `storedMessageSchema`, `Message`, `toMessage()`.

**Refactor.** Module header written in `projects/schema.ts`'s voice, saying why `role` is absent
from the body schema and why the stored `content` has no maximum.

**Deviation from the plan:** none. The plan's interface was implemented as written.
