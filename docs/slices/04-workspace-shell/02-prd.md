# Slice 04 — Workspace shell & chat persistence · PRD

**Spec:** F6.1, F6.2, F3.4 (partial) · **Branch:** `slice/04-workspace-shell` · **Depends on:** 3 · **Date:** 2026-08-17

## Problem

A user can create a project, rename it and throw it away — and then there is nowhere to go.
The dashboard rows are deliberately not links (Slice 3, D12), because the screen they would
point at does not exist. Genesis is an app builder with no place to build.

This slice puts up the room the rest of the product happens in: the three-panel workspace
the brief names (chat · editor · preview), and the one panel of the three that carries real
behaviour today — a chat with a persisted transcript. The assistant is a stub that echoes.
That is the point: the layout and the persistence model get reviewed on their own, before
Slice 5 lands an SSE stream on top of them and every question about ordering, liveness and
state becomes a question about streaming instead.

## The demo

Click a project on the dashboard, land in the three-panel workspace, type "build a contact
dashboard", watch it appear beside an echoed reply, reload the page, and find both still
there — every read and write over `/api/projects/:projectId/messages`, with
`firestore.rules` denying the browser the collection outright.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below
was answered from `PRODUCT_SPEC.md` §4 (F6.1, F6.2, F3.4) and §7.2, `IMPLEMENTATION_PLAN.md`
§4 (Slices 4 and 5) and §8, `CLAUDE.md`'s non-negotiables, and the merged code of Slices 1,
2, 2b and 3. Load-bearing decisions carry the alternative that was rejected, because a
decision with no rejected alternative was not a decision.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | What is the workspace's route? | **`/projects/:projectId`**, access class `protected`. | Routes name the resource. `CLAUDE.md`'s rule bans a *user* identifier in a path, not a resource id, and `:projectId` is already checked for ownership on the server by construction. Rejected: `/workspace/:projectId`, which names a piece of UI rather than the thing being worked on, and would have to be renamed the moment a second view of a project exists; and `/projects/:projectId/chat`, which puts a panel in the URL that this slice would then owe a `/editor` and a `/preview` to match. |
| D2 | Where do chat messages live? | **`users/{uid}/projects/{projectId}/messages/{messageId}`.** | The same argument as Slice 3's D1, one level deeper: ownership is **structural**, not procedural. The uid segment is always the one `withVerifiedUser` read off the ID token, so another user's transcript is not addressable by a request rather than merely refused, and there is no `ownerUid` equality check anywhere for a later slice to copy without. Rejected: a top-level `messages` collection carrying `ownerUid` and `projectId`, which needs two `where` clauses to be right and is one forgotten clause away from a cross-tenant read. |
| D3 | Which routes? | **Two.** `GET /api/projects/:projectId/messages`, `POST /api/projects/:projectId/messages`. | F6.2 asks for history and input, F3.4 for persistence. Nothing in this slice edits or deletes a message (D13), so there is no `PATCH` and no `DELETE`. `/api/projects/**` was reserved for exactly this in Slice 3. |
| D4 | Do the routes live on `projectsRouter` or their own? | **Their own — `functions/src/messages/`, mounted at `/` and `/api` like every other router.** | One module per collection, matching `functions/src/{auth,hl,users,projects}/`. Slice 3 reserved the *URL* namespace, not the module; keeping the file a reviewer opens to answer "who can write a message" small is worth more than co-locating by path prefix. |
| D5 | Who authors an assistant message? | **The server, always.** The `POST` body carries `content` and nothing else; `role` is assigned server-side and a body containing one is a 400 under `.strict()`. | This is the load-bearing security decision of the slice, and it is a Slice 5 decision taken early: from Slice 5 on, **the transcript is the LLM's context**. A client that can author an assistant turn can write its own future context — self-service prompt injection, from the browser, into a prompt that also carries HighLevel API knowledge and the user's project files. It is also what makes the transcript trustworthy as a record of what was actually generated. Rejected: `{ role, content }` in the body, which is the shape every chat tutorial uses and the reason this needed deciding rather than defaulting. |
| D6 | Where does the stub reply come from, and when is it written? | **The same request.** `POST` validates, writes **both** messages in one `WriteBatch`, and responds `201 { messages: [user, assistant] }`. | One round trip, one write path, and the pair is atomic — a user message can never be stranded without its reply. **This contract changes in Slice 5**, and knowingly: the assistant write moves to the stream's `done` handler, the user-message write stays exactly here, and the response becomes the user message alone. Recorded so that change reads as planned rather than as churn. Rejected: two client calls (a partial transcript is visible between them, and the client decides when the assistant speaks); a separate `/echo` route (a route that exists only to be deleted in Slice 5). |
| D7 | What is the echo? | **`You said: <content>`**, deterministic, no LLM, no randomness. | It has to be assertable byte-for-byte in a test and obviously not intelligence when a human looks at it. The chat panel says so out loud with an `Echo mode` badge (D19), and both disappear together in Slice 5. |
| D8 | How is the transcript ordered? | **`createdAt` ASC, tie-broken by `seq` ASC** — where `seq` is the message's index within the write that created it (`0` user, `1` assistant). | **This is the slice's one real hazard.** A Firestore `WriteBatch` resolves every `serverTimestamp()` sentinel in it to the *same* commit timestamp, so the two messages of a turn are not nearly tied — they are exactly tied, on every single turn. Firestore then breaks the tie by document name, and a document name here is a random auto-id: the echo renders above the prompt roughly half the time. `seq` puts the intended order ahead of that implicit tiebreak. Across separate requests the commit timestamps genuinely differ, so `seq` costs nothing when Slice 5 writes the assistant message in a request of its own. Rejected: a monotonic per-project counter in a transaction — exactly correct, and it buys a contended counter and a transaction on every turn forever, to order a collection that only ever appends. Rejected: deriving the assistant's timestamp as the user's plus a millisecond, which is inventing clock values on the server. Rejected, and it was the tempting one: **one "turn" document holding prompt and reply together**, which dissolves the tie completely — it fails on Slice 5, where the assistant message is written separately from a stream and a turn can end in an error with no reply at all. |
| D9 | Does the transcript need a composite index? | **Yes** — `messages` collection-scope, `createdAt` ASC + `seq` ASC, declared in `firestore.indexes.json`. | A two-field `orderBy` is a composite query. **The Firestore emulator serves any query without an index**, so no test at any level can catch this missing — it fails only in production, on the first workspace load after deploy. Declaring it is the whole mitigation, and it gets a line in the definition of done rather than a test. Slice 3's R2, second occurrence. |
| D10 | Is the transcript paginated? | **No. It is capped at 200 messages per project — 100 exchanges — and the list returns all of them.** A `POST` whose pair would cross the cap is `409 message_limit`. | Slice 3's D8 honesty rule, applied unchanged: an unpaginated list is only honest if it cannot truncate. Rejected: returning the most recent 200 of an unbounded history, which silently hides messages the user can remember writing; rejected: cursors and infinite scroll, which is real surface area for a five-day build whose demo is one conversation. The cap is a product limit the UI states, not a hidden truncation — at the cap the composer disables itself and says why (AC-32). Slice 5's bounded-context budget is a *different* limit and does not replace this one. |
| D11 | Message field limits? | **`content` 1–4,000 characters after trimming**, required. Empty-after-trim is `400 invalid_body`. | Four thousand characters is about a page of prose, which is what a considered prompt looks like. Enforced in the Zod schema at the boundary, not in the composer — the composer is not the boundary. The *stored* schema carries no maximum, because the echo of a 4,000-character prompt is longer than one and a stored document is not a request body. |
| D12 | How does the transcript stay current after a send? | **The store appends the two messages the server returned.** No refetch. | This deviates from Slice 3's D14 and the deviation is the point. D14 rejected splicing because the projects list is ordered by `updatedAt` on the server, so a local edit had to re-derive server ordering and would eventually get it wrong. A transcript cannot be reordered: it only ever appends, and the pair the server just returned is by construction its two newest members — appending *is* the server's order, not an approximation of it. Refetching instead would re-read the whole history on every turn, which grows without bound while the thing it re-reads cannot have changed. This is not `onSnapshot` and does not weaken `CLAUDE.md`'s liveness rule: the state rendered is the server's own response body. It is also the shape Slice 5 needs — a streamed reply accumulates into a placeholder appended at the end. |
| D13 | Can a message be edited, deleted, or the history cleared? | **No.** The collection is append-only. | F6.2 asks for history and an input. An edit surface on a transcript that is about to become an LLM's context is a decision with real consequences (does editing a past turn re-run the generation?) and it belongs with F10.1's iterative refinement if it is ever wanted. Recorded as out of scope. |
| D14 | What do the message routes do for a project that is absent, soft-deleted, or unreadable? | **404 `not_found`**, on both, by reusing Slice 3's `readProject`. | The three collapse into one answer there and must collapse into the same one here, or "gone" means two different things one path segment apart. Slice 3's `readProject` is exported for this rather than reimplemented — a second copy is how the two drift. |
| D15 | Does posting a message advance the project's `updatedAt`? | **No.** | `updatedAt` means "the project's own fields changed", which is what the dashboard's ordering and its "Updated" line both claim. Making a message write touch the project document would silently redefine both, and add a second document to a write that is otherwise atomic in one collection. Rejected: ordering the dashboard by recency of activity, which is a nicer list and a different feature. |
| D16 | Responsive behaviour of the three panels? | **At ≥1024px (`lg`), three resizable panels side by side. Below it, one panel at a time, chosen by shadcn-vue `tabs` — Chat · Code · Preview, Chat selected by default.** | Three panels sharing a 390px viewport are three unusable panels. `tabs` is a component the brief names explicitly and this is its honest use, rather than inventing a tabbed surface to justify vendoring one. Rejected: desktop-only, which is a screenshot in the Loom and a broken page for anyone who opens the deployed URL on a phone; rejected: stacking the three vertically, which makes every panel a third of a screen tall and the editor unusable in Slice 7. |
| D17 | The breakpoint swaps one component tree for another. What happens to what the user has typed? | **The draft lives in the workspace store, not in the composer.** | Crossing the breakpoint unmounts one layout and mounts the other. A draft held in component state is eaten by a window resize — the kind of thing that is invisible in review and infuriating in use. One `ref` in a store that already exists. |
| D18 | Are the editor and preview panels real in this slice? | **No — labelled placeholders**, each naming the slice that fills it (files and editor: 6 and 7; preview: 10). | They are structure, not screens: they have no request, no data and no failure mode, so the loading/empty/error rule has nothing to attach to. The rule applies in full to the workspace route and to the chat panel, which do have all three. |
| D19 | Where does `badge` go? | **Twice, both real UI.** `Echo mode` in the chat panel header, and the project's HighLevel connection state in the workspace header — `HighLevel connected` when `project.locationId` is set, `Not connected` when it is `null`. | Both say something a user needs and neither is decoration. The connection badge is also the **first thing in the product to read the `locationId` Slice 3 stores**, which until now was a field written and never used — and it sets up Slice 10, where "connected" is the difference between real CRM data in the preview and an empty one. |
| D20 | The remaining primitives? | **`scroll-area`** wraps the transcript, **`separator`** rules the workspace header off from the panels and the chat header off from the transcript, **`resizable`** is the three-panel splitter. All via `npx shadcn-vue@latest add <name>`. | The brief's "layout primitives" line, discharged. All three are shadcn-vue wrappers over `reka-ui` primitives (`ScrollArea*`, `Separator`, `Splitter*`) that are already installed at 2.10.3, so no runtime dependency is added by any of them. |
| D21 | What is the composer's input control? | **A vendored shadcn-vue `textarea`** — a sixth component, beyond the five `IMPLEMENTATION_PLAN.md` §4 names for this slice. **Enter sends; Shift+Enter inserts a newline.** | "Build a contact dashboard with search and a list of upcoming appointments" does not belong in a single-line `Input`. `textarea` is an input primitive in the same family as the ones the brief lists, and it is added by the CLI like every other one so its provenance stays diffable against upstream. Recorded here because the plan's Libraries line did not name it, and `PRODUCT_SPEC.md` §7.2's rule is that a departure is recorded rather than decided at the keyboard. |
| D22 | The app shell centres `main` at `max-w-5xl` with vertical padding. The workspace needs the whole window. | **Routes declare `meta.layout`.** `'contained'` is the default and unchanged; the workspace declares `'full'`, and `App.vue` becomes a flex column — header `shrink-0`, `main` `flex-1 min-h-0` with no max width and no padding. | The panels need a *bounded* height to scroll inside, and a flex column gives them one without a `calc()` that hard-codes the header's height and breaks the first time the header gains a line. Rejected: breaking out of the container from inside the view with negative margins, which is a lie about who owns the layout and leaves the container's padding in the scroll height. |
| D23 | Do dashboard project rows become links? | **Yes — the project name becomes a `RouterLink` to `/projects/:id`.** Rename and Delete stay buttons. | Slice 3's D12: "the moment one becomes a link, Slice 4 has started." It has. The name is the link and the row is not, so the two destructive actions cannot be hit by a mis-aimed tap on a row. |
| D24 | One store or two for the workspace? | **One — `useWorkspaceStore`**, holding the project, the transcript, the draft and their states. | The project and its transcript share one lifecycle: same `projectId`, loaded together, reset together. Two stores that must be reset in lockstep is a bug with a countdown on it. Rejected: a `messages` store beside a `workspace` store; also rejected: a transcript cache keyed by project id, which is a cache with no invalidation rule for a screen reached one project at a time. |
| D25 | Does the workspace load the project and the transcript in parallel? | **No — sequentially.** The project is fetched first; the transcript only if it resolves. | The 404 case is the reason. Fetched in parallel, a deleted project produces two 404s and the view has to decide which one it is rendering; fetched in sequence there is one answer, and no request is issued for a transcript that cannot exist. The cost is one extra round trip to the same region on the happy path, which is the cheaper of the two prices. |
| D26 | Does the workspace read the project from the projects store? | **No — it fetches `GET /api/projects/:projectId` itself.** | A deep link, a reload, or a bookmark arrives with an empty store. A store that is populated only when you came from the dashboard is worse than one that never is, because only one of those two gets tested. The route already exists (Slice 3, AC-5); no new endpoint is needed. |
| D27 | How does a corrupt stored message read? | **Fail closed.** It is omitted from the transcript and `message.unreadable` is logged, carrying no field of the document. | Slice 3's D20 and the `readProfile` / `handleGetConnection` precedent. There is no by-id read of a message, so omission is the whole behaviour. A message with an unrecognised `role` is unreadable by the same rule — a bubble that is neither the user's nor the assistant's has no side of the transcript to sit on. |
| D28 | App Check? | **On `POST`, not on `GET`.** | One rule for the whole API, unchanged since Slice 2: mutations are attested, plain authenticated reads are not. As in Slice 3, `requireAppCheck` short-circuits under the emulator, so which routes carry it is verified by reading the router, and the plan says so rather than pretending otherwise. |
| D29 | How are message times rendered? | **`formatTime(iso)` added beside `formatDay` in `frontend/src/lib/date.ts`** — `en-GB`, UTC, `HH:mm`, `null` for anything that does not parse. | Same pinning, same reason, same failure behaviour as `formatDay`: a rendered time that depends on the machine makes two users disagree and an assertion machine-dependent. A message whose timestamp will not parse renders without a time rather than with "Invalid Date"; its content is what matters. |
| D30 | Is this one reviewable PR? | **Yes, and it is the largest so far — larger than Slice 3.** Two routes in one new functions module, one rules block, one index entry, six vendored shadcn-vue blocks, one route, one view, four components, one store, one typed client, an app-shell change and a dashboard change, plus tests. | Checked deliberately, and the mitigation is build order rather than optimism: the boundary ships first — schemas, then routes, then rules — so the security-relevant half is reviewable before a single component exists. What would have pushed it over is named out of scope below: no streaming, no LLM, no files, no editor, no preview, no message editing, no pagination, no panel-size persistence. The six vendored blocks are ~600 lines of upstream code that is diffable rather than read. |

