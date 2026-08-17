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

## T4 — `POST /api/projects/:projectId/messages`

**Red, L1.** `handlers.spec.ts` gains `echoFor` (exactly `You said: <content>`, and it does not
re-trim what the body schema already trimmed) and `messagePair` — user then assistant, `seq` 0
then 1, the second's content the echo of the first's, both documents carrying the *same* injected
timestamp value, and `role` assigned in the document. 5 new cases, all red.

**Red, L4.** The `POST` describe block, 27 cases: the pair at 201 with `seq` 0 and 1 stored
(AC-1); distinct auto-ids; whitespace trimmed in the store, on the wire and inside the echo
(AC-5); each of `role`/`id`/`seq`/`createdAt` and the named `{role: 'assistant', content}` → 400
with nothing written (AC-11); five bad `content` shapes → 400 with nothing written, and 4,000
exactly accepted (AC-12); 200 seeded → 409 `message_limit` with the verbatim copy, 199 → 409,
198 → 201 landing on exactly 200 (AC-13); the project document byte-identical before and after
(AC-14); 401, 403, cross-tenant 404 with bob's transcript unchanged, soft-deleted and
never-existed 404, three malformed ids (AC-6..AC-10).

**Green.** `echoFor`, `messagePair`, `messageCount`, `handleCreateMessage`, and the `attested`
`POST` route. Order inside the handler is id → body → project → count → batch: parsing before
reading means a body carrying `role` is refused before anything could have acted on it.

**Refactor.** The 409 message is `This project has reached its limit of 200 messages.` — asserted
verbatim at L4 because the composer renders it. One test-side fix: `messagePair(...).map()`
needed an explicit `unknown` return, since `DocumentData` indexes to `any` and
`no-unsafe-return` rightly caught the laundering.

**Deviation from the plan:** one addition. Alongside the plan's cases, `POST` gets a
**round-trip** case — three turns written through the real batch and read back through the real
query, asserting both the interleaved order and that the two documents of a turn genuinely
resolved to the *same* commit timestamp. The plan put AC-3 in T3; the seeded version lives there,
and this is the one R1 actually turns on ("the L4 one is the assertion that matters, because it
exercises the actual commit"). A single pair would come back right half the time by luck, so it
runs three.

## T5 — Rules and the composite index

**Red — and it needed proving differently.** The seven new L3 cases in `tests/rules/firestore.spec.ts`
**passed before the rules block existed**, because Firestore rules are additive: the absence of an
`allow` *is* the denial, so a path with no match block is already closed. A test that passes
immediately is testing nothing, so rather than accept it, the cases were checked for teeth
directly — a scratch `match /users/{uid}/{document=**}` granting the owner recursively was added
to `firestore.rules`, the suite went to **14 failures** including all seven messages cases, and
the scratch grant was reverted. That is the regression these cases exist to catch (a later rule
granting a parent recursively), and it is now demonstrated rather than assumed.

Cases: a verified owner — the most privileged client there is — is denied `getDoc`, `getDocs` on
the collection, `setDoc` of a user message *and* of an assistant one, `updateDoc` and `deleteDoc`
(AC-16); a different verified user and an anonymous client are denied the same on alice's path
(AC-17); every existing describe re-runs unchanged (AC-18). All `assertFails`; no `assertSucceeds`
import was added, and there still is not one in the file. The denied payload is exactly what
`handleCreateMessage` writes, so the denial is on the rule and not on the shape.

**Green.** The `match /users/{uid}/projects/{projectId}/messages/{messageId}` deny-all block,
comment included, verbatim from the PRD — and **in the same commit**, the
`firestore.indexes.json` entry: `messages`, `COLLECTION`, `createdAt` ASC + `seq` ASC.

**R2, read rather than tested.** No test at any level can catch the index missing — the emulator
serves any query. Checked by reading the entry against `transcriptQuery()`: the handler calls
`orderBy('createdAt','asc').orderBy('seq','asc')` and the index declares `createdAt` ASCENDING
then `seq` ASCENDING, in that order. (`firebase firestore:indexes` cannot verify this against
`demo-genesis` — it needs a real project — so the reading is the whole mitigation, as the plan
says.)

**Deviation from the plan:** none, beyond the extra work of proving the red step.
