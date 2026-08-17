# Slice 04 — Workspace shell & chat persistence · Technical plan

**PRD:** `02-prd.md` (approved) · **Branch:** `slice/04-workspace-shell` · **Date:** 2026-08-17

## Approach

The boundary ships first and the UI last, because this is the largest slice so far (D30, R4)
and the security-relevant half — who may author an assistant turn — has to be reviewable
before a component exists. `functions/src/messages/` is a new module beside
`{auth,hl,users,projects}/` (D4) holding a `.strict()` body schema, a stored-document schema
and two handlers; it reuses Slice 3's `readProject` for "this project is gone" rather than
carrying a second definition of it (D14). The transcript's ordering hazard (D8, R1) is
carried by a `seq` field and a two-key `orderBy`, and both halves get a test: the query
builder is factored into a pure `transcriptQuery()` so the second `orderBy` cannot be
deleted silently at L1, and an L4 case writes a real pair through the route and reads it
back, which is the assertion that exercises the actual commit.

On the frontend, one `useWorkspaceStore` holds the project, the transcript, the draft and
four states (D24); `WorkspaceView` fetches the project first and the transcript only if it
resolves (D25), and switches between a `resizable` tree and a `tabs` tree at `lg` with
`useMediaQuery` from `@vueuse/core` — already a dependency, and a `v-if` rather than
Tailwind's `hidden lg:*`, because CSS-only would leave both trees in the DOM at once and
AC-23 and AC-24 would both be trivially true.

Rejected: a `messages` router hung off `projectsRouter` — one module per collection keeps
the file a reviewer opens to answer "who can write a message" small. Rejected: computing the
returned pair's timestamps from `WriteBatch.commit()`'s `writeTime` — `handleCreateProject`
already establishes re-reading after a `serverTimestamp()` write, and `getAll()` fetches both
documents in one round trip. Rejected: an in-memory sort after the query — one ordering
mechanism, so an index or query mistake fails visibly rather than being papered over.

## File map