## In scope

- `functions/src/messages/` — router, handlers, and the schemas for the body, the stored
  document and the wire shape
- `GET /api/projects/:projectId/messages` — the project's transcript, chronological, capped
  at 200
- `POST /api/projects/:projectId/messages` — attested; writes the user turn and the stub
  reply in one batch and returns both
- `functions/src/projects/handlers.ts` — `readProject` exported so the message routes reuse
  the one definition of "this project is gone" (D14)
- `firestore.rules` — `users/{uid}/projects/{projectId}/messages/{messageId}` deny-all, with
  L3 tests
- `firestore.indexes.json` — the `createdAt` + `seq` composite index
- `frontend/src/lib/messagesApi.ts` — typed client over `apiClient.request`
- `frontend/src/lib/date.ts` — `formatTime` beside `formatDay`
- `frontend/src/stores/workspace.ts` — project, transcript, draft, send, four states
- `frontend/src/views/WorkspaceView.vue` — loading, not-found, error and the panel layout,
  including the `lg` switch between `resizable` and `tabs`
- `frontend/src/components/workspace/ChatPanel.vue` — header, transcript, loading, empty and
  error states
- `frontend/src/components/workspace/MessageComposer.vue` — textarea, Enter-to-send, disabled
  and at-limit states, send error
