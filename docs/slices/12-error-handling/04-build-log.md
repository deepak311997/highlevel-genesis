# Slice 12 — Error handling & state hardening · Build log

**Branch:** `slice/12-error-handling` · **Plan:** `03-plan.md` (approved) · **PRD:** `02-prd.md`
· **Base:** `main` at `94bcc1f` · **Started:** 2026-08-18

## Baseline before any change

| Gate | Result |
|---|---|
| `npm run typecheck` | green |
| `npm run lint` | green (0 warnings) |
| `npm run test:unit` | green — 68 frontend files / 962 cases, plus 3 script files / 21 cases |
| `npm run test:rules` | green — 1 file / 52 cases |
| `npm run test:integration` | green (run concurrently with T1; see T-log) |

No pre-existing failure. Nothing was fixed silently.

## The audit, carried from the PRD (definition-of-done line)

**Every screen on `main` at `94bcc1f` already renders loading, empty and error.** Each cell
names the `data-testid` that proves it. "—" means the surface has no such state by
construction (a form has nothing to be empty of).

| Screen / panel | Loading | Empty | Error | Retry |
|---|---|---|---|---|
| `SignInView` | button label | — | `signin-error` | resubmit |
| `SignUpView` | button label | — | `signup-error`, `signup-email-error`, `signup-password-error` | resubmit |
| `ForgotPasswordView` | button label | — | `forgot-error`, `forgot-email-error` | resubmit |
| `VerifyEmailView` | button label | — | `verify-error` | resend |
| `AuthActionView` | state machine | — | `action-password-error` + failed state | resubmit |
| `HlCallbackView` | `hl-callback-status` | — | status copy per error code | back to dashboard |
| `AccountCard` | `account-loading` | `account-empty` | `account-error` | `account-retry` |
| `ConnectionPanel` | `connection-loading` | `connection-empty` | `connection-error`, `connection-callback-error`, `connection-needs-reconnect` | `connection-retry` |
| `ConnectionPanel` › Data access | `data-access-loading` | — | `data-access-error` | `data-access-check`, `data-access-reconnect` |
| `ProjectsCard` | `projects-loading` | `projects-empty` | `projects-error` | `projects-retry` |
| `ProjectFormDialog` | button label | — | `project-form-error` | resubmit |
| `ProjectDeleteDialog` | button label | — | `project-delete-error` | resubmit |
| `WorkspaceView` | `workspace-loading` | `workspace-missing` | `workspace-error` | `workspace-retry` |
| `ChatPanel` | `chat-loading` | `chat-empty` | `chat-error`, `generate-error`, `generate-file-error` | `chat-retry`, `generate-retry` |
| `MessageComposer` | button label | — | `composer-error` | resend |
| `FileTree` | `file-tree-loading` | `file-tree-empty` | `file-tree-error` | `file-tree-retry` |
| `FileEditor` / `CodeEditor` | `file-editor-loading`, `code-editor-loading` | `file-editor-empty` | `file-editor-read-error`, `file-editor-error` | `file-editor-retry`, resave |
| `PreviewPanel` | `preview-loading` | `preview-empty` | `preview-error`, `preview-failure`, `preview-runtime-error` | `preview-retry`, `preview-reconnect` |
| `SnapshotSheet` | `snapshot-loading` | `snapshot-empty` | `snapshot-error`, `snapshot-restore-error` | `snapshot-retry` |

**The measurement behind AC-1 (plan C4).** Of the 61 testids above, 60 were already asserted
in their component's spec at `94bcc1f`. The script that measured it, reproduced so the claim
stays checkable:

```sh
# from frontend/, for each testid in the table:
grep -rn "<the testid>" src --include='*.spec.ts' | head -1
```

The single exception was `preview-reconnect`, which *was* asserted — as a `RouterLinkStub`
with `to === '/dashboard'` and the text `Reconnect HighLevel` (`PreviewPanel.spec.ts:411–414`)
— but never by its testid, so the table was not checkable against it. T19 closes that.

## Lane analysis

The plan pins the lanes (§ Lanes) and the build follows them exactly:

- **Barrier L-SKELETON (T1 → T2 ∥ T3 → T4)** runs first and alone, because it opens
  `ConnectionPanel.vue` (also L-HL), `SnapshotSheet.vue` (also L-TOAST) and `ChatPanel.spec.ts`
  (also L-STREAM). T2 and T3 are disjoint inside it and run concurrently.
