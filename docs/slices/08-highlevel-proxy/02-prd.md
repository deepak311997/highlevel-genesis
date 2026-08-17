# Slice 08 — HighLevel API proxy · PRD

**Spec:** F7.1, F7.2, F8.3 (HighLevel half), F1.3 (token refresh, completing Slice 2's deferral) ·
**Branch:** `slice/08-highlevel-proxy` · **Depends on:** 2 · **Date:** 2026-08-17

## Problem

Genesis holds a live, location-scoped HighLevel token for every connected user and **nothing calls
it**. `getAccessToken()` has existed since Slice 2 as a pure decision function with a `TokenDeps`
port and no adapter behind it; Slice 2's review cut the Firestore transaction that would fill it
(AC-28–31, T13) precisely because there was no consumer yet. There is now.

Generated apps run in a sandboxed iframe. They cannot hold an OAuth token and they cannot reach
`services.leadconnectorhq.com` — CORS forbids it and the secret must never be in the page. So the
only way "real HighLevel data in the preview" is achievable at all is a server-side proxy that
authenticates the caller, resolves *their* token, injects *their* location, and forwards a request
whose shape it has already agreed to. This slice builds that proxy and the refresh machinery under
it. It is also the slice where a mistake leaks another tenant's CRM.

## The demo

Connect the sandbox account, press **Check data access** on the dashboard, and see live counts come
back from all three HighLevel surfaces — Contacts, Conversations and Calendars — fetched through
`/api/hl/proxy/**` with a token the browser never sees; then `curl` the same route with a signed-in
session and get the same contacts back as raw HighLevel JSON.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below was
answered from `PRODUCT_SPEC.md` §4 (F7.1, F7.2, F8.3) and §3, `HIGHLEVEL_PLATFORM.md` §§3, 4, 5, 6,
8 and 10, `IMPLEMENTATION_PLAN.md` §4 (Slices 2, 8, 9, 10) and §8, `CLAUDE.md`'s non-negotiables,
and the merged code and documents of Slices 2, 2b, 3, 4 and 5. Load-bearing decisions carry the
alternative that was rejected, because a decision with no rejected alternative was not a decision.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | What shape is the proxy endpoint? | **Path passthrough.** `<METHOD> /api/hl/proxy/<HighLevel path>` — the method is the HighLevel method and everything after `/proxy` is the HighLevel path. | Slice 2's D24 reserved exactly this subtree, and `HIGHLEVEL_PLATFORM.md` §8 fixes the convention the LLM will be taught: `hl('POST', '/contacts/search', {…})`. A shim then maps that to `fetch('/api/hl/proxy' + path, { method, … })` with no translation table, so the string in the system prompt and the string in the URL are the same string. Rejected: **an RPC envelope**, `POST /api/hl/call` with `{ method, path, query, body }` — it needs a schema of its own, hides the method from every HTTP-level tool (a `curl` demo, Cloud Logging, an allowlist read at a glance), and makes GET requests unpostable to a cache. Rejected: **one named route per operation** (`GET /api/hl/contacts`), which is a second API surface to invent, document, keep in sync with HighLevel's, and teach the model — a translation layer whose only output is more prose in the system prompt. |
| D2 | Where does the route allowlist live? | **One exported table, `functions/src/hl/routes.ts`.** Rows are `{ method, pattern, version, scope, locationIn }`. | `HIGHLEVEL_PLATFORM.md` §8: "the allowlist doubles as the spec — one table, three consumers (proxy, system prompt, README)." Slice 9 imports it to render the cheat-sheet; Slice 13's README renders it too. A table that is *data* can be rendered three ways; a table that is a `switch` statement can be rendered once. |
| D3 | Which routes are on it? | **Thirteen rows** — see *API contracts*. Contacts: `POST /contacts/search`, `GET /contacts/:contactId`, `POST /contacts/`, `PUT /contacts/:contactId`. Conversations: `GET /conversations/search`, `GET /conversations/:conversationId`, `GET /conversations/:conversationId/messages`, `POST /conversations/messages`. Calendars: `GET /calendars/`, `GET /calendars/:calendarId`, `GET /calendars/events`, `GET /calendars/events/appointments/:eventId`, `GET /calendars/:calendarId/free-slots`. | This is F7.1 read literally — "Contacts (list/search/create/update), Conversations (list, get messages, send), Calendars (list, appointments, availability)" — mapped onto `HIGHLEVEL_PLATFORM.md` §6's verified paths. Every row has a recorded fixture or a documented shape behind it. Nothing is on the list because it might be useful later. |
| D4 | What is deliberately **off** it? | **`DELETE /contacts/:contactId`**, `POST /contacts/upsert`, `POST /calendars/events/appointments`, `GET /locations/:id`, and everything else HighLevel serves. | `DELETE` is §8's own worked example of the confused deputy — "a generated 'contact cleanup tool' must not be able to `DELETE /contacts/{id}` in a loop" — and no prompt in the brief's demo script needs it. `upsert` is a second create path with duplicate-handling semantics that depend on a location setting we do not control. Creating appointments is a write to somebody's real calendar for a read-shaped requirement ("list, appointments, availability"). `GET /locations/:id` is connection metadata, already served by `GET /api/hl/connection` in a redacted projection; exposing it through the proxy would give generated code a second, unredacted view of the account. The scopes for the first and third **are** granted, so this is an allowlist decision rather than a capability we lack — which is the point of having one. |
| D5 | `POST /conversations/messages` **sends a real SMS or email.** Is it on the list? | **On the list, disabled by default**, behind `HL_ALLOW_MESSAGE_SEND`. Off, the route answers `403 route_disabled`; it is off in every environment including tests except the one integration case that flips it. | F7.1 names "send" and the conformance ledger grades it, so omitting the row would be a gap. `HIGHLEVEL_PLATFORM.md` §6.2 and §10 risk 6 are equally explicit that a demo must not fire real messages: in the sandbox it may fail for want of a provisioned number, and if it succeeds it costs money and reaches a real person. A row plus a predicate satisfies both. Rejected: leaving it off the table entirely, which reads as an unimplemented surface rather than a deliberately safed one. |
| D6 | How is the upstream URL built? | **Rebuilt from the matched pattern's template**, never by concatenating the caller's path. Path parameters are extracted, re-validated, and re-encoded into a constant template. | This is the slice's structural security property, and it is worth more than any amount of input filtering: if the URL can only ever be assembled from a compile-time constant plus `[A-Za-z0-9_-]` parameters, then `..`, `%2F`, `//`, an absolute URL, an `@` userinfo trick and a fragment are not *rejected* — they are unrepresentable. Rejected: sanitising the incoming path and appending it, which is the same defence expressed as a blocklist, and blocklists on URL parsing are a category with a bad record. |
| D7 | What is a legal path parameter? | **`[A-Za-z0-9_-]{1,64}`**, the same grammar `projectIdSchema` already uses. Anything else is `400 invalid_path`. | HighLevel ids are 20–24 character alphanumerics. The grammar excludes `/`, `.`, `%` and every URL metacharacter by construction, which is what makes D6's re-encoding total rather than best-effort. Reusing Slice 3's grammar means one rule in the codebase rather than two that drift. |
| D8 | A caller sends its own `locationId`. Then what? | **Ours wins, silently.** The value from `hlConnections/{uid}` is written over whatever the caller supplied, in the query or the body as the row dictates. | The security property is identical either way — the caller cannot reach another location, because the token is location-scoped and the id we send is our own. Given that, the question is only what happens to a *generated app* that includes `locationId` out of habit, which is likely: overriding means it works, rejecting means it 400s on something that was never a threat. Rejected: `400` on a caller-supplied `locationId`, which trades a real failure mode for a cosmetic one. Rejected: silently *dropping* it and sending nothing, which would break every row that requires the field. One log line records that an override happened, so the habit is visible without being fatal. |
| D9 | Query or body? | **A per-row field, `locationIn: 'query' \| 'body' \| null`.** `POST /contacts/search` and `POST /contacts/` take it in the JSON body; `GET /conversations/search`, `GET /calendars/` and `GET /calendars/events` take it as a query parameter; routes addressing a single record by id take it nowhere. | HighLevel is not consistent about this and the inconsistency is load-bearing — `/contacts/search` with `locationId` in the query returns a 4xx, and `/calendars/` without it returns someone else's idea of "all". Encoding it per row in the same table that authorises the row means the two can never disagree. |
| D10 | **Whose** `locationId` — the connection's, or the project's snapshot? | **The connection's, always.** The proxy takes no project id and does not read a project. | The access token *is* location-scoped: sending a `locationId` that disagrees with the token's location is a 401/403 from HighLevel, not a different result set. So the connection's location is the only value that can work, and a project id in the path would be a lookup on every CRM call that changes nothing. Slice 3's per-project snapshot stays what it was — a record of which location a project was built against, useful when the user reconnects elsewhere. Rejected: `/api/hl/proxy/:projectId/**`, which also drags a project into a route that has nothing to do with one. |
| D11 | Do we validate the forwarded body against a schema? | **No.** For `POST`/`PUT` the JSON body is forwarded opaquely, with the row's `locationId` written over the top level. | Parse-don't-validate governs *our* boundary; the request body's boundary is HighLevel's, and it is HighLevel that owns the schema. A per-route Zod mirror of `/contacts/search`'s filter DSL would be a second copy of an API we do not control, would go stale on their next release, and would reject valid fields a correct generated app used. The allowlist is the security control — it decides *which* endpoint may be reached — and the body is not a security control at an endpoint we have already decided to permit. Express's existing `json({ limit: '1mb' })` is the size bound. |
| D12 | Query parameters? | **Forwarded verbatim**, except the row's injected `locationId`. | Pagination (`page`, `pageLimit`, `searchAfter`), time windows (`startTime`, `endTime` in epoch ms — §6.3, settled) and `limit` all ride here, and enumerating them per row would be the same stale mirror D11 refuses. F10.5's pagination bonus falls out of this for free rather than being a feature. |
| D13 | The `Version` header? | **Per row.** `2021-07-28` for contacts; `2021-04-15` for conversations and calendars. Never taken from the caller. | §5: omitting it is an error, and the two surfaces genuinely disagree about which date they want. Per row rather than per prefix because the table is already the place a row's facts live, and a prefix rule would have to be re-derived every time a row is added. |
| D14 | Which caller headers reach HighLevel? | **None.** The upstream request carries exactly four headers, all ours: `Authorization`, `Version`, `Accept`, and `Content-Type` on writes. | A forwarded header is an input we did not decide to accept. In particular a caller-supplied `Authorization` or `Version` would let a generated app pick its own token or its own API version — the first is a credential-substitution hole, the second a way to reach undocumented behaviour. Allowlisting headers to nothing is simpler than allowlisting them to something. |
| D15 | Auth on the proxy? | **`withVerifiedUser` (ID token + `email_verified`) *and* `requireAppCheck`.** | Slice 1's D26 and Slice 5's D12, unchanged. Attestation matters here for the same reason it matters on `/generate`: this is an endpoint where an unattested caller spends a finite third-party budget (100 requests / 10 s per location, §5) and can write to somebody's CRM. **This is an inherited constraint on Slice 10**, recorded below rather than left to be discovered. |
| D16 | So how does Slice 10's iframe call this? | **Not decided here, and deliberately constrained.** Slice 10 must hand the shim *both* credentials, and the recommended shape is a `postMessage` bridge in which the **parent** performs the fetch. | A `srcdoc` iframe has an opaque origin: its `fetch` sends `Origin: null`, which `originAllowlist` refuses, and putting an ID token inside the iframe hands a bearer credential to generated code. A parent-side bridge sidesteps both — the credential never crosses into the sandbox, and the request is same-origin. `IMPLEMENTATION_PLAN.md` §4 assigns the choice to Slice 10 discovery and this slice does not pre-empt it; it records the two constraints (App Check, opaque origin) that any answer has to satisfy. |
| D17 | What does a successful call return? | **HighLevel's JSON body verbatim, with HighLevel's 2xx status mirrored** (so `POST /contacts/` answers 201). No envelope, no re-shaping, no field filtering. | Slice 9's system prompt will carry recorded HighLevel payloads as response-shape examples, and §9's closing note is that "real payloads beat prose, and they're what makes generated code render real data on the first try". A re-shaped body would make every one of those examples a lie. Rejected: `{ data, status }`, which adds one unwrapping step to every line of generated code for no benefit. |
| D18 | Rate-limit headers? | **Forwarded.** The five `X-RateLimit-*` headers from §5 are copied onto our response, and added to the CORS `exposedHeaders` list so they survive a cross-origin configuration. | Slice 2's out-of-scope table assigned "rate-limit header surfacing" to this slice in as many words. It is also what turns a 429 into a message with a number in it rather than a mystery. |
| D19 | How are HighLevel's failures mapped? | **Into the existing `{ error, code }` envelope**, with a stable code per condition — see *Edge cases*. HighLevel-originated failures additionally carry **`detail`**: HighLevel's own message, truncated to 200 characters. | F8.3 asks for "clear errors surfaced in preview/UI", and the preview cannot show a clear error if the proxy has flattened every upstream condition to "something went wrong". `detail` is upstream's text about the *request*, never ours about our internals, so it leaks nothing — and it is the string Slice 10 renders in the preview and Slice 9 tells the model to expect. |
| D20 | HighLevel answers 401. Then what? | **`409 hl_reconnect_required`**, and `needsReconnect: true` is written to the connection. **No forced-refresh retry.** | With D25's proactive five-minute skew, a 401 is not an expiry we should have caught — it is a revoked install, an uninstalled app, or a scope the app no longer has, and §2's gotcha is that a scope change *forces re-authorisation* anyway. All three are fixed by reconnecting, which is what the panel already offers. Rejected: **mirroring 401 to the client**, which is actively dangerous — `apiClient` callers read 401 as "your session died", so a HighLevel token problem would sign the user out of Genesis. Rejected: **force a refresh and retry once**, which doubles the refresh rate on precisely the failure a refresh cannot fix, against a rotation grace window whose size is undocumented (§3). |
| D21 | A route that is not on the allowlist? | **`403 route_not_allowed`**, before any Firestore read and any upstream call. | 403 states the true reason: the path may well exist at HighLevel, and we are refusing to reach it. A 404 would imply it does not exist and would send a generated app looking for a typo. |
| D22 | Slice 2 deferred the transactional refresh. Does it land here? | **Yes — in full.** `functions/src/hl/tokenStore.ts` implements `TokenDeps` against Firestore: the fast-path read, and `runTransaction` performing the rotation with a re-read short-circuit. Slice 2's AC-28 to AC-31 are restated below as AC-24 to AC-28. | Slice 2's review cut it on evidence (rotation is survivable) and said "Slice 8 is where it gets its first real consumer". It is. `getAccessToken`'s pure half and its skew arithmetic already ship and are unchanged. |
| D23 | **The refresh network call sits inside a Firestore transaction, and transactions retry.** Is that safe? | **Yes, and it is the documented shape** (`HIGHLEVEL_PLATFORM.md` §3). Two properties make it hold: Firestore read-write transactions are **pessimistic** — the second caller's `tx.get` on the same document blocks until the first commits — and the transaction body **re-reads and short-circuits** when it finds a token someone else already rotated. So the common concurrent case makes exactly one upstream refresh, and a retried transaction re-reads before it would re-refresh. | This is the slice's one real concurrency hazard and it is drawn in the companion. The honest residue: if locking does not serialise the two (a cross-region race, an emulator that models it differently), both callers refresh, both succeed, and one refresh token is orphaned — which the **measured** grace window survives, because HighLevel accepts a reused refresh token at least once (§3, corrected 2026-08-16). Rejected: a **lease field** claimed in one transaction with the network call outside it and the result written in a second — correct, and the right answer for a system with real concurrency, but it introduces a lock with an expiry policy, a stale-lease sweep and a third failure mode, for a hazard that has been measured to be survivable. Rejected: an **in-process promise map**, which serialises one Cloud Run instance and says nothing about the other nine. |
| D24 | A connection already marked `needsReconnect`? | **`getAccessToken` refuses immediately** with `HlReconnectRequiredError`, before reading a token or calling anything. | Slice 2's review named this as travelling with T13: "a connection already marked dead still attempts a refresh, fails, and re-marks it." Harmless then, wasteful now that a preview can fire several calls at once at a dead connection. |
| D25 | When does a refresh happen? | **Proactively, on the existing five-minute skew.** Never reactively on a 401 (D20). | `HIGHLEVEL_PLATFORM.md` §3, rule 2: "Reactive-only refresh maximises the number of simultaneous refresh attempts." The skew is already implemented and unit-tested; this slice only supplies the effect behind it. |
| D26 | A refresh fails. What is persisted? | **On a definitive `invalid_grant`: `needsReconnect: true`, and the stored `refreshToken` is left exactly as it is.** On anything else — 5xx, a network error, a timeout — **nothing is written at all**, and the caller gets `502 hl_unavailable`. | Slice 2's D23, unchanged and now given an implementation. §3, rule 1: never destroy a refresh token that may still be valid. The asymmetry is the whole point — a blip must not be recorded as a dead connection, and a dead connection must not be retried forever. |
| D27 | Upstream timeout and response size? | **A 20-second `AbortSignal` on the upstream fetch → `504 hl_timeout`; a 5 MiB response cap → `502 hl_too_large`.** | The `api` function's own timeout is 60 s, so an unbounded upstream call would burn the request budget and answer nothing. 5 MiB is roughly 25× the largest recorded fixture and still inside what a Cloud Run response can carry; without it a pathological `pageLimit` is an out-of-memory rather than an error. |
| D28 | What gets logged? | **One structured line per call, `hl.proxy`** — the matched *pattern* (not the concrete path), the upstream status, the elapsed milliseconds, and `X-RateLimit-Remaining`. Never a request body, a response body, a token or a contact. | The pattern rather than the path because it aggregates, and because a concrete path carries a contact id into Cloud Logging for no operational gain. The rate-limit remainder is here because a burst problem (§5's N+1 warning) is invisible until someone is already at 429. |
| D29 | How is HighLevel stubbed for the tests? | **`buildFakeHlRouter` gains the three surfaces**, replaying `tests/fixtures/highlevel/*.json`, still gated on `FUNCTIONS_EMULATOR` alone. The fake **requires** `Authorization: Bearer` and a `Version` header, and **filters by the `locationId` it receives**. | Extending the existing fake rather than adding a second double keeps one gate to audit (Slice 2's D21 reasoning, unchanged). The three behaviours above are not decoration: requiring the two headers is what proves the proxy attaches them, and filtering by `locationId` is what turns tenant isolation into an *observable* result — a caller connected to another location gets an empty set, exactly as HighLevel would answer. Failure behaviour follows the fake's existing "the input says what should happen" idiom: the ids `__401`, `__429`, `__500`, `__slow` and `__huge` each produce their condition. |
| D30 | What is the UI half of this slice? | **A "Data access" section inside the existing `ConnectionPanel`** on the dashboard: an on-demand **Check data access** button that issues one call per surface and renders a count for each, with idle, loading, result, empty and error states. Not automatic on page load. | A slice is vertical if it can be demoed, and the plan's own demo line for Slice 8 is a `curl` — which is not a screen. This is the smallest honest screen: the proxy's whole job is "can this user's token actually read their CRM", the connection panel is where connection state already lives, and F8.3's "expired connection → prompt to reconnect" needs somewhere to render, which is this panel and its existing Reconnect button. On demand rather than on mount because three HighLevel calls on every dashboard visit spends a rate-limit budget (§5) to answer a question nobody asked. Rejected: **wiring it into `PreviewPanel`**, which is Slice 10's surface and would need Slice 10's credential decision first. Rejected: **no UI at all**, which makes this the first horizontal slice in the build. |
| D31 | Which three calls does the probe make? | **`POST /contacts/search` with `{ pageLimit: 1 }`, `GET /conversations/search?limit=1`, and `GET /calendars/`.** Contacts and conversations render `total`; calendars renders the length of the array. | One call per surface, the smallest payload each will return, and no parameters beyond the injected `locationId` — deliberately not `GET /calendars/events`, which needs a time window in epoch milliseconds and a calendar id, and would make the probe's failure ambiguous between "no access" and "no events this fortnight". |
| D32 | Does the frontend parse these responses? | **Narrowed by hand**, as every existing typed client does. Zod is not added to the frontend here. | Slice 2's review Finding 5 deferred "parse-don't-validate on the frontend's own API responses" as a **cross-cutting** pass rather than one client at a time; doing it for this one client alone would leave two conventions in the codebase and pre-empt that pass. The narrowing is defensive regardless: a missing or non-numeric `total` renders as "—", not as `NaN`. |
| D33 | Does anything change in Firestore? | **No new collection, no rules change, no new index.** `hlConnections/{uid}` gains no field — `needsReconnect`, `accessToken`, `refreshToken` and `expiresAt` all already exist and are all already denied to every client. | Stated because the definition of done asks. The L3 denial for `hlConnections` is re-asserted in the same commit, since this is the slice that starts writing the document from a second code path. |
| D34 | Rate limiting on the proxy itself? | **Out of scope — F10.4 / stretch S4.** A 429 from HighLevel is mapped and surfaced (D19), and `X-RateLimit-Remaining` is logged (D28) and forwarded (D18); no per-user quota is enforced by us. | The realistic burst comes from a generated app doing N+1 (§5), and §8's answer to that is a system-prompt instruction — which is Slice 9's. Named here rather than left to be noticed, and carried in Risks. |
| D35 | Is this one reviewable PR? | **Yes**, and it was checked. New: one pure module (the table and matcher), one pure error mapper, one Firestore adapter, one handler, fake-server rows, one frontend client, one store action, one panel section. Changed: three existing files by a few lines each. No new collection, no new rules, no new index, no new vendored component, no new dependency. | The mitigation is build order: the table and matcher first as pure functions with their L1 tests, then the token adapter with its L4 concurrency test, then the handler, then the fake, then the client and the panel. **The entire security-relevant half is reviewable before a single `.vue` file is touched** — which is what the plan means when it says a mistake here leaks another tenant's data. |

## In scope

- `functions/src/hl/routes.ts` — the allowlist table (D2, D3), the specificity-ordered matcher
  (literal segments beat parameters, D6), path-parameter validation (D7), and upstream URL assembly
- `functions/src/hl/proxy.ts` — `handleProxy`: resolve the connection, resolve the token, inject
  `locationId`, forward, mirror status, copy rate-limit headers, log
- `functions/src/hl/proxyError.ts` — the pure upstream-condition → `{ status, code, message, detail }`
  mapper (D19, D20)
- `functions/src/hl/tokenStore.ts` — the Firestore `TokenDeps` adapter: fast-path read and the
  transactional rotation (D22, D23, D26)
- `functions/src/hl/token.ts` — `needsReconnect` short-circuit and `HlReconnectRequiredError` (D24)
- `functions/src/hl/index.ts` — mounts `/hl/proxy/*` on the reserved subtree, attested and verified
- `functions/src/hl/config.ts` — `hlAllowMessageSend()` (D5)
- `functions/src/hl/fake.ts` — the three surfaces from recorded fixtures, header requirements,
  `locationId` filtering, and the failure markers (D29)
- `functions/src/api/index.ts` — CORS `exposedHeaders` for the `X-RateLimit-*` set (D18)
- `functions/.env.example` — `HL_ALLOW_MESSAGE_SEND`, defaulting to unset
- `frontend/src/lib/hlProxyApi.ts` — `hlProxy(method, path, payload)` over `apiClient`
- `frontend/src/stores/hl.ts` — `probe` state (`idle | loading | ready | error`), `probeResult`,
  `checkDataAccess()`, cleared by `reset()`
- `frontend/src/components/ConnectionPanel.vue` — the Data access section and its five states (D30)
- `tests/integration/hl-proxy.spec.ts`, `tests/integration/hl-token-refresh.spec.ts`
- `tests/e2e/highlevel.spec.ts` — the probe added to the existing connect walk
- `tests/rules/firestore.spec.ts` — `hlConnections` denial re-asserted
- `docs/IMPLEMENTATION_PLAN.md` §0/§4/§9 and `docs/PRODUCT_SPEC.md` §3 status rows

## Out of scope

| Not here | Picked up by |
|---|---|
| The HighLevel cheat-sheet in the system prompt; teaching the model the `hl()` convention | Slice 9 — which imports `routes.ts` rather than restating it |
| The `srcdoc` shim, the credential bridge into the iframe, and preview rendering (D16) | Slice 10 |
| `DELETE /contacts/:id`, `POST /contacts/upsert`, `POST /calendars/events/appointments` (D4) | Not planned — an allowlist decision, revisited only if a slice needs one |
| `GET /locations/:id` through the proxy (D4) | Not planned — `GET /api/hl/connection` already serves the redacted view |
| Sending messages in any environment where the flag is not set (D5) | Not planned for the demo; the flag is the mechanism |
| Per-user or per-project rate limiting on the proxy (D34) | Stretch S4 (F10.4) |
| A system-prompt instruction against N+1 request patterns | Slice 9 |
| Caching or de-duplicating identical upstream calls | Not planned |
| Zod on the frontend's own API responses (D32) | Slice 12's cross-cutting pass |
| Webhook-driven invalidation of a dead connection (HL `UNINSTALL`) | Not planned — `HIGHLEVEL_PLATFORM.md` §7 rates it 20 minutes well spent, and it is not in the brief |
| Seeding the sandbox account with demo data | Slice 13 (`scripts/seed-sandbox.ts`) |
| Migrating to HighLevel API `v3` | Not planned — date-pinned versions are settled (§8), a named README follow-up |

## User flow

1. A verified user with a connected HighLevel sub-account opens the dashboard. The connection panel
   loads and reads *Connected to India Square*.
2. Below it, a **Data access** section sits idle with a **Check data access** button and one line of
   explanation.
3. The user presses it. The section shows a loading state; the button disables.
4. The store issues three requests through `apiClient` — `POST /api/hl/proxy/contacts/search`,
   `GET /api/hl/proxy/conversations/search?limit=1`, `GET /api/hl/proxy/calendars/`.
5. For each, the proxy verifies the ID token and App Check, matches the path against the allowlist,
   reads `hlConnections/{uid}`, resolves an access token (refreshing inside a transaction if it is
   within five minutes of expiry), injects the connection's `locationId`, and forwards to HighLevel
   with the row's `Version` header.
6. HighLevel's JSON comes back unchanged with its status mirrored and the `X-RateLimit-*` headers
   copied across.
7. The section renders `Contacts 20 · Conversations 5 · Calendars 3`. A surface that answers zero
   renders as an empty state for that row rather than an error.
8. If HighLevel answers 401 — a revoked install, or a scope removed — the proxy writes
   `needsReconnect: true`, answers `409 hl_reconnect_required`, and the section shows the reason with
   a **Reconnect HighLevel** button; the next status refresh moves the whole panel into its existing
   reconnect state.
9. If the user is not connected at all, the section is not rendered; the panel's existing empty state
   already asks them to connect.

## Data model

**No new collection, no new field, no rules change, no new index** (D33). `hlConnections/{uid}` is
written from a second code path for the first time, so the fields it touches are restated:

| Field | Written by | Note |
|---|---|---|
| `accessToken` | callback (Slice 2), **refresh (this slice)** | never leaves the server |
| `refreshToken` | callback, **refresh** | rotated on every refresh, and **never cleared on a transient failure** (D26) |
| `expiresAt` | callback, **refresh** | `now + expires_in * 1000` |
| `locationId` | callback | the value the proxy injects (D8, D10) |
| `needsReconnect` | callback (`false`), **this slice (`true`)** | set only on a definitive `invalid_grant` or an upstream 401 (D20, D26) |
| `updatedAt` | callback, **refresh** | `serverTimestamp()` |

**Rules:** unchanged — `match /hlConnections/{uid} { allow read, write: if false; }`. Re-asserted at
L3 in this commit because this is the slice that starts mutating the document from a second path.

## API contracts

### The allowlist

`locationIn` says where the connection's `locationId` is injected. `flag` marks a row that is
disabled unless its environment variable is set.

| # | Method | Path pattern | Version | Scope | `locationIn` |
|---|---|---|---|---|---|
| 1 | `POST` | `/contacts/search` | `2021-07-28` | `contacts.readonly` | body |
| 2 | `GET` | `/contacts/:contactId` | `2021-07-28` | `contacts.readonly` | — |
| 3 | `POST` | `/contacts/` | `2021-07-28` | `contacts.write` | body |
| 4 | `PUT` | `/contacts/:contactId` | `2021-07-28` | `contacts.write` | — |
| 5 | `GET` | `/conversations/search` | `2021-04-15` | `conversations.readonly` | query |
| 6 | `GET` | `/conversations/:conversationId` | `2021-04-15` | `conversations.readonly` | — |
| 7 | `GET` | `/conversations/:conversationId/messages` | `2021-04-15` | `conversations/message.readonly` | — |
| 8 | `POST` | `/conversations/messages` · **flag `HL_ALLOW_MESSAGE_SEND`** | `2021-04-15` | `conversations/message.write` | — |
| 9 | `GET` | `/calendars/` | `2021-04-15` | `calendars.readonly` | query |
| 10 | `GET` | `/calendars/:calendarId` | `2021-04-15` | `calendars.readonly` | — |
| 11 | `GET` | `/calendars/events` | `2021-04-15` | `calendars/events.readonly` | query |
| 12 | `GET` | `/calendars/events/appointments/:eventId` | `2021-04-15` | `calendars/events.readonly` | — |
| 13 | `GET` | `/calendars/:calendarId/free-slots` | `2021-04-15` | `calendars.readonly` | — |

Rows 10 and 11 overlap in shape (`/calendars/<one segment>`). **Literal segments beat parameters at
every position, independent of table order** (D6) — `/calendars/events` resolves to row 11 and
`/calendars/2oKn7but6Q2WaHIu7pqC` to row 10. Trailing slashes are normalised away on the incoming
path and preserved on the upstream template, so `/calendars` and `/calendars/` both reach row 9 and
both call `GET /calendars/` upstream.

### `<METHOD> /api/hl/proxy/<path>` — new

Auth: ID token + `email_verified`. App Check: **required** (D15). Mounted on the existing `api`
function, under the subtree Slice 2's D24 reserved.

**Request** — the method and the path after `/api/hl/proxy` are the HighLevel method and path.
Query parameters are forwarded verbatim (D12); on `POST`/`PUT` the JSON body is forwarded opaquely
(D11). Nothing else about the caller's request crosses the boundary (D14).

**Success** — HighLevel's status (2xx) and its JSON body, byte for byte (D17), plus the
`X-RateLimit-Limit-Daily`, `X-RateLimit-Daily-Remaining`, `X-RateLimit-Interval-Milliseconds`,
`X-RateLimit-Max` and `X-RateLimit-Remaining` headers (D18).

**Failure** — the existing envelope, extended with `detail` for upstream-originated conditions:

```json
{ "error": "HighLevel could not find that record.", "code": "hl_not_found", "detail": "Contact not found" }
```

| Condition | Status | `code` |
|---|---|---|
| No `Authorization` header, or an unverifiable token | 401 | `unauthenticated` |
| `email_verified` is false | 403 | `email_unverified` |
| Missing or invalid App Check token | 401 | `app_check_failed` |
| Method + path not on the allowlist | 403 | `route_not_allowed` |
| An allowlisted path with a method that is not on its row | 403 | `route_not_allowed` |
| A row whose flag is not set (D5) | 403 | `route_disabled` |
| A path parameter outside `[A-Za-z0-9_-]{1,64}` | 400 | `invalid_path` |
| No `hlConnections/{uid}` document | 409 | `hl_not_connected` |
| Connection already marked `needsReconnect` (D24) | 409 | `hl_reconnect_required` |
| Refresh returned `invalid_grant` (D26) | 409 | `hl_reconnect_required` |
| Refresh failed transiently — 5xx, network, timeout (D26) | 502 | `hl_unavailable` |
| HighLevel 401 (D20) | 409 | `hl_reconnect_required` |
| HighLevel 403 | 403 | `hl_forbidden` |
| HighLevel 404 | 404 | `hl_not_found` |
| HighLevel 429 | 429 | `hl_rate_limited` |
| HighLevel 400 / 422 / any other 4xx | 400 | `hl_bad_request` |
| HighLevel 5xx | 502 | `hl_unavailable` |
| Upstream took longer than 20 s (D27) | 504 | `hl_timeout` |
| Upstream body over 5 MiB (D27) | 502 | `hl_too_large` |
| Anything else | 500 | `internal` |

## Edge cases and failure modes

| Situation | Behaviour | User sees | Retry? |
|---|---|---|---|
| Happy path, token fresh | No transaction, no refresh, one upstream call | Counts for all three surfaces | n/a |
| Token within the five-minute skew | One transactional refresh, then the call | The same, a few hundred ms slower | n/a |
| Three probe calls at once on an expired token | The first transaction rotates; the others block on its lock, re-read, and use the new token — **one** upstream refresh (D23) | The same | n/a |
| Refresh answers `invalid_grant` | `needsReconnect: true`; `refreshToken` left in place; `409 hl_reconnect_required` | "Your HighLevel connection expired." with **Reconnect HighLevel** | After reconnecting |
| Refresh answers 500 or the network fails | **Nothing written**; `502 hl_unavailable` | "HighLevel is not responding. Try again." | Yes |
| The connection is already `needsReconnect` | Refused before any read of the token (D24) | As above, with Reconnect | After reconnecting |
| The user is not connected | `409 hl_not_connected`, no upstream call | The panel's existing empty state; the probe section is not rendered | Connect first |
| HighLevel answers 401 (revoked install, scope removed) | `needsReconnect: true`; `409 hl_reconnect_required` | "Your HighLevel connection expired." with **Reconnect HighLevel** | After reconnecting |
| HighLevel answers 429 | `429 hl_rate_limited` with `detail` and the `X-RateLimit-*` headers forwarded | "HighLevel is rate-limiting this account. Try again shortly." | Yes |
| HighLevel answers 404 for a contact id | `404 hl_not_found` with HighLevel's message as `detail` | The proxy's error; the probe never produces one | n/a |
| HighLevel is slow past 20 s | Aborted; `504 hl_timeout` | "HighLevel took too long to answer." | Yes |
| HighLevel returns 6 MiB | Aborted at the cap; `502 hl_too_large` | "That HighLevel response was too large." | n/a |
| A caller tries `DELETE /api/hl/proxy/contacts/abc` | `403 route_not_allowed` before any read | n/a — no UI produces one | n/a |
| A caller tries `GET /api/hl/proxy/contacts/search` (right path, wrong method) | `403 route_not_allowed` | n/a | n/a |
| A caller tries `POST /api/hl/proxy/conversations/messages` with the flag unset | `403 route_disabled` | n/a | n/a |
| A caller tries `/api/hl/proxy/contacts/../../oauth/token` | Express normalises, then no row matches → `403 route_not_allowed`; the upstream URL is a template either way (D6) | n/a | n/a |
| A caller tries `/api/hl/proxy/contacts/%2E%2E%2Foauth` | The parameter fails `[A-Za-z0-9_-]{1,64}` → `400 invalid_path` | n/a | n/a |
| A caller sends `locationId` for another location, in the body or the query | Overwritten with the connection's; HighLevel answers about the caller's own location (D8) | Their own data | n/a |
| Alice and Bob are connected to different sub-accounts | Each request carries its own uid's token *and* its own uid's `locationId`; the fake filters accordingly | Each sees only their own | n/a |
| A caller sends `Authorization: Bearer <a HighLevel token>` alongside a valid Firebase token | The caller's header is not forwarded; ours is used (D14) | Their own data | n/a |
| A caller sends `Version: v3` | Not forwarded; the row's version is used (D13) | Normal | n/a |
| A body of 2 MiB | `413` from `express.json({ limit: '1mb' })`, before the route | n/a | n/a |
| The probe's contacts call succeeds and conversations fails | Each row renders its own outcome; one failure does not blank the others | Two counts and one row-level error | Per row, via the button |
| A surface answers zero records | That row's empty state — "None yet" — not an error | An honest zero | n/a |
| The user signs out while a probe is in flight | `reset()` clears the probe state with the rest | Nothing stale for the next account | n/a |
| A client tries to read `hlConnections/{uid}` directly | Denied by `firestore.rules`; the frontend has no Firestore SDK to try with | n/a | n/a |

## Acceptance criteria

**The allowlist and the matcher (the confused-deputy fix)**

- **AC-1** — Given each of the thirteen table rows, when its method and a legal concrete path are
  matched, then the row is returned with its `version`, `scope` and `locationIn` intact.
- **AC-2** — Given `DELETE /contacts/abc123`, `POST /contacts/upsert`,
  `POST /calendars/events/appointments`, `GET /locations/abc123`, `GET /users/`, and the bare path
  `/`, when each is matched, then no row is returned.
- **AC-3** — Given `GET /contacts/search` and `DELETE /calendars/`, whose paths are on the table but
  whose methods are not on those rows, when each is matched, then no row is returned.
- **AC-4** — Given `GET /calendars/events`, then row 11 is matched and not row 10; given
  `GET /calendars/2oKn7but6Q2WaHIu7pqC`, then row 10 is matched — **regardless of the order the
  rows appear in the table**, asserted by matching against a reversed copy of it.
- **AC-5** — Given the path parameters `..`, `a/b`, `a%2Fb`, a 65-character id, an empty segment,
  and `abc.123`, when each is matched, then the result is an invalid-path refusal and never a row.
- **AC-6** — Given a matched row and its parameters, when the upstream URL is assembled, then it
  begins with `hlApiBase()`, its path equals the row's template with each parameter substituted and
  URL-encoded, and no substring of the caller's raw path appears in it other than those parameters.
- **AC-7** — Given `GET /calendars` and `GET /calendars/`, then both match row 9 and both assemble
  the upstream path `/calendars/`.

**`locationId` injection and tenant isolation**

- **AC-8** — Given a row with `locationIn: 'body'` and a request body containing another location's
  `locationId`, when the upstream request is assembled, then the body's top-level `locationId` is
  the connection's and every other field of the body is unchanged.
- **AC-9** — Given a row with `locationIn: 'query'` and a query string containing another location's
  `locationId` plus two unrelated parameters, then the upstream query carries the connection's
  `locationId` once and both unrelated parameters unchanged.
- **AC-10** — Given a row with `locationIn: null`, then no `locationId` is added to the query or the
  body.
- **AC-11** — Given verified users alice and bob connected to *different* sub-accounts, when each
  `POST`s `/api/hl/proxy/contacts/search`, then each receives only their own location's contacts,
  and bob receives an empty set for alice's location even when he names it in the body.

**The upstream request**

- **AC-12** — Given any allowlisted call, when it reaches the stub, then the request carries
  `Authorization: Bearer <the stored access token>`, the row's `Version`, and
  `Accept: application/json`; and it carries **no** header taken from the caller's request.
- **AC-13** — Given a caller that sends `Authorization`, `Version`, `Cookie` and `X-Forwarded-For`
  headers of its own, then none of their values appears in the upstream request.
- **AC-14** — Given a contacts row and a calendars row, then the upstream `Version` headers are
  `2021-07-28` and `2021-04-15` respectively.
- **AC-15** — Given an upstream 200, then the proxy's status is 200, its body is byte-identical to
  the upstream body, and the five `X-RateLimit-*` headers are present with the upstream values.
- **AC-16** — Given an upstream 201 on `POST /contacts/`, then the proxy answers 201.

**The boundary**

- **AC-17** — Given a request with no `Authorization` header, then the response is
  `401 unauthenticated` and no Firestore read and no upstream call is made.
- **AC-18** — Given a token whose `email_verified` is false, then the response is
  `403 email_unverified`.
- **AC-19** — Given a request with no App Check token, then the response is `401 app_check_failed`.
- **AC-20** — Given a route that is not on the allowlist, then the response is
  `403 route_not_allowed`, and neither `hlConnections/{uid}` nor HighLevel is touched.
- **AC-21** — Given `POST /api/hl/proxy/conversations/messages` with `HL_ALLOW_MESSAGE_SEND` unset,
  then the response is `403 route_disabled` and no upstream call is made; given the same request
  with the flag set, then the call is forwarded.
- **AC-22** — Given a verified, attested caller with **no** `hlConnections/{uid}` document, then the
  response is `409 hl_not_connected` and no upstream call is made.
- **AC-23** — Given `/api/hl/proxy` with an empty remaining path, then the response is
  `403 route_not_allowed` rather than a 404 from the app's terminal handler.

**Token refresh — the hazard (restating Slice 2's AC-28 to AC-31)**

- **AC-24** — Given a connection whose `expiresAt` is more than five minutes away, when a proxy call
  is made, then no transaction is opened, no refresh request reaches HighLevel, and the stored token
  is the one sent upstream.
- **AC-25** — Given a connection expiring inside the five-minute skew, when a proxy call is made,
  then one refresh is performed and the **new** `accessToken`, `refreshToken` and `expiresAt` are
  persisted, `needsReconnect` stays false, and the call proceeds with the new token.
- **AC-26** — Given three concurrent proxy calls on a connection expiring inside the skew, then
  **exactly one** refresh request reaches HighLevel, all three calls succeed, and the persisted
  `refreshToken` is the one that refresh returned.
- **AC-27** — Given a refresh that returns `invalid_grant`, then `needsReconnect` becomes true, the
  stored `refreshToken` is **unchanged**, and the caller gets `409 hl_reconnect_required`.
- **AC-28** — Given a refresh that fails with a 500 or a network error, then `needsReconnect` stays
  false, `accessToken`, `refreshToken` and `expiresAt` are all unchanged, and the caller gets
  `502 hl_unavailable`.
- **AC-29** — Given a connection already carrying `needsReconnect: true`, then the response is
  `409 hl_reconnect_required` and **no** refresh request is attempted.

**Error mapping (F8.3)**

- **AC-30** — Given upstream statuses 401, 403, 404, 429, 400 and 503, when each is mapped, then the
  proxy's status and `code` are `409 hl_reconnect_required`, `403 hl_forbidden`, `404 hl_not_found`,
  `429 hl_rate_limited`, `400 hl_bad_request` and `502 hl_unavailable`.
- **AC-31** — Given an upstream 401 over the wire, then `needsReconnect` becomes true on the
  connection document and the response is `409`, never `401`.
- **AC-32** — Given an upstream error body carrying a `message`, then the response's `detail` is that
  message truncated to 200 characters; given an upstream error with an unparseable body, then
  `detail` is absent and the response still carries `error` and `code`.
- **AC-33** — Given an upstream response that has not completed after 20 seconds, then the request is
  aborted and the response is `504 hl_timeout`; given an upstream body larger than 5 MiB, then the
  response is `502 hl_too_large`.
- **AC-34** — Given any mapped error, then the response body contains no access token, no refresh
  token and no uid.

**Logging**

- **AC-35** — Given a completed proxy call, then exactly one `hl.proxy` log line is emitted carrying
  the matched **pattern**, the upstream status, an elapsed duration and the rate-limit remainder, and
  carrying no request body, response body, token or contact identifier.

**Rules — the backstop**

- **AC-36** — Given any client — the connection's owner, another signed-in user, an anonymous one —
  when it reads, lists, creates, updates or deletes `hlConnections/{uid}`, then every operation is
  denied.
- **AC-37** — Given any client, when it touches `users/{uid}`, `users/{uid}/projects/{projectId}`,
  that project's `messages` subcollection, or `authThrottle/{key}`, then it is denied — re-asserted.

**Frontend — the client and the store**

- **AC-38** — Given `hlProxy('POST', '/contacts/search', { pageLimit: 1 })`, then the request is a
  `POST` to `/api/hl/proxy/contacts/search` with a JSON body, an `Authorization: Bearer` header and
  an App Check header; given `hlProxy('GET', '/calendars/')`, then the request is a `GET` with no
  body.
- **AC-39** — Given a non-2xx response, then `hlProxy` rejects with an `ApiError` carrying the
  server's `error` message and status; and no `firebase/firestore` import exists anywhere under
  `frontend/src`.
- **AC-40** — Given `checkDataAccess()` runs and all three calls succeed, then `probe` is `ready`
  and `probeResult` holds a count per surface; given one call rejects, then that surface carries its
  error message and the other two carry their counts.
- **AC-41** — Given a response whose `total` is missing or is not a number, then that surface's count
  is `null` rather than `NaN`, and the panel renders `—`.
- **AC-42** — Given `reset()` runs, then `probe` returns to `idle` and `probeResult` is cleared.

**Frontend — the panel**

- **AC-43** — Given a connected user, when the panel renders, then a **Check data access** button is
  present and no counts are shown until it is pressed — and no proxy request is issued on mount.
- **AC-44** — Given the button is pressed, then the section shows a loading state and the button is
  disabled; when the calls resolve, then one row per surface renders its count.
- **AC-45** — Given a surface answers zero records, then that row renders an empty state and not an
  error.
- **AC-46** — Given a call fails with `hl_reconnect_required`, then the section renders the reason
  and a **Reconnect HighLevel** button that calls `hl.connect()` exactly once.
- **AC-47** — Given the user is not connected, then the Data access section is not rendered at all.

**End to end**

- **AC-48** — Given a verified account, when the user connects HighLevel through the stubbed
  marketplace and presses **Check data access**, then counts for Contacts, Conversations and
  Calendars appear on the dashboard, sourced through `/api/hl/proxy/**`.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1, AC-2, AC-3 | L1 | `functions/src/hl/routes.spec.ts` | Every row matches; the four named exclusions and two wrong-method cases do not |
| AC-4 | L1 | `functions/src/hl/routes.spec.ts` | Literal-beats-parameter, proven against a reversed table |
| AC-5, AC-7 | L1 | `functions/src/hl/routes.spec.ts` | Parameter grammar; trailing-slash normalisation |
| AC-6 | L1 | `functions/src/hl/routes.spec.ts` | The upstream URL is assembled from the template, and encodes each parameter |
| AC-8, AC-9, AC-10 | L1 | `functions/src/hl/routes.spec.ts` | `locationId` injection per `locationIn`, other fields and parameters untouched |
| AC-11 | L4 | `tests/integration/hl-proxy.spec.ts` | Two users, two locations, adversarial body — each sees only their own |
| AC-12, AC-13, AC-14 | L4 | `tests/integration/hl-proxy.spec.ts` | The stub refuses a call missing `Authorization` or `Version`; caller headers absent |
| AC-15, AC-16 | L4 | `tests/integration/hl-proxy.spec.ts` | Body byte-identical to the fixture; rate-limit headers; 201 mirrored |
| AC-17, AC-18, AC-19 | L4 | `tests/integration/hl-proxy.spec.ts` | 401 / 403 / App Check, with nothing read and nothing forwarded |
| AC-20, AC-23 | L4 | `tests/integration/hl-proxy.spec.ts` | `route_not_allowed` over the wire, including the bare subtree |
| AC-21 | L4 | `tests/integration/hl-proxy.spec.ts` | The send flag off and on |
| AC-22 | L4 | `tests/integration/hl-proxy.spec.ts` | `hl_not_connected` with no upstream call |
| AC-24, AC-25 | L4 | `tests/integration/hl-token-refresh.spec.ts` | Fresh token bypasses; skewed token rotates and persists all three fields |
| AC-24, AC-29 | L1 | `functions/src/hl/token.spec.ts` | The existing skew cases, plus the `needsReconnect` short-circuit |
| AC-26 | L4 | `tests/integration/hl-token-refresh.spec.ts` | Three concurrent calls, one upstream refresh — the slice's hazard |
| AC-27, AC-28 | L4 | `tests/integration/hl-token-refresh.spec.ts` | `invalid_grant` vs. a 500: what is written and what is not |
| AC-30, AC-32, AC-34 | L1 | `functions/src/hl/proxyError.spec.ts` | The mapping table row by row; `detail` truncation; no secret in any output |
| AC-31 | L4 | `tests/integration/hl-proxy.spec.ts` | An upstream 401 sets `needsReconnect` and answers 409 |
| AC-33 | L4 | `tests/integration/hl-proxy.spec.ts` | `__slow` and `__huge` against the stub |
| AC-35 | L1 | `functions/src/hl/proxy.spec.ts` | The `hl.proxy` line's fields, and that it carries no payload |
| AC-36, AC-37 | L3 | `tests/rules/firestore.spec.ts` | Every client operation on `hlConnections` denied; existing denials re-asserted |
| AC-38, AC-39 | L1 | `frontend/src/lib/hlProxyApi.spec.ts` | Method, path, body and headers; `ApiError` on a refusal |
| AC-39 | L1 | `frontend/src/lib/no-firestore.spec.ts` | Existing scan, unchanged |
| AC-40, AC-41, AC-42 | L1 | `frontend/src/stores/hl.spec.ts` | Probe success, partial failure, defensive `total`, and `reset()` |
| AC-43, AC-44, AC-45, AC-46, AC-47 | L2 | `frontend/src/components/ConnectionPanel.spec.ts` | Idle, loading, result, empty and reconnect states; nothing on mount |
| AC-48 | L5 | `tests/e2e/highlevel.spec.ts` | Connect through the stub, press the button, see three counts |

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`,
      `test:e2e`
- [ ] The allowlist is **data**, exported from one module, and Slice 9 can import it without
      copying a row (D2)
- [ ] No upstream URL is built by concatenating a caller-supplied string anywhere in
      `functions/src/hl` — a `grep` at review, because D6 is the slice's structural security claim
- [ ] `hlConnections/{uid}` denial re-asserted at L3, in the commit that adds the second writer
- [ ] Error paths from `PRODUCT_SPEC.md` F8.3 handled for this surface: every row of the failure
      table has a user-facing message and a code, and the reconnect path is tested end to end
- [ ] The Data access section ships with loading, empty and error states (DoD, and D30)
- [ ] No secrets in source; `functions/.env.example` gains `HL_ALLOW_MESSAGE_SEND` with a comment
      saying why it defaults to off
- [ ] HighLevel is stubbed in every automated test, gated on `FUNCTIONS_EMULATOR` alone (D29)
- [ ] Runs clean on `npm run dev` from a fresh clone, including a probe against the stub
- [ ] No `firebase/firestore` import anywhere under `frontend/src`
- [ ] `IMPLEMENTATION_PLAN.md` §0 status, §4 Slice 8, and §9's rows for F7.1, F7.2 and F8.3 updated;
      `PRODUCT_SPEC.md` §3's `api/hl/*` line marked shipped
- [ ] README delta noted for Slice 13: the allowlist table is a README section, and
      `HL_ALLOW_MESSAGE_SEND` is a deployment note
- [ ] **Manual check against the real sandbox** recorded in the review: one `curl` per surface with a
      real token, confirming the recorded fixtures still match the live shapes
- [ ] PR opened with demo evidence — the dashboard counts and the `curl`; **human approves before
      merge**

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **A mistake here leaks another tenant's CRM.** This is the plan's own words for Slice 8, and it is accurate: the proxy holds a location-scoped token that reads an entire business's contacts. | Three independent structural properties rather than one check: the uid comes from the verified token and nowhere else, the `locationId` is read from that uid's own document and written over anything the caller sent (D8), and the upstream URL is assembled from a compile-time template (D6). AC-11 makes isolation *observable* by giving two test users two different sub-accounts and having the stub filter by the `locationId` it actually received (D29) — so a proxy that forgot to inject would return the wrong set, not merely fail an assertion about an argument. |
| R2 | **The refresh network call runs inside a Firestore transaction, and transactions retry.** A naive reading says a contended retry re-sends a refresh token that the first attempt already spent, which is the "bricked connection" scare from `HIGHLEVEL_PLATFORM.md` §3. | Two mechanisms and one measurement. Firestore read-write transactions are pessimistic, so the second caller blocks on the first's read lock rather than racing it; and the transaction body re-reads and returns the other winner's token before it would refresh again (D23). The measurement is §3's correction of 2026-08-16: a reused refresh token still works once, so even if both mechanisms failed the connection survives. AC-26 asserts the one-refresh property against the emulator; if the emulator models locking differently the test fails loudly rather than the property being assumed. |
| R3 | **The allowlist is the only thing standing between a generated app and `DELETE /contacts/{id}` in a loop.** A matcher that is subtly too permissive — a greedy parameter that swallows a `/`, a prefix match where an exact match was meant — reopens the whole API. | D6 and D7 make over-permissiveness hard to express: parameters cannot contain `/` by grammar, and the upstream URL cannot contain anything but the template and those parameters. AC-2, AC-3 and AC-5 are written as *refusals*, and AC-6 asserts the assembled URL rather than the match, which is the property that actually matters. |
| R4 | **`GET /calendars/events` and `GET /calendars/:calendarId` are the same shape**, and whichever the matcher happens to try first wins. Ordering bugs of this kind pass every test written from the table's own order. | D6's specificity rule is order-independent and AC-4 proves it by running the matcher against a **reversed** copy of the table. |
| R5 | **`POST /conversations/messages` sends a real SMS or email**, costing money and reaching a real person — and the sandbox may fail it for want of a provisioned number, which reads as our bug. | D5: the row exists and is disabled unless `HL_ALLOW_MESSAGE_SEND` is set, which it is nowhere except the single integration case that flips it. It stays out of the Loom, as §6.2 advises. |
| R6 | **The recorded fixtures are three days old and HighLevel's shapes are only ⚠️-verified for `/contacts/search`'s filter DSL and `/conversations/search`'s query parameters** (§10 items 4). A proxy tested only against a stub built from those fixtures proves the proxy, not the integration. | The proxy forwards query and body opaquely (D11, D12), so a wrong filter grammar is a HighLevel 4xx surfaced with a `detail` rather than a Genesis bug — and Slice 9, which is where the grammar actually has to be right, owns it. The definition of done carries a manual `curl` per surface against the real sandbox, recorded in the review, so the gap is closed by evidence rather than by hope. |
| R7 | **Nothing limits how often a generated app calls the proxy**, and §5's burst ceiling is 100 requests / 10 seconds per location — reachable by a contact list that fires one detail call per row. | Bounded and named rather than solved (D34): 429 is mapped to a real message with HighLevel's own text attached, `X-RateLimit-Remaining` is forwarded and logged, and the actual fix — telling the model to use list endpoints and never N+1 — is Slice 9's system prompt. Per-user quota is stretch S4. |
| R8 | **App Check on the proxy is a constraint Slice 10 inherits**, and Slice 10 is already the build's hardest unknown. Discovering it there, mid-slice, would be expensive. | D16 records it explicitly along with the opaque-origin problem and the recommended shape (a parent-side `postMessage` bridge, so no credential enters the sandbox and the request stays same-origin). Slice 10 still owns the decision; it does not have to rediscover the constraints. |
| R9 | **This slice adds a screen element to a panel that already has six states**, and the plan's stated demo for Slice 8 is a `curl`. Scope creep here is easy to justify and hard to stop. | D30 fixes the ceiling: one section, one button, one line per surface, no new component, no new route, no new store. Everything larger — the preview, the file tree, an API explorer — is an out-of-scope row with a slice number against it. |

## Blocked

Nothing. Every question this slice raises is answered above.
