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

## T6 — The typed messages client

**Red.** `frontend/src/lib/messagesApi.spec.ts`, mocking `@/lib/apiClient`'s `request` as
`projectsApi.spec.ts` does. `listMessages('proj-1')` calls `/api/projects/proj-1/messages` and
unwraps `{ messages }`, including the empty case; `sendMessage` is a `POST` with
`Content-Type: application/json` and a body of **exactly** `{ content: 'hi' }`; both encode an id
needing escaping; both surface the server's message on a rejection; `MESSAGE_LIMIT` is 200.

**Green.** `frontend/src/lib/messagesApi.ts` — `Message`, `MESSAGE_LIMIT`, `listMessages`,
`sendMessage`, with `pathFor` using `encodeURIComponent`.

**Refactor.** Header comment in `projectsApi.ts`'s voice, including why appending the returned
pair is not a deviation from the liveness rule.

**Deviation from the plan:** `MESSAGE_LIMIT` lives in `messagesApi.ts` as the plan specifies, and
gained a test of its own pinning it to 200 — a duplicated constant with no assertion is a copy
waiting to drift.

## T7 — `formatTime`

**Red.** Four cases in `frontend/src/lib/date.spec.ts`: `09:05` for `T09:05:00Z`, `23:30` for
`T23:30:00Z` without shifting into the local zone, `00:00` for midnight (not `24:00`, which
`hour12: false` produces without care), and `null` for `''` / `'not a date'` / `'undefined'`.

**Green.** A second module-scope `Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute:
'2-digit', hour12: false, timeZone: 'UTC' })` and `formatTime(iso)`.

**Refactor.** The "why pinned" comment folded to cover both formatters.

**Deviation from the plan:** none. The midnight case is one line beyond the plan's list, guarding
a real `Intl` foot-gun.

## T8 — The workspace store

**Red.** `frontend/src/stores/workspace.spec.ts`, 24 cases, stubbing `fetch` rather than the
client — `projects.spec.ts`'s pattern, and what makes the header assertion real. `open()` issues
`GET /api/projects/proj-1` then `GET /api/projects/proj-1/messages` in that order, both carrying
`Authorization: Bearer` and `X-Firebase-AppCheck` (AC-36); a 404 sets `projectMissing` and issues
**no** second request (AC-21's store half); a 500 sets `projectError` and leaves `projectMissing`
false; opening a second project drops the first's transcript; `loadMessages()` re-issues the
request and clears its error (AC-30); `send()` issues one `POST`, appends both returned messages,
clears the draft and issues **no `GET`** (AC-31), sends the trimmed draft, and appends rather than
replaces; a failed `send()` sets `sendError`, appends nothing, keeps the draft, and re-submitting
re-issues (AC-34); a blank or whitespace draft and a closed workspace issue nothing; the draft
survives a fresh `useWorkspaceStore()`, which is what a remounted component gets (AC-25);
`atLimit` is false at 199 and true at 200 (AC-32's source); `reset()` empties all twelve pieces of
state. Plus a case in `auth.spec.ts`: sign-out empties the workspace as the fourth store.

**Green.** `frontend/src/stores/workspace.ts`, and `useWorkspaceStore().reset()` added to
`signOutNow()`.

**Refactor.** Store header covering D12 (why appending is not a deviation from the liveness rule),
D17/R8 (why the draft lives here) and D26 (why the project is fetched rather than read from the
projects store). One test-side fix: `init.body` needed narrowing rather than `String()`, which
`no-base-to-string` correctly flagged.

**Plan amendment — `getProject` did not exist.** The plan has the store call
`GET /api/projects/:projectId` and does not list `frontend/src/lib/projectsApi.ts` as edited. The
route has existed since Slice 3 (AC-5) but **no typed client function for it did** — Slice 3's
dashboard only ever listed, created, patched and deleted. The options were to add it to
`projectsApi.ts`, to put it in `messagesApi.ts`, or to call `request()` directly from the store.
The first is the only one that keeps a client module per route module, so `getProject(id)` was
added to `projectsApi.ts` with its own red test first (path, envelope unwrapping, rejection, and
the id-encoding case it joins). This is an addition to the plan's file map, not a departure from
its design.

**Also noted:** `npm --prefix frontend run format` reformatted four files this slice does not
touch — `stores/hl.ts`, `components/ConnectionPanel.vue`, `lib/authApi.ts`, `lib/hlApi.spec.ts` —
so `main` is not Prettier-clean at those lines. Reverted to keep the slice's diff reviewable. See
*Deferred* at the end of this log.

## T9 — Vendor the six shadcn-vue blocks

**Red.** None possible — this is upstream code fetched by a CLI, and a test asserting a vendored
file exists would assert the CLI ran. The plan's replacements for the red step, all met:
`typecheck` and `lint --max-warnings 0` pass on the generated files, the suite is green, and
`git diff frontend/package.json` is **empty** (the lockfile too).

**Green.** `npx shadcn-vue@latest add tabs badge resizable scroll-area separator textarea` from
`frontend/` — 17 files across the six directories.

**Two things the plan did not predict, both resolved inside its own instructions:**

1. **The CLI added a runtime dependency.** It installed `@lucide/vue` ^1.31.0 — its configured
   `iconLibrary` — even though the repo already carries `lucide-vue-next` ^1.0.0 (the dialog uses
   it) and that is what the generated `ResizableHandle.vue` actually imports. Nothing under
   `frontend/src` imports `@lucide/vue`, so it was uninstalled. The PRD's definition of done
   ("no new runtime dependency appears in `frontend/package.json` as a result") is met, and D20's
   claim survives: all six blocks sit on `reka-ui`, `class-variance-authority`, `clsx`,
   `@vueuse/core` and the already-present `lucide-vue-next`.

2. **Ten of the generated files failed `strictTypeChecked` / `exactOptionalPropertyTypes`**, which
   T9's refactor step anticipated ("make the **minimum** edit and add a comment saying it deviates
   from upstream"). Every failure was one already-solved family: upstream forwards props with
   `reactiveOmit` / `useForwardProps(Emits)`, whose result carries keys whose value is `undefined`,
   and `exactOptionalPropertyTypes` treats "absent" and "present but undefined" as different
   types. The repo's existing answer — strip undefined keys, documented at length in
   `ui/label/Label.vue` and reused in `ui/dialog/DialogContent.vue` — was applied to
   `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, `ResizablePanelGroup`, `ResizableHandle`,
   `ScrollArea`, `ScrollBar` and `Separator`. Three of those have a **required** prop
   (`SplitterGroup.direction`, `TabsTrigger.value`, `TabsContent.value`) which a filtered record
   cannot promise the compiler is still present, so each is bound explicitly in the template and
   filtered out of the spread — checked rather than cast. `ResizableHandle` also filters its own
   `withHandle`, which is not a prop the primitive knows and would otherwise land on the DOM node.
   `ScrollBar` and `Separator` gained `class: undefined` defaults for
   `vue/require-default-prop`. `Textarea.vue` needed `Input.vue`'s two existing deviations: a
   function-type emits declaration for `prefer-function-type`, and the conditional `useVModel`
   option object for `exactOptionalPropertyTypes`. `Badge` needed no edit at all.

**Refactor.** `npm --prefix frontend run format`. Prettier also wanted to reformat four files this
slice does not touch; those were reverted (see *Deferred*).
