# Slice 08 — HighLevel API proxy · Review

**Reviewed:** 2026-08-18 · **Branch:** `slice/08-highlevel-proxy` · **Diff:** `main...HEAD`,
41 files, ~7 600 insertions (of which ~2 800 are the slice's own documents)

Reviewed as another author's PR, which is the honest frame: the build ran in sessions this one
does not share. The diff was read in full first, then six axes were run concurrently as
independent reviewers — correctness, security, architecture, performance, readability, and one
auditing the PRD's 48 acceptance criteria against the test bodies that claim to cover them rather
than against the matrix. Every finding below was re-verified against the source before it was
written down; the ones that could not be reproduced were dropped, and that is recorded at the end.

## Suite

Baseline taken from `.autopilot/logs/08/gate-post-build.2.log`, the orchestrator's gate on
`339f5b5` — not re-run, because it had already been run on that commit minutes before this stage
started. The right-hand column is after this review's fixes.

| Check | Gate (339f5b5) | After review |
|---|---|---|
| `typecheck` | clean | clean (functions, frontend, root) |
| `lint` | clean, zero warnings | clean, zero warnings |
| `test:unit` | 1 147 — 577 functions, 549 frontend, 21 scripts | **1 180** — 596 functions, 563 frontend, 21 scripts |
| `test:rules` | 30 | 30 (untouched) |
| `test:integration` | 265, 13 files | 265, 13 files (re-run, green) |
| `test:e2e` | 12 | 12 (untouched) |

Unit count moves by +33, and it accounts exactly:

| File | Before | After | Δ |
|---|---|---|---|
| `hl/tokenStore.spec.ts` *(new)* | — | 8 | +8 |
| `hl/index.spec.ts` *(new)* | — | 11 | +11 |
| `lib/hlProxyApi.spec.ts` | 9 | 21 | +12 |
| `hl/routes.spec.ts` | 79 | 88 | +9 |
| `hl/proxyError.spec.ts` | 42 | 44 | +2 |
| `stores/hl.spec.ts` | 31 | 33 | +2 |
| `hl/exchange.spec.ts` | 12 | 13 | +1 |
| `hl/token.spec.ts` | 14 | 11 | **−3** |
| `hl/config.spec.ts` | 16 | 7 | **−9** |

The two negatives are the deleted exports (F7). Nothing was weakened to get a green suite: the
assertions those blocks made that were not already made elsewhere were **moved**, and the rest
were duplicate coverage of `resolveConnection` and of a predicate now asserted against the
function that is actually wired. `npx prettier --check` also now passes on
`functions/src/hl/fake.ts`, which it did not: `lint` runs ESLint alone, so nothing caught it.

`test:integration` was re-run in full because five of the fixes are in modules it exercises;
`test:rules` and `test:e2e` were not, because nothing this review changed is reachable from them.

## Findings

Ordered by leverage. Severity is this review's, checked against the PRD's decisions table first —
two axis findings that turned out to be recorded trade-offs were demoted, and one was dropped.

| # | Severity | Finding | Action taken |
|---|---|---|---|
| F1 | **Critical** | **A retried Firestore transaction re-spends the refresh token, and bricks the connection.** `rotate()` puts the refresh network call inside `runTransaction`, and justified it with a re-read short-circuit that "stops a retry from re-spending a refresh token". It does not. The short-circuit only fires when *somebody else* committed a rotation; when *this* transaction's own commit is `ABORTED`, the SDK re-invokes the body against a document its own rolled-back `tx.update` did not change — same stale expiry, same refresh token. Against a HighLevel that rotates on use (§3), the second presentation is `invalid_grant`, which `isDefinitiveRefreshFailure` cannot tell from a genuinely dead grant: `needsReconnect: true` is written, the good grant the first attempt bought is discarded with the rollback, and the user must reinstall the marketplace app. Invisible to the whole suite, because the Firestore emulator does not retry the way production does *and* the fake token endpoint mints a fresh grant for any token it is shown — the emulator is a HighLevel that does not rotate. | Fixed test-first. `functions/src/hl/tokenStore.spec.ts` is new: a Firestore whose transaction body re-runs and discards non-final writes, against a HighLevel that spends a token on use and answers `400 invalid_grant` to a reuse. Three of its eight cases were red. `rotate()` now holds what it bought outside the body, keyed by the refresh token it presented, and a retry reuses that grant rather than re-presenting a spent token. Keyed rather than merely present, so a document another caller has since rotated is left alone. The comment now names three properties instead of conflating two. |
| F2 | Required | **A probe that lands after sign-out shows the previous account's CRM counts to the next user.** `checkDataAccess` writes `probeResult` and `probe` unconditionally after its `await`. Signing out is a route change, not a page load — `auth.ts`'s `signOutNow` exists for exactly that reason — so three requests in flight resolve after `reset()` has cleared the refs and refill them, with `probe` left at `ready`. The next person to sign in on that browser sees the previous account's contact, conversation and calendar counts under their own connection, and nothing ever clears them, because they never ran a probe. The PRD's own edge-case table promises the opposite ("*the user signs out while a probe is in flight → nothing stale for the next account*"), and `workspace.ts` already carries the mechanism and states the reason in as many words. | Fixed test-first. A failing case in `stores/hl.spec.ts` holds the three calls open across a `reset()`. A `generation` counter, bumped by `reset()`, now guards every write that lands after an `await` — `checkDataAccess` and `refresh` both. |
| F3 | Required | **Nothing bound App Check to the proxy mount.** AC-19 claimed `tests/integration/hl-proxy.spec.ts`; that file has no App Check case, and could not have one — `requireAppCheck` short-circuits under `FUNCTIONS_EMULATOR` and there is no App Check emulator. The middleware is well tested in isolation, but **deleting the word `attested` from `hl/index.ts:80` broke no test in the repo**. On D15's own reasoning that is the wrong thing to leave to a reading: an unattested caller here spends a finite third-party budget and can write to somebody's CRM. | Fixed. `functions/src/hl/index.spec.ts` is new: it replaces the middleware with one that behaves the way the deployed one does — refuses — and drives the router over a socket, mounted at both `/` and `/api` as `createApiApp` mounts it. Removing `attested` now fails six cases (verified by doing it). The double mount gets its own assertion too: attested **once** per request, which is what the pathful `use` buys. The two deliberately-unattested routes are asserted as unattested, so the file states the whole policy rather than half of it. |
| F4 | Required | **`hlProxy` interpolates its `path` argument, so `..` escapes the proxy prefix.** `` `${PROXY_BASE}${path}` `` is a relative URL and is *resolved* before it is sent: `/api/hl/proxy` + `/../../projects` is `/api/projects`, carrying this user's ID token and App Check header. Not reachable today — every caller is a literal in `stores/hl.ts`. It matters because the function's own docblock states the plan: Slice 10's `srcdoc` shim mirrors this signature so generated code calls `hl(...)` unchanged, with the fetch in the parent (D16) because the sandbox cannot attest. At that moment the path argument is LLM output, and this is the confused deputy the server-side allowlist exists to prevent, reintroduced one layer above it. | Fixed test-first — eight failing cases. `hlProxy` now tests its path against `routes.ts`'s own segment grammar before building a URL, so it refuses exactly what `matchRoute` would refuse and nothing a legal HighLevel path needs. Rejects with an `ApiError` rather than throwing, so one bad surface in the probe stays one bad surface. |
| F5 | Required | **The token endpoint had no timeout, and it runs inside the Firestore transaction.** The proxy's own upstream call has had a 20-second bound since D27; `postToken` had none, so undici's 300-second default was the only limit — on the one HighLevel call whose duration *is* a document lock's duration. A HighLevel that accepts the connection and then says nothing would hold `hlConnections/{uid}` until the function's own 60-second timeout, with every other proxied call for that user queued behind it burning its own budget, each occupying a concurrency slot. | Fixed test-first: a stalling `fetch` that only the signal can end, in `hl/exchange.spec.ts`. `postToken` now carries `AbortSignal.timeout(hlUpstreamTimeoutMs())` — the same number, so there is one rather than two. A timeout is not `invalid_grant`, so it stays transient: nothing written, `502 hl_unavailable`, which is what D26 asks for. |
| F6 | Required | **`detailFrom` parses up to 5 MiB to extract 200 characters.** `mapUpstreamStatus` hands it whatever came back, and the cap allows 5 MiB — measured at ~12 ms of CPU and ~10 MiB of heap on a 5 MiB body, making a *failed* call roughly three times the cost of a successful one, on the one path whose size upstream chooses rather than us. The largest recorded HighLevel error body is 84 bytes. | Fixed test-first. A 64 KiB guard before the parse — ~700× the largest real error body, and past it a response is a page or a payload, neither of which `detail` may carry. |
| F7 | Required | **Two exported functions with no consumer, one of them a second copy of a live security policy.** `hlAllowMessageSend()` (`hl/config.ts`) had no caller outside its own spec; the live check is `isRouteEnabled(row, env)`, which reimplements the identical `=== 'true'` rule. So the guard on a route that sends a real SMS existed twice and the copy with the test suite was the one that never ran — the failure mode being that someone tightens the tested one and ships nothing. `getAccessToken()` (`hl/token.ts`) likewise had no caller on this branch or on `main`, and was documented as "kept as the simple entry point for callers that want only a credential". See *Dead code* below for the decision. | Both deleted. `hlAllowMessageSend`'s cases (`'   '`, `'0'`, `'1'`, `'no'`, `'yes'`, `'TRUE'`) move into `routes.spec.ts` beside the copy that is actually wired, so nothing is lost and the tested function is the live one. `getAccessToken`'s one assertion that `resolveConnection`'s block did not already make ("rotates exactly once, never twice") moves across. |
| F8 | Required | **`locationId` scrubbing was exact-key only, so P1's stated invariant was false.** `routes.ts` claims "a caller-supplied location therefore never reaches HighLevel, on any route". `URLSearchParams.delete('locationId')` and `delete out.locationId` do not remove `LocationId=x`, `locationId[]=x` or `locationId[0]=x` — and `qs`, which Nest and therefore HighLevel parse queries with, folds the bracketed forms back into the same field. Whether HighLevel would honour the caller's value is inferred, not verified, and the location-scoped token is a second boundary that should refuse a foreign location regardless; this is defence in depth. But the sentence is one the review is meant to lean on, so it should be true rather than nearly true. | Fixed test-first. `isLocationKey` matches the key case-insensitively, exactly or bracketed. Deliberately not a prefix test: `locationIdentifier` survives, because we do not control HighLevel's field list and must not delete from it by guess — asserted. |
| F9 | Required | **`markNeedsReconnect` turned a mapped 409 into a 500 when the connection had just been deleted.** `.update()` rejects on a missing document; `handleDeleteConnection` hard-deletes. A call that resolved a connection, waited on HighLevel, got a 401, and found the user had disconnected meanwhile would have that rejection escape `handleProxy` — so the marking, which is an optimisation for the *next* call, ate the `409 hl_reconnect_required` this one was owed (AC-31). | Fixed test-first, in the new `tokenStore.spec.ts`. The write is now explicitly best effort: failure is logged (no uid, no field of the document) and swallowed. |
| F10 | Required | **Three comments asserted things that were not true.** `tokenStore.ts` on the retry short-circuit (F1). `routes.ts`'s `PARAM`: "the same rule as `projectIdSchema`, deliberately one rule in the codebase rather than two that drift" — while being the second literal copy of the regex. `fake.ts`: `FUNCTIONS_EMULATOR` is "the one signal an operator cannot set by hand and a deploy cannot carry" — it is on neither firebase-tools' `RESERVED_KEYS` nor its reserved prefixes, so a line in `functions/.env` deploys it. | All three corrected. `PARAM` now says the duplication is deliberate and why — the two namespaces are separate and coupling them would let a widening on the Genesis side silently widen what may be substituted into an upstream URL. `fake.ts` now says what the gate does and does not buy, and names Slice 13's deploy checklist as the owner of the positive guard. See *Carried forward* for that item. |
| F11 | Consider | **`api/index.ts` deep-imports `../hl/proxy` for a five-string constant**, past the `../hl` barrel every other feature import in the file goes through. The architecture lane argued this drags `tokenStore` and `firebase-admin` into app construction; that part is wrong — `../hl` already imports `./proxy` for the mount, so nothing extra is loaded. It is a consistency nit, not a cost. | Not changed. The alternative (re-export from the barrel, or a leaf `rateLimit.ts`) is a fair improvement and is recorded here rather than made, because `RATE_LIMIT_HEADERS`'s whole justification is that one constant serves two places and moving it a third time earns nothing today. |
| F12 | Consider | **A write body sent without `Content-Type: application/json` is silently replaced by `{ locationId }`.** `express.json()` sets `req.body = {}` when the type does not match, and `buildUpstreamBody` spreads that and injects. `POST /contacts/search` then becomes an *unfiltered* search of the whole location, answering 200 with the wrong data rather than an error; `POST /contacts/` attempts a create with no fields. `hlProxy` always sets the header, so nothing shipped can trigger it — a hand-rolled `curl` or Slice 10's shim can. | Recorded, not fixed. Refusing it needs an error code the PRD's failure table does not have, and that table is a contract Slice 9 teaches the model and Slice 10 renders. Choosing a new code is the PRD owner's call, not a reviewer's. Carried forward below as a Slice 10 inherited constraint, with the recommended shape: refuse a write row whose body arrived unparsed, before the upstream call. |
| F13 | Consider | **No `hl.proxy` line is emitted for a call that never reached upstream.** `logProxy` sits after `forwardUpstream` returns, so `route_not_allowed`, `route_disabled`, `invalid_path`, `hl_not_connected`, `hl_reconnect_required`, `hl_timeout`, `hl_too_large` and a transport failure all log nothing. D28 says "one structured line per call"; AC-35 says "given a **completed** proxy call", which the implementation satisfies. The operational cost is real, though: a 504 storm or a wave of dead connections is invisible in Cloud Logging. | Recorded, not fixed. Logging the mapped status on the error path changes what the `status` field means — it is documented as the *upstream* status — and that is a shape Slice 9's cheat-sheet and any future dashboard read. Carried forward as a Slice 12/13 observability item. |
| F14 | Consider | **The 5 MiB cap is a per-request bound on a function that admits 80 concurrent requests.** `functions/src/index.ts` declares `memory: '256MiB'` and no `concurrency`, which firebase-tools resolves to 1 CPU and the gen-2 default of 80. `readCapped` buffers the body as a string and `res.send` forces two more full copies (ETag, `Content-Length`, socket buffer) — measured at ~15–16 MiB RSS per 5 MiB response, so roughly 14–16 concurrent maximum-size responses exhaust the container, against the 80 the platform will admit. The failure is an OOM kill that takes all 80 in-flight requests with it. Real fixtures are 2–20 KB, so this needs a pathological `pageLimit`, which is the exact scenario `MAX_UPSTREAM_BYTES`'s own comment cites — the cap moved the OOM from one request to fifteen rather than removing it. | Recorded, not fixed. D27 fixed 5 MiB with a stated rationale and AC-33 asserts it; the fake's `OVER_CAP_BYTES` is tied to it. The available fixes — an explicit `concurrency`, more memory, or streaming the body straight to `res` instead of buffering — are all cost-and-scaling decisions affecting every API route, which is a product call rather than a review call. Carried forward for Slice 13 with the arithmetic. |
| F15 | Consider | **`SurfaceProbe` is optional-field soup, and `ProbeResult` is reached by a double cast.** `{ count: number \| null; error: string \| null; reconnect: boolean }` makes `{ count: 5, error: 'boom' }` representable, and `error === null` is then used as a de facto discriminant in four places. `Object.fromEntries(rows) as unknown as ProbeResult` is the only bridge to a three-required-field interface, so removing a row from `SURFACES` is a runtime `undefined` in the panel rather than a compile error. One dead consequence is already visible: `ConnectionPanel.vue`'s `reconnecting.probe.error ?? '…'` fallback can never render. | Recorded, not fixed. A discriminated union is the right shape and the reference doc says so, but it touches the store, the panel, and three test files — a refactor beside behavioural fixes is two changes, and this review already carries nine. Carried forward as a named follow-up rather than half-done. |
| F16 | Nit | `logProxy` (`hl/proxy.ts`) projects `ProxyLogContext` into `ProxyLogContext` and justifies it as `logGeneration`'s "field by field rather than spread" defence — which buys nothing when the parameter is already exactly that type. The three emitters in `lib/log.ts` also share a byte-identical body and three copies of the same cast. | Left alone. The narrow *context types* are the property that matters and they are right; collapsing the emitters is churn with no behaviour behind it. |
| F17 | Nit | `hlApiBase()` strips trailing slashes on the `baseUrl` branch and not on the emulator-override branch, so a `HL_TEST_API_BASE` ending in `/` would produce `//contacts/search`. Test configuration only. | Left alone; recorded so the next person does not spend an hour on it. |
| F18 | Nit | The Data access section's heading is a `<p class="font-medium">` where `CardTitle` renders a real heading, and the result rows have no `aria-live`, so a screen-reader user gets no announcement when three counts land. The button label also keys off `probeResult === null` rather than `probe`, so it flips back to "Check data access" while a re-check runs. | Left alone; the first two are a genuine accessibility improvement worth making in Slice 12's UI pass, the third is cosmetic. |

## Dead code

Step 9 asks before deleting. There is no one to ask in an unattended run, so the call is recorded
here instead.

```
DEAD CODE IDENTIFIED:
- hlAllowMessageSend()  functions/src/hl/config.ts   — no caller; isRouteEnabled() is the live check
- getAccessToken()      functions/src/hl/token.ts    — no caller on this branch or on main
```

**Both deleted**, and the two are not the same judgement.

`hlAllowMessageSend` is not merely unused, it is *actively misleading*: it is a second
implementation of the predicate that decides whether a route may send a real SMS, it has a test
suite of its own, and it is not the one the proxy consults. Keeping an unreachable copy of a
security policy beside the reachable one is how a tightening gets shipped to nothing. The PRD's
in-scope list names the function (D5) — the implementation chose `isRouteEnabled(row, env)`
instead, so the table could stay pure and Slice 9 could import it without dragging `process.env`
in, which is the better design. Deleting the orphan resolves the contradiction in favour of the
shipped one, and the PRD's *decision* is untouched: the flag, the exact-`'true'` rule, and the
`403 route_disabled` refusal all remain, tested where they are enforced.

`getAccessToken` is the weaker case, and the argument for deleting it is that this is the slice
that made it dead. It shipped in Slice 2 as the port's entry point with no consumer; Slice 8 added
the real consumer and gave it `resolveConnection` instead, leaving `getAccessToken` a one-line
delegate whose doc comment describes callers that do not exist. That is precisely the
after-a-refactor residue Step 9 is about. If Slice 9 or 10 wants a credential-only entry point it
is four lines, added with its caller.

Neither deletion weakens a test to get a green suite: the assertions each block made that were not
already made elsewhere were moved, not dropped, and the −12 in the unit count is duplicate
coverage of `resolveConnection` and of a predicate now asserted against the live function — where
`config.spec.ts` had nine cases for a rule nothing enforced, `routes.spec.ts` now has nine for the
same rule where it is enforced.

## AC coverage

All 48 audited by opening the test bodies rather than trusting the matrix. 43 hold as written.
Five did not, and the two that could be closed have been.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 – AC-18, AC-20, AC-22 – AC-25, AC-27 – AC-34, AC-36 – AC-48 | **Covered** | Audited against the test bodies. The strongest are AC-4 (`describe.each` over the table *and* a reversed copy — a real second execution, since matching sorts the table it is passed), AC-6 (`url.pathname` asserted **equal** to the row template with parameters substituted, derived independently, so a concatenated path fails), AC-11 (the stub filters fixtures by the `locationId` it actually received, so a proxy that forgot to inject returns *the wrong records* rather than failing an assertion about an argument), AC-13 (asserted on header *values*, so `{...req.headers, ...ours}` is caught), AC-15 (`res.raw` compared byte-for-byte against the same request put to the stub directly), AC-20 (a caller with **no** connection document getting `route_not_allowed` and not `hl_not_connected` — the only way to observe a read that did not happen), AC-33 (both cap branches, declared and chunked), and AC-34 (asserted against the *rendered* envelope, not the error object). |
| **AC-19** | **Was weak → now covered** | The matrix claimed `hl-proxy.spec.ts`; that file has no App Check case. Closed by F3 — `hl/index.spec.ts`. |
| **AC-21** | **Weak, accepted** | The "off" half is proven over the wire with `403 route_disabled` distinct from `route_not_allowed`. The **"on" half is exercised nowhere** — only `isRouteEnabled(send, {HL_ALLOW_MESSAGE_SEND:'true'}) === true`, a predicate test. The matrix's "the send flag off **and on**" overstates it. Accepted rather than closed: the emulator's environment is fixed for a whole `emulators:exec` run, so a shell value that turns the flag on turns it on for the case that has to prove the default is off — and the untested direction **fails safe**. An implementation that refused flagged rows unconditionally would ship a dead route, not a route that sends an SMS it should not have. |
| **AC-26** | **Weak, accepted and already disclosed** | The AC says "exactly **one** refresh for three concurrent callers". The test that asserts exactly one **staggers** its callers by 250 ms and 500 ms, so it proves the in-transaction re-read, not the lock; the genuinely concurrent test asserts a *bound* (`> 0`, `<= 6`). The build log's Finding 2 says so plainly and measures the emulator at 3–4. It rests on production Firestore's pessimistic locking, which the emulator does not implement. Accepted as an honest, documented deviation — and F1's fix removes the part of the residue that actually mattered: extra refreshes are now survivable rather than capable of bricking the grant. |
| **AC-17** | **Weak, accepted** | "No Firestore read" is asserted as "the stored document is unchanged", which is a no-**write** check. A handler that read `hlConnections/{uid}` before checking auth would pass. Accepted: `withVerifiedUser` runs as router middleware, so the ordering is structural rather than a branch that could be got wrong, and AC-20 — which *does* discharge its ordering claim, via the observable status difference — covers the case where the ordering is a decision the handler makes. |
| **AC-35** | **Weak, accepted** | Everything about `logProxy` is proven in isolation, including a key-set equality that would fail on an added `body` or `uid`. Nothing observes a line arising from a completed call, so a handler that stopped logging would pass green. Accepted: no integration test in this repo inspects function logs, and the security-relevant half — that the line has nowhere to put a payload — is a property of the type and is proven. Related to F13. |

Two smaller observations that did not change a verdict: AC-6's "URL-encoded" clause is vacuous,
because `encodeURIComponent` is the identity on `[A-Za-z0-9_-]` — the re-encoding is real but is
never exercised; and AC-12's "no header taken from the caller" is proven by sampling four named
headers rather than by asserting the upstream set is exactly the four.

## What was checked and found sound

A review that finds nothing on a diff this size has not looked. This one found ten things worth
fixing — but the load-bearing half of the slice is genuinely well built, and saying which parts
were attacked and held is the other half of an honest report.

- **The matcher.** Enumerated every row by segment count and tried to construct a wrong-row match:
  `GET /contacts/search`, `PUT /contacts/search`, `GET /conversations/messages`,
  `POST /calendars/events`, `DELETE /contacts/abc`, `/calendars/xyz/appointments/EVT`,
  `/contacts//`, `//contacts`, the bare subtree, `%2E%2E%2F`, and `..` traversal. Every one lands
  where the doc says, including the shape-before-method ordering — which is the subtle one, and is
  right: filtering by method first would resolve `GET /contacts/search` to `/contacts/:contactId`
  with the parameter `search`, a perfectly legal id shape, and forward it.
- **SSRF is structurally closed, not filtered.** Confirmed against a real Express 4 app over raw
  sockets that `req.path` inside the `use` mount stays undecoded, and that `buildUpstreamUrl`
  never sees the caller's path at all. `url.search = new URLSearchParams(raw).toString()`
  re-encodes `#`, `?` and `&`, so fragment and host injection are not expressible.
- **Credential handling.** No token in a log line, an error body or a response — asserted at L1
  against the rendered envelope and at L4 against `res.raw` for every failure marker. Node's
  undici strips `Authorization` on a cross-origin redirect, so the four-header upstream request
  does not leak on a redirect either. `hlConnections` stays denied to every client, and the new L3
  cases cover `list` and `update` — the latter being the write a client would actually want now
  that a server path sets `needsReconnect`.
- **The cap and the timeout interact correctly.** The `timedOut` flag rather than an inspection of
  the `AbortError` is right, because the size cap aborts through the same controller and the two
  map to different statuses. `Number('')` → 0 handles a missing `content-length` safely, and both
  cap branches have a case.
- **The error map** matches the PRD's failure table row for row, including the 401 → 409 inversion
  and its reason: `apiClient` reads a 401 as "your session died", so mirroring HighLevel's would
  sign a user out of Genesis because their *CRM* token was revoked.
- **Firestore access is one document read per proxied call**, with no N+1 anywhere;
  `resolveConnection` returns the token and the location from that one read, and the
  `needsReconnect` short-circuit saves a round trip on a dead connection.
- **`matchRoute` costs ~780 ns** — 0.0003% of a proxied request. The `text +=` in `readCapped` is
  a V8 rope, 3.3 ms for 5 MiB, not quadratic. Neither is worth touching.
- **`fake.ts`'s `fs` calls are emulator-only** (`buildFakeHlRouter(isEmulator())` returns an empty
  router otherwise) and cost ~0.06 ms per faked request.
