# Slice 02 — HighLevel connection · Review

**Date:** 2026-08-16 · **Branch:** `slice/02-highlevel-connection` · **Reviewed:** `main...HEAD`
**Verdict:** ✅ **Approved with two things named for the shipper.** Four findings, all fixed.
Two AC groups are deliberately unmet and travel to Slice 8.

The slice does what it set out to do, and the parts that were hardest to get right are the
parts that are best covered: the encrypted state, the callback's five outcomes, and tenant
isolation on the bulk-install path. The most serious finding was not in the code but in the
process — two modules shipped with no tests at all, and the component test that appeared to
cover them mocked them away.

## Suite

Run at review time, after the fixes, **with a development session running alongside** (the
suites now use a second set of emulator ports).

| Check | Result |
|---|---|
| `typecheck` | ✅ 0 errors |
| `lint` | ✅ 0 warnings (`--max-warnings 0`) |
| L1 unit — functions | ✅ **160** passed |
| L1/L2 unit — frontend | ✅ **240** passed |
| L3 rules | ✅ **19** passed |
| L4 integration | ✅ **70** passed |
| L5 e2e | ✅ **4** passed |

Baseline at branch point: 85 / 190 / 16 / 34 / 2.

## AC coverage

Only deltas and gaps are listed; the build log's table covers the rest and was verified
accurate.

| AC | Test | Verified |
|---|---|---|
| 1–3 | `authorize.spec.ts` | ✅ v2 path, `version_id`, and the `%20` scope separator — the last catches a failure that is silent in production |
| 4, 5 | `state.spec.ts` | ✅ Including `does not disclose the uid`, which asserts the reason for encrypting rather than signing |
| 10–12 | `state.spec.ts` + `hl-callback.spec.ts` | ✅ Asserted twice on purpose: a correct verifier wired to the wrong error code still ships a broken screen |
| 13 | `hl-callback.spec.ts` | ✅ Replay leaves the existing connection byte-identical |
| 16 | `hl-callback.spec.ts` | ✅ All three bulk shapes — one, many, none. The many case is the tenant-isolation guard |
| 21 | `log.spec.ts` | ✅ Asymmetric by design: `state` redacted, `code` preserved |
| 22–26 | `hl-connection.spec.ts` | ✅ Absence of tokens asserted against **raw text**, not parsed keys |
| **28–31** | — | ⛔ **Not met.** T13 cut to Slice 8 — see *Deliberately deferred* |
| 33 | `firestore.spec.ts` | ✅ Owner, stranger and anonymous all denied, read *and* write |
| 34–43 | `ConnectionPanel.spec.ts`, `HlCallbackView.spec.ts`, `guard.spec.ts`, **`hl.spec.ts`**, **`hlApi.spec.ts`** | ✅ The last two added by this review — see Finding 1 |

**39 of 43 met.**

## Findings

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | Required | **`stores/hl.ts` and `lib/hlApi.ts` shipped with no tests.** T15 called for both; the implementation went in without them. Worse than a plain gap: `ConnectionPanel.spec.ts` mocks the store wholesale, so the suite *looked* like it covered this code while asserting nothing about it. Uncovered: the `label` fallback, the `busy` lifecycle, `lastError` clearing, per-request token reads, and every error-mapping path. | **Fixed.** 25 tests added across `stores/hl.spec.ts` and `lib/hlApi.spec.ts`. Both modules proved correct — which is luck, not evidence; the tests are the evidence. |
| 2 | Required | **`ConnectionStatus` was optional-field soup read through an unchecked cast.** `snapshot.data() as ConnectionDocument` asserts a shape on unparsed input, and `locationId ?? ''` turned a half-written document into `connected: true` with blanks. That renders as "Connected to" followed by nothing — **and offers no way out**, because the panel only shows Connect when it believes you are disconnected. | **Fixed.** The document is parsed with Zod; the status is a discriminated union so `{ connected: true }` without a location is unrepresentable. Fails closed to `{ connected: false }` and logs, which is both truthful and recoverable — reconnecting overwrites the document. Typecheck immediately caught an unnarrowed `needsReconnect` access the old shape had hidden. |
| 3 | Required | **`messageFor` was duplicated between `authApi.ts` and `hlApi.ts`, and had already diverged.** The HighLevel copy lost the 429 case, so a throttled caller saw "Something went wrong" instead of being told to wait. A textbook near-duplicate of a canonical helper. | **Fixed.** One `messageForResponse` in `lib/api.ts`, used by both, with a regression test for the 429 path. |
| 4 | Required | **The callback swallowed HighLevel's errors.** Both failure paths caught and discarded the throw. The user's single `exchange_failed` code is right — naming the upstream condition helps nobody and signals a prober — but it left *us* with nothing to act on when the real integration fails in production. | **Fixed.** Exchange and resolve now log a redacted `describeError`, distinguished from one another. Values pass through the redaction pass, so an authorization code cannot ride along. |
| 5 | FYI | `frontend/src/lib/api.ts` and `hlApi.ts` both do `(await res.json()) as T` on unparsed input. Contrary to parse-don't-validate, but the established Slice 0 pattern; changing it means changing the shared helper and every caller. | Not changed. Raised as a candidate for a later cross-cutting pass. |
| 6 | FYI | `state.ts` casts `JSON.parse(plaintext) as StatePayload`, then narrows both fields before use. Momentarily a lie, checked before it matters. | Not changed. |
| 7 | FYI | The store mirrors an *endpoint*, not a Firestore collection, so the reference doc's "a store that mirrors a collection is a cache that will disagree" does not apply — the connection document is unreadable by any client by design. | No action. |

