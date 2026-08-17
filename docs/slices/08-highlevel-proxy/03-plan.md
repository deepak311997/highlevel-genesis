# Slice 08 — HighLevel API proxy · Technical plan

**PRD:** `02-prd.md` (approved, treated as the contract) · **Branch:** `slice/08-highlevel-proxy` ·
**Date:** 2026-08-17

## Approach

The slice is built as four pure modules, one Firestore adapter, one handler and one panel
section, in that order — which is D35's build order, and it means the entire
security-relevant half is reviewable before a `.vue` file is touched. `hl/routes.ts` holds
the thirteen-row allowlist as exported **data** plus a specificity-ordered matcher and an
upstream-URL assembler; nothing in it reads the environment or Firestore, so Slice 9 can
import the table to render the cheat-sheet. `hl/proxyError.ts` is the pure
condition → `{ status, code, message, detail }` mapper for both upstream statuses and token
failures. `hl/tokenStore.ts` is the Firestore `TokenDeps` adapter Slice 2 deferred: a
fast-path read and a `runTransaction` that re-reads, short-circuits, rotates and persists.
`hl/proxy.ts` composes them — match, resolve, inject, forward, mirror, copy headers, log.

The structural security claim is D6, and the implementation makes it total rather than
best-effort: the upstream URL is assembled by substituting validated `[A-Za-z0-9_-]{1,64}`
parameters into the matched row's own `pattern` string, so no substring of the caller's raw
path can appear in it. The matcher is segment-based, so `..`, `%2F` and an empty segment are
values that fail the grammar rather than strings a filter has to catch.

Alternatives considered and rejected:

- **`hlRouter.all('/hl/proxy/*', …)` plus a second line for the bare path** — two lines,
  Express 4's positional `req.params[0]`, and it misses methods with no `router.<verb>` call.
  `hlRouter.use('/hl/proxy', …)` catches every method and the bare subtree in one line.
- **A second Firestore read for the `locationId`** — `resolveConnection()` returns the token
  *and* the location from the one read `getAccessToken()` already makes.
- **A `lease` field with the refresh outside the transaction** — D23's rejected alternative,
  restated here because the code shape tempts it: it adds a lock, an expiry policy and a
  stale-lease sweep for a hazard §3 measured as survivable.
- **A per-route Zod mirror of HighLevel's request bodies** — D11. The allowlist is the
  security control; the body's schema belongs to HighLevel.
- **Threading an error `code` through `ApiError` on the frontend** — deferred; see P14.

## Plan-level decisions

The PRD settles every product question. These are the implementation choices it left to this
stage, recorded because the build session will otherwise have to invent them.

