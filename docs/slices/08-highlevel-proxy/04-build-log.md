# Slice 08 — HighLevel API proxy · Build log

**Branch:** `slice/08-highlevel-proxy` · **Plan:** `03-plan.md` · **PRD:** `02-prd.md` ·
**Started:** 2026-08-17

Appended task by task, as each red-green-refactor cycle closes.

## Baseline

`typecheck`, `lint` and `test:unit` green before the first change — 424 functions unit tests,
514 frontend, 15 scripts. `test:rules` and `test:integration` could not be started at that
moment: another checkout on this machine (`~/Documents/Projects/highlevel-genesis`) was
holding the test emulator ports (5101 / 8180 / 9199 / 4700 / 4800 / 5273), which
`package.json` fixes by convention rather than reading from the environment. Recorded here
rather than worked around; the emulator-backed suites are run before the slice is called
done.

---

## T1 — The allowlist table and the matcher → AC-1, AC-2, AC-3, AC-4, AC-5, AC-7

**Tests added** (L1, `functions/src/hl/routes.spec.ts`, 48 cases):

- every one of the thirteen rows matches a legal concrete path with its `version`, `scope`
  and `locationIn` intact (AC-1), and the table itself carries none of D4's four exclusions
- the six not-on-the-table refusals (AC-2) and three wrong-method refusals (AC-3)
- literal-beats-parameter, run twice — against `HL_ROUTES` and against a reversed copy
  (AC-4)
- the parameter grammar, both as refused paths and as `isLegalParam` over the six raw
  values (AC-5)
- trailing-slash normalisation on `/calendars` and `/contacts` (AC-7, first half)

**Implementation:** `functions/src/hl/routes.ts` — `HlRoute`, `HL_ROUTES`, `RouteMatch`,
`isLegalParam`, `matchRoute(method, path, table = HL_ROUTES)`.

### Amendment 1 — specificity is ranked across every method, not within one

The plan's matcher (T1, *Green*) says: "take candidates whose `method` matches **and** whose
segment count matches …". Written that way, the red step failed on AC-3's own example:
`GET /contacts/search` matched `GET /contacts/:contactId` with the parameter `search`,
because `search` is a perfectly legal id shape. The PRD requires `403 route_not_allowed`
there, and forwarding a lookup for a contact nobody has is the worse behaviour besides.

**Corrected route:** gather candidates by *shape* across every method, rank by specificity,
keep the class tied with the winner, and only then pick the row whose method matches. A
segment some row spells out as a literal can therefore never be swallowed by another row's
parameter. This makes AC-3 pass as written and adds a third case to it,
`GET /conversations/messages`, which is the same hazard on the conversations rows.

### Clarification — AC-5's `a/b`

Five of AC-5's six values sit in a single segment and are refused by the grammar as
`invalid_path`. `a/b` cannot: a slash makes it *two* segments, so `/contacts/a/b` is a shape
no row has and is refused one step earlier as `not_allowed` — before any Firestore read,
which is the stronger refusal. AC-5's operative property ("never a row") holds for all six.
Both facts are asserted: `isLegalParam` rejects all six raw values, and `/contacts/a/b` has
its own named case saying why its kind differs.

---

## T2 — Upstream URL and `locationId` injection → AC-6, AC-7, AC-8, AC-9, AC-10

**Tests added** (L1, `functions/src/hl/routes.spec.ts`): every row assembles a URL whose
pathname is its own template with the parameters substituted (AC-6); `/calendars` and
`/calendars/` both assemble `/calendars/` (AC-7); `locationId` written over the caller's in
the body (AC-8) and once in the query alongside two untouched parameters (AC-9); nothing
added — and a caller's own removed — on a row that takes none (AC-10, P1); a repeated query
parameter round-trips (D12, P3).

**Implementation:** `buildUpstreamUrl(row, params, rawQuery, locationId)` and
`buildUpstreamBody(row, body, locationId)`.

### Addition — the assembler re-checks the grammar

D6's claim is that the URL *cannot* be built from a caller-supplied string. A claim that
holds only because the one caller today happens to validate first is not structural, so
`buildUpstreamUrl` re-checks each parameter against `isLegalParam` and throws otherwise. It
has its own test. This also keeps `URL` from silently normalising a `..` segment away, which
is the one way `encodeURIComponent` alone could be defeated.