- `frontend/src/components/workspace/EditorPanel.vue`, `PreviewPanel.vue` — labelled
  placeholders (D18)
- `frontend/src/components/ui/{tabs,badge,resizable,scroll-area,separator,textarea}/` —
  vendored via the shadcn-vue CLI
- `frontend/src/router/index.ts` — the `/projects/:projectId` route and `meta.layout`
- `frontend/src/router/guard.ts` — `RouteLayout` added to the `RouteMeta` declaration
- `frontend/src/App.vue` — the flex shell and the contained/full switch (D22)
- `frontend/src/components/ProjectsCard.vue` — the project name becomes a link (D23)

## Out of scope

| Not here | Picked up by |
|---|---|
| Any LLM call, any streaming, any SSE client (the assistant is a stub, D7) | Slice 5 |
| A "generating…" state, token accumulation, stream interruption | Slice 5 |
| Files, a file tree, a real editor, Monaco (D18) | Slices 6 and 7 |
| A real preview, an iframe, a runtime shim (D18) | Slice 10 |
| Editing, deleting or clearing messages (D13) | Not planned; the nearest relative is F10.1 |
| Pagination, infinite scroll, or trimming the transcript (D10) | Not planned. The cap makes the flat transcript honest |
| Persisting panel sizes across visits (D17 persists the draft, not the layout) | Not planned |
| Ordering the dashboard by chat activity (D15) | Not planned |
| Making a whole project row clickable (D23 links the name only) | Not planned |
| Markdown or code-block rendering inside a message | Slice 6, where the assistant's output actually contains code |
| A per-project HighLevel location picker behind the connection badge (D19) | Not planned; Slice 3's D9 fixes `locationId` at create |

