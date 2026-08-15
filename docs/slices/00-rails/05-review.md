# Slice 00 — Rails · Review

**Date:** 2026-08-15 · **Branch:** `main` (uncommitted working tree) · **Reviewer:** automated

## Process note

Stages 1–3 were skipped for this slice — there is no `01-discovery.md`, `02-prd.md`, or
`03-plan.md`. Slice 0 was scaffolded directly on request. The acceptance criteria used for this
review are therefore `docs/IMPLEMENTATION_PLAN.md` §4 (Slice 0) and §3 (definition of done), plus the
deliverables section of `GENESIS_ASSIGNMENT_V2.pdf`. Slices 1+ should run the full loop.

## Suite

| Check | Result |
|---|---|
| `typecheck` (vue-tsc + tsc) | pass |
| `lint` (strictTypeChecked, zero warnings) | pass |
| Unit — functions (Vitest) | 4 passed |
| Unit — frontend (Vitest + VTU) | 12 passed |
| Rules (`@firebase/rules-unit-testing`) | 5 passed |
| E2E (Playwright, emulators) | 2 passed |
| `npm test` (CI path) | exit 0 |
| Production build | pass |

## Acceptance-criteria coverage

| Criterion (IMPLEMENTATION_PLAN §4) | Evidence |
|---|---|
| Monorepo layout `/frontend`, `/functions`, `firebase.json`, `.firebaserc` | present; matches the PDF deliverables list |
| Vue 3 + TS + Vite + Tailwind + shadcn-vue | builds; 12 KB CSS emitted confirms Tailwind active |
| Firebase emulators for auth/firestore/functions/hosting | `All emulators ready` |
| Five test harnesses wired and running | L1/L2/L3/L5 all executed; L4 has no cases yet |
| CI running typecheck + lint + unit + rules | `.github/workflows/ci.yml` |
| Vertical proof: `/health` page → `ping` function → Firestore | `{"ok":true,…,"roundTripMs":276}` |
| Demo: emulators up, open `/health`, see ok | verified manually and by e2e |

**Gap:** L4 (integration against emulators) has no test cases. The health endpoint is covered
end-to-end by L5 instead. Acceptable for Slice 0; Slice 2's OAuth callback is the first thing
that genuinely needs L4.

## Findings

| # | Severity | Finding | Action |
|---|---|---|---|
| 1 | Required | `generate` was a public, unauthenticated endpoint with `timeoutSeconds: 3600`. A caller could hold an instance open for an hour; the stub needs ~750 ms. | Fixed — 60 s / 256 MiB, with a comment tying the long timeout to Slice 5's auth check |
| 2 | Required | `HealthView` modelled one value as three parallel refs (`status`, `result \| null`, `message`), forcing `?? -1` sentinels that `formatDuration` rendered as `—`. A silent fallback hiding an unclear invariant. | Fixed — discriminated union `State`; sentinels deleted |
| 3 | Required | CI installed with `npm install`, which can resolve versions the lockfiles don't pin and mutate them in place. | Fixed — `npm ci` for all three packages |
| 4 | Required | `lib/firebase.ts` connected to emulators only when `VITE_USE_EMULATORS === 'true'`. With the var unset — as in the current `.env` — a dev build would silently target production Firebase. | Fixed — emulators are the default in a dev build; opting out is now explicit |
| 5 | Consider | Six dependencies have zero references: `vuefire`, `reka-ui`, `lucide-vue-next`, `@vueuse/core`, `@anthropic-ai/sdk`, `zod`. All are for Slices 1–6. | **Accepted as-is** at ship time — kept deliberately so the scaffold is complete. Trade-off understood: later slices won't show their own dependency additions |
| 6 | Consider | `GENESIS_ASSIGNMENT_V2.pdf` is committed, and the assignment mandates a **public** repo — this publishes HighLevel's take-home brief verbatim. | **Resolved** — gitignored before the first commit, so it never enters history. The file stays on disk locally |
| 7 | FYI | `encodeSseComment` is exported and tested but unused by product code. Intended for Slice 5 keep-alive frames. | Left in place; flagged rather than deleted |
| 8 | Nit | `tests/rules/vitest.config.mts` uses a root-relative `include`, so it only works when run from the repo root. | Left — the npm script always runs from root |

## Change sizing

~77 files, far past the ~1000-line guidance. This is the documented exemption: scaffolding and
generated config where the reviewer verifies intent rather than every line. Worth stating plainly
rather than waving through — the reviewable surface is `firebase.json`, `firestore.rules`,
`functions/src/**`, and `frontend/src/**` (roughly 600 lines); the rest is lockfiles, brand assets,
and configuration.

## Manual verification

- `npm run dev` → `http://localhost:5173/health` renders the ok state with live timings.
- `curl` against the functions emulator returns `{"ok":true,…}`.
- SSE verified by timestamping frames: they arrive ~125 ms apart, not buffered into one write.
- Emulator suite starts clean on ports 4000 / 5001 / 5050 / 8080 / 9099.

## Deliberately deferred

- **L4 integration tests** — first genuinely needed by Slice 2 (OAuth callback error paths).
- **Auth on `generate`** — Slice 5, together with the long timeout it needs.
- **Deployment** — Slice 13. `.firebaserc` still points at `demo-genesis`.
