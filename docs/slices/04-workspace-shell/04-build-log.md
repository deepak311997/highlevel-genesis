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

## T10 — `MessageComposer`

**Red.** `frontend/src/components/workspace/MessageComposer.spec.ts`, 16 cases, mocking
`@/stores/workspace` with a plain object as `ProjectsCard.spec.ts` mocks its store. The draft
renders from the store and typing writes back to it (D17, both directions); an empty and a
whitespace-only draft disable submit and send nothing on Enter (AC-31); a non-empty draft plus
Enter calls `send()` exactly once, as does the button; **Shift+Enter** sends nothing and does not
clear the draft (AC-33), and so do Ctrl/Meta/Alt+Enter; `sending` disables submit; at `atLimit` the
textarea and the button are both `disabled` and the limit is stated on screen with the number
(AC-32); `sendError` renders under the composer with the textarea still holding the draft, and a
resubmit after a failure still sends (AC-34).

**Green.** `MessageComposer.vue` — `Textarea` bound to `workspace.draft`,
`@keydown.enter.exact.prevent="submit()"` (`.exact` is what makes every modifier combination fall
through rather than send), an `Alert variant="destructive"` for `sendError`, and the `composer-input`
/ `composer-submit` / `composer-error` / `composer-limit` test ids.

**Refactor.** Header comment explaining why the draft is not local state, and why Enter and
Shift+Enter differ. `submit()` re-checks `canSend` rather than trusting the `disabled` attribute:
a keyboard shortcut reaches the handler without going through the button.

**Deviations from the plan:** two small additions. The Ctrl/Meta/Alt+Enter cases (the plan named
only Shift), because `.exact` is what makes all four behave and one assertion would not pin it;
and the at-limit case asserts the *number* appears, since D10's point is that the cap is stated
rather than hidden.

## T11 — `ChatPanel`

**Red.** `frontend/src/components/workspace/ChatPanel.spec.ts`, 15 cases, with `MessageComposer`
stubbed and the workspace store mocked. `messagesLoading` — and the tick before a request starts —
renders `chat-loading` and no bubbles (AC-27); loaded-and-empty renders `chat-empty`, no error, and
the composer (AC-28); loaded-with-messages renders one `message-bubble` per message with a
`data-role` distinguishing the two, its content, and a `message-time` of `09:05`, while a message
whose `createdAt` is `'not a date'` renders its content with **no** time (AC-29); `messagesError`
renders the server's message and a `chat-retry` whose click calls `loadMessages()`, and beats the
loading branch (AC-30); the `Echo mode` badge is present; the composer renders in every branch but
loading; and AC-35's two scroll cases.

**Green.** `ChatPanel.vue`. Branch order is `ProjectsCard.vue`'s — error, then
`messagesLoading || !messagesLoaded`, then bubbles, then empty. The transcript sits in `ScrollArea`
inside a plain `<div ref="scrollRoot">`, and the scrolling element is found with
`scrollRoot.value?.querySelector('[data-reka-scroll-area-viewport]')`; a
`watch(() => workspace.messages.length, …, { flush: 'post' })` plus one `onMounted` call sets
`scrollTop = scrollHeight`.

**Refactor.** The two-branch `MessageComposer` became one `showComposer` computed with a comment
saying why a failed transcript still gets a composer (the send route is a different request from
the list route). A duplicated paragraph was removed from the spec header.

**Two plan corrections, both about AC-35's test mechanics:**

1. **The mocked store had to be `reactive`.** The plan reuses `ProjectsCard.spec.ts`'s plain-object
   mock, but that spec only ever sets state *before* mounting. AC-35 is about appending to a
   *mounted* panel, and `watch` cannot fire on a plain object — the two scroll cases failed with
   `scrollTop` 0 while the other 13 passed. The store is now `reactive(...)`, and `ChatPanel` is
   imported dynamically after it, since a static import is hoisted above the `const` and the mock
   factory would close over an undefined store.
2. **`Object.defineProperty` on the element after mount was too late, and `scrollHeight` had to
   vary.** The plan's recipe defines `scrollHeight` on the viewport after mounting, but `onMounted`
   has already read 0 by then, so the mount case could never pass. `scrollHeight` is now a settable
   getter on `HTMLElement.prototype` for the suite (removed in `afterAll`), and the append case
   mounts at **120** and grows to **480** — which is stronger than the plan's version, because it
   proves the panel re-measured on the append rather than reusing the height it read on mount. The
   plan's claim that jsdom stores a written `scrollTop` was checked directly with a scratch spec
   and is correct.

**Also caught by typecheck:** `mount(Component, MOUNT, { attachTo })` takes two arguments, not
three, so the `attachTo` was being silently dropped. Merged into the options object.

## T12 — `EditorPanel` and `PreviewPanel`

**Red.** Folded into T13's `WorkspaceView.spec.ts`, as the plan specifies — "each names the slice
that fills it" is asserted there, and two placeholders with no request, no data and no failure mode
have nothing else to test (D18).

**Green.** `EditorPanel.vue` — heading `Code`, body naming Slices 6 and 7,
`data-testid="editor-panel"`. `PreviewPanel.vue` — heading `Preview`, body naming Slice 10,
`data-testid="preview-panel"`. Each header comment says why it has no loading/empty/error state.

## T13 — `WorkspaceView`, the route, and the app shell

**Red, `App.spec.ts`.** A memory router with two routes — one declaring no `meta.layout`, one
declaring `layout: 'full'` — asserts `main` carries `max-w-5xl`/`mx-auto` on the first and
`flex-1`/`min-h-0` without `max-w-5xl` on the second (D22), that the header renders on both, and
that the shell still says "Loading…" until Firebase has answered.