## User flow

1. On `/dashboard`, a project's name is now a link. Clicking it navigates to
   `/projects/<id>`.
2. The workspace shows its **loading** state while `GET /api/projects/:projectId` is in
   flight — a header skeleton and three empty panels.
3. On 404 it shows **"That project no longer exists."** with a **Back to dashboard** link and
   issues no transcript request. On any other failure it shows the server's message with a
   **Try again** button.
4. On success the header shows the project name, a **Back to dashboard** link, and a badge
   reading `HighLevel connected` or `Not connected`. Below a `separator`, three panels:
   **Chat**, **Code** and **Preview**, resizable at ≥1024px and tabbed below it.
5. The chat panel shows its **loading** state while
   `GET /api/projects/:projectId/messages` is in flight, then its **empty** state — "No
   messages yet. Describe the app you want." — or the transcript. A failed transcript request
   shows the server's message with a **Try again** button; the rest of the workspace is
   unaffected.
6. The composer is a textarea. Submit is disabled while it is empty or whitespace, and while
   a send is in flight. **Enter** sends; **Shift+Enter** inserts a newline.
7. Submitting issues `POST /api/projects/:projectId/messages`. On 201 the two returned
   messages are appended, the draft clears, and the transcript scrolls to the bottom.
8. If the send fails, nothing is appended, the draft keeps its text, and the error renders
   under the composer. Sending again retries it.
9. At 200 stored messages the composer disables itself and says the project has reached its
   message limit.
10. Reloading the page re-fetches the project and the transcript; everything is still there.

## Data model

**`users/{uid}/projects/{projectId}/messages/{messageId}`** — a subcollection of a project,
which is itself a subcollection of the profile (D2). Written and read only by the Admin SDK
inside `/api/projects/:projectId/messages`; no client may read or write it.

| Field | Type | Note |
|---|---|---|
| `role` | `'user' \| 'assistant'` | server-assigned, never from the body (D5) |
| `content` | string | 1–4,000 chars trimmed on the way in; no maximum on the stored schema (D11) |
| `seq` | number | index within the write that created it — `0` user, `1` assistant (D8) |
| `createdAt` | Timestamp | server clock, written once; messages are immutable (D13) |

`messageId` is a Firestore auto-id.

**Wire shape** (`Message`): `{ id: string, role: 'user' | 'assistant', content: string,
createdAt: string }` — timestamp ISO-8601, the project's convention since Slice 2.
**`seq` never crosses the wire**: it is an ordering mechanism the server owns, and the array
it produces is already in order.

**Rules change.** One new block, matching the file's existing shape — every match block is a
denial and every one has an L3 test:

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
`match /users/{uid}/projects/{projectId}` says anything about this path. The block is
required, not decorative.

