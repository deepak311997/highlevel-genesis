# Slice 02 — HighLevel connection · Build log

**Branch:** `slice/02-highlevel-connection` · **Started:** 2026-08-16 · from `main` at `93f72e9`

Baseline before any change, confirmed green: typecheck 0 · lint 0 · **functions 85 · frontend 190** ·
rules 16 · integration 34. E2E not run — see *Blocked*.

---

## T1 — Record the HighLevel fixtures · ✅

Took several attempts, and every failure turned out to be a defect in our own reference doc
or in how the app was installed, never in the code. The sequence is worth keeping because
each step's error message pointed somewhere other than the cause:

| Symptom | Actual cause |
|---|---|
| `No integration found with the id: <app id>` | The **v1** authorize path. Names the app id, so it reads as a bad `client_id`; two key pairs were regenerated before the real cause surfaced. See T3. |
| Consent page never appeared | The sandbox had **no sub-account**. `chooselocation` lists sub-accounts, so with none there was nothing to choose. |
| `invalid_scope` naming six scopes | Five were not configured on the app and one, `locations.readonly`, needed a new app version. None of the five is required by the spec — recorded as D26. |
| `userType: "Company"`, no `locationId` | Installing from the **marketplace listing** installs agency-wide. Resolved through `installedLocations` → `locationToken`, recorded as D25. |

**Eight fixtures recorded**, redacted, and verified free of JWT-shaped strings by grepping
every file. Two findings contradict `HIGHLEVEL_PLATFORM.md` and are corrected there:

- **`/calendars/events` takes epoch milliseconds.** ISO 8601 returns `{"events":[]}` with
  HTTP 200 over the same window epoch-ms returns three events. Wrong format is
  indistinguishable from an empty calendar — the silent failure the doc flagged as the
  first thing to verify, and it was right to.
- **Refresh tokens survive one reuse.** The doc said they are invalidated immediately, and
  PRD risk 3 — "the loser bricks the connection" — rested on that. Measured: second use
  succeeded, third returned `invalid_grant`. HighLevel runs a grace window. This is what
  made T13 safe to cut.

---

## T2 — Seal and open the state → AC-4, 5, 10, 11, 12 · ✅

| | |
|---|---|
| Red | `functions/src/hl/state.spec.ts` — 14 cases |
| Green | `functions/src/hl/state.ts` |
| Commits | `b700858`, `34e5c6a` |

AES-256-GCM under an HKDF-derived key, wire format `base64url(iv ‖ ct ‖ tag)`.

Two tests are worth naming because they encode decisions rather than behaviour:

- **`does not disclose the uid`** decodes the token and asserts the raw bytes do not contain
  the uid. This is the entire justification for D4 — encryption over signing — expressed as
  an assertion rather than a comment.
- **One rejection case per region of the wire format** (IV, ciphertext, tag). A decrypt that
  ignored any one of the three would still pass a round-trip test.

No deviation from the plan.

---

## T3 — Build the authorize URL → AC-1, 2, 3 · ✅ *(amended mid-task)*

| | |
|---|---|
| Red | `functions/src/hl/authorize.spec.ts` — 10 cases |
| Green | `functions/src/hl/authorize.ts`, `functions/src/hl/config.ts` |
| Commits | `9679b11`, `6cf4e15`, then `091691b` for the amendment |

### Deviation: the documented authorize endpoint does not work

`HIGHLEVEL_PLATFORM.md` §2 Step 4 documents `/oauth/chooselocation`, and the first
implementation matched it. Against the live app that path answers:

```
HttpException: No integration found with the id: 6a7eafb703672cba975e2d1d
```

**The message is actively misleading**, and it cost an hour: it names the *app id*, so it
reads as a bad or stale `client_id`. The natural response — regenerating the client key pair
— changes nothing, because the client id was never the problem. Two key pairs were generated
before the real cause surfaced.

The developer portal's own generated install link settled it:

```
https://marketplace.gohighlevel.com/v2/oauth/chooselocation?…&version_id=<app id>
```

**Amendment, approved before implementing:** the path is `/v2/oauth/chooselocation` and
`version_id` is required. `HL_VERSION_ID` is configured separately rather than derived from
`HL_CLIENT_ID` — it happens to equal the segment before the hyphen today, but that is a
coincidence HighLevel has not promised to preserve.