**Red, `WorkspaceView.spec.ts`.** 12 cases, with the store and `useRoute` mocked and
`window.matchMedia` stubbed controllably — **jsdom has no `matchMedia` at all**, so without the
stub `useMediaQuery` reports the query unsupported and the tabbed tree would render in every test,
making AC-23 and AC-24 assert the same thing. `open()` is called once on mount and again when the
route param changes; `projectLoading` renders `workspace-loading` and **no panels** (AC-20 — the AC
is stricter than the PRD's user-flow prose, and the AC is the contract); `projectMissing` renders
"That project no longer exists." with a `RouterLink` to `/dashboard`, no retry, no chat panel, and
`loadMessages` never called (AC-21); `projectError` renders the server's message and a
`workspace-retry` that re-opens (AC-22); with `matches: true` all three panels are present and the
placeholders name Slices 6, 7 and 10 while the tabbed tree is **not mounted** (AC-23); with
`matches: false` a tab list of Chat/Code/Preview renders with Chat shown, and selecting Preview
shows the preview panel and removes the chat panel (AC-24); the badge follows `locationId` both
ways (AC-26); and with `messagesError` set the header, badge and other two panels are still
rendered while no *workspace* error shows (AC-30's view half).

**Green.** `RouteLayout` added to `router/guard.ts`'s `RouteMeta`; the `/projects/:projectId` route
with `meta: { access: 'protected', layout: 'full' }` and a lazy import; `App.vue` as a flex column
with a `shrink-0` header and the contained/full switch on `main`; `WorkspaceView.vue`, driven by
one `watch(..., { immediate: true })` that covers both first mount and a param change.

**Refactor.** View header explaining why the project is fetched before the transcript (D25) and why
the layout switch is a `v-if` rather than Tailwind visibility classes (D16) — CSS-only would leave
both trees mounted, which is what would make AC-23 and AC-24 trivially true of the same DOM.

**Three test-mechanics corrections, all found by running the tests:**

1. **Mounted views leaked between tests.** Each test's view stayed alive watching the *shared*
   mocked `route`, so changing a param in one test re-triggered views a previous test had left
   mounted — `open` was called three times where two were expected, in a test that looked
   unrelated. Fixed with `enableAutoUnmount(afterEach)`.
2. **`App.spec.ts` needed `ThemeToggle` stubbed.** `App` renders it, and `useTheme` calls
   `matchMedia`, which jsdom lacks — so mounting `App` threw. Stubbed, as `ProjectsCard.spec.ts`
   stubs the dialogs that own their own suites.
3. Two `as` assertions in the mocked store were flagged by `no-unnecessary-type-assertion` and
   removed.

## T14 — The dashboard link

**Red.** `ProjectsCard.spec.ts` — the project name is a `RouterLink` whose `to` is
`/projects/proj-1` (and `/projects/proj-2` for the second row) carrying the project's name, while
Rename and Delete are still `BUTTON` elements; and a row contains exactly one link (AC-19).
`RouterLinkStub` added to the existing `MOUNT` stubs.

**Green.** The name wrapped in `<RouterLink :to="`/projects/${project.id}`">`, with focus-visible
styling so a keyboard user can see where they are. The row stays inert (D23).

**Refactor.** Two updates the plan called for, and one it did not:

- `DashboardView.spec.ts`'s one test that mounts the **real** `ProjectsCard` gained
  `RouterLinkStub`, exactly as the plan predicted — it mounts without a router and would have
  broken the moment the card needed one.
- `ProjectsCard.vue`'s header comment, which said rows are deliberately not links because Slice 4
  does not exist, now says what D23 decided and why the name rather than the row.
- **Not in the plan:** Slice 3 left a passing test, `does not make a row a link`, asserting no `a`
  element anywhere inside a row — the exact claim D23 inverts. It was **not deleted**. Slice 3's
  D12 said "the moment one becomes a link, Slice 4 has started", so the claim narrows instead: the
  test is now `does not make the row itself a link`, asserting the row is still an `LI` with no
  `href` while the name inside it navigates. That is what stops a later change wrapping the whole
  rectangle — with Delete inside it — and is a deliberate, documented inversion rather than a test
  weakened to get a green suite.

## T15 — End to end

**Red.** Not applicable in the usual sense, and the plan says so: "Green: nothing new — every part
exists by T14. If it fails, the failure is real." It passed on the first run, which is the intended
outcome — the parts were built and tested one at a time, and this walks the demo line through all
of them at once.

**Green.** `tests/e2e/workspace.spec.ts`, three tests, 9 e2e tests green in total:

1. **AC-37** — sign up and verify, create a project through the UI, click its **name**, land on
   `/projects/<id>`, see the name, a `Not connected` badge (AC-26 in a browser) and all three panels
   with the editor and preview naming Slices 6, 7 and 10, see `chat-empty`, type the prompt, press
   Enter, get two bubbles with `data-role` `user` then `assistant` and the echo second, watch the
   composer clear — then **reload** and see both again, then go **back to the dashboard and in
   again** and see them a third time. The reload proves the pair came back from the API; the second
   visit proves it is not sitting in a store that happened not to be cleared.
2. **AC-33 in a real browser** — Shift+Enter inserts a newline (`'first line\nsecond line'`) and
   sends nothing. L2 asserts no request is issued; only a browser shows the newline actually lands.
3. **AC-21 by the path a user reaches it** — delete the project from the dashboard, then navigate
   back to the workspace URL: "That project no longer exists.", no chat panel, and the Back link
   returns to the dashboard.

Playwright's Desktop Chrome viewport is 1280×720, so this walks the **resizable** tree; the tabbed
tree is covered at L2, where the breakpoint is controllable rather than guessed at.

**Refactor.** `locator.type()` → `locator.pressSequentially()`, its non-deprecated equivalent.