**Index.** `firestore.indexes.json` gains one entry (D9):

```json
{
  "collectionGroup": "messages",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "createdAt", "order": "ASCENDING" },
    { "fieldPath": "seq", "order": "ASCENDING" }
  ]
}
```

## API contracts

Both routes are mounted on the existing `api` function at both `/` and `/api` (the emulator
strips the function name, a Hosting rewrite does not), and both go through
`withVerifiedUser` — ID token **and** `email_verified`, Slice 1's D26. Every error body is
the existing envelope: `{ "error": "<user-facing message>", "code": "<machine code>" }`.

Errors shared by both routes: **401** `unauthenticated`, **403** `email_unverified`,
**400** `invalid_id` for a `:projectId` outside `[A-Za-z0-9_-]{1,64}`, and **404**
`not_found` for a project that is absent, soft-deleted, unreadable, or another user's —
which are indistinguishable by construction (Slice 3, D15).

### `GET /api/projects/:projectId/messages`

Auth: ID token. App Check: no.

- **200** → `{ "messages": [ { "id": "…", "role": "user", "content": "build a contact
  dashboard", "createdAt": "2026-08-17T…Z" }, { "id": "…", "role": "assistant", "content":
  "You said: build a contact dashboard", "createdAt": "2026-08-17T…Z" } ] }` — chronological,
  at most 200, unreadable documents omitted
- **200** → `{ "messages": [] }` when there are none
- **400** `invalid_id` · **404** `not_found`

### `POST /api/projects/:projectId/messages`

Auth: ID token. App Check: **required**.

Request body, `.strict()`: `{ "content": string }`.

- **201** → `{ "messages": [ <user message>, <assistant message> ] }` — exactly two, in that
  order
- **400** `invalid_body` — unknown key (including `role`, `id`, `seq`, `createdAt`), missing
  `content`, `content` blank after trimming, `content` over 4,000 characters, or a wrong type
- **400** `invalid_id` · **404** `not_found`
- **409** `message_limit` — storing the pair would take the project past 200 messages (D10)

## Edge cases and failure modes

| Situation | Behaviour | User sees | Retry? |
|---|---|---|---|
| Project has no messages | `GET` → `{ messages: [] }` | Chat empty state and an enabled composer | n/a |
| Project fetch 404s (deleted in another tab, or a bad id in the URL) | View renders not-found; **no transcript request is issued** (D25) | "That project no longer exists." and **Back to dashboard** | n/a |
| Project fetch fails otherwise (401, 500, network) | View renders its error state | The server's message and **Try again** | Retry button |
| Transcript request fails | Chat panel renders its error state; header, badges and the other two panels are unaffected | The server's message and **Try again** inside the chat panel | Retry button |
| Send fails (400, 404, 409, network) | Nothing appended, draft retained, `sendError` set | Message under the composer, text still in it | Re-submit |
| Project deleted while the workspace is open, then a send | 404 `not_found` | "That project no longer exists." under the composer | n/a |
| Blank or whitespace-only content | Submit disabled in the composer; the server answers 400 if it arrives anyway | Disabled button | n/a |
| Content over 4,000 characters | 400 `invalid_body` with Zod's message naming the field | Message under the composer | Edit and re-submit |
| Project already holds 200 messages | 409 `message_limit`, nothing written; the composer is already disabled | "This project has reached its limit of 200 messages." | n/a |
| Body carries `role`, `id`, `seq` or `createdAt` | 400 `invalid_body`; nothing written | n/a — no UI sends one | n/a |
| Transcript of another account's project | 404 — the path names nothing that exists | "That project no longer exists." | n/a |
| Malformed `:projectId` (`..`, over 64 chars, illegal characters) | 400 `invalid_id` **before** any Firestore call | n/a — no UI produces one | n/a |
| A user turn and its echo share a commit timestamp | `seq` breaks the tie; the prompt is always above the reply (D8) | A transcript that reads in the order it happened | n/a |
| Stored message fails to parse, or has an unknown `role` | Omitted from the transcript; `message.unreadable` logged | A shorter transcript, no broken bubble | n/a |
| Stored `createdAt` will not parse into a date | `formatTime` returns `null`; the bubble renders without a time | The message, no timestamp line | n/a |
| Window crosses the 1024px breakpoint mid-draft | The layout tree swaps; the draft is in the store (D17) | The same text, in the other layout | n/a |
| No token / expired token | 401 `unauthenticated` | Workspace error state; the router guard handles a genuinely dead session | Retry |
| Verified in Auth but stale token claim | 403 `email_unverified` | "Verify your email address first." | Retry after a token refresh |
| Network failure | `ApiError` with status 0 | "Check your connection and try again." | Retry |
| A client tries the collection directly | Denied by `firestore.rules`, and the frontend has no Firestore SDK to try it with | n/a | n/a |

## Acceptance criteria

**Routes — the happy path**

- **AC-1** — Given a verified caller who owns a project, when they
  `POST /api/projects/:projectId/messages` with `{ "content": "build a contact dashboard" }`,
  then the response is 201 with exactly two messages — `role: "user"` carrying the trimmed
  content, then `role: "assistant"` carrying `You said: build a contact dashboard` — and two
  documents exist under `users/{uid}/projects/{projectId}/messages` with `seq` `0` and `1`.
- **AC-2** — Given a project with one exchange stored, when the caller `GET`s its messages,
  then the response is 200 with the user message **before** the assistant message, each in
  the wire shape, and neither carrying a `seq` field.