### Functions

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/messages/schema.ts` | New | `MESSAGES`, `MESSAGE_LIMIT`, `CONTENT_MAX`, `messagesPath()`, `createMessageBodySchema` (`.strict()`), `storedMessageSchema`, `Message`, `toMessage()` |
| `functions/src/messages/schema.spec.ts` | New | L1 — body `.strict()` refusals, trimming, length; stored schema's three corrupt shapes; `toMessage` carries no `seq` |
| `functions/src/messages/handlers.ts` | New | `echoFor()`, `parseStoredMessage()`, `transcriptQuery()`, `messagePair()`, `handleListMessages()`, `handleCreateMessage()` |
| `functions/src/messages/handlers.spec.ts` | New | L1 — the echo, the two-key query, the pair's `seq` values, the `message.unreadable` log line |
| `functions/src/messages/index.ts` | New | `messagesRouter` — `GET` and `POST /projects/:projectId/messages`, `attested` on `POST` only |
| `functions/src/projects/handlers.ts` | Edit | Export `readProject`, `requireProjectId`, `notFound` (D14). No behaviour change |
| `functions/src/api/index.ts` | Edit | Mount `messagesRouter` at `/` and `/api`, after `projectsRouter` |

### Data layer

| File | New/Edit | What changes |
|---|---|---|
| `firestore.rules` | Edit | One `match /users/{uid}/projects/{projectId}/messages/{messageId}` deny-all block |
| `firestore.indexes.json` | Edit | `messages` collection-scope composite: `createdAt` ASC + `seq` ASC (D9, R2) |

### Frontend — libraries and state

| File | New/Edit | What changes |
|---|---|---|
| `frontend/src/lib/messagesApi.ts` | New | `Message`, `listMessages()`, `sendMessage()` over `apiClient.request` |
| `frontend/src/lib/messagesApi.spec.ts` | New | L1 — paths, verbs, body, envelope unwrapping |
| `frontend/src/lib/date.ts` | Edit | `formatTime(iso)` beside `formatDay` (D29) |
| `frontend/src/lib/date.spec.ts` | Edit | L1 — pinned `en-GB`/UTC `HH:mm`, `null` for unparseable |
| `frontend/src/stores/workspace.ts` | New | Project, transcript, draft, `open()`, `loadMessages()`, `send()`, `reset()` |
| `frontend/src/stores/workspace.spec.ts` | New | L1 — sequential load, 404 issues no transcript request, `send()` appends and issues no `GET`, draft survives, headers on every request |
| `frontend/src/stores/auth.ts` | Edit | `useWorkspaceStore().reset()` in `signOutNow()` |
| `frontend/src/stores/auth.spec.ts` | Edit | Assert the fourth store is reset |

### Frontend — components and routing

| File | New/Edit | What changes |
|---|---|---|
| `frontend/src/components/ui/tabs/` | New (CLI) | `npx shadcn-vue@latest add tabs` |
| `frontend/src/components/ui/badge/` | New (CLI) | `… add badge` |
| `frontend/src/components/ui/resizable/` | New (CLI) | `… add resizable` |
| `frontend/src/components/ui/scroll-area/` | New (CLI) | `… add scroll-area` |
| `frontend/src/components/ui/separator/` | New (CLI) | `… add separator` |
| `frontend/src/components/ui/textarea/` | New (CLI) | `… add textarea` (D21) |
| `frontend/src/components/workspace/MessageComposer.vue` | New | Textarea, Enter-to-send, disabled/at-limit/error states |
| `frontend/src/components/workspace/MessageComposer.spec.ts` | New | L2 — AC-31..34 |
| `frontend/src/components/workspace/ChatPanel.vue` | New | Header + `Echo mode` badge, loading/empty/error, bubbles, scroll-to-bottom |
| `frontend/src/components/workspace/ChatPanel.spec.ts` | New | L2 — AC-27..30, AC-35 |
| `frontend/src/components/workspace/EditorPanel.vue` | New | Labelled placeholder naming Slices 6 and 7 (D18) |
| `frontend/src/components/workspace/PreviewPanel.vue` | New | Labelled placeholder naming Slice 10 (D18) |
| `frontend/src/views/WorkspaceView.vue` | New | Loading / not-found / error / header+badge / the `lg` layout switch |
| `frontend/src/views/WorkspaceView.spec.ts` | New | L2 — AC-20..24, AC-26, AC-30 |
| `frontend/src/router/guard.ts` | Edit | `RouteLayout` type, added to the `RouteMeta` declaration |
| `frontend/src/router/index.ts` | Edit | `/projects/:projectId`, `access: 'protected'`, `layout: 'full'` |
| `frontend/src/App.vue` | Edit | Flex column shell; `main` contained or full-bleed by `route.meta.layout` (D22) |
| `frontend/src/App.spec.ts` | New | L2 — contained on a `contained` route, full-bleed on a `full` one |
| `frontend/src/components/ProjectsCard.vue` | Edit | The project name becomes a `RouterLink` (D23) |
| `frontend/src/components/ProjectsCard.spec.ts` | Edit | L2 — AC-19, plus `RouterLinkStub` in the mount options |
| `frontend/src/views/DashboardView.spec.ts` | Edit | Add `RouterLinkStub` to the one test that mounts the real card |

### Tests and docs

| File | New/Edit | What changes |
|---|---|---|
| `tests/integration/messages.spec.ts` | New | L4 — both routes, happy path and every refusal |
| `tests/rules/firestore.spec.ts` | Edit | L3 — the messages subcollection denied to owner, stranger and anonymous |
| `tests/e2e/workspace.spec.ts` | New | L5 — AC-37 |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §0 status, §4 Slice 4, §9 conformance rows for F6.1 / F6.2 / shadcn inventory |
| `docs/PRODUCT_SPEC.md` | Edit | §7.2 inventory: `tabs`/`badge`/`resizable`/`scroll-area`/`separator` shipped, `textarea` recorded (D21) |

## Interfaces, decided here so the build does not have to invent them

**`functions/src/messages/schema.ts`**

```ts
export const MESSAGES = 'messages'
/** The cap and the list's limit are the same number: an unpaginated list is
 *  only honest if it cannot truncate. Mirrors PROJECT_LIMIT / LIST_LIMIT. */
export const MESSAGE_LIMIT = 200
export const CONTENT_MAX = 4000

export function messagesPath(uid: string, projectId: string): string {
  return `${projectsPath(uid)}/${projectId}/${MESSAGES}`
}

export const createMessageBodySchema = z
  .object({ content: z.string().trim().min(1).max(CONTENT_MAX) })
  .strict()

export const storedMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  seq: z.number().int().min(0),
  createdAt: firestoreTimestamp,
})

export interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export function toMessage(id: string, stored: StoredMessage): Message  // drops `seq`
```

Note `content` carries **no maximum on the stored schema** (D11) — the echo of a 4,000-character
prompt is longer than one. `firestoreTimestamp` is imported from `../users/schema`, as
`projects/schema.ts` does.

**`functions/src/messages/handlers.ts`**

```ts
export function echoFor(content: string): string          // `You said: ${content}`
export function parseStoredMessage(snapshot: DocumentSnapshot): StoredMessage | null
/** Factored out so R1's second orderBy has an L1 test that fails if it is deleted. */
export function transcriptQuery(collection: Query): Query // .orderBy(createdAt,asc).orderBy(seq,asc).limit(MESSAGE_LIMIT)
/** The two documents of one turn, seq 0 then seq 1. `now` is injected so this is pure. */
export function messagePair(content: string, now: FieldValue): [DocumentData, DocumentData]
export async function handleListMessages(req, res, uid): Promise<void>
export async function handleCreateMessage(req, res, uid): Promise<void>
```

`handleCreateMessage`, in order: `requireProjectId(req)` → `parseBody(createMessageBodySchema, req)`
→ `readProject(uid, id)` or `throw notFound()` → count → 409 → `WriteBatch` of the pair →
`getDb().getAll(userRef, assistantRef)` → parse both → 201. Parsing first means a refused body
costs no Firestore call, exactly as `handleCreateProject` does it.

The count mirrors `liveProjectCount`: `.limit(MESSAGE_LIMIT).select().get()` then `snapshot.size`.
The refusal is `count + 2 > MESSAGE_LIMIT` — so 198 stored succeeds and lands on 200, 199 and 200
are both 409 (D10: "a `POST` whose pair would cross the cap").

**`frontend/src/lib/messagesApi.ts`** — `pathFor(projectId)` uses `encodeURIComponent`, as
`projectsApi.ts` does. `sendMessage(projectId, content)` returns `Message[]` — the pair.

**`frontend/src/stores/workspace.ts`**

```ts
export interface WorkspaceStore {
  projectId: Ref<string | null>
  project: Ref<Project | null>
  projectLoading: Ref<boolean>
  /** The 404, kept apart from `projectError`: one has a Back link, the other a Retry. */
  projectMissing: Ref<boolean>
  projectError: Ref<string | null>
  messages: Ref<Message[]>
  messagesLoading: Ref<boolean>
  messagesLoaded: Ref<boolean>
  messagesError: Ref<string | null>
  draft: Ref<string>
  sending: Ref<boolean>
  sendError: Ref<string | null>
  atLimit: ComputedRef<boolean>            // messages.length >= MESSAGE_LIMIT
  canSend: ComputedRef<boolean>            // draft trims non-empty, not sending, not at limit
  open: (projectId: string) => Promise<void>
  loadMessages: () => Promise<void>
  send: () => Promise<void>
  reset: () => void
}
```

`MESSAGE_LIMIT` is duplicated as a frontend constant (`200`) in `messagesApi.ts` — the functions
package is not importable from `frontend/`, and `projectsApi.ts` already mirrors the wire shape
the same way. `open()` is sequential (D25): a 404 sets `projectMissing` and returns **without
issuing a transcript request**. `send()` appends the returned pair and issues no `GET` (D12).

**Route and layout (D22)**

```ts
// router/guard.ts
export type RouteLayout = 'contained' | 'full'
declare module 'vue-router' {
  interface RouteMeta { access?: RouteAccess; layout?: RouteLayout }
}
```

`App.vue` becomes `<div class="flex min-h-screen flex-col">`, `header` gets `shrink-0`, and
`main` is `mx-auto w-full max-w-5xl px-6 py-10` when `route.meta.layout !== 'full'` and
`flex flex-1 flex-col min-h-0` when it is.

## Task list

Ordered so each task leaves the suite green and nothing depends on a later one.

### T1 — Message schemas → AC-10 (id), AC-11, AC-12, AC-15 (stored)
- **Red:** `functions/src/messages/schema.spec.ts` — `createMessageBodySchema` refuses each of
  `role`, `id`, `seq`, `createdAt` as an unknown key (`{ role: 'assistant', content: 'x' }`
  explicitly, per R3); refuses missing / `''` / `'   '` / 4,001-character / non-string `content`;
  trims `'  hi  '` to `'hi'`. `storedMessageSchema` rejects a missing `content`, a missing
  `createdAt`, and `role: 'system'`. `toMessage` returns `{id, role, content, createdAt}` and
  no `seq`, with `createdAt` an ISO string.
- **Green:** `functions/src/messages/schema.ts` as specified above.
- **Refactor:** the module-header comment, in `projects/schema.ts`'s voice — say why `role` is
  not in the body schema and why the stored `content` has no maximum.

### T2 — Export the project-access helpers → enables AC-9, AC-10, AC-14
- **Red:** *none, and deliberately.* This is a visibility change with no behaviour to assert;
  a test that only proved `readProject` is exported would be testing TypeScript. The suite must
  stay green across it, which is the whole check.
- **Green:** in `functions/src/projects/handlers.ts`, add `export` to `readProject`,
  `requireProjectId` and `notFound`. The PRD's D14 names `readProject` only; the same argument
  ("a second copy is how the two drift") covers the other two, since the messages routes owe
  byte-identical `invalid_id` and `not_found` answers. Rejected: moving all three to a new
  `projects/access.ts`, which is a cleaner home and a larger, noisier diff across Slice 3 code.
- **Refactor:** extend each doc comment to say it is now shared with `messages/`.

### T3 — `GET /api/projects/:projectId/messages` → AC-2, AC-3, AC-4, AC-6, AC-7, AC-8, AC-9, AC-10, AC-15
- **Red, L1:** `functions/src/messages/handlers.spec.ts` — `transcriptQuery()` called with a
  chainable spy asserts `orderBy('createdAt','asc')`, then `orderBy('seq','asc')`, then
  `limit(200)`, **in that order**. This is R1's regression guard: deleting the second `orderBy`
  fails here rather than in production half the time. `parseStoredMessage` logs
  `message.unreadable` with `outcome: 'invalid'` and no field of the document, and returns `null`
  for each of the three corrupt shapes; an absent snapshot returns `null` and logs nothing.
- **Red, L4:** `tests/integration/messages.spec.ts` — seed a pair with equal `createdAt` and
  `seq` 0/1 and assert user-before-assistant and that no key `seq` is on the wire (AC-2); three
  turns at distinct timestamps come back oldest-first (AC-3); empty is `200 {"messages": []}`,
  not 404 (AC-4); no header → 401 and unverified token → 403 (AC-6, AC-7); alice cannot read
  bob's transcript, and bob's documents are unchanged (AC-8); soft-deleted and never-existed
  project ids → 404 via `expectNotFound` (AC-9); `..`, 65 characters and `a/b` → 400 `invalid_id`
  (AC-10); seeded corrupt documents are omitted (AC-15).
- **Green:** `handlers.ts` (`parseStoredMessage`, `transcriptQuery`, `handleListMessages`),
  `messages/index.ts` with the `GET` route only, mounted in `api/index.ts` at `/` and `/api`.
- **Refactor:** the module header, and the `messagesPath` call site.

> **Trap the build session must not walk into.** A Firestore `orderBy` **excludes documents
> where the field is absent**. A corrupt document seeded without `createdAt` or without `seq`
> never reaches `parseStoredMessage` at all — it is filtered by the query. So AC-15's L4 case
> asserts *omission* for all three shapes, and the `message.unreadable` log line is asserted at
> L1 only (which is what the PRD's test matrix already assigns). Seed the "missing content" and
> "bad role" documents **with** a valid `createdAt` and `seq`, or they prove nothing about the
> parse. Integration tests cannot read the functions process's console in any case.

### T4 — `POST /api/projects/:projectId/messages` → AC-1, AC-5, AC-11, AC-12, AC-13, AC-14
- **Red, L1:** `handlers.spec.ts` — `echoFor('build a contact dashboard')` is exactly
  `'You said: build a contact dashboard'`; `messagePair()` returns two documents, `role`
  `user` then `assistant`, `seq` `0` then `1`, the second's content the echo of the first's.
- **Red, L4:** `messages.spec.ts` — 201 with exactly two messages in order, and two stored
  documents carrying `seq` 0 and 1 (AC-1); leading/trailing whitespace is trimmed in the store,
  on the wire, and inside the echo (AC-5); `{ role: 'assistant', content: '…' }` and each of
  `id` / `seq` / `createdAt` → 400 `invalid_body` with nothing written (AC-11); missing, blank,
  whitespace-only, 4,001-character and non-string `content` → 400 with nothing written (AC-12);
  200 seeded → 409 `message_limit` and nothing written, 198 seeded → 201 and the collection
  holds 200 (AC-13); the project document's `updatedAt` is byte-identical before and after
  (AC-14); the 401/403/404/400-`invalid_id` and cross-tenant cases repeated for `POST`.
- **Green:** `handleCreateMessage` and the attested `POST` route.
- **Refactor:** pull the shared "count then refuse" comment into shape; check the 409 message
  reads `This project has reached its limit of 200 messages.` — the composer renders it verbatim.

### T5 — Rules and the composite index → AC-16, AC-17, AC-18
- **Red:** `tests/rules/firestore.spec.ts` — a new `describe` for
  `users/{uid}/projects/{projectId}/messages/{messageId}`: a verified owner is denied `getDoc`,
  `getDocs` on the collection, `setDoc`, `updateDoc` and `deleteDoc`; a different verified user
  and an anonymous client are denied the same (AC-16, AC-17). Seed past the rules with
  `withSecurityRulesDisabled`, as `seedProject` does, so update and delete have a document to be
  denied *on*. AC-18's existing cases are re-run unchanged — the assertion is that a rules-file
  edit did not cost another collection its denial. Every case is an `assertFails`; there is no
  `assertSucceeds` import in this file and there must not be one after this task.
- **Green:** the `firestore.rules` block exactly as the PRD's Data model section writes it,
  comment included. **In the same commit**, the `firestore.indexes.json` entry (D9).
- **Refactor:** none expected.

> **No test can catch the missing index (R2).** The emulator serves any query, so L3, L4 and L5
> all pass without it and the first workspace load after deploy is where it fails. Verified at
> review by reading the index entry against `transcriptQuery()`'s two `orderBy` calls.

### T6 — The typed messages client → AC-36
- **Red:** `frontend/src/lib/messagesApi.spec.ts` — mocks `@/lib/apiClient`'s `request`, as
  `projectsApi.spec.ts` does. `listMessages('proj-1')` calls `/api/projects/proj-1/messages` and
  unwraps `{ messages }`; `sendMessage('proj-1', 'hi')` is a `POST` with
  `Content-Type: application/json` and a body of exactly `{ content: 'hi' }`; an id needing
  escaping is encoded; a rejection surfaces the server's message.
- **Green:** `frontend/src/lib/messagesApi.ts`.
- **Refactor:** the header comment, in `projectsApi.ts`'s voice.

### T7 — `formatTime` → AC-29
- **Red:** `frontend/src/lib/date.spec.ts` — `formatTime('2026-08-17T09:05:00.000Z')` is
  `'09:05'`; `'2026-08-17T23:30:00.000Z'` is `'23:30'` and does not shift into the local zone;
  `''`, `'not a date'` and `'undefined'` return `null`.
- **Green:** a second module-scope `Intl.DateTimeFormat('en-GB', { hour: '2-digit',
  minute: '2-digit', hour12: false, timeZone: 'UTC' })` and `formatTime(iso)`.
- **Refactor:** fold the "why pinned" comment so it covers both formatters.

### T8 — The workspace store → AC-25, AC-31, AC-34, AC-36
- **Red:** `frontend/src/stores/workspace.spec.ts`, stubbing `fetch` rather than the client —
  `projects.spec.ts`'s pattern, and what makes the header assertion real. Cases: `open()` issues
  `GET /api/projects/proj-1` and then `GET /api/projects/proj-1/messages`, in that order; a 404
  on the project sets `projectMissing` and issues **no** second request (AC-21's store half);
  a 500 sets `projectError` and leaves `projectMissing` false; `loadMessages()` re-issues the
  transcript request; `send()` issues one `POST`, appends both returned messages, clears the
  draft, and issues **no `GET`** (AC-31); a failed `send()` sets `sendError`, appends nothing and
  keeps the draft, and calling `send()` again re-issues the request (AC-34); the draft is store
  state, so a value set on the store survives any component lifecycle (AC-25); `atLimit` is true
  at 200 messages; every request carries `Authorization: Bearer` and `X-Firebase-AppCheck`
  (AC-36); `reset()` empties all of it.
- **Green:** `frontend/src/stores/workspace.ts`; add `useWorkspaceStore().reset()` to
  `signOutNow()` in `stores/auth.ts` and extend `auth.spec.ts`'s reset assertion to four stores.
- **Refactor:** the store header — why appending is not a deviation from the liveness rule (D12),
  and why the draft lives here (D17, R8).

### T9 — Vendor the six shadcn-vue blocks → enables T10–T13
- **Red:** *none possible* — this is upstream code fetched by a CLI, and a test asserting a
  vendored file exists would assert the CLI ran. What replaces the red step: the suite must be
  green afterwards, `npm --prefix frontend run lint -- --max-warnings 0` and `typecheck` must
  pass on the generated files, and `git diff frontend/package.json` must be **empty** — all six
  sit on `reka-ui` 2.10.3, `class-variance-authority` and `clsx`, every one already installed
  (D20). Confirmed against `node_modules/reka-ui`: `SplitterGroup`, `SplitterPanel`,
  `SplitterResizeHandle`, `ScrollAreaRoot`, `ScrollAreaViewport`, `ScrollAreaScrollbar`,
  `Separator` and `Tabs*` are all exported at that version.
- **Green:** `npx shadcn-vue@latest add tabs badge resizable scroll-area separator textarea`
  from `frontend/`. `components.json` is already configured (`@/components/ui`, TypeScript,
  slate, CSS variables).
- **Refactor:** run `npm --prefix frontend run format`. If a generated file trips
  `strictTypeChecked`, make the **minimum** edit and add a comment saying it deviates from
  upstream — `PRODUCT_SPEC.md` §7.2's existing rule for the `Alert` and `Button` deviations.

### T10 — `MessageComposer` → AC-31, AC-32, AC-33, AC-34
- **Red:** `frontend/src/components/workspace/MessageComposer.spec.ts`, mocking
  `@/stores/workspace` with a plain object as `ProjectsCard.spec.ts` mocks its store. Cases:
  empty and whitespace-only drafts disable submit and `Enter` issues no `send()` (AC-31);
  a non-empty draft plus `Enter` (no shift) calls `send()` exactly once (AC-31);
  `Shift+Enter` calls `send()` zero times and does not clear the draft (AC-33); at
  `atLimit` the textarea and the button are `disabled` and the limit is stated on screen
  (AC-32); `sendError` renders under the composer and the textarea still holds the draft
  (AC-34); `sending` disables submit.
- **Green:** `MessageComposer.vue` — `Textarea` bound to `workspace.draft` (the store, D17),
  `@keydown.enter.exact.prevent="submit"`, a plain `@keydown.enter.shift` left alone, an
  `Alert variant="destructive"` for `sendError`, `data-testid`s `composer-input`,
  `composer-submit`, `composer-error`, `composer-limit`.
- **Refactor:** the comment explaining why the draft is not local state.

### T11 — `ChatPanel` → AC-27, AC-28, AC-29, AC-30, AC-35
- **Red:** `frontend/src/components/workspace/ChatPanel.spec.ts`, with `MessageComposer` stubbed
  (it has a suite of its own) and the workspace store mocked. Cases: `messagesLoading` renders
  `chat-loading` and no bubbles (AC-27); loaded-and-empty renders `chat-empty`, no error, and
  the composer (AC-28); loaded-with-messages renders one `message-bubble` per message with a
  `data-role` distinguishing user from assistant, each carrying its content and a
  `message-time`, and a message whose `createdAt` is `'not a date'` renders its content with
  **no** `message-time` (AC-29); `messagesError` renders the server's message and a
  `chat-retry` button whose click calls `loadMessages()` (AC-30); the `Echo mode` badge is
  present.
  **AC-35:** mount with one message, take the viewport
  (`wrapper.find('[data-reka-scroll-area-viewport]').element`), `Object.defineProperty` its
  `scrollHeight` to `480`, push a second message onto the mocked store's array,
  `await flushPromises()`, and expect `scrollTop` to be `480`. jsdom stores and returns a
  written `scrollTop`, which is what makes this a real assertion rather than `0 === 0`.
- **Green:** `ChatPanel.vue`. Branch order is `ProjectsCard.vue`'s and for its reason: **error
  first**, then loading (`messagesLoading || !messagesLoaded`), then bubbles, then empty. The
  transcript sits inside `ScrollArea` wrapped in a plain `<div ref="scrollRoot">`; the panel
  finds the scrolling element with `scrollRoot.value?.querySelector('[data-reka-scroll-area-viewport]')`
  — a documented reka-ui attribute, emitted into its own injected stylesheet — and a
  `watch(() => workspace.messages.length, …, { flush: 'post' })` plus one call in `onMounted`
  sets `scrollTop = scrollHeight`. The composer renders in every branch except loading.
- **Refactor:** a comment on the viewport lookup saying why it is a query and not a ref.

> `jsdom` does **not** implement `ResizeObserver`. `SplitterGroup` guards on
> `typeof ResizeObserver !== 'function'` and `@vueuse/core`'s `useResizeObserver` has an
> `isSupported` guard, so mounting should be clean; reka-ui's `useSize` does not guard, and it
> is reached only when a scrollbar or corner actually mounts (hover-type, so not in jsdom). If a
> spec does throw on it, stub `globalThis.ResizeObserver` with a three-method no-op class **in
> that spec** — do not change the vendored component.

### T12 — `EditorPanel` and `PreviewPanel` → AC-23 (their half)
- **Red:** folded into T13's `WorkspaceView.spec.ts`, which is where "each names the slice that
  fills it" is actually asserted. Two placeholder components with no request, no data and no
  failure mode have nothing else to test, and the loading/empty/error rule has nothing to attach
  to (D18).
- **Green:** `EditorPanel.vue` — heading `Code`, body naming Slices 6 and 7,
  `data-testid="editor-panel"`. `PreviewPanel.vue` — heading `Preview`, body naming Slice 10,
  `data-testid="preview-panel"`.
- **Refactor:** none.

### T13 — `WorkspaceView`, the route, and the app shell → AC-20, AC-21, AC-22, AC-23, AC-24, AC-26, AC-30
- **Red, `App.spec.ts`:** build a memory router in the spec with two routes — one with no
  `meta.layout`, one with `layout: 'full'` — mock `@/stores/auth`, mount `App` with the router
  as a plugin, and assert `main`'s classes carry `max-w-5xl` on the first and not on the second.
- **Red, `WorkspaceView.spec.ts`:** mock the workspace store, and stub `window.matchMedia`
  with a controllable fake (`{ matches, media, addEventListener, removeEventListener,
  addListener, removeListener, onchange: null, dispatchEvent }`) — **jsdom has no `matchMedia`
  at all**, so without the stub `useMediaQuery` reports unsupported and the tabbed tree renders
  in every test. Cases: `projectLoading` renders `workspace-loading` and **no panels** (AC-20 —
  note this is stricter than the PRD's user-flow prose, which says "three empty panels"; the AC
  is the contract); `projectMissing` renders "That project no longer exists." with a
  `RouterLink` to `/dashboard` and the store's `loadMessages` was never called (AC-21);
  `projectError` renders the server's message and a `workspace-retry` whose click calls
  `open()` again (AC-22); with `matches: true` all three panels are present at once and the
  editor and preview panels name their slices (AC-23); with `matches: false` a `TabsList` of
  Chat/Code/Preview renders with Chat selected, one panel is shown, and selecting Preview shows
  the preview panel and hides the chat panel (AC-24); `locationId` set → a badge reading
  `HighLevel connected`, `null` → `Not connected` (AC-26); with `messagesError` set the header,
  the badge and the other two panels are still rendered (AC-30's view half).
- **Green:** `WorkspaceView.vue`; `RouteLayout` in `router/guard.ts`; the `/projects/:projectId`
  route in `router/index.ts` with `meta: { access: 'protected', layout: 'full' }` and a lazy
  import; the flex shell in `App.vue`. The view drives the store from
  `watch(() => route.params.projectId, id => workspace.open(String(id)), { immediate: true })` —
  one mechanism that covers both the first mount and a param change.
- **Refactor:** the view header — why the project is fetched before the transcript (D25), and
  why the layout switch is a `v-if` rather than Tailwind visibility classes.

### T14 — The dashboard link → AC-19
- **Red:** `ProjectsCard.spec.ts` — the project name is a `RouterLink` whose `to` is
  `/projects/proj-1`, and Rename and Delete are still `button` elements. Add
  `RouterLink: RouterLinkStub` (from `@vue/test-utils`) to the existing `MOUNT` stubs.
- **Green:** wrap the name in `<RouterLink :to="`/projects/${project.id}`">`. The row itself
  stays inert (D23), so a mis-aimed tap cannot reach Delete.
- **Refactor:** **also add `RouterLinkStub` to `DashboardView.spec.ts`'s one test that mounts
  the real `ProjectsCard`** ("keeps the rest of the dashboard when the project list has
  failed") — it currently mounts without a router and will fail the moment the card needs one.
  Update `ProjectsCard.vue`'s header comment, which today says rows are deliberately not links
  because Slice 4 does not exist yet.

### T15 — End to end → AC-37
- **Red:** `tests/e2e/workspace.spec.ts` — `signUpAndVerify`, create a project through the
  dashboard UI, click its name, land on `/projects/<id>`, see `chat-empty`, type "build a
  contact dashboard" into `composer-input`, press Enter, see two bubbles with the prompt above
  the echo, reload and see both still there in that order, navigate back to `/dashboard` and
  into the project again and see them a third time. Playwright's Desktop Chrome viewport is
  1280×720, so this walks the resizable tree.
- **Green:** nothing new — every part exists by T14. If it fails, the failure is real.
- **Refactor:** none.

### T16 — Documentation
- **Red:** none — prose.
- **Green:** `docs/IMPLEMENTATION_PLAN.md` §0 status table, §4 Slice 4, §9 rows for F6.1, F6.2
  and the shadcn-vue inventory; `docs/PRODUCT_SPEC.md` §7.2's component table — `tabs`, `badge`,
  `resizable`, `scroll-area`, `separator` shipped, and a `textarea` row recorded with D21 as its
  reason. `README` delta: none expected — no setup step changes; confirm at review.

## AC → task coverage

| AC | Task(s) | AC | Task(s) |
|---|---|---|---|
| AC-1 | T4 | AC-20 | T13 |
| AC-2 | T3 | AC-21 | T8, T13 |
| AC-3 | T3 | AC-22 | T13 |
| AC-4 | T3 | AC-23 | T12, T13 |
| AC-5 | T4 | AC-24 | T13 |
| AC-6 | T3, T4 | AC-25 | T8 |
| AC-7 | T3, T4 | AC-26 | T13 |
| AC-8 | T3, T4 | AC-27 | T11 |
| AC-9 | T2, T3, T4 | AC-28 | T11 |
| AC-10 | T1, T3, T4 | AC-29 | T7, T11 |
| AC-11 | T1, T4 | AC-30 | T11, T13 |
| AC-12 | T1, T4 | AC-31 | T8, T10 |
| AC-13 | T4 | AC-32 | T10 |
| AC-14 | T4 | AC-33 | T10 |
| AC-15 | T1, T3 | AC-34 | T8, T10 |
| AC-16 | T5 | AC-35 | T11 |
| AC-17 | T5 | AC-36 | T6, T8 |
| AC-18 | T5 | AC-37 | T15 |
| AC-19 | T14 | | |

**Every AC maps to at least one task.** AC-36's second clause — "no `firebase/firestore` import
exists anywhere under `frontend/src`" — is carried by the **existing**
`frontend/src/lib/no-firestore.spec.ts`, which scans the whole tree and needs no edit; it is
listed under T6/T8 because those are the tasks that would break it.

## Firestore rules changes

One new block, verbatim from the PRD:

```
// --- chat messages ------------------------------------------------
// A subcollection of a project, so both the owner's uid and the
// project id are part of the document path and the API scopes by the
// uid from the token alone. Written only by
// POST /api/projects/:projectId/messages, which assigns `role` itself
// — a client that could write here could author an assistant turn,
// which from Slice 5 on is the LLM's own context.
match /users/{uid}/projects/{projectId}/messages/{messageId} {
  allow read, write: if false;
}
```

Rules do not cascade into subcollections, so neither `match /users/{uid}` nor
`match /users/{uid}/projects/{projectId}` says anything about this path — the block is required,
not decorative, and the L3 cases are what would catch a later rule that granted a parent
recursively.

L3 tests (`tests/rules/firestore.spec.ts`), all `assertFails`, seeded with
`withSecurityRulesDisabled` so update and delete have a document to be denied on:

| Case | Client | Operations |
|---|---|---|
| The owner, verified — the most privileged client there is | `verified('alice')` | `getDoc`, `getDocs` on the collection, `setDoc`, `updateDoc`, `deleteDoc` |
| A different verified user | `verified('mallory')` | the same five, on alice's path |
| Anonymous | `unauthenticatedContext()` | `getDoc`, `getDocs`, `setDoc` |
| AC-18 re-assertion | existing describes | `users/{uid}`, `users/{uid}/projects/{projectId}`, `hlConnections/{uid}`, `authThrottle/{key}` — unchanged, re-run |

The payload for the denied writes is exactly what `handleCreateMessage` writes
(`{ role, content, seq, createdAt }`), so the denial is on the rule and not on the shape.

## Dependencies

**No new packages.** All six shadcn-vue blocks are vendored source over `reka-ui` 2.10.3,
`class-variance-authority` 0.7.1 and `clsx` 2.1.1 — every one already in
`frontend/package.json`. `@vueuse/core` 14.4.0 is already a dependency (`Input.vue`,
`DialogContent.vue` use it) and supplies `useMediaQuery`. `git diff frontend/package.json`
being empty after T9 is a check, not a hope.

## Manual verification

```bash
npm run dev          # emulators + SPA against them, one command
```

1. Sign up, verify through the emulator link, land on `/dashboard`.
2. Create a project called **Contact dashboard**. Click its **name** — the row itself does
   nothing, only the name navigates.
3. Land on `/projects/<id>`. Header: the project name, **Back to dashboard**, and a
   **Not connected** badge (no HighLevel connection yet). Three panels side by side; drag the
   splitters.
4. Type `build a contact dashboard`, press **Enter**. Two bubbles appear, prompt above echo,
   each with a time. Press **Shift+Enter** in the composer — a newline, no request.
5. Reload. Both messages are still there, in the same order.
6. Narrow the window below 1024px. Tabs appear — Chat, Code, Preview, Chat selected. Type into
   the composer, widen past 1024px again: the text is still there (D17).
7. Open devtools → Network. Every call is `/api/projects/<id>/messages`; there is no Firestore
   channel. `Ctrl-F` the source panel for `firestore` and find nothing.
8. Delete the project from the dashboard in a second tab, then send in the first: the composer
   shows "That project no longer exists."
9. Connect HighLevel from the dashboard, create a *new* project, open it — the badge reads
   **HighLevel connected** (existing projects keep the `locationId` they were created with).

## Estimate

| Task | Estimate |
|---|---|
| T1 — Message schemas | 45m |
| T2 — Export project-access helpers | 10m |
| T3 — `GET` messages | 1h 30m |
| T4 — `POST` messages | 1h 30m |
| T5 — Rules and index | 45m |
| T6 — Messages client | 30m |
| T7 — `formatTime` | 20m |
| T8 — Workspace store | 1h 15m |
| T9 — Vendor six shadcn-vue blocks | 45m |
| T10 — `MessageComposer` | 1h |
| T11 — `ChatPanel` | 1h 15m |
| T12 — Editor/Preview placeholders | 15m |
| T13 — `WorkspaceView`, route, app shell | 1h 45m |
| T14 — Dashboard link | 30m |
| T15 — E2E | 45m |
| T16 — Documentation | 20m |
| **Total** | **≈ 13h** |

Nothing exceeds half a day. The two to watch are **T13** (a new view, a route, a guard type and
the app shell in one commit — and the only place `matchMedia` has to be stubbed) and **T9**,
which is short if the CLI behaves and unbounded if the generated code fights
`strictTypeChecked`. T3 and T4 are large in test count rather than in difficulty.

## Open risks carried from the PRD

R1 (the batch timestamp tie) is answered twice — T3's L1 query assertion and T4's L4 round trip.
R2 (the invisible index) is answered by T5's same-commit rule and a review reading, because no
test at any level can see it. R4 (slice size) is answered by the build order above: T1–T5 are
the whole security boundary and land before a component exists.