## Genesis-specific checks

| Check | Result |
|---|---|
| Non-owner denied on every new collection (L3) | ✅ No new collection this slice — the state is encrypted and never stored. `hlConnections` denials re-asserted against a document that now holds real credentials |
| No OAuth token reaches the client or a log | ✅ Projection is an allowlist; asserted against raw response text; `SENSITIVE_QUERY` scrubs `code` and `state` in query position |
| Secrets out of source | ✅ `functions/.env.local` is committed but contains only fake values and *omits* the real credentials so they fall through from the gitignored `.env`. Fixtures grepped for JWT-shaped strings — none |
| Loading, empty, error states | ✅ Six on the connection panel, plus the callback route's transient state |
| Fake HighLevel unreachable in production | ✅ Gated on `FUNCTIONS_EMULATOR` alone, with a test asserting the router is empty otherwise |
| Tests cannot reach the real API | ✅ `HL_TEST_*` overrides, honoured only under the emulator, set by the test scripts — so the suite is immune to whichever mode `.env.local` is left in |

## Two things for the shipper to weigh

Neither blocks merge; both should be in the PR description rather than discovered in review.

**1. The PR mixes feature work with build tooling.** Three changes were requested mid-build
and are outside the PRD: emulator-driven `npm run dev`, the `.env.local` fix, and running the
suites on a second port set. Each is justified — the second fixed a real bug where the local
OAuth flow completed on the deployed site — but together they are roughly a fifth of the
non-test diff and would have been a clean separate PR. Splitting now costs more than it saves;
naming them in the PR body does not.

**2. The diff is large: 5,572 insertions across 62 files.** Above the "split it" line, though
the composition matters — 1,397 lines are recorded fixtures, 1,880 are tests, 447 are docs.
Source is ~2,800, which is a large-but-coherent vertical slice. No single source file exceeds
182 lines.

## Manual verification

- **The real integration was exercised end to end against the sandbox** during the build, not
  simulated: authorization code exchanged, agency→location token derived, and live reads of
  contacts (5), calendars (5), events (3), conversations (5) and the location name
  (`India Square`). Those responses are the fixtures the suite replays.
- **Rotation measured, not assumed:** refresh rotates, the old token survives one reuse, the
  third attempt returns `invalid_grant`.
- ⚠️ **The full browser flow against real HighLevel was not completed.** It requires
  registering a tunnel URL as the app's redirect, which replaces the deployed one. The
  equivalent path is covered by the e2e against the stub, where every component except
  HighLevel itself is production code. **Ship should verify the deployed callback once the
  real redirect URI is registered** — that is F9.3 and it belongs to Slice 13 regardless.

## Deliberately deferred

- **AC-28–31 and T13 (transactional refresh) → Slice 8.** Cut on evidence: D13 argued for it
  on the premise that rotation-on-use bricks a connection when two callers refresh at once,
  and measurement disproved that premise. The transaction remains worth building — it prevents
  wasted calls and inconsistent stored state — and Slice 8 is where it gets its first real
  consumer. `getAccessToken` and its skew arithmetic ship now.
- **`needsReconnect` short-circuit in `getAccessToken`.** A connection already marked dead
  still attempts a refresh, fails, and re-marks it. Harmless, no AC covers it, travels with T13.
- **Parse-don't-validate on the frontend's own API responses** (Finding 5), as a cross-cutting
  pass rather than one client at a time.