- **AC-3** — Given a project with several exchanges written in separate requests, when the
  caller `GET`s its messages, then they are returned oldest-first across turns as well as
  within them.
- **AC-4** — Given a project with no messages, when the caller `GET`s them, then the response
  is 200 `{ "messages": [] }` — not 404.
- **AC-5** — Given a `POST` whose `content` has leading and trailing whitespace, when it is
  accepted, then the stored and returned content is trimmed, and the echo quotes the trimmed
  form.

**Routes — the boundary**

- **AC-6** — Given a request with no `Authorization` header, when it hits either route, then
  the response is 401 `unauthenticated` and no document is created.
- **AC-7** — Given a valid ID token whose `email_verified` claim is false, when it hits either
  route, then the response is 403 `email_unverified` and nothing is written.
- **AC-8** — Given verified users alice and bob, and given bob owns a project with messages,
  when alice `GET`s and `POST`s that project id with her own token, then both answer 404
  `not_found` and bob's transcript is unchanged.
- **AC-9** — Given a soft-deleted project, and given a project id that never existed, when
  the owner `GET`s or `POST`s messages on either, then the response is 404 `not_found` and
  nothing is written.
- **AC-10** — Given a `:projectId` of `..`, one of 65 characters, or one containing a
  character outside `[A-Za-z0-9_-]`, when it reaches either route, then the response is 400
  `invalid_id` and no Firestore read or write is attempted.
- **AC-11** — Given a `POST` body carrying any key outside its schema — specifically `role`,
  `id`, `seq` and `createdAt` — then the response is 400 `invalid_body` and no document is
  created. In particular a body of `{ "role": "assistant", "content": "…" }` is refused, so
  a client cannot author an assistant turn.
- **AC-12** — Given `content` that is missing, empty, whitespace-only, longer than 4,000
  characters, or not a string, when it reaches `POST`, then the response is 400
  `invalid_body` and no document is created.
- **AC-13** — Given a project already holding 200 messages, when the owner `POST`s, then the
  response is 409 `message_limit` and no document is created; given 198, then the `POST`
  succeeds and the project holds 200.
- **AC-14** — Given a project, when a message is posted to it, then the project document's
  `updatedAt` is byte-identical to what it was before.
- **AC-15** — Given a stored message document that fails to parse — a missing `content`, a
  missing `createdAt`, or a `role` outside `user`/`assistant` — when the owner `GET`s the
  transcript, then it is omitted and a `message.unreadable` event is logged carrying no field
  of the document.

**Rules — the backstop**

- **AC-16** — Given a verified owner using the Firestore client SDK, when they read, list,
  create, update or delete `users/{uid}/projects/{projectId}/messages/{messageId}`, then
  every operation is denied.
- **AC-17** — Given a different signed-in user, and given an unauthenticated client, when
  either reads or writes that path, then it is denied.
- **AC-18** — Given any client, when it reads or writes `users/{uid}`,
  `users/{uid}/projects/{projectId}`, `hlConnections/{uid}` or `authThrottle/{key}`, then it
  is denied — re-asserted, since the rules file changed.

**Frontend — the workspace route**

