# Slice 02 — HighLevel connection · Build log

**Branch:** `slice/02-highlevel-connection` · **Started:** 2026-08-16 · from `main` at `93f72e9`

Baseline before any change, confirmed green: typecheck 0 · lint 0 · **functions 85 · frontend 190** ·
rules 16 · integration 34. E2E not run — see *Blocked*.

---

## T1 — Record the HighLevel fixtures · ⛔ **blocked**

Blocked on a browser step only the project owner can perform: installing the app into the
sandbox location and returning the authorization code. Three attempts, and the failure
turned out to be a defect in our own reference doc rather than in configuration — see the
T3 amendment below.

Everything downstream of a real token response is blocked with it: **T4** (response schemas),
**T8** (the fake HighLevel server, which serves the recorded payloads), **T10**, **T11**,
**T13**, **T18**.

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

## Suite

| Check | Baseline | Now |
|---|---|---|
| typecheck | 0 | 0 |
| lint | 0 | 0 |
| L1 unit — functions | 85 | **132** |
| L1/L2 unit — frontend | 190 | 190 |
| L3 rules | 16 | 16 |
| L4 integration | 34 | 34 |
| L5 e2e | not run | not run |

## Blocked

1. **T1 — the sandbox install.** Needs the project owner to complete the browser flow and
   return the authorization code. Blocks T4, T8, T10, T11, T13, T18.
2. **E2E cannot run.** A development-mode Vite server (PID 15421) holds port 5173, and
   `reuseExistingServer: false` refuses it by design — a dev server talks to *real* Firebase,
   so reusing it would test production while reporting an emulator pass. Must be stopped
   before T18.

## Deferred

- **`needsReconnect` short-circuit in `getAccessToken`.** A connection already marked dead
  will currently still attempt a refresh, which fails and re-marks it. Harmless, and no AC
  covers it, so it stays out of this branch. Worth raising at review.
