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