- **AC-19** — Given the dashboard has rendered a project, when the card renders, then the
  project's name is a link whose target is `/projects/<that project's id>`, and Rename and
  Delete are still buttons.
- **AC-20** — Given the project request is in flight, when the workspace renders, then it
  shows its loading state and no panels.
- **AC-21** — Given the project request rejects with 404, when the workspace renders, then
  it shows "That project no longer exists." with a link to `/dashboard`, and **no transcript
  request is issued**.
- **AC-22** — Given the project request rejects with any other status, when the workspace
  renders, then it shows the server's message with a **Try again** button that re-issues
  `GET /api/projects/:projectId`.
- **AC-23** — Given the project resolves, when the workspace renders at a viewport of
  1024px or wider, then all three panels — chat, code and preview — are present at once, and
  the editor and preview panels each name the slice that fills them.
- **AC-24** — Given the project resolves, when the workspace renders below 1024px, then one
  panel is shown at a time behind a tab list of Chat, Code and Preview, with Chat selected;
  selecting Preview shows the preview panel and hides the chat panel.
- **AC-25** — Given text has been typed into the composer, when the layout switches between
  the resizable and tabbed trees, then the composer still holds that text.
- **AC-26** — Given a project whose `locationId` is set, when the workspace header renders,
  then a badge reads `HighLevel connected`; given `locationId` is `null`, then it reads
  `Not connected`.

**Frontend — the chat panel**

- **AC-27** — Given the transcript request is in flight, when the chat panel renders, then it
  shows its loading state and no messages.
- **AC-28** — Given the transcript resolves empty, when the chat panel renders, then it shows
  its empty state, the composer is enabled, and no error is shown.
- **AC-29** — Given the transcript resolves with messages, when the chat panel renders, then
  there is one bubble per message, user and assistant bubbles are distinguishable, each
  carries its content and a time derived from `createdAt`, and a message whose `createdAt`
  will not parse renders its content with no time.
- **AC-30** — Given the transcript request rejects, when the chat panel renders, then it
  shows the server's message with a **Try again** button that re-issues the transcript
  request, while the workspace header and the other two panels remain rendered.
- **AC-31** — Given the composer is empty or holds only whitespace, when it renders, then
  submit is disabled and pressing Enter issues no request; given it holds text, when Enter is
  pressed, then `POST /api/projects/:projectId/messages` is issued once, the two returned
  messages are appended to the transcript, the draft clears, and **no `GET` of the transcript
  is issued** (D12).
- **AC-32** — Given the transcript holds 200 messages, when the composer renders, then it is
  disabled and states the limit.
- **AC-33** — Given Shift+Enter is pressed in the composer, then no request is issued and the
  draft is not cleared.
- **AC-34** — Given the send request rejects, when the composer re-renders, then it shows the
  server's message, keeps the draft, appends nothing to the transcript, and re-submitting
  issues the request again.
- **AC-35** — Given messages are appended to the transcript, when the chat panel updates,
  then the scroll viewport's `scrollTop` equals its `scrollHeight` — the newest message is
  what is in view.
- **AC-36** — Given any workspace store call, when it issues its request, then the request
  carries an `Authorization: Bearer` header and an App Check header, and no
  `firebase/firestore` import exists anywhere under `frontend/src`.

**End to end**

- **AC-37** — Given a verified account with a project, when the user clicks the project on
  the dashboard, sends "build a contact dashboard", sees the echoed reply, and reloads the
  page, then both messages are still on screen in that order — and navigating back to the
  dashboard and into the project again shows them too.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L4 | `tests/integration/messages.spec.ts` | `POST` returns the pair, 201, and stores two documents with `seq` 0 and 1 |
| AC-2 | L4 | `tests/integration/messages.spec.ts` | User before assistant for a batch-written pair; wire shape carries no `seq` |
| AC-2 | L1 | `functions/src/messages/handlers.spec.ts` | The tie case in isolation: equal `createdAt`, ordered by `seq` |
| AC-3 | L4 | `tests/integration/messages.spec.ts` | Three turns in separate requests come back oldest-first |
| AC-4 | L4 | `tests/integration/messages.spec.ts` | Empty transcript is 200 `{ messages: [] }` |
| AC-5 | L4 | `tests/integration/messages.spec.ts` | Content trimmed on the wire and in the store; the echo quotes the trimmed form |
| AC-5 | L1 | `functions/src/messages/handlers.spec.ts` | `echoFor()` is exactly `You said: <content>` |
| AC-6 | L4 | `tests/integration/messages.spec.ts` | Both routes, no header → 401 |
| AC-7 | L4 | `tests/integration/messages.spec.ts` | Both routes, unverified token → 403 |
| AC-8 | L4 | `tests/integration/messages.spec.ts` | Cross-tenant: alice cannot read or write bob's transcript; his is unchanged |
| AC-9 | L4 | `tests/integration/messages.spec.ts` | Soft-deleted and never-existed project ids → 404 on both routes |
| AC-10 | L4 | `tests/integration/messages.spec.ts` | Malformed `:projectId` → 400 `invalid_id` |
| AC-10, AC-11, AC-12 | L1 | `functions/src/messages/schema.spec.ts` | `.strict()` body schema: `role` and the other forbidden keys, blank, over-length, wrong type |
| AC-11, AC-12 | L4 | `tests/integration/messages.spec.ts` | The same refusals over the wire, with nothing written |
| AC-13 | L4 | `tests/integration/messages.spec.ts` | 200 stored → 409; 198 stored → 201 and the project holds 200 |
| AC-14 | L4 | `tests/integration/messages.spec.ts` | The project's `updatedAt` is unchanged by a message write |
| AC-15 | L4 | `tests/integration/messages.spec.ts` | Seeded corrupt documents (missing content, missing timestamp, bad role) are omitted |
| AC-15 | L1 | `functions/src/messages/schema.spec.ts` | Stored-document schema rejects each of the three |
| AC-15 | L1 | `functions/src/messages/handlers.spec.ts` | The `message.unreadable` line carries no field of the document |
| AC-16, AC-17 | L3 | `tests/rules/firestore.spec.ts` | Owner, stranger and anonymous client denied every operation on the messages subcollection |
| AC-18 | L3 | `tests/rules/firestore.spec.ts` | Existing denials re-asserted after the rules edit |
| AC-19 | L2 | `frontend/src/components/ProjectsCard.spec.ts` | The name is a `RouterLink` to `/projects/<id>`; Rename and Delete are buttons |
| AC-20, AC-21, AC-22 | L2 | `frontend/src/views/WorkspaceView.spec.ts` | Loading, 404-with-back-link and no transcript request, error + Retry re-issues |
| AC-23, AC-24 | L2 | `frontend/src/views/WorkspaceView.spec.ts` | Three panels at ≥1024px; tabs below it, Chat default, Preview selectable |
| AC-25 | L1 | `frontend/src/stores/workspace.spec.ts` | The draft lives in the store and survives a component unmount |
| AC-26 | L2 | `frontend/src/views/WorkspaceView.spec.ts` | The connection badge follows `project.locationId` |
| AC-27, AC-28, AC-29, AC-30 | L2 | `frontend/src/components/workspace/ChatPanel.spec.ts` | Loading, empty, bubbles (roles, times, unparseable time), error + Retry |
| AC-30 | L2 | `frontend/src/views/WorkspaceView.spec.ts` | A failed transcript leaves the header and the other two panels rendered |
| AC-31, AC-32, AC-33, AC-34 | L2 | `frontend/src/components/workspace/MessageComposer.spec.ts` | Disabled when blank and at the limit; Enter sends; Shift+Enter does not; failure keeps the draft |
| AC-31, AC-34 | L1 | `frontend/src/stores/workspace.spec.ts` | `send()` appends the returned pair and issues no `GET`; a failure appends nothing |
| AC-35 | L2 | `frontend/src/components/workspace/ChatPanel.spec.ts` | The viewport's `scrollTop` is set to its `scrollHeight` after messages change |
| AC-36 | L1 | `frontend/src/lib/messagesApi.spec.ts` | Paths, verbs, bodies and response parsing through `apiClient` |
| AC-36 | L1 | `frontend/src/lib/no-firestore.spec.ts` | Existing scan, unchanged, still finds no `firebase/firestore` import |
| AC-29 | L1 | `frontend/src/lib/date.spec.ts` | `formatTime` pins locale and zone and returns `null` for an unparseable value |
| AC-20, AC-23 | L2 | `frontend/src/App.spec.ts` | `main` is contained on a `contained` route and full-bleed on a `full` one (D22) |
| AC-37 | L5 | `tests/e2e/workspace.spec.ts` | Dashboard → project → send → echo → reload → history, and back-and-in again |

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`,
      `test:e2e`