- Then **L-SESSION** (T5→T6→T7→T8→T9→T10, T20 last), **L-HL** (T12→T13), **L-TOAST**
  (T14→T15; T16; T17→T18) and **L-AC1** (T19) run fully in parallel — they share no file.
- **T11 is the one join** (`generateApi.*` from L-SESSION, `stores/workspace.spec.ts` from
  L-TOAST, `ChatPanel.spec.ts` from the barrier) and is kept by the lead, run last.

## Tasks

### T1 — Vendor `Skeleton` (AC-2)

- **Red:** `frontend/src/components/ui/skeleton/Skeleton.spec.ts` — three cases: the
  `data-slot="skeleton"` attribute plus the three base classes; a caller's `rounded` winning
  the tailwind-merge conflict against `rounded-md` (the five sites that use `rounded` keep
  their shape — R2); and the sizing utilities the call sites carry surviving. Failed to
  resolve `./index`, which is the expected red.
- **Green:** `Skeleton.vue` + `index.ts` exactly as the plan pins them. Base is `bg-secondary`,
  **not** upstream's `bg-accent` — `style.css` reserves the ember accent for the live element,
  and the plan records this departure. `npx shadcn-vue@latest add skeleton` was deliberately
  not run.
- **Deviation:** none.

### T2 — Skeleton: the dashboard three (AC-2) · lane L-SKELETON, run concurrently with T3

- **Red:** four tests, one per loading surface, each asserting the existing loading testid
  still resolves **and** the count of `[data-slot="skeleton"]` inside it.
  - `AccountCard.spec.ts` — `renders Skeleton placeholders while loading` (`account-loading`, 2)
  - `ConnectionPanel.spec.ts` — `renders Skeleton placeholders while loading` (`connection-loading`, 2)
  - `ConnectionPanel.spec.ts` — `renders Skeleton placeholders while the probe runs`
    (`data-access-loading`, 3)
  - `ProjectsCard.spec.ts` — `renders Skeleton placeholders while loading` (`projects-loading`, 2)

  All four failed on the count (`expected [] to have a length of 2 but got +0`), not on an
  import — the right red.
- **Green:** seven `<div class="… animate-pulse rounded bg-secondary" />` became
  `<Skeleton class="… rounded" />`, keeping `rounded` rather than the base `rounded-md` so
  tailwind-merge preserves each shape (R2), and keeping `v-for="n in 3"` / `:key="n"` on the
  probe's placeholder.
- **Deviation:** the second ConnectionPanel test is named `renders Skeleton placeholders while
  the probe runs` rather than repeating the plan's literal name. Two identically-named tests in
  one file makes a failure report ambiguous about which state broke, and it sits in a different
  `describe` block (`ConnectionPanel — data access`). Behaviour asserted is exactly as planned.

### T3 — Skeleton: the workspace seven (AC-2) · lane L-SKELETON, run concurrently with T2

- **Red:** seven tests named `renders Skeleton placeholders while loading`, in T2's shape.
  `WorkspaceView` (`workspace-loading`, 1), `ChatPanel` (`chat-loading`, 2), `FileTree`
  (`file-tree-loading`, 2), `FileEditor` (`file-editor-loading`, 1), `CodeEditor`
  (`code-editor-loading`, 3), `PreviewPanel` (`preview-loading`, 1), `SnapshotSheet`
  (`snapshot-loading`, 2 — through the file's document-scoped `must()` helper, since the sheet
  portals). 7 failed / 124 passed, every failure on the count, none on an import.
- **Green:** twelve placeholders replaced, each `Skeleton` carrying verbatim the `h-*`/`w-*` it
  replaced. No wrapper restructured — the `absolute inset-0` covers in `CodeEditor.vue` and
  `FileEditor.vue` are untouched, so Monaco's height chain is unchanged (R2).
- **Deviations, both recorded rather than silent:**
  - `FileTree.spec.ts`'s existing skeleton test was extended **and renamed** to the plan's name,
    keeping its `file-row` assertion, rather than leaving two near-identical names.
  - `CodeEditor.spec.ts`'s existing `renders the skeleton until the editor mounts` was **kept
    intact** and the count case added beside it. That test asserts a two-phase mount timing
    sequence which a count assertion would muddy; the plan's "extend rather than add a second"
    was aimed at avoiding a duplicate skeleton-*presence* test, and no test was weakened.

