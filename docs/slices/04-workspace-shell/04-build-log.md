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

## T2 — Export the project-access helpers

**Red.** None, deliberately, as the plan specifies. This is a visibility change with no
behaviour to assert; a test that only proved `readProject` is exported would be testing
TypeScript. The check is that the suite stayed green across it, which it did.

**Green.** `export` added to `readProject`, `requireProjectId` and `notFound` in
`functions/src/projects/handlers.ts`. The PRD's D14 names `readProject` only; the same argument
covers the other two, since the message routes owe byte-identical `invalid_id` and `not_found`
answers on a path that carries the same `:projectId`.

**Refactor.** Each doc comment extended to say it is now shared with `messages/`, and why.

**Deviation from the plan:** none.

## T3 — `GET /api/projects/:projectId/messages`

**Red, L1.** `functions/src/messages/handlers.spec.ts` — `transcriptQuery()` is called with a
chainable recording spy and the assertion is on the *ordered* list of calls:
`orderBy(createdAt,asc)`, `orderBy(seq,asc)`, `limit(200)`. That is R1's regression guard —
deleting the second `orderBy` breaks nothing an emulator-backed test can see reliably, so it has
to fail here. `parseStoredMessage` returns `null` and logs `message.unreadable` with
`outcome: 'invalid'` for each of the three corrupt shapes, puts no field of the document in the
line, and returns `null` without logging for an absent snapshot. Failed on the missing module.

**Red, L4.** `tests/integration/messages.spec.ts`, 16 GET cases — a batch-tied pair returns
user-before-assistant (AC-2) and the wire shape carries no `seq`; three turns at distinct
timestamps come back oldest-first (AC-3); empty is `200 {messages: []}` (AC-4); no header → 401
and unverified → 403 (AC-6, AC-7); alice gets 404 on bob's project and his documents are
byte-identical after (AC-8); soft-deleted, never-existed and unparseable project ids → 404 via
`expectNotFound` (AC-9); four malformed ids → 400 `invalid_id` (AC-10); corrupt message documents
are omitted and their siblings returned (AC-15); 205 seeded returns 200. All 16 failed against
the terminal catch-all, which is why `expectNotFound` asserts the user-facing copy and not just
the code.

**Green.** `handlers.ts` (`parseStoredMessage`, `transcriptQuery`, `handleListMessages`),
`messages/index.ts` with the `GET` route only, mounted in `api/index.ts` at `/` and `/api` after
`projectsRouter`.

**Refactor.** Module headers for both files, and the comment on `transcriptQuery` explaining why
it is a function rather than an inline chain.

**Deviations from the plan:**

1. The plan's T3 sketch had the AC-3 case posting three turns through the route. That would make
   T3's red step depend on T4's `POST` existing, so the case seeds three turns at distinct
   timestamps instead — which is also closer to what the AC says ("written in separate
   requests" is about distinct commit timestamps, and seeding gives exactly that). The
   round-trip-through-`POST` version of AC-3 lands in T4, where `POST` exists.
2. Two cases beyond the plan's list: a project document that cannot be parsed reads as 404 (the
   third shape D14 collapses, which the plan named only for `readProject`'s own tests), and a
   205-message transcript returns exactly 200. Both are one line each against behaviour the
   plan already specifies.
3. `clearProjects` in this file uses `recursiveDelete`, not `listDocuments().delete()` as
   `projects.spec.ts` does — a project now has a subcollection, and deleting the parent document
   would leave its messages orphaned and visible to the next test.