- [ ] `users/{uid}/projects/{projectId}/messages/{messageId}` has a deny-all rules block
      **and** L3 tests proving every client operation is denied
- [ ] The `createdAt` + `seq` composite index is declared in `firestore.indexes.json` — no
      test can catch its absence (D9), so it is verified at review by reading the file
      against the query in the handler
- [ ] Error paths from `PRODUCT_SPEC.md` F8 handled for this surface: every failure mode in
      the table above has a user-facing message
- [ ] Loading, empty and error states exist for the workspace route and for the chat panel
- [ ] `tabs`, `badge`, `resizable`, `scroll-area`, `separator` and `textarea` added with
      `npx shadcn-vue@latest add <name>`, not hand-written — and no new runtime dependency
      appears in `frontend/package.json` as a result (all six sit on `reka-ui`, already
      installed)
- [ ] No secrets in source; no `.env` change expected — confirm at review
- [ ] Runs clean on `npm run dev` (emulators) from a fresh clone
- [ ] No `firebase/firestore` import anywhere under `frontend/src`
- [ ] `IMPLEMENTATION_PLAN.md` §0 status table, §4 Slice 4, and §9 conformance rows for
      F6.1, F6.2 and the shadcn-vue inventory updated
- [ ] `PRODUCT_SPEC.md` §7.2's component inventory row for `tabs`/`badge` marked shipped, and
      `textarea` recorded there (D21)
- [ ] README delta: none expected — no setup step changes. Confirm at review
- [ ] PR opened with demo evidence; **human approves before merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The batch timestamp tie renders the echo above the prompt.** A `WriteBatch` gives every `serverTimestamp()` in it the same commit timestamp, so ordering by `createdAt` alone falls through to Firestore's implicit `__name__` tiebreak — a random auto-id — on *every single turn*. It would look like a flaky test and be a deterministic bug. | `seq` (D8), asserted twice: an L1 test that orders a synthetic tied pair, and an L4 test that writes a real pair through the route and reads it back. The L4 one is the assertion that matters, because it exercises the actual commit. |
| R2 | **The composite index is missing in production and no test can see it.** The emulator serves any query, so L3, L4 and L5 all pass against an index-free project; the first workspace load after deploy is where it fails. | Declared in `firestore.indexes.json` in the same commit as the query, called out in the definition of done, and re-checked at review by reading the index entry against the handler's query. Slice 3's R2, and it recurs because the mitigation is a reading, not a test. |
| R3 | **A client authors an assistant message.** Harmless today — it is an echo — and from Slice 5 on it is prompt injection into a context that also carries HighLevel API knowledge and the user's files. | `role` is server-assigned and the body is `.strict()`, so `{ role, content }` is a 400 rather than a field quietly dropped (D5). AC-11 asserts exactly that body. The rules block's comment says why the collection is closed to its own owner. |
| R4 | **This is the largest slice so far** — two routes, six vendored component blocks, a view, four components, a store, and changes to the app shell and the dashboard. Something gets skimmed. | Build order puts the boundary first: schemas, then routes, then rules, then the client, then the UI — so the security-relevant half is reviewable before a component exists. Six vendored blocks are ~600 lines that are *diffed against upstream*, not read. Everything that would have grown it further is a named out-of-scope row. |
| R5 | **`POST` writes both messages, and Slice 5 changes that.** A reviewer reading the contract in isolation will see a shape that is about to be rewritten. | Recorded as D6, including exactly what moves: the assistant write goes to the stream's `done` handler, the user write stays. The store's append-the-response model (D12) is chosen *because* it is what streaming needs, so the frontend half does not change at all. |
| R6 | **The transcript append deviates from Slice 3's D14 refetch rule**, and will read as an inconsistency. | Argued in D12 rather than left to be found: the projects list is server-ordered by a field a mutation changes, a transcript is append-only and cannot be reordered. Neither uses `onSnapshot`, which is what `CLAUDE.md` actually forbids. Named here so it is judged as a decision. |
| R7 | **`PRODUCT_SPEC.md` F6.2 mentions "streaming assistant status", which this slice does not build.** | Deliberate and stated: the assistant is a stub with no stream to have a status for. F6.5 and the streaming half of F6.2 belong to Slice 5, which `IMPLEMENTATION_PLAN.md` §9 already assigns them to. Recorded in Out of scope. |
| R8 | **The `lg` breakpoint swaps component trees**, so anything held in component state below it is lost above it. The draft is the obvious casualty; a later slice will add streaming state to the same panels. | The draft moves to the store now (D17) and AC-25 asserts it. The pattern is set before Slice 5 has streaming state to lose: panel state that must survive the swap lives in `useWorkspaceStore`. |

## Blocked

Nothing. Every question this slice raises is answered above.