Corrected in the same commit, because a reference doc that is wrong is worse than one that is
missing: **§2 Step 4** and the **§9 day-0 checklist** both now carry the v2 form *and the
error message*, so the next person searching for it lands on the answer rather than on the
client-key detour. Step 4 now states outright that the portal's generated link is
authoritative when it and the doc disagree.

**PRD impact:** AC-1 changes `/oauth/chooselocation` → `/v2/oauth/chooselocation`; AC-2 gains
`version_id`. To be applied to `02-prd.md` before review.

### Also worth keeping

The scope separator is asserted as `%20`, never `+`. `URLSearchParams` emits `+`, which is
correct for a form body and wrong here — HighLevel reads it as a literal, so consent is
granted for a scope set that quietly differs from the one requested, and the failure surfaces
much later as a 401 on an endpoint that should have worked. The URL is assembled by hand for
this reason alone.

---

## T5 — Keep OAuth credentials out of the logs → AC-21 · ✅

| | |
|---|---|
| Red | `functions/src/lib/log.spec.ts` — 4 new cases (3 failed as expected, 1 was the regression guard) |
| Green | `functions/src/lib/log.ts` — `SENSITIVE_QUERY` |
| Commits | `73a1bca`, `9f6b155` |

### Deviation: a test was rewritten rather than satisfied

The plan called for redacting `code` and `state`. Written literally, one test asserted that a
**`code` field** is redacted. Implementing that revealed it to be wrong, so the test was
changed deliberately rather than the rule shipped:

Every Firebase error reports its error code on a `code` property — `describeError` builds
`auth/email-already-exists: …` from exactly that — and this slice's own callback logs which
outcome it redirected with (`denied`, `invalid_state`, …). A rule matching `code` anywhere
would redact precisely the lines written to diagnose a failing OAuth flow, in exchange for
covering a case we never produce.

The rule therefore matches **query-string position only** — `([?&](?:code|state)=)[^&\s]+` —
and the test now asserts the *asymmetry*: a `state` field is redacted, a `code` field is
preserved. The parameter name is kept and only the value replaced, so a log line still records
which credential was present.

---

## T6 — Expiry arithmetic → AC-27, 32 · ✅

| | |
|---|---|
| Red | `functions/src/hl/token.spec.ts` — 9 cases |
| Green | `functions/src/hl/token.ts` |
| Commits | `bb5fe0f`, `eeb1047` |

Decision split from effect: this file is pure and the transactional rotation arrives through
`TokenDeps`, so the arithmetic is unit-testable and the race is tested at L4 where a race can
actually happen (T13).

The boundary is tested from both sides. `isFresh` uses a strict `>`, so a token expiring
exactly at the skew boundary refreshes — erring toward one extra refresh is far cheaper than
erring toward a 401 mid-flight.

No deviation.

---

## T7 — Verified-user wrapper → AC-6, 7 · ✅

| | |
|---|---|
| Red | `functions/src/auth/requireUser.spec.ts` — 9 cases |
| Green | `functions/src/auth/requireUser.ts` |
| Commits | `69db466`, `55e80aa` |

### Deviation: shape changed from `RequestHandler` to an async function

The first implementation returned a synchronous `RequestHandler` that called `next(err)`.
Four tests failed — not because the implementation was wrong, but because the rejection
arrived a microtask after the assertion ran.

Rather than make the test wait, the wrapper now returns an **async** function mounted with the
existing `asyncHandler`, which is the shape `requireAppCheck` already uses. That is more
consistent with the codebase, keeps rejections on a path the terminal error handler already
owns, and is awaitable in a test. The plan's file map is unaffected.

`uid` is passed to the handler as an argument rather than left on `req`/`res.locals`: ambient
state is untyped under `noPropertyAccessFromIndexSignature`, and a handler that forgot to
check would still compile and read `undefined` as a uid.

---

## T4 — Parse HighLevel's responses → AC-16 · ✅

`functions/src/hl/schema.spec.ts` (13) · `schema.ts` · commits `445ca6a`, `b0dda4f`

A discriminated union on `userType` rather than one schema with optional fields: a
"Location" token without a `locationId` is not something we can act on, and failing at the
boundary beats discovering it three calls later.

**`GET /locations/{id}` wraps its response** — `{ location: {...}, traceId }`, not a bare
location. Read `.name` off the body and you get `undefined`: no error, just a panel showing
`lUanVn0CtZJTlymH8ySo` where `India Square` belongs. A test now demands the wrapper.