### T4 — `animate-pulse` lives in one place (AC-3) · closes the barrier

- **Red:** `frontend/src/lib/no-pulse.spec.ts`, in `no-cdn.spec.ts`'s exact shape — needle by
  concatenation (`'animate-' + 'pulse'`), `SELF = 'no-pulse.spec.ts'`, a `FORMS`/`INNOCENT` pair
  (4 + 3 cases) proving the scanner before it is trusted, offenders reported **by path**, and
  `components/ui/skeleton/` the only allowed directory. Written before being run, so its red
  state is the offender list.
- **The red state, and the plan amendment it forced.** The scan named three files:
  `AccountCard.spec.ts`, `ConnectionPanel.spec.ts`, `ProjectsCard.spec.ts`. The plan's T4 note
  says *"no spec mentions the string today (checked)"* — true at `94bcc1f`, and made false by
  **T2 itself**, whose new spec comments read ``hand-rolled `animate-pulse` div``. T3 hit the
  same thing and had already reworded its own.

  Two ways out, and the choice matters: exempt `*.spec.ts` from the scan, or reword the prose.
  **Rewording is the fix taken.** A spec is source, and a hand-rolled placeholder inside a test
  fixture is precisely the thing this scan has to catch — exempting the specs would carve a hole
  in the scan to accommodate a comment, which is weakening the test to get it green. The three
  comments now read "hand-rolled pulsing div", matching T3's wording.
- **Green:** 8/8 in the scan. Full frontend suite **70 files / 983 tests**, typecheck and lint
  clean (zero warnings).
- **Barrier closed.** L-SESSION, L-HL, L-TOAST and L-AC1 may now run concurrently.

## Post-barrier fan-out

Lanes dispatched concurrently, exactly as the plan's § Lanes pins them, with two
build-stage coordination changes recorded below under *Deviations from the plan's lane split*.

### T19 — the audit table's one unchecked row (AC-1) · lane L-AC1

- **Red/Green:** one assertion added to the existing `offers Reconnect HighLevel for %s` case in
  `PreviewPanel.spec.ts`: `expect(link.attributes('data-testid')).toBe('preview-reconnect')`.
  `RouterLinkStub` does forward non-prop attributes, so the plan's fallback form
  (`wrapper.find('[data-testid=…]')`) was not needed — and the form used is the better claim,
  because it pins the testid to the *same* element already proved to carry `to === '/dashboard'`
  and the text `Reconnect HighLevel`, rather than asserting the testid exists somewhere.
- No change to `PreviewPanel.vue` was needed; the testid renders at line 138 as the plan says.
  22 tests in that file green. **AC-1 now holds for all 61 audit rows.**

### T14 — vendor `sonner` (AC-7, dependency) · kept by the lead

Kept out of the lane split deliberately: it is the only task that runs `npm install`, and
mutating `node_modules` underneath four lanes running Vitest is a race with nothing to gain.

- **Red:** `deps.spec.ts` gained `'vue-sonner'` to `EXPECTED` — failed on the whole-set
  assertion (`expected [ …(14) ] to deeply equal [ …(15) ]`), which is what makes "one new
  dependency" a claim with a test behind it. `Sonner.spec.ts` failed to resolve `./index`.
- **Green:** `npm install vue-sonner` (^2.0.9). `Sonner.vue` written by hand rather than taken
  from `npx shadcn-vue@latest add sonner`: upstream themes off `@vueuse/core`'s `useColorMode`,
  and this project already owns `useDarkClass()`, which *observes* the `dark` class that
  `useTheme` and the pre-paint script in `index.html` both write. A second derivation of the
  theme is what `useDarkClass`'s own doc comment exists to prevent.
- `style.css` gained `@import 'vue-sonner/style.css';` after the two `@fontsource` imports and
  after `@import 'tailwindcss'`, which stays first. **R1 stands: no automated test can see this
  import.** Without it the Toaster mounts, all four tests still pass, and nothing is visible.
  The manual walk in the definition of done is the only proof, and it is listed there for
  exactly this reason.
- 4 tests green; `eslint src/components/ui/sonner --max-warnings 0` clean.