| # | Decision | Rationale |
|---|---|---|
| **P1** | **`locationId` is a reserved key.** It is deleted from the caller's query string and from the top level of the caller's JSON body **on every row**, then re-added from the connection exactly when `locationIn` says so. | The strongest form of D8: a caller-supplied `locationId` never reaches HighLevel at all, on any route, so R1's second structural property holds without a per-row argument. Satisfies AC-8, AC-9 and AC-10 as written; slightly extends D11/D12's "forwarded verbatim", which is noted here rather than discovered at review. |
| **P2** | **Mount with `hlRouter.use('/hl/proxy', attested, asyncHandler(withVerifiedUser(handleProxy)))`.** | A *pathless* `router.use` runs twice, because `hlRouter` is mounted at both `/` and `/api` — that is the note already in `hl/index.ts`. A `use` **with a path** matches under exactly one of the two mounts, so it runs once. It is also the only form that catches every method (a `DELETE` must be refused with 403, not fall through to the app's 404) and the bare `/hl/proxy` (AC-23). |
| **P3** | **Forward the raw query string, not `req.query`.** Take everything after the first `?` of `req.originalUrl`, load it into `URLSearchParams`, apply P1, re-serialise. | `req.query` is qs-parsed: repeated parameters and bracket syntax cannot be round-tripped back to what the caller sent, and D12 promises verbatim forwarding. |
| **P4** | **`HttpError` gains an optional `detail`, rendered by `errorHandler`.** | D19 puts `detail` in the existing envelope. One envelope, one error handler; the alternative is the proxy writing its own error responses and a second failure shape in the codebase. |
| **P5** | **The upstream timeout is emulator-overridable** — `hlUpstreamTimeoutMs()`, honouring `HL_TEST_UPSTREAM_TIMEOUT_MS` only under `FUNCTIONS_EMULATOR`, defaulting to 20 000 ms. The integration and e2e scripts set 2 000; the fake's `__slow` sleeps 5 000. | Exactly `keepAliveMs()`'s precedent in `generate.ts`, for exactly its reason: AC-33 becomes a two-second test rather than a twenty-second one, and the real default is asserted at L1. The name appears in no `.env` file, so a shell value survives the emulator's `.env` precedence. |
| **P6** | **The 5 MiB cap is real, not overridden.** Enforced by a `Content-Length` short-circuit plus a chunk-counting read that aborts the controller when the cap is passed. | 5 MiB over localhost costs milliseconds, so there is nothing to buy by faking it — and a cap that is 5 MiB in production and 5 KiB in tests is a cap nobody has actually tested. |
| **P7** | **The rate-limit header list is one exported constant**, `RATE_LIMIT_HEADERS` in `hl/proxy.ts`, consumed by the handler (to copy) and by `api/index.ts` (for CORS `exposedHeaders`). | D18 needs the same five names in two places. Two literals is how they drift. |
| **P8** | **On `invalid_grant` the transaction must *commit*.** The refusal is signalled by returning a sentinel from the transaction body and throwing **after** `runTransaction` resolves. | Throwing from inside the body discards `needsReconnect: true` along with everything else, and AC-27 would fail for a reason that reads like a Firestore bug. This is the single most likely mistake in the slice. |
| **P9** | **A third typed log context**, `ProxyLogContext` in `lib/log.ts`, alongside `AuthLogContext` and `GenerationLogContext`. | The precedent is explicit in `lib/log.ts`: a narrow typed context per event family is what makes "no body, no token, no contact id" a property of the type rather than of whoever remembered. No field of `ProxyLogContext` matches `SENSITIVE_KEY`, so nothing useful is redacted away. |
| **P10** | **`resolveConnection()` is the new primary in `token.ts`; `getAccessToken()` delegates to it.** | The proxy needs the token *and* the `locationId`, from one read. Keeping `getAccessToken` means Slice 2's shipped unit tests stay green and later slices keep the simple entry point. |
| **P11** | **The frontend treats HTTP 409 as "reconnect".** | The PRD's failure table gives 409 exactly two meanings — `hl_reconnect_required` and `hl_not_connected` — and both are answered by the same button. See P14 for the rejected alternative. |

## Deviations from the PRD's test matrix

Three, each with the reason. Everything else maps exactly as the matrix states.

| AC | Matrix says | Plan says | Why |
|---|---|---|---|
| **AC-19** — no App Check token → `401 app_check_failed` | L4, `tests/integration/hl-proxy.spec.ts` | **L1**, `functions/src/auth/appCheck.spec.ts` — *"rejects a request carrying no App Check header"*, which already exists and already asserts the 401 and the code — plus review of the one mount line in `hl/index.ts` | `requireAppCheck` short-circuits under `FUNCTIONS_EMULATOR` and there is no App Check emulator, so **no emulator-backed test can observe the difference**. This is stated in as many words in `projects/index.ts`'s comment; the same comment goes on the proxy mount. Writing an L4 case here would produce a green test that proves nothing. |
| **AC-21** — send flag off *and* on | L4 for both halves | **L4 for "off"** (the suite's real state → `403 route_disabled`, and the fake records no call), **L1 for "on"** (`isRouteEnabled(row, env)` and the handler's branch) | The functions emulator's environment is fixed for the whole `emulators:exec` run, so a shell value that turns the flag on turns it on for every case in the suite — including the one that must prove the default. The safety-critical direction keeps the wire test. |
| **AC-33** — 20 s timeout | L4 | L4, with P5's emulator-only override at 2 000 ms; the **20 000 ms default** is asserted at L1 in `functions/src/hl/config.spec.ts` | A twenty-second case in a suite that runs on every push is a case people delete. |

Every other acceptance criterion maps to at least one task below, and the mapping is stated
per task. **No AC is unmapped.**

## File map

| File | New/Edit | What changes |
|---|---|---|
| `functions/src/hl/routes.ts` | **New** | `HlRoute` type; the thirteen-row `HL_ROUTES` table; `matchRoute(method, path)` returning a discriminated `RouteMatch`; `buildUpstreamUrl(row, params, rawQuery, locationId)`; `buildUpstreamBody(row, body, locationId)`; `isRouteEnabled(row, env)` |
| `functions/src/hl/routes.spec.ts` | **New** | AC-1 – AC-10, and AC-21's enabled/disabled branch |
| `functions/src/hl/proxyError.ts` | **New** | `mapUpstreamStatus(status, rawBody)` → `HttpError`; `mapTokenError(err)` → `HttpError`; `detailFrom(rawBody)` with the 200-character truncation; `isDefinitiveRefreshFailure(err)` |
| `functions/src/hl/proxyError.spec.ts` | **New** | AC-30, AC-32, AC-34 |
| `functions/src/hl/tokenStore.ts` | **New** | `storedTokensSchema`; `firestoreTokenDeps(): TokenDeps` — the fast-path `read` and the transactional `refresh`; `markNeedsReconnect(uid)` |
| `functions/src/hl/proxy.ts` | **New** | `RATE_LIMIT_HEADERS`; `logProxy(context)`; `forwardUpstream(...)` with the timeout and the size cap; `handleProxy(req, res, uid)` |
| `functions/src/hl/proxy.spec.ts` | **New** | AC-35 — the log line's fields, and that its type has nowhere to put a payload |
| `functions/src/hl/config.spec.ts` | **New** | `hlAllowMessageSend()` and `hlUpstreamTimeoutMs()`, including the 20 000 ms default |
| `functions/src/hl/token.ts` | Edit | `ConnectionSnapshot` gains `needsReconnect` and `locationId`; new `HlReconnectRequiredError` and `HlRefreshUnavailableError`; new `resolveConnection()`; `getAccessToken()` delegates to it |
| `functions/src/hl/token.spec.ts` | Edit | The `deps()` fixture gains the two new fields; new cases for the `needsReconnect` short-circuit (AC-29) and for `resolveConnection` returning the location |
| `functions/src/hl/config.ts` | Edit | `hlAllowMessageSend()`, `hlUpstreamTimeoutMs()` |
| `functions/src/hl/index.ts` | Edit | One mount line (P2) and the comment that replaces the "reserved for Slice 8" note, including the App Check-under-emulator caveat |
| `functions/src/hl/fake.ts` | Edit | The three surfaces replayed from `tests/fixtures/highlevel/*.json`; the `Authorization` + `Version` requirement; `locationId` filtering; the `__401` / `__429` / `__500` / `__slow` / `__huge` markers; `X-RateLimit-*` on every response |
| `functions/src/lib/errors.ts` | Edit | `HttpError` gains an optional `detail`; `errorHandler` includes it when present (P4) |
| `functions/src/lib/errors.spec.ts` | Edit | `detail` present and absent |
| `functions/src/lib/log.ts` | Edit | `ProxyLogContext` and `logProxyEvent` (P9) |
| `functions/src/lib/log.spec.ts` | Edit | The new context, and that its values go through `redact` |
| `functions/src/api/index.ts` | Edit | CORS `exposedHeaders: RATE_LIMIT_HEADERS` (D18, P7) |
| `functions/.env.example` | Edit | `HL_ALLOW_MESSAGE_SEND`, blank, with the comment saying why it defaults to off |
| `tests/integration/hl-proxy.spec.ts` | **New** | AC-11 – AC-18, AC-20 – AC-23, AC-31, AC-33 |
| `tests/integration/hl-token-refresh.spec.ts` | **New** | AC-24 – AC-28 |
| `tests/rules/firestore.spec.ts` | Edit | AC-36's missing operations — `list` and `update` on `hlConnections`; AC-37 re-asserted |
| `tests/e2e/highlevel.spec.ts` | Edit | AC-48 — the probe added to the existing connect walk |
| `package.json` | Edit | `HL_TEST_UPSTREAM_TIMEOUT_MS=2000` on `test:integration` and `test:e2e` (P5) |
| `frontend/src/lib/hlProxyApi.ts` | **New** | `hlProxy(method, path, payload?)` over `request` |
| `frontend/src/lib/hlProxyApi.spec.ts` | **New** | AC-38, AC-39 |
| `frontend/src/stores/hl.ts` | Edit | `probe`, `probeResult`, `checkDataAccess()`, cleared by `reset()` |
| `frontend/src/stores/hl.spec.ts` | Edit | AC-40 – AC-42 |
| `frontend/src/components/ConnectionPanel.vue` | Edit | The Data access section and its five states |
| `frontend/src/components/ConnectionPanel.spec.ts` | Edit | AC-43 – AC-47 |
| `docs/IMPLEMENTATION_PLAN.md` | Edit | §0 status, §4 Slice 8, §9 rows for F7.1, F7.2, F8.3 |
| `docs/PRODUCT_SPEC.md` | Edit | §3's `api/hl/*` line marked shipped |
| `docs/slices/08-highlevel-proxy/04-build-log.md` | **New** | Written by the build stage |

**Unchanged, deliberately:** `firestore.rules` (D33 — no new collection, no new field, no new
index), `functions/src/hl/connection.ts` (its projection schema must never gain token fields),
`frontend/src/lib/api.ts` and `apiClient.ts` (P14).

## Task list

Ordered so each task leaves the suite green and nothing depends on a later task to compile.
Tasks T1–T7 are pure functions and their L1 tests; T8–T13 wire them up behind the emulator;
T14–T17 are the frontend; T18 is documentation.

---

### T1 — The allowlist table and the matcher → AC-1, AC-2, AC-3, AC-4, AC-5, AC-7

- **Red:** `functions/src/hl/routes.spec.ts`
  - *"matches every row in the table with its version, scope and locationIn intact"* —
    `it.each` over all thirteen rows with a legal concrete path (AC-1).
  - *"refuses a route that is not on the table"* — `DELETE /contacts/abc123`,
    `POST /contacts/upsert`, `POST /calendars/events/appointments`, `GET /locations/abc123`,
    `GET /users/`, and `/` (AC-2).
  - *"refuses an allowlisted path reached with the wrong method"* — `GET /contacts/search`,
    `DELETE /calendars/` (AC-3).
  - *"prefers a literal segment to a parameter regardless of table order"* —
    `GET /calendars/events` → row 11, `GET /calendars/2oKn7but6Q2WaHIu7pqC` → row 10, run
    **twice: once against `HL_ROUTES` and once against `[...HL_ROUTES].reverse()`** (AC-4).
  - *"refuses a path parameter outside the grammar"* — `..`, `a/b`, `a%2Fb`, 65 characters,
    an empty segment, `abc.123`; each yields `{ kind: 'invalid_path' }` and never a row
    (AC-5).
  - *"normalises a trailing slash"* — `GET /calendars` and `GET /calendars/` both match row 9
    (AC-7, first half).
- **Green:** `functions/src/hl/routes.ts`.
  - ```ts
    export interface HlRoute {
      method: 'GET' | 'POST' | 'PUT'
      /** The HighLevel path, exactly as sent upstream. `:name` marks a parameter. */
      pattern: string
      version: '2021-07-28' | '2021-04-15'
      scope: string
      locationIn: 'query' | 'body' | null
      /** Set on a row that is refused unless this environment variable is set. */
      flag?: 'HL_ALLOW_MESSAGE_SEND'
    }
    export type RouteMatch =
      | { kind: 'matched'; row: HlRoute; params: Record<string, string> }
      | { kind: 'not_allowed' }
      | { kind: 'invalid_path' }
    ```
  - `HL_ROUTES: readonly HlRoute[]` — the PRD's thirteen rows verbatim, in table order, each
    with a one-line comment where the row's `locationIn` is not obvious.
  - `PARAM = /^[A-Za-z0-9_-]{1,64}$/` — the same grammar as `projectIdSchema`, referenced in
    a comment so the two are known to be one rule.
  - `segmentsOf(path)` = `path.split('/').filter((s) => s !== '')`. Dropping empty segments is
    what makes `/calendars` and `/calendars/` the same request, and what makes a doubled
    slash unremarkable.
  - `matchRoute(method, path)`: take candidates whose `method` matches **and** whose segment
    count matches **and** whose every literal segment is equal; order them by their literal
    mask compared left to right (literal beats parameter at the earliest differing position),
    take the first; then validate that row's parameter segments against `PARAM` — any failure
    is `invalid_path`. No candidates at all is `not_allowed`. The ordering is computed, never
    read off the table, which is what makes AC-4's reversed-table case pass.
  - **Segments are validated undecoded.** A legal HighLevel id contains no `%`, so
    `%2E%2E%2F` fails the grammar rather than becoming `../` after a decode we would then have
    to re-check.
- **Refactor:** the module-level doc comment carries D6's claim and D2's "one table, three
  consumers" so Slice 9 finds the contract at the top of the file it imports.

### T2 — Upstream URL, `locationId` injection → AC-6, AC-7, AC-8, AC-9, AC-10

- **Red:** `functions/src/hl/routes.spec.ts`
  - *"builds the upstream URL from the row's template, never from the caller's path"* — the
    URL starts with `hlApiBase()`, its pathname equals the pattern with parameters
    substituted and `encodeURIComponent`-encoded, and a hostile raw path contributes nothing
    beyond its accepted parameters (AC-6).
  - *"assembles `/calendars/` for both `/calendars` and `/calendars/`"* (AC-7, second half).
  - *"writes our locationId over the caller's in the body, leaving every other field"* — a
    body carrying another location plus two unrelated fields (AC-8).
  - *"writes our locationId into the query once, leaving unrelated parameters"* — a query
    carrying another location plus two unrelated parameters (AC-9).
  - *"adds no locationId on a row that takes none"* — and, per P1, *removes* one the caller
    supplied (AC-10).
- **Green:**
  - `buildUpstreamUrl(row, params, rawQuery, locationId): URL` — substitute `:name` in
    `row.pattern` (which preserves the trailing slash by construction), join to `hlApiBase()`,
    then `const q = new URLSearchParams(rawQuery); q.delete('locationId'); if (row.locationIn === 'query') q.set('locationId', locationId)`.
  - `buildUpstreamBody(row, body, locationId): unknown` — for a non-object body, return it
    unchanged; otherwise shallow-copy, `delete locationId`, and re-add when
    `row.locationIn === 'body'`.
- **Refactor:** state in a comment that `buildUpstreamUrl` takes the *matched row* and never
  a string, because that is the whole of D6.

### T3 — `HttpError` carries a `detail` → supports AC-32

- **Red:** `functions/src/lib/errors.spec.ts` — *"includes a detail when the error carries
  one"* and *"omits the key entirely when it does not"*.
- **Green:** a fourth constructor parameter `readonly detail?: string`; `errorHandler` builds
  `{ error, code, ...(err.detail === undefined ? {} : { detail: err.detail }) }`. The spread
  rather than an assignment because `exactOptionalPropertyTypes` distinguishes an absent key
  from an explicit `undefined`, and the wire shape should not carry `"detail": null`.
- **Refactor:** none expected; the change is four lines.

### T4 — The upstream error mapper → AC-30, AC-32, AC-34

- **Red:** `functions/src/hl/proxyError.spec.ts`
  - *"maps every upstream status to its own code"* — `it.each` over 401 → `409
    hl_reconnect_required`, 403 → `403 hl_forbidden`, 404 → `404 hl_not_found`, 429 → `429
    hl_rate_limited`, 400 → `400 hl_bad_request`, 422 → `400 hl_bad_request`, 503 → `502
    hl_unavailable`, 418 → `400 hl_bad_request` (AC-30).
  - *"never answers 401, whatever HighLevel said"* — the regression D20 names: a mirrored 401
    signs the user out of Genesis.
  - *"carries HighLevel's message as detail, truncated to 200 characters"*, and *"omits detail
    for a body it cannot parse"* (AC-32).
  - *"puts no token and no uid in any mapped error"* — build the mapper's output for every
    status from a body containing an access token, a refresh token and a uid, and assert none
    appears in `JSON.stringify` of the result (AC-34).
  - *"treats only invalid_grant as definitive"* — `isDefinitiveRefreshFailure` true for a 400
    carrying `invalid_grant`, false for a 400 without it, a 500, and a plain `Error`.
- **Green:** `functions/src/hl/proxyError.ts`. `detailFrom(raw)` parses the body and reads
  `message` (HighLevel's field, per `location-401-missing-scope.json`), falling back to
  `error_description`, then `error`; truncates at 200 characters; returns `undefined` for
  anything unparseable or non-string. `mapUpstreamStatus` returns an `HttpError` per the
  PRD's table. `mapTokenError` turns `HlNotConnectedError` → `409 hl_not_connected`,
  `HlReconnectRequiredError` → `409 hl_reconnect_required`,
  `HlRefreshUnavailableError` → `502 hl_unavailable`, and rethrows anything else.
- **Refactor:** the user-facing message strings live in one `const` map beside the codes, so
  the F8.3 copy can be read in one place.

### T5 — `needsReconnect` short-circuit and `resolveConnection` → AC-29, AC-24 (decision half)

- **Red:** `functions/src/hl/token.spec.ts`
  - *"refuses a connection already marked needsReconnect, without reading a token or
    refreshing"* — `deps.refresh` not called, rejection is `HlReconnectRequiredError` (AC-29).
  - *"returns the stored token and the connection's location without a refresh when fresh"*
    (AC-24's pure half).
  - *"refreshes and still returns the connection's location when inside the skew"*.
- **Green:** `functions/src/hl/token.ts` — `ConnectionSnapshot` gains `needsReconnect: boolean`
  and `locationId: string`; `HlReconnectRequiredError` and `HlRefreshUnavailableError` join
  `HlNotConnectedError`; `resolveConnection(uid, deps, now)` returns
  `{ accessToken, locationId }` from one `deps.read`; `getAccessToken` becomes
  `(await resolveConnection(...)).accessToken`. The existing `deps()` fixture in the spec gains
  the two fields, and every case Slice 2 shipped stays as it is.
- **Refactor:** move the "why five minutes early" comment so it still sits above `SKEW_MS`.

### T6 — The send flag and the upstream timeout → AC-21 (enabled half), AC-33 (default)

- **Red:** `functions/src/hl/config.spec.ts`
  - *"the send route is disabled unless HL_ALLOW_MESSAGE_SEND is set"* — unset, empty and
    `'false'` are all off; `'true'` is on.
  - *"the upstream timeout is twenty seconds"*, and *"honours the test override only under the
    emulator"*.
  - `functions/src/hl/routes.spec.ts` — *"a flagged row is enabled only when its variable is
    set"*, over `isRouteEnabled(row, env)` for both a flagged and an unflagged row (AC-21's
    enabled half; see the deviation table).
- **Green:** `hlAllowMessageSend()` reads `HL_ALLOW_MESSAGE_SEND` and returns true only for
  `'true'`; `hlUpstreamTimeoutMs()` returns `emulatorOverride('HL_TEST_UPSTREAM_TIMEOUT_MS')`
  parsed as a positive finite number, else `UPSTREAM_TIMEOUT_MS = 20_000`. `isRouteEnabled`
  lives in `routes.ts` and takes the environment as an argument, so the table module stays
  pure and testable; `proxy.ts` calls it with `process.env`.
- **Refactor:** `functions/.env.example` gains `HL_ALLOW_MESSAGE_SEND=` with the comment
  explaining that `POST /conversations/messages` sends a real SMS or email, costs money and
  reaches a real person, so it is off in every environment including the tests.

### T7 — The proxy log line → AC-35

- **Red:** `functions/src/hl/proxy.spec.ts` — spy on `console.info`:
  - *"emits exactly one hl.proxy line carrying the pattern, the status, a duration and the
    rate-limit remainder"*.
  - *"logs the matched pattern rather than the concrete path"* — the line contains
    `/contacts/:contactId` and not the id that was called.
  - *"has nowhere to put a body, a token or a contact"* — assert the emitted object's keys are
    exactly the five expected ones.
- **Green:** `ProxyLogContext { pattern, status, durationMs, rateLimitRemaining }` and
  `logProxyEvent` in `lib/log.ts`; `logProxy(context)` exported from `proxy.ts`, projecting
  field by field exactly as `logGeneration` does and for the same stated reason.
- **Refactor:** none.

### T8 — The boundary: mount, match, refuse → AC-17, AC-18, AC-20, AC-22, AC-23, AC-29 (wire), AC-19 (by note)

- **Red:** `tests/integration/hl-proxy.spec.ts` — a new file with the `hl-connection.spec.ts`
  harness (seeded users, `seedConnection`, `auth(token)`), asserting:
  - *"refuses a request with no Authorization header"* → 401 `unauthenticated`, and
    `hlConnections/{uid}` is untouched (AC-17).
  - *"refuses a caller whose email is not verified"* → 403 `email_unverified` (AC-18).
  - *"refuses a route that is not on the allowlist"* → `DELETE /api/hl/proxy/contacts/abc123`
    → 403 `route_not_allowed`, with no connection read and no upstream call (AC-20).
  - *"refuses the bare subtree rather than 404ing"* → `GET /api/hl/proxy` → 403
    `route_not_allowed` (AC-23).
  - *"refuses a right path with a wrong method"* → `GET /api/hl/proxy/contacts/search` → 403.
  - *"refuses a bad path parameter"* → `/api/hl/proxy/contacts/%2E%2E%2Foauth` → 400
    `invalid_path`.
  - *"refuses the disabled send route"* → `POST /api/hl/proxy/conversations/messages` → 403
    `route_disabled` — and **not** `route_not_allowed`, which is what distinguishes a safed
    row from an absent one (AC-21, off half).
  - *"answers hl_not_connected when there is no connection document"* → 409, no upstream call
    (AC-22).
  - *"refuses a connection already marked needsReconnect"* → 409 `hl_reconnect_required`
    (AC-29 over the wire).
- **Green:**
  - `functions/src/hl/tokenStore.ts` — `storedTokensSchema` (Zod, parsing `accessToken`,
    `refreshToken`, `expiresAt` via `firestoreTimestamp` from `users/schema`, `locationId`,
    `needsReconnect` with `.catch(false)`), and `firestoreTokenDeps().read`. A document that
    does not parse is treated as **no connection** — `handleGetConnection`'s precedent, with a
    `logAuthEvent('hl.tokens.unreadable')` line carrying no field of the document.
  - `functions/src/hl/proxy.ts` — `handleProxy` down to the point of the upstream call:
    match → flag → `resolveConnection` → *(next task)*. Every refusal goes through
    `mapUpstreamStatus`/`mapTokenError` so there is one place that decides a status.
  - `functions/src/hl/index.ts` — the P2 mount line, plus the comment recording that
    `requireAppCheck` short-circuits under the emulator so this route's attestation is
    verified by reading the line (AC-19's note).
  - **Ordering check:** the mount goes above `hlRouter.use(buildFakeHlRouter(...))` and does
    not collide with `/__fake-hl`. The `cors()` middleware answers preflight `OPTIONS` before
    the router, so no `OPTIONS` reaches the matcher.
- **Refactor:** pull the seeded-connection helper into the spec's own top-level function
  rather than importing across spec files; the two integration suites want different defaults.

### T9 — The upstream call → AC-11, AC-12, AC-13, AC-14, AC-15, AC-16, AC-21 (enabled, at L1)

- **Red:** `tests/integration/hl-proxy.spec.ts`
  - *"returns HighLevel's body byte for byte with its status"* — `POST /contacts/search`
    against the fake, `res.raw` equal to the fake's own serialisation, status 200, and the
    five `X-RateLimit-*` headers present with the upstream values (AC-15).
  - *"mirrors a 201 on a create"* — `POST /api/hl/proxy/contacts/` (AC-16).
  - *"attaches our Authorization, the row's Version and Accept"* — two assertions. The fake
    refuses any surface request missing `Authorization` or `Version`, so reaching a 200 at all
    is the first; the second reads `GET /api/hl/proxy/contacts/__echo`, a marker id that
    matches row 2 by the ordinary grammar and makes the fake answer with the headers it
    received. `__echo` on a contacts row and on a calendars row gives `2021-07-28` and
    `2021-04-15` (AC-12, AC-14).
  - *"forwards no header the caller sent"* — the caller sends `Version: v3`, `Cookie` and
    `X-Forwarded-For` alongside its valid Firebase `Authorization`; `__echo` shows the row's
    version and the **stored** access token as the bearer, and shows neither the cookie nor
    the forwarded address (AC-13).
  - The echo lives on a marker id rather than on every surface's response body, so the three
    surfaces keep answering their fixtures unchanged — which is what AC-15's byte-identity
    assertion is measured against.
  - *"gives each user only their own location's records"* — alice on
    `lUanVn0CtZJTlymH8ySo`, bob on `aB9zzQ1CtZJTlymH8ySo`; bob names alice's location in the
    body and still receives an empty set (AC-11).
- **Green:**
  - `functions/src/hl/fake.ts` — the three surfaces. This is test infrastructure whose red
    step is the integration test above; it has no L1 test of its own beyond the existing
    "no routes outside the emulator" case, and the plan says so rather than inventing one.
    - `loadFixture(name)` anchored on `__dirname` exactly as `llm/fake.ts`'s `loadEvents`
      (`resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'highlevel', name)`), read
      **inside the handler**, never at module scope, because `tests/` does not deploy.
    - A guard applied to the surface routes only: no `Authorization: Bearer …` or no
      `Version` header → `401 { message: '…' }`. This is what proves the proxy attaches them.
    - Every response carries the five `X-RateLimit-*` headers. The `__echo` marker id answers
      with the request headers the fake received, so AC-12 – AC-14 have something exact to
      assert on without a control API and without polluting the fixture responses.
    - Filtering: `POST /contacts/search` reads `locationId` from the body,
      `GET /conversations/search` and `GET /calendars/` from the query; each filters its
      fixture array by that value and recomputes `total`. A location with no records answers
      an empty array, not a 404 — which is what makes AC-11 an observable result rather than
      an assertion about an argument.
    - Literal routes are registered before parameter routes (`/calendars/events` before
      `/calendars/:calendarId`), because Express matches in registration order.
  - `functions/src/hl/proxy.ts` — `forwardUpstream`: exactly four headers
    (`Authorization`, `Version`, `Accept`, and `Content-Type` on writes), the assembled URL,
    the serialised body on `POST`/`PUT`; mirror the status; copy `RATE_LIMIT_HEADERS`;
    `res.status(upstream.status).type('application/json').send(text)`.
  - `functions/src/api/index.ts` — `exposedHeaders: RATE_LIMIT_HEADERS` on the `cors()` call.
- **Refactor:** the fake's per-surface handlers collapse into a small helper that takes a
  fixture name, a collection key and where to read `locationId` from — thirteen routes should
  not be thirteen copies of the same six lines.

### T10 — Upstream failures over the wire → AC-31, AC-32 (wire), AC-33, AC-34 (wire)

- **Red:** `tests/integration/hl-proxy.spec.ts`
  - *"turns an upstream 401 into a 409 and marks the connection"* — `GET
    /api/hl/proxy/contacts/__401` → 409 `hl_reconnect_required`, and
    `hlConnections/{uid}.needsReconnect` is now true, and the response is **never** 401
    (AC-31).
  - *"forwards HighLevel's own message as detail"* — the body carries `detail`, and it is
    HighLevel's text (AC-32 over the wire).
  - *"maps a 429 with the rate-limit headers still attached"* — `__429`.
  - *"aborts an upstream that will not answer"* — `__slow` → 504 `hl_timeout` (AC-33).
  - *"refuses an upstream body over the cap"* — `__huge` → 502 `hl_too_large` (AC-33).
  - *"puts no token in any error response"* — assert on `res.raw` against the seeded access
    and refresh tokens for each of the above (AC-34 over the wire).
- **Green:**
  - `tokenStore.markNeedsReconnect(uid)` — a plain `update` of `needsReconnect` and
    `updatedAt`, no transaction: it is idempotent and there is nothing to read first.
  - `forwardUpstream` gains one `AbortController`, a `setTimeout` that aborts and sets a
    `timedOut` flag, cleared in a `finally`; and a capped read — `Content-Length` over
    `MAX_UPSTREAM_BYTES = 5 * 1024 * 1024` short-circuits, otherwise the body is consumed
    chunk by chunk with a running byte count that aborts the controller when it is passed. A
    null body reads as an empty string.
  - `handleProxy` catches: `timedOut` → `504 hl_timeout`; the cap → `502 hl_too_large`; any
    other fetch rejection → `502 hl_unavailable`; a non-2xx status → `markNeedsReconnect`
    first if it is 401, then `mapUpstreamStatus`.
  - The fake gains the five markers, recognised in any path parameter: `__401`, `__429`,
    `__500`, `__slow` (sleep 5 000 ms) and `__huge` (just over 5 MiB).
- **Refactor:** the marker check becomes one helper in the fake, called from each surface, so
  a new surface inherits every failure case.

### T11 — The transactional refresh → AC-24, AC-25, AC-26, AC-27, AC-28

The slice's one real concurrency hazard (D23, R2), and the reason it gets its own file.

- **Red:** `tests/integration/hl-token-refresh.spec.ts`
  - *"uses the stored token and opens no transaction when it is fresh"* — `expiresAt` an hour
    out; the fake echoes the bearer it received, and it is the seeded one; the stored
    `refreshToken` is unchanged (AC-24).
  - *"rotates inside the skew and persists all three fields"* — `expiresAt` two minutes out;
    afterwards `accessToken`, `refreshToken` and `expiresAt` have all changed,
    `needsReconnect` is still false, and the call succeeded (AC-25).
  - *"performs exactly one refresh for three concurrent calls"* — three
    `POST /api/hl/proxy/contacts/search` issued with `Promise.all` against a connection two
    minutes from expiry; all three answer 200, and the persisted `refreshToken` is the one the
    single refresh returned. The refresh count is read from a counter the fake exposes at
    `GET /__fake-hl/__refresh-count` — a test-only counter on a test-only router, reset per
    case (AC-26).
  - *"marks the connection and keeps the refresh token when the grant is dead"* — seed
    `refreshToken: 'dead-…'`, which the fake already answers `invalid_grant` for;
    `needsReconnect` becomes true, `refreshToken` is **unchanged**, the caller gets 409
    `hl_reconnect_required` (AC-27).
  - *"writes nothing when the refresh fails transiently"* — seed `refreshToken: 'boom-…'`,
    which the fake already answers 500 for; `accessToken`, `refreshToken`, `expiresAt` and
    `needsReconnect` are all exactly as seeded, and the caller gets 502 `hl_unavailable`
    (AC-28).
- **Green:** `firestoreTokenDeps().refresh(uid)`:
  ```
  runTransaction(async tx => {
    parse(await tx.get(ref))                     // fail closed on an unusable document
    if (isFresh(...)) return { kind: 'reused', accessToken }   // D23's short-circuit
    try { next = await refreshTokens(stored.refreshToken) }
    catch (err) {
      if (isDefinitiveRefreshFailure(err)) {
        tx.update(ref, { needsReconnect: true, updatedAt: serverTimestamp() })
        return { kind: 'dead' }                  // P8 — the transaction must COMMIT
      }
      throw new HlRefreshUnavailableError()      // aborts; nothing is written (D26)
    }
    tx.update(ref, { accessToken, refreshToken, expiresAt, updatedAt })
    return { kind: 'rotated', accessToken }
  })
  ```
  then, **outside** the transaction, `dead` → throw `HlReconnectRequiredError`.
- **Refactor:** the file's doc comment carries D23 in full — the pessimistic-locking
  property, the re-read short-circuit, and §3's measured grace window as the residue. This is
  the comment a future reader needs most, and the place a "clever" refactor would break the
  slice.
- **Note:** if the emulator does not serialise the two `tx.get`s and AC-26 sees two refreshes,
  that is a **finding to record, not a test to weaken** — the plan's answer is R2's: the
  measured grace window means the connection survives, and the build log says so.

### T12 — Rules re-asserted → AC-36, AC-37

- **Red:** `tests/rules/firestore.spec.ts`, in the existing `server-only collections` describe:
  - *"denies a verified owner listing hlConnections"* — `getDocs(collection(alice, 'hlConnections'))`.
  - *"denies a verified owner updating their own connection"* — `updateDoc(..., { needsReconnect: false })`,
    seeded past the rules first so the update has a document to be denied on. This is the one
    a client would actually want: clearing the flag this slice sets.
  - The existing read/create/delete/stranger/anonymous cases stay and are the rest of AC-36;
    AC-37's four collections are already covered and are re-run unchanged.
- **Green:** nothing. **No rules change is needed** (D33) — a rule that denies a document
  denies it whatever fields it holds. The commit is the test plus a comment in
  `firestore.rules` recording that `hlConnections/{uid}` now has a second writer.
- **Refactor:** none.

### T13 — The typed client → AC-38, AC-39

- **Red:** `frontend/src/lib/hlProxyApi.spec.ts`, in `hlApi.spec.ts`'s shape (hoisted mocks
  for `@/lib/firebase` and `@/lib/appCheck`, a stubbed `fetch`):
  - *"POSTs a JSON body to the proxy path"* — `hlProxy('POST', '/contacts/search', { pageLimit: 1 })`
    → URL `/api/hl/proxy/contacts/search`, method POST, body the serialised payload,
    `Authorization: Bearer …` and `X-Firebase-AppCheck` present (AC-38).
  - *"GETs with no body and the payload as a query string"* — `hlProxy('GET', '/calendars/')`
    has no body; `hlProxy('GET', '/conversations/search', { limit: 1 })` sends `?limit=1`
    (AC-38).
  - *"rejects with an ApiError carrying the server's message and status"* — a 409 with
    `{ error: 'Your HighLevel connection expired.' }` (AC-39).
  - `frontend/src/lib/no-firestore.spec.ts` runs unchanged and now scans the new file
    (AC-39's second half) — no edit needed.
- **Green:** `frontend/src/lib/hlProxyApi.ts` — a thin wrapper over `request`, whose module
  comment states that its argument order is `HIGHLEVEL_PLATFORM.md` §8's `hl()` convention
  **because Slice 10's shim will mirror it** and Slice 9 teaches the model that exact string.
- **Refactor:** none.

### T14 — The store probe → AC-40, AC-41, AC-42

- **Red:** `frontend/src/stores/hl.spec.ts`, mocking `@/lib/hlProxyApi`:
  - *"holds a count per surface when all three succeed"* — `probe === 'ready'` (AC-40).
  - *"keeps the other two counts when one surface fails"* — the failing surface carries its
    message, the others carry numbers (AC-40).
  - *"reads a missing or non-numeric total as no count rather than NaN"* — `{}` and
    `{ total: 'lots' }` both give `null` (AC-41).
  - *"issues exactly the three probe calls"* — `POST /contacts/search { pageLimit: 1 }`,
    `GET /conversations/search { limit: 1 }`, `GET /calendars/` (D31).
  - *"clears the probe on reset"* — `probe` back to `idle`, `probeResult` null (AC-42).
  - *"flags a 409 as needing a reconnect"* — the surface's `reconnect` is true (P11,
    supporting AC-46).
- **Green:** `frontend/src/stores/hl.ts`:
  ```ts
  export interface SurfaceProbe { count: number | null; error: string | null; reconnect: boolean }
  export interface ProbeResult { contacts: SurfaceProbe; conversations: SurfaceProbe; calendars: SurfaceProbe }
  probe: Ref<'idle' | 'loading' | 'ready' | 'error'>
  probeResult: Ref<ProbeResult | null>
  checkDataAccess(): Promise<void>
  ```
  `Promise.allSettled` over the three calls; `probe` becomes `'error'` only when all three
  rejected — one failure is a row-level outcome, not a section-level one, which is the PRD's
  "one failure does not blank the others". `reset()` clears both new refs, beside the five it
  already clears. Counts are narrowed by hand (D32): `total` must be a finite number, and
  calendars uses the `calendars` array's length.
- **Refactor:** the three surfaces become one `SURFACES` array of
  `{ key, method, path, payload, read }`, so the store body is a `map` and adding a fourth
  surface is a row.

### T15 — The Data access section → AC-43, AC-44, AC-45, AC-46, AC-47

- **Red:** `frontend/src/components/ConnectionPanel.spec.ts` — the existing hoisted store mock
  gains `probe`, `probeResult` and `checkDataAccess`:
  - *"offers Check data access when connected, and issues nothing on mount"* —
    `data-access-check` present, `checkDataAccess` not called (AC-43).
  - *"shows a loading state and disables the button while the probe runs"* (AC-44).
  - *"renders one row per surface with its count"* (AC-44).
  - *"renders an empty state for a surface that answered zero"* — `0` renders "None yet", not
    an error (AC-45).
  - *"renders an em dash for a surface with no usable count"* (AC-41's UI half).
  - *"offers Reconnect HighLevel when a surface needs one, and calls connect once"* —
    `data-access-reconnect`, distinct from the panel's existing `connection-connect` (AC-46).
  - *"renders nothing at all when the user is not connected"* (AC-47).
- **Green:** the section lives **inside the existing connected branch** of
  `ConnectionPanel.vue`, which is what makes AC-47 fall out rather than needing its own guard
  — and it means the reconnect-required panel state keeps its own screen, exactly as the
  user flow's step 8 describes. Five states, all present: idle (button plus one line of
  explanation), loading, result, per-row empty, and error with Reconnect. Test ids:
  `data-access`, `data-access-check`, `data-access-loading`, `data-access-row-contacts` /
  `-conversations` / `-calendars`, `data-access-error`, `data-access-reconnect`.
- **Refactor:** the three rows become a `v-for` over the store's result, so the template has
  one row in it rather than three near-copies.

### T16 — End to end → AC-48

- **Red:** `tests/e2e/highlevel.spec.ts` — extend the existing *"connect the sandbox location"*
  test rather than adding a second connect walk: after `connection-location` reads
  *India Square*, click `data-access-check` and expect each of the three rows to show a
  numeric count (`/\d+/`, not a hard-coded 5 — the fixtures are recorded data and a count is
  the assertion, not its value).
- **Green:** nothing new; if this fails, the failure is in T8–T15 and belongs there.
- **Refactor:** none.

### T17 — Documentation

- **Red:** none — this task genuinely cannot start with a failing test, and says so rather
  than pretending. Nothing in it is executable.
- **Green:**
  - `docs/IMPLEMENTATION_PLAN.md` §0 status table (Slice 8), §4's Slice 8 entry, and §9's rows
    for F7.1, F7.2 and F8.3. §9's F1.2/F1.3 rows still read "⏭ next" for a slice that merged;
    correct them in the same pass.
  - `docs/PRODUCT_SPEC.md` §3's `api/hl/*` line marked shipped.
  - A README delta noted in the build log for Slice 13: the allowlist table is a README
    section, and `HL_ALLOW_MESSAGE_SEND` is a deployment note.
- **Refactor:** none.

## Firestore rules changes

**None.** D33: no new collection, no new field, no new index. `hlConnections/{uid}` already
carries `accessToken`, `refreshToken`, `expiresAt`, `locationId`, `needsReconnect` and
`updatedAt`, and the rule is already the only one it needs:

```
match /hlConnections/{uid} {
  allow read, write: if false;
}
```

What the commit adds is **proof**, because this is the slice that gives the document a second
writer. T12's L3 cases, in `tests/rules/firestore.spec.ts`:

| Case | Client | Operation | Expected |
|---|---|---|---|
| existing | verified owner | `getDoc` | denied |
| **new** | verified owner | `getDocs` on the collection | denied |
| existing | verified owner | `setDoc` | denied |
| **new** | verified owner | `updateDoc({ needsReconnect: false })` on a seeded document | denied |
| existing | verified owner | `deleteDoc` | denied |
| existing | another verified user | read + write | denied |
| existing | anonymous | read + write | denied |

The new update case is the one that matters: it is the write a client would actually want,
now that a server path sets `needsReconnect: true`. AC-37's re-assertion is the existing
`users/{uid}`, `users/{uid}/projects/{projectId}`, `.../messages/{messageId}` and
`authThrottle/{key}` cases, re-run unchanged.

## Dependencies

**None.** No new package in `functions`, `frontend` or the root — which is D35's claim and
`IMPLEMENTATION_PLAN.md` §4's "Libraries: none — a hand-written `fetch` wrapper, deliberately."

Two existing dependencies are leaned on and worth naming: `zod` for `storedTokensSchema` at
the Firestore boundary, and Node 22's built-in `fetch`/`AbortController`/`URLSearchParams`
for the upstream call. No shadcn-vue component is vendored; the section reuses `Alert`,
`Button` and the existing `Card` body.

## Manual verification

On emulators, from a fresh clone:

```bash
npm run install:all
npm run dev                     # emulators + SPA, HighLevel stubbed
```

1. Sign up, verify through the emulator's oobCode link, land on the dashboard.
2. **Connect HighLevel** → Approve on the fake consent screen → the panel reads
   *Connected to India Square*.
3. The **Data access** section is idle: a button and one line of explanation, and the network
   tab shows **no** `/api/hl/proxy` request yet (AC-43).
4. Press **Check data access** → the button disables, a loading state appears, then three
   rows with counts. The network tab shows exactly three requests:
   `POST /api/hl/proxy/contacts/search`, `GET /api/hl/proxy/conversations/search?limit=1`,
   `GET /api/hl/proxy/calendars/`.
5. The `curl` half of the demo — take the ID token from the browser's devtools:

   ```bash
   TOKEN='<idToken from the SPA>'
   BASE='http://127.0.0.1:5001/demo-genesis/asia-south1'
   curl -s -X POST "$BASE/hl/proxy/contacts/search" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"pageLimit":1}' | head -c 400
   curl -si -X DELETE "$BASE/hl/proxy/contacts/abc123" \
     -H "Authorization: Bearer $TOKEN" | head -n 1     # expect 403 route_not_allowed
   ```

   The first returns raw HighLevel JSON with the `X-RateLimit-*` headers on it; the second
   proves the confused-deputy refusal.
6. In another terminal, set the connection dead and watch the reconnect path:

   ```bash
   # Firestore emulator UI → hl-genesis → hlConnections/<uid> → needsReconnect = true
   ```

   Press **Check data access** again → the section shows the reason and a
   **Reconnect HighLevel** button.

**Against the real sandbox** (the definition of done's recorded check, for the review):
point `functions/.env.local` at the real HighLevel, reconnect, and run one `curl` per surface
with a real token, confirming the recorded fixtures still match the live shapes. Record the
three status codes and the top-level keys in `05-review.md`. **Do not** enable
`HL_ALLOW_MESSAGE_SEND` for this.

## Estimate

| Task | What | Estimate |
|---|---|---|
| T1 | Allowlist table and matcher | 1 h 15 |
| T2 | Upstream URL and `locationId` injection | 45 m |
| T3 | `HttpError.detail` | 15 m |
| T4 | Upstream error mapper | 45 m |
| T5 | `needsReconnect` short-circuit, `resolveConnection` | 30 m |
| T6 | Send flag, upstream timeout, `.env.example` | 30 m |
| T7 | Proxy log line | 20 m |
| T8 | Mount, match, refuse — the boundary at L4 | 1 h 15 |
| T9 | The upstream call, and the fake's three surfaces | **2 h** |
| T10 | Upstream failures over the wire | 1 h |
| T11 | The transactional refresh | **1 h 30** |
| T12 | Rules re-asserted | 20 m |
| T13 | The typed client | 30 m |
| T14 | The store probe | 45 m |
| T15 | The Data access section | 1 h |
| T16 | End to end | 30 m |
| T17 | Documentation | 30 m |
| | **Total** | **≈ 13 h 40** |

**Nothing exceeds half a day**, and the two largest are flagged: **T9** because it is
thirteen fake routes plus the header and filtering behaviour that make AC-11 and AC-12
meaningful, and **T11** because it is the slice's one real concurrency hazard and P8 is the
mistake that makes AC-27 fail for a reason that looks like something else. If the clock bites,
the honest cut is **not** these two — it is T15's row template polish, and nothing else in
the list.

## Risks this plan carries forward

| # | From the PRD | What the plan does about it |
|---|---|---|
| R1 | A mistake leaks another tenant's CRM | T1/T2 make D6 structural, P1 makes D8 total across every row, and T9's AC-11 gives two users two locations against a fake that filters by the `locationId` it received — so a proxy that forgot to inject returns the wrong set rather than failing an argument assertion |
| R2 | The refresh runs inside a transaction | T11, with P8 called out as the likely mistake and the "record it, do not weaken the test" instruction if the emulator models locking differently |
| R3 | The allowlist is the only thing between generated code and `DELETE` | T1's refusal cases and T2's URL assertion, which tests the assembled URL rather than the match |
| R4 | `/calendars/events` and `/calendars/:calendarId` | T1's reversed-table case; the ordering is computed, never read off the table |
| R5 | `POST /conversations/messages` sends a real message | T6's flag, off in every environment including the suite; the L4 case proves the refusal, and the deviation table says why the enabled half is L1 |
| R6 | Fixtures are three days old | The manual sandbox check above, recorded in the review |
| R7 | Nothing limits proxy call volume | Out of scope (D34); the 429 mapping and the forwarded headers are T10's |
| R8 | App Check is a constraint Slice 10 inherits | Recorded in D16 and repeated in `hl/index.ts`'s mount comment, which is where Slice 10 will look |
| R9 | Scope creep in a panel with six states | T15 is one section, one button, one row per surface, no new component and no new store |