## T8 — The fake HighLevel server · ✅

`functions/src/hl/fake.spec.ts` (2) · `fake.ts` · commit `d862d87`

Gated on `FUNCTIONS_EMULATOR` alone — it mints tokens without checking a client secret, so
deployed it would be an open door rather than a test double. Same reasoning as Slice 1's
fake mail transport (D21).

**Deviation: it had to become stateless.** The first version kept the installed-location
count in a module variable written during the token exchange and read during
`installedLocations`, which assumes both requests land in the same process — an assumption
the functions emulator does not guarantee. The count now travels on the `companyId`, so each
request answers from its own input. The same discovery removed an introspection endpoint
that AC-17 was briefly asserted through; that assertion moved to L1 in
`exchange.spec.ts`, where the plan had put it in the first place.

## T10 / T11 — The callback, every path → AC-9–21 · ✅

`tests/integration/hl-callback.spec.ts` (17) · `callback.ts`, `exchange.ts` · commit `d862d87`

Every path answers 302 and never a body. Query parameters are narrowed rather than
stringified: Express types them as `string | string[] | ParsedQs`, so `String(...)` on
`?state[]=a&state[]=b` yields `"[object Object]"` — narrowing sends a hostile shape down the
rejection path instead of turning it into a plausible-looking value.

**Deviation: AC-16 now resolves agency-wide installs** rather than rejecting them outright
(D25). Approved before implementing.

**Test defect found and fixed:** codes were reused across tests, so the fake's replay
handling — correct, and modelled on HighLevel's own — failed three tests for a reason
unrelated to what they assert. Each test now mints its own code; only the prefix carries
meaning.

## T13 — Transactional refresh · ⏭ **cut to Slice 8**

Cut with approval, on evidence rather than time pressure. D13 argued for building it now
because rotation-on-use would brick a connection when two callers refresh at once. **T1
measured that premise and it does not hold** — the old refresh token survives at least one
reuse. A concurrent double refresh is survivable, so the transaction is a robustness
measure rather than the only thing preventing an unrecoverable connection, and Slice 8 is
where it gets its first real consumer.

`getAccessToken` and its skew arithmetic (T6) still ship; only the Firestore transaction
moves. **AC-28 to AC-31 are therefore not met by this slice** and travel with it.

## T9 · T12 · T14 — endpoints and rules → AC-1–8, 22–26, 33 · ✅

`hl-connect.spec.ts` (7) · `hl-connection.spec.ts` (13) · `firestore.spec.ts` (+3) ·
commits `b106781`, `7bc0ad4`

The status projection is built by naming fields to include rather than removing ones to
hide — an allowlist fails safe when the document grows a field. Absence of token material is
asserted against the **raw response text**, because a leak nested one level down survives a
top-level key check.

T14 needed no rules change, which is the correct outcome: the plan said if it did, something
would be wrong. Its value is proving the deny still holds now the document holds real
credentials.

## T15 · T16 · T17 — the frontend → AC-34–43 · ✅

`ConnectionPanel.spec.ts` (15) · `HlCallbackView.spec.ts` (7) · `guard.spec.ts` (+3) ·
`hl.ts`, `hlApi.ts` · commit `adcc5b6`

Six panel states ship, not three: loading, empty, connected, connected-without-a-name,
reconnect-required, and error-with-retry.

**Test defect found and fixed:** the panel's store mock used `{ value: false }` wrappers, but
Pinia auto-unwraps refs on the store object, so every check was truthy and all six branches
collapsed to the first. Eleven tests failed; the fix was the mock, not the component.

## T18 — End to end · ✅

`tests/e2e/highlevel.spec.ts` (2) · commit `f56bebd`

Sign up → verify → Connect → approve at the fake → **Connected to India Square** → reload →
disconnect, plus the deny path. Everything is production code except the far side of the
handshake.

---

## Out-of-plan work, done on request

Both were asked for mid-build and are outside the slice's plan. Recorded here rather than
passed off as slice work.

**Local development now runs on the emulators** (`43ea3cb`). `npm run dev` starts the
emulators *and* the SPA against them in one command; `npm run dev:cloud` keeps the old
behaviour. This reverses a Slice 0–1 decision, and the reason is concrete: pointing
`npm run dev` at real Firebase meant the SPA proxied `/api` to the **deployed** functions, so
any endpoint living only on a branch answered 404 on the developer's own machine — this
slice's entire `/api/hl` surface included.