`routes.ts` imports `hlApiBase` from `config.ts`. That reads the environment, but only when
`buildUpstreamUrl` is *called* — `config.ts` resolves everything lazily — so Slice 9 can
still import `HL_ROUTES` with no environment at all.

---

## T3 — `HttpError` carries a `detail` → supports AC-32

**Tests added** (L1, `functions/src/lib/errors.spec.ts`): a detail is rendered when present;
the key is **absent**, not null, when it is not. The second is asserted with
`toStrictEqual` on `json.mock.lastCall`, because `toHaveBeenCalledWith` treats an explicit
`undefined` value as an absent key — which is precisely the distinction under test. The
shared `mockResponse()` helper's `json` spy gained a typed argument so that assertion can be
written at all.

**Implementation:** a fourth constructor parameter `readonly detail?: string`, spread into
the envelope only when defined (P4).

---

## T4 — The upstream error mapper → AC-30, AC-32, AC-34

**Tests added** (L1, `functions/src/hl/proxyError.spec.ts`, 42 cases): the PRD's status table
row by row (AC-30); *never 401*, asserted across the whole range rather than on one status
(D20); `detail` from HighLevel's `message`, `error_description` or `error`, truncated at 200
and absent for six kinds of unusable body (AC-32); no token and no uid in the **rendered
envelope** for any status (AC-34); `mapTokenError` for the three token conditions and a
rethrow for anything else; `isDefinitiveRefreshFailure` true only for a 400 carrying
`invalid_grant`.

**Implementation:** `functions/src/hl/proxyError.ts` — `MESSAGES` (the F8.3 copy in one
place), `proxyError`, `detailFrom`, `mapUpstreamStatus`, `mapTokenError`,
`isDefinitiveRefreshFailure`.

**Ordering note:** `HlReconnectRequiredError` and `HlRefreshUnavailableError` are listed in
the plan under T5's file, but `mapTokenError` cannot compile without them, so they landed in
T4's green commit. T5 then added `needsReconnect`, `locationId` and `resolveConnection` as
planned.

---

## T5 — `needsReconnect` short-circuit and `resolveConnection` → AC-29, AC-24 (decision half)

**Tests added** (L1, `functions/src/hl/token.spec.ts`): the token and the location returned
from one read with no refresh when fresh (AC-24's pure half); a refresh inside the skew still
returning the connection's location; a `needsReconnect` connection refused with
`HlReconnectRequiredError` and **no** `refresh` call, both when the token is fresh and when it
is stale (AC-29). Slice 2's nine existing cases are unchanged and still green.

**Implementation:** `ConnectionSnapshot` gains `locationId` and `needsReconnect`;
`resolveConnection` becomes the primary and `getAccessToken` delegates to it (P10).

---

## T6 — The send flag and the upstream timeout → AC-21 (enabled half), AC-33 (default)

**Tests added** (L1): `functions/src/hl/config.spec.ts` — the flag is off unset, blank,
`false`, `0`, `no`, `TRUE` and `yes`, and on only for an exact `true`; the timeout is 20 000
ms, the override is ignored outside the emulator, honoured under it, and falls back for four
unusable values. `functions/src/hl/routes.spec.ts` — `isRouteEnabled` over a flagged and an
unflagged row (AC-21's enabled half, per the plan's deviation table).

**Implementation:** `hlAllowMessageSend()`, `UPSTREAM_TIMEOUT_MS`, `hlUpstreamTimeoutMs()` in
`config.ts`; `isRouteEnabled(row, env)` in `routes.ts`, taking the environment as an argument
so the table module stays pure. `functions/.env.example` gains `HL_ALLOW_MESSAGE_SEND=` with
the comment saying why it is blank everywhere, tests included.

---

## T7 — The proxy log line → AC-35

**Tests added** (L1): `functions/src/hl/proxy.spec.ts` — exactly one `hl.proxy` line with the
four fields; the *pattern* and not the concrete id; the key set asserted as an equality so a
future `body` or `uid` fails; a missing rate-limit header logged as `null`. Plus
`RATE_LIMIT_HEADERS` is the five names D18 asks for. `functions/src/lib/log.spec.ts` — the
new context, the `@ts-expect-error` proof that it has no field for a body, and that a value
arriving despite the type still goes through `redact`.

**Implementation:** `ProxyLogContext` and `logProxyEvent` in `lib/log.ts` (P9);
`RATE_LIMIT_HEADERS` and `logProxy` in `hl/proxy.ts` (P7).
