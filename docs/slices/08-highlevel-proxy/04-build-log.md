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

---

## Session 2 — resumed, and what the first session had actually done

The first build session ended without a final message. Its log stops at T7; its **commits do
not**. Reading the branch rather than the log: T13 (the typed client) and T14 (the store
probe) are both committed, green, and match the plan. So the work left is T8–T12, T15–T17.

Why the first session jumped: the baseline note above says the emulator ports were held by
another checkout, and T8–T12 are exactly the emulator-backed tasks. T13 and T14 are pure L1,
so it took the work it could run. That was the right call and is recorded here rather than
treated as a deviation to undo — but the log not saying so is the reason this section exists.

**Baseline re-established on resume**, ports now free, everything green before the first new
change: `typecheck`, `lint`, `test:unit` (539 frontend, functions unit, 15 scripts),
`test:rules` (28), `test:integration` (232, 11 files). So the emulator-backed suites the first
session could not start are green as inherited, and every failure from here is this session's.

The second session then committed **T8's red** — `tests/integration/hl-proxy.spec.ts`, twelve
cases — and merged main, and ended there. So the branch arrives at session 3 with a red
integration suite and no `handleProxy`.

---

## Session 3 — resumed at T8's red, and how the remaining work was split

**Inherited state, read off the branch rather than the log:** T1–T7, T13 and T14 green and
committed; T8's red committed with no green behind it. Remaining: **T8–T12, T15–T17**.

**Ports.** Another checkout on this machine (`~/Documents/Projects/highlevel-genesis`) is again
holding the default test band (5101 / 8180 / 9199 / 4700 / 4800 / 5273) — the same collision the
baseline note records, and the reason `EMULATOR_PORT_OFFSET` exists. This session runs the
emulator-backed suites on its own band throughout:

```
EMULATOR_PORT_OFFSET=300 EMULATOR_HUB_PORT=4900 EMULATOR_LOGGING_PORT=4950
FUNCTIONS_EMULATOR_PORT=5301 FIRESTORE_EMULATOR_PORT_CLIENT=8380
AUTH_EMULATOR_PORT=9399 E2E_PORT=5473
```

No source or `package.json` change was needed for that; the band is entirely environment, which
is what `scripts/test-emulator-config.mjs` was built for.

### Lanes

Reading the file map and the task list together, the remaining tasks fall into one chain and two
independent lanes. The split is by *file ownership*, and no file is claimed twice:

| Lane | Tasks | Files owned |
|---|---|---|
| **Chain (this session)** | T8 → T9 → T10 → T11, then T16 | `hl/proxy.ts`, `hl/tokenStore.ts`, `hl/proxyError.ts`, `hl/fake.ts`, `hl/index.ts`, `api/index.ts`, `package.json`, `tests/integration/hl-proxy.spec.ts`, `tests/integration/hl-token-refresh.spec.ts`, `tests/e2e/highlevel.spec.ts` |
| **A** | T15 | `frontend/src/components/ConnectionPanel.vue`, `ConnectionPanel.spec.ts` |
| **B** | T12, T17 | `tests/rules/firestore.spec.ts`, `firestore.rules`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRODUCT_SPEC.md` |

**T8–T11 stay a chain and are not split.** They are four passes over the same three modules —
`proxy.ts` grows a handler, then an upstream call, then a timeout and a cap; `fake.ts` grows a
counter, then three surfaces, then five failure markers; `tokenStore.ts` grows a read and then
the transaction. Two lanes on those files is a conflict chosen in advance, not a lane split.

**T16 (e2e) stays with the chain** because it depends on both the chain and lane A.

Lanes A and B were told the interfaces they meet at — lane A codes against the `probe` /
`probeResult` / `checkDataAccess` contract T14 already shipped, lane B against the rule that is
already in `firestore.rules` — so neither had to guess at a sibling's work. Both were forbidden
git and forbidden the emulator-backed suites, since the emulator band is a single shared
resource and the git index is a single shared file. The orchestrator commits every cycle and
runs every suite.

Both lanes finished while the chain was still on T8, so **T12, T15 and T17 are committed ahead
of T9–T11 rather than in plan order**. Holding them back would have risked losing finished work
to a session that died mid-chain, which is the worse trade; the red-green pairing inside each
task is intact and the commit messages are the lanes' own.

---

## T8 — The boundary: mount, match, refuse → AC-17 – AC-20, AC-22, AC-23, AC-29 (wire), AC-19 (by note)

**Tests:** the twelve cases session 2 committed as T8's red, unchanged — including the ordering
proof (`consults the allowlist before it reads a connection`), which is the only way to observe
a Firestore read that did not happen.

**Implementation:** `hl/tokenStore.ts` (`storedTokensSchema`, `firestoreTokenDeps().read`),
`handleProxy` down to `resolveConnection`, the P2 mount line in `hl/index.ts` with the App
Check-under-emulator caveat recorded on it, and the stub's call counter.

**Addition — the three route refusals live in `proxyError.ts`.** The plan says "every refusal
goes through `mapUpstreamStatus`/`mapTokenError` so there is one place that decides a status",
but neither covers `route_not_allowed`, `route_disabled` or `invalid_path`. `routeRefusal(code)`
was added beside them with its own status table, so all of F8.3's copy and every status this
surface can answer with is readable in one file rather than two.

`firestoreTokenDeps().refresh` throws plainly until T11 rather than answering a plausible
status. Nothing in the suite reaches it, and a `502 hl_unavailable` placeholder would have read
like a HighLevel blip.

---

## T9 — The upstream call → AC-11 – AC-16

**Tests added** (L4, six cases): byte-identity asserted against **the stub's own serialisation**
rather than against a re-parsed object, because a re-serialised body parses identically and is
not the same bytes; the five rate-limit headers compared value for value against what the stub
sent; a 201 mirrored; `Authorization`, `Version` and `Accept` read back through the `__echo`
marker id; the caller's `Version`, `Cookie`, `X-Forwarded-For` and ID token all absent upstream,
asserted on their **values** so the case holds however the runtime spells a header; and AC-11,
with bob naming alice's location in his own body and receiving an empty set.

`tests/integration/helpers.ts` gained a `headers` field on `JsonResponse`. The rate-limit
headers are part of this endpoint's contract, and a harness that could not see them would have
let the suite call them shipped without ever having looked.

**Implementation:** `forwardUpstream` with exactly four headers built from scratch; the body
returned as the text it arrived as; `RATE_LIMIT_HEADERS` copied before the status is decided so
a 429 keeps them; `exposedHeaders` on the CORS call from the same constant. The stub gained the
three surfaces, the header requirement, `locationId` filtering with `total` recomputed, and the
`__echo` marker.

---

## T10 — Upstream failures over the wire → AC-31 – AC-34

**Tests added** (L4, eight cases). Seven fail against the branch without the implementation;
the eighth — no token material in any failure body — passes already, and is kept as the
regression it is rather than presented as something this commit established.

**Addition — two size-cap markers, not one.** The plan names `__huge`. A declared
`Content-Length` and a chunked body are two different code paths, and the chunked one is the
only thing standing between a pathological `pageLimit` and an out-of-memory, so `__hugestream`
was added and both branches have a case. An untested branch in a size cap is the branch that
fails.

**Implementation:** one `AbortController` carrying both bounds, with the timeout distinguished
by a flag rather than by inspecting the `AbortError` — the cap aborts through the same
controller and the two are a 504 and a 502. `markNeedsReconnect` is a plain `update` that
touches the flag and `updatedAt` and nothing else. `package.json` sets
`HL_TEST_UPSTREAM_TIMEOUT_MS=2000` on `test:integration` and `test:e2e` (P5).

Two small shapes the linter forced, both worth knowing: `globalThis.Response` is named
explicitly in `readCapped` because this module also imports Express's `Response`, and the
timeout flag is a field on an object rather than a `let` because the compiler narrows a captured
local to its initial value across the `await` and then reports the check as dead code.

---

## T11 — The transactional refresh → AC-24 – AC-28, and the slice's one recorded residue

**Tests added** (L4, `tests/integration/hl-token-refresh.spec.ts`, seven cases). Four were red.

**Implementation:** `rotate(uid)` — `runTransaction` with a re-read short-circuit, P8's
commit-then-throw for `invalid_grant`, and an abort that writes nothing for anything transient.
`ConnectionSnapshot` still carries no refresh token: `parseStored` and `snapshotOf` were split so
the token is read once, inside the transaction, where the only thing done with it is to spend it.

### Finding 1 — the stub's counters could not have worked, and two suites were passing blind

The plan has the fake count upstream calls in a module variable. That cannot work, and the
reason is structural rather than a bug: the functions emulator runs a **pool of worker
processes**, and every call to the stub is *nested* — the proxy, running inside an invocation,
calls back into the emulator to reach it. That request is therefore served by a different worker
than the one that will serve the test's read, so the counter reads zero however many calls were
made.

Zero is also the expected value in every one of T8's assertions. So
`expect(await upstreamCalls()).toBe(0)` was passing **without ever having looked**, in nine
cases, and would have shipped that way. It surfaced only because AC-26 needs a count of *one*,
which zero cannot fake.

**Corrected route:** the counters are appended to a file in the temp directory, one byte per
event, keyed by `FIRESTORE_EMULATOR_HOST` so two checkouts running on their own port bands
cannot share them. `O_APPEND` is atomic at that size, which matters exactly in the concurrent
case where a read-modify-write counter would undercount and pass. Firestore was the obvious
alternative and was rejected: it would add a collection, a `firestore.rules` block and an L3
case for state that exists only under the emulator.

### Finding 2 — the Firestore emulator does not implement the transaction read lock

D23's first property is that Firestore read-write transactions are pessimistic, so a second
caller's `tx.get` blocks rather than races. **The emulator does not do this.** Measured over six
rounds of three simultaneous proxy calls on a token inside the skew:

| Round | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Refresh requests | 3 | 3 | 4 | 4 | 4 | 4 |

Never one. Never a storm either — and that distinction is the informative half. All three
readers see the stale document and refresh; one commits; the others abort and retry, and the
retry's re-read **does** find the rotated token and short-circuits. Without that short-circuit
three callers could refresh on each of five attempts: fifteen.

Staggering the same three calls by 250 ms gives **exactly one refresh**, which is the
short-circuit asserted directly.

**What this means for AC-26.** Its literal "exactly one refresh request reaches HighLevel" is a
property of production Firestore's locking and **is not verified by an automated test** in this
repo. Per the plan's own instruction — *"a finding to record, not a test to weaken"* — the case
was rewritten rather than deleted or relaxed into nothing:

- `reuses a token another caller already rotated` asserts **exactly one**, deterministically,
  by staggering the callers. This is D23's second property and the mechanism the whole design
  rests on.
- `leaves one usable connection when three calls arrive at once` asserts what holds in both
  worlds and is what actually protects the user: every caller succeeds, `needsReconnect` stays
  false, and the token every later call carries is the one that was persisted — so the losers
  converged on the winner's result rather than stranding themselves on a token nobody stored.
  The count is bounded at six: comfortably above the measured 3–4, far below the fifteen a
  broken short-circuit would produce.

The residue is survivable and was measured before this slice started: `HIGHLEVEL_PLATFORM.md`
§3 (corrected 2026-08-16) records that HighLevel accepts a reused refresh token at least once.
That is why this is a residue rather than a defect to redesign around, and it is exactly the
case R2 anticipated. **It is the one thing in this slice that a reviewer should look at first.**

---

## T12 — Rules re-asserted → AC-36, AC-37 *(lane B)*

Two cases in the existing `server-only collections` describe: a verified owner denied `getDocs`
on the collection, and denied `updateDoc({ needsReconnect: false })` on a document **seeded past
the rules first**, so it is denied on a real document rather than passing because there was
nothing there. That update is the one a client would actually want now that a server path sets
the flag.

Both pass on the first run, and that is the correct outcome for a re-assertion task rather than
a red step that was skipped: the rule is `allow read, write: if false`, and a rule that denies a
document denies it whatever fields it holds. What the cases buy is a tripwire on the slice that
gives the document a second writer. `firestore.rules` gained a comment naming that writer and
nothing else — no rule expression changed (D33). 28 → 30 cases.

---

## T15 — The Data access section → AC-41 (UI half), AC-43 – AC-47 *(lane A)*

Ten cases; eight red, and the two AC-47 cases green from the start — which is the point of
putting the section inside the existing connected branch rather than giving it a guard of its
own. `describe()` orders its checks `error → null → 0 → the number`, so a surface that answered
zero renders "None yet" and never reaches a truthiness test; that falsy-zero trap has its own
named case. The three rows are one `v-for`. No new component, store or route (R9).

---

## T16 — End to end → AC-48

The probe is added to the **existing** connect walk rather than in a second one, so it runs
against a connection the browser actually made. The rows must be absent before the press (D30's
"not on mount"), and each row is asserted with `/\d+/` rather than a hard-coded count: the
fixtures are recorded data and their sizes are theirs to change. What a digit proves is that a
count came back through `/api/hl/proxy/**` at all — which means the ID token was verified, the
connection was read, the row's `Version` went upstream and the location was injected, none of
which the browser can see directly.

---

## T17 — Documentation *(lane B)*

`IMPLEMENTATION_PLAN.md` §0, §4 and §9 (F7.1, F7.2, F8.3 — **F8.3 amber**, because surfacing a
failure inside the preview is Slice 10's half), plus the stale F1.2/F1.3 rows the plan asked to
be corrected in the same pass. `PRODUCT_SPEC.md` §3's `api/hl/*` line marked shipped — and its
`api/oauth/callback` line two rows above, which was the same staleness for a slice that merged.

**README delta for Slice 13**, which the plan asks to be recorded here rather than written now:

> The README gains the allowlist as a section of its own — the thirteen rows of `HL_ROUTES`
> (method, path pattern, `Version`, scope, and where `locationId` is injected) rendered from
> `functions/src/hl/routes.ts` rather than retyped, because it is one table with three consumers:
> the proxy, Slice 9's system prompt and this README (`HIGHLEVEL_PLATFORM.md` §8). And
> `HL_ALLOW_MESSAGE_SEND` becomes a deployment note: `POST /conversations/messages` is on the
> table but answers `403 route_disabled` unless the variable is exactly `true`, because sending
> is a real SMS or email that costs money and reaches a real person. It is off in every
> environment including the test suites, and enabling it is a deliberate act.

`docs/IMPLEMENTATION_PLAN.md` §4's Slice 1 heading still reads "🔵 in review" for a slice §0
records as merged. Slice 4's build log noticed the same thing and deliberately left it as not
its text; left again, and named here so the third slice to notice does not have to rediscover it.

---

## Two amendments outside the plan's file map

Both were blocking, both are recorded rather than folded in quietly.

### Amendment 2 — `scripts/test-emulator-config.mjs` never moved eventarc or Cloud Tasks

`npm run test:e2e` could not start: `EADDRINUSE 127.0.0.1:9499`. The generator moves every
emulator `firebase.json` declares, plus the hub and the logging emulator — but the CLI also
starts **Eventarc and Cloud Tasks** alongside `functions`, and those were left on their defaults
(9299, 9499). So two checkouts on different bands shared them by construction, which is the
exact failure the band mechanism exists to prevent, one layer down. The existing "shares no port
between two checkouts" case could not see it, because it only inspects ports the config names.

They are settings rather than arithmetic, and here that is forced rather than stylistic: those
CLI defaults sit **inside the shifted auth band**, so a `+offset` rule would eventually put one
checkout's eventarc on another's auth port. Two L1 cases added, then the fix. 19 → 21 script
tests.

### Amendment 3 — Playwright's five-second `expect` default was asserting the machine

After the port fix, e2e failed three times running with **three different tests, in three slices
none of which this branch had touched** — always at exactly 5.3 s, always "element(s) not found".
The functions emulator's slowest invocation across an entire run was **732 ms**, so the app was
never the reason; a second checkout's emulator set, a browser and an editor on the same machine
were.

Every `expect` in this suite waits for a state the app *reaches* — a request lands, a store
updates, a branch re-renders. None is a latency budget, so a five-second default was asserting
something about the machine rather than about the product. Raised to 15 s, which is the value
the individual hops that already needed one were given, so the file gains no new number. **This
is not a weakened assertion**: nothing about what is checked changed, and a branch that never
renders still fails — fifteen seconds later. Two consecutive full green runs followed, and a
third in the final pass.

---

## Acceptance criteria — every one, and where it is proved

| AC | Level | Test |
|---|---|---|
| AC-1 – AC-5, AC-7 | L1 | `hl/routes.spec.ts` — matcher, refusals, grammar, reversed table |
| AC-6, AC-8 – AC-10 | L1 | `hl/routes.spec.ts` — URL assembly and `locationId` injection |
| AC-11 | L4 | `hl-proxy.spec.ts` › *gives each user only their own location's records* |
| AC-12 – AC-14 | L4 | `hl-proxy.spec.ts` › *attaches our Authorization…*, *sends the row's own Version…*, *forwards no header the caller sent* |
| AC-15, AC-16 | L4 | `hl-proxy.spec.ts` › *returns HighLevel's body byte for byte…*, *mirrors a 201 on a create…* |
| AC-17, AC-18 | L4 | `hl-proxy.spec.ts` › *refuses a request with no Authorization header*, *…whose email is not verified* |
| **AC-19** | **L1 + review** | `auth/appCheck.spec.ts` › *rejects a request carrying no App Check header*, plus the mount line in `hl/index.ts`. Per the plan's deviation table: `requireAppCheck` short-circuits under the emulator, so no emulator-backed test can observe it |
| AC-20, AC-23 | L4 | `hl-proxy.spec.ts` › *refuses a route the allowlist does not name*, *refuses the bare subtree rather than 404ing* |
| AC-21 | L4 + L1 | L4 for "off" (*refuses the message-send route…*); L1 for "on" (`routes.spec.ts` `isRouteEnabled`, `config.spec.ts`) — the emulator's environment is fixed for a whole run |
| AC-22 | L4 | `hl-proxy.spec.ts` › *answers hl_not_connected when there is no connection document* |
| AC-24, AC-25 | L4 | `hl-token-refresh.spec.ts` › *uses the stored token and asks for no refresh…*, *rotates inside the skew and persists all three fields* |
| **AC-26** | **L4, partial** | *reuses a token another caller already rotated* asserts exactly one refresh, deterministically. The simultaneous case asserts survival and a bound — see Finding 2; the literal "exactly one" rests on production Firestore locking the emulator does not implement |
| AC-27, AC-28 | L4 | `hl-token-refresh.spec.ts` › *marks the connection and keeps the refresh token…*, *writes nothing when the refresh fails transiently* |
| AC-29 | L1 + L4 | `hl/token.spec.ts`, and `hl-proxy.spec.ts` › *refuses a connection already marked needsReconnect, without refreshing* |
| AC-30, AC-32, AC-34 | L1 + L4 | `hl/proxyError.spec.ts`, and `hl-proxy.spec.ts` › *forwards HighLevel's own message as detail*, *puts no token material in any upstream failure* |
| AC-31 | L4 | `hl-proxy.spec.ts` › *turns an upstream 401 into a 409 and marks the connection* |
| AC-33 | L4 + L1 | *aborts an upstream that will not answer*, *refuses an upstream body over the cap* (both branches); the 20 000 ms default at L1 in `config.spec.ts` |
| AC-35 | L1 | `hl/proxy.spec.ts` |
| AC-36, AC-37 | L3 | `tests/rules/firestore.spec.ts` |
| AC-38, AC-39 | L1 | `frontend/src/lib/hlProxyApi.spec.ts`, `no-firestore.spec.ts` |
| AC-40 – AC-42 | L1 | `frontend/src/stores/hl.spec.ts` |
| AC-43 – AC-47 | L2 | `frontend/src/components/ConnectionPanel.spec.ts` |
| AC-48 | L5 | `tests/e2e/highlevel.spec.ts` |

**Two carry a caveat, both stated above and neither hidden:** AC-19 cannot be observed under the
emulator (the plan said so in advance), and AC-26's count half cannot be observed under the
Firestore emulator (the plan anticipated it and asked for it to be recorded).

## The definition of done's `grep`

> No upstream URL is built by concatenating a caller-supplied string anywhere in `functions/src/hl`.

Every use of `hlApiBase()` in the codebase:

```
hl/routes.ts:324   new URL(`${hlApiBase()}${pathname}`)   ← pathname is row.pattern, parameters
                                                            re-validated and encodeURIComponent'd
hl/exchange.ts:48  `${hlApiBase()}/oauth/token`           ← constant (Slice 2)
hl/exchange.ts:76  `${hlApiBase()}/oauth/installedLocations`
hl/exchange.ts:102 `${hlApiBase()}/oauth/locationToken`
hl/exchange.ts:128 `${hlApiBase()}/locations/${locationId}` ← from the connection document, not a
                                                              caller (Slice 2, unchanged)
```

And every read of the caller's path in `functions/src/hl` outside the stub:

```
proxy.ts:153-154  req.originalUrl → the raw query string → URLSearchParams
proxy.ts:233      req.path        → matchRoute, and nowhere else
```

Neither ever reaches a URL by concatenation. **D6 holds structurally.**

## Full suite, final state

| Suite | Result |
|---|---|
| `typecheck` | clean (functions, frontend, root) |
| `lint` | clean, zero warnings |
| `test:unit` | **1 147** — 577 functions, 549 frontend, 21 scripts |
| `test:rules` | **30** (was 28) |
| `test:integration` | **265**, 13 files (was 232, 11) |
| `test:e2e` | **12**, three consecutive green runs |

Emulator-backed suites were run on the port band recorded at the top of this session, because
another checkout holds the default one.

<!-- build-complete -->