**The local OAuth flow was completing on the deployed site** (`2a067a6`). The emulator loads
`functions/.env`, and those values beat anything the shell exports — so the redirect URI was
the production one and both approve and deny ended on a 404. `functions/.env.local` is the
mechanism Firebase provides for this, and it is committed with a narrow `.gitignore`
exception because a fresh clone must be able to run `npm run dev`. It carries a second,
commented block for running against real HighLevel through an HTTPS tunnel.

That switch had a sharp consequence: with `.env.local` in real-HighLevel mode, **the suite
would have exchanged real authorization codes against the live API**. `config.ts` now
honours `HL_TEST_*` overrides, names absent from both `.env` files so a shell value survives,
honoured only under the emulator. The suite is now independent of local configuration
(`5add018`).

**The suites run on a second set of emulator ports** (`f56bebd`), so running tests no longer
means stopping a development session. `firebase.test.json` is generated from `firebase.json`
rather than committed, so port numbers are the only possible difference. The subtle part was
the SPA's own `connectAuthEmulator` and `connectFirestoreEmulator` calls, which were
hardcoded and kept the browser pointed at the development session's emulators after
everything else had moved.

---

## Suite

| Check | Baseline | Now |
|---|---|---|
| typecheck | 0 | **0** |
| lint | 0 | **0** |
| L1 unit — functions | 85 | **160** |
| L1/L2 unit — frontend | 190 | **215** |
| L3 rules | 16 | **19** |
| L4 integration | 34 | **68** |
| L5 e2e | 2 | **4** |

All measured with a development session running alongside.

## Acceptance criteria

| AC | Covered by |
|---|---|
| 1–3 | `authorize.spec.ts` — v2 path, every parameter, `%20` scope separator |
| 4, 5 | `state.spec.ts` — round trip, uid never in plaintext, uniqueness |
| 6, 7 | `hl-connect.spec.ts` — 401 unauthenticated, 403 unverified |
| 8 | `requireUser.spec.ts` + route wiring. A genuinely forged App Check token is refused by Google, not by us — manual, as Slice 1 recorded for its AC-50 |
| 9 | `hl-callback.spec.ts` — document shape and redirect |
| 10–12 | `state.spec.ts` (unit) + `hl-callback.spec.ts` (the redirect each produces) |
| 13 | `hl-callback.spec.ts` — replay leaves the existing connection untouched |
| 14–16 | `hl-callback.spec.ts` — deny, exchange failure, and all three bulk-install shapes |
| 17 | `exchange.spec.ts` — form-urlencoded, `user_type`, no `Version` header |
| 18, 19 | `hl-callback.spec.ts` — name stored; lookup failure degrades to null |
| 20 | `hl-callback.spec.ts` — reconnect replaces, one document per uid |
| 21 | `log.spec.ts` — code and state scrubbed in query position, error codes preserved |
| 22–26 | `hl-connection.spec.ts` — shapes, secrets absent from raw text, idempotent delete, cross-user isolation |
| 27, 32 | `token.spec.ts` — skew arithmetic, not-connected error |
| **28–31** | ⛔ **not met — T13 cut to Slice 8** |
| 33 | `firestore.spec.ts` — owner, stranger and anonymous all denied |
| 34–39, 42 | `ConnectionPanel.spec.ts` — six states, per-code copy, double-click guard |
| 40, 41 | `HlCallbackView.spec.ts` — finishing state, store write, `replace` not `push` |
| 43 | `guard.spec.ts` — `/hl/callback` round-trips through sign-in |
| Demo | `highlevel.spec.ts` — connect, name on screen, reload, disconnect, deny |

**39 of 43 met.** The four outstanding are AC-28–31, which belong to the cut task and move
with it.

## Deferred

- **`needsReconnect` short-circuit in `getAccessToken`.** A connection already marked dead
  still attempts a refresh, which fails and re-marks it. Harmless, no AC covers it.
- **AC-28–31**, with T13, to Slice 8.
- **PRD amendments applied** — AC-1, AC-2, AC-16 and risk 3 are updated in `02-prd.md`;
  D25 and D26 record what the build discovered.