- **The two reformats in the diff are Prettier-driven, not noise** — both `main` lines were 101
  characters; `main` was the drifted state.
- **Pinia reactivity in the panel is correct.** Setup stores are wrapped in `reactive()`, so
  `hl.probeResult` inside a `computed` is tracked. Worth knowing that no test would catch a
  regression: `ConnectionPanel.spec.ts` mocks the store as a plain object, so a future
  `const { probeResult } = useHlStore()` would pass unit tests and break in the browser.

## Findings dropped

Three axis findings were not reproducible against the code and are recorded as dropped rather than
silently omitted — agents reviewing in isolation produce plausible claims about code that does not
do what they assumed.

- *"`api/index.ts`'s deep import drags `tokenStore` and `firebase-admin` into app construction."*
  It does not: `api/index.ts` imports `hlRouter` from `../hl`, which already imports `./proxy` for
  the mount. The constant is free. The consistency point survives as F11; the cost does not.
- *"Any upstream 401 permanently disables the connection, and HighLevel answers 401 for a missing
  scope too, so reconnecting may not fix it."* Real mechanism, but D20 decided it explicitly and
  gave its reasons, and the alternative proposed (two consecutive 401s, or sniffing the error
  body) trades a clean rule for a heuristic on a body shape we do not control. Not a defect; noted
  for Slice 10, where the trigger becomes hallucinated code in the user's own preview.
- *"`buildUpstreamUrl`'s guard throw is reported as `hl_unavailable`."* True and unreachable —
  `matchRoute` validates first, and the guard exists precisely so the claim does not depend on
  that. Not worth a branch.

## Manual verification

- The App Check binding was verified by deleting `attested` from `hl/index.ts:80` and confirming
  six cases fail, then restoring it and confirming a clean tree.
- Each new test was confirmed **red before the fix** — by running it against the unfixed source,
  and for `detailFrom` and `hlProxy` by stashing the source change and re-running.
- `npx prettier --check` run over every changed source file.

**Not done: the definition of done's manual sandbox check** — "one `curl` per surface with a real
token, confirming the recorded fixtures still match the live shapes". This session has no
HighLevel credentials, no authorisation to use the sandbox account, and no human to hand a browser
to. It is the one DoD item this review cannot discharge, and it is the one R6 rests on: the whole
slice is tested against a stub built from fixtures recorded on 2026-08-14. **It must be done
before the PR is approved**, and it is called out again in the ship notes rather than left in a
checklist.

## Deliberately deferred

Carried forward with an owner rather than left to be rediscovered.

| Item | Owner | Why not here |
|---|---|---|
| A write row whose body arrived unparsed should be refused, not sent as `{ locationId }` (F12) | Slice 10 | Needs an error code the PRD's failure table does not have, and that table is a contract Slice 9 teaches and Slice 10 renders. |
| A positive deployed-runtime guard on `buildFakeHlRouter`, so `FUNCTIONS_EMULATOR` in a deployed `.env` cannot mount the token-minting stub (F10) | Slice 13 | The comment no longer claims it is impossible. The guard touches Slice 1's `isEmulator()`, which gates App Check and the fake mail transport too — a deploy-hardening change, not a proxy change. |
| `concurrency`, memory, or a streamed response body, so the 5 MiB cap × 80 concurrent requests is not an OOM on a 256 MiB container (F14) | Slice 13 | A cost-and-scaling decision affecting every API route. The arithmetic is in F14 so the decision can be made rather than derived again. |
| `SurfaceProbe` as a discriminated union (F15) | Slice 12's cross-cutting pass | A refactor beside nine behavioural fixes is two changes. It sits naturally with D32's deferred parse-don't-validate pass on the frontend's own responses. |
| An `hl.proxy` line on the paths that never reach upstream (F13) | Slice 12/13 | Changes what `status` means in a line Slice 9's cheat-sheet and any dashboard read. |
| An `aria-live` region and a real heading on the Data access section (F18) | Slice 12 | Accessibility belongs in the pass that does it consistently. |
| `AbortSignal` on the remaining `exchange.ts` calls; wiring client disconnect to the upstream abort | Slice 12 | Neither runs inside a transaction, so neither holds a lock; bounded at 20 s and low value against the risk of touching Slice 2's callback path. |
| AC-21's "flag on" and AC-26's "exactly one" over the wire | Not planned | Both need infrastructure the emulator does not provide — a per-test environment, and a pessimistic read lock. Both fail safe, and both are recorded above rather than claimed. |

## Verdict

**Approve, subject to the sandbox `curl` above.** The slice does what its PRD says, its structural
security claims hold — the upstream URL is unrepresentable from caller input, the uid comes from
the token and the location from that uid's own document — and its tests are unusually good at
asserting results rather than arguments. Ten findings were fixed; the one that mattered most was
invisible to a green suite and would have cost users a marketplace reinstall.
