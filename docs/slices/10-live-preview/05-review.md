# Slice 10 — Live preview · Review

**Branch:** `slice/10-live-preview` · **Diff:** `main...HEAD`, 26 files, ~6,000 insertions
(2,438 of them slice docs) · **Reviewed:** 2026-08-18 · **Reviewer:** stage 4, unattended

Reviewed as another author's PR: the diff read in full first, then six lanes run concurrently
— correctness, security, architecture, performance, readability, and one auditing the PRD's
acceptance criteria against the tests that claim to cover them. Every lane finding was
re-derived against the code before it reached this document; the ones that could not be
reproduced were dropped and are listed under *Claims that did not survive*.

## Suite

Baseline counts are the orchestrator's gate run on `13dfbf6`
(`.autopilot/logs/10/gate-post-build.1.log`), not a re-run. The right-hand column is what was
re-run **after** the fixes below.

| Check | Baseline (13dfbf6) | After fixes |
|---|---|---|
| `typecheck` | clean | clean |
| `lint` (`--max-warnings 0`) | clean | clean |
| `prettier --check` | not in the gate's six suites | clean, after `--write` on the 2 files this review's edits unformatted |
| `test:unit` — functions | 43 files / 1051 tests | not re-run — no `functions/` change |
| `test:unit` — frontend | 65 files / 883 tests | **65 files / 897 tests** (+14) |
| `test:unit` — scripts | 3 files / 21 tests | not re-run — no `scripts/` change |
| `test:rules` | 1 file / 38 tests | not re-run — `firestore.rules` untouched |
| `test:integration` | 16 files / 329 tests | not re-run — `functions/src` untouched |
| `test:e2e` | 17 passed | **7 passed** — the Slice 05 and Slice 10 specs, re-run against the emulators after the fixes (the panel's rebuild timing is the one thing only L5 exercises end to end). The other 10 cover auth, files, the editor and the HighLevel handshake, none of which this review touched. |

The PRD's definition of done requires the L3 and L4 counts to be **unchanged against `main`**,
measured rather than assumed. `git diff main...HEAD --stat` lists no file under `functions/`,
`firestore.rules`, `tests/rules/` or `tests/integration/`, so both counts are unchanged by
construction; the baseline run confirms 38 and 329.

## AC coverage

All 39 criteria have a named passing test. The audit opened every test rather than trusting
the matrix; the table records only where the audit disagreed with the build log.

| AC | Test | Verified |
|---|---|---|
| AC-1 … AC-8 | `previewDocument.spec.ts` | Yes. AC-4 is a genuine byte-identical round trip — the embedded `ASSETS` literal is `JSON.parse`d back out and compared with `toEqual`, and the `<script`/`</script` counts are asserted equal at 3. AC-1 is satisfied *as amended*: head opens with the CSP meta and **then** the shim, because AC-7 requires the meta to precede it. The PRD's AC-1 wording ("the shim `<script>` is the first element of `<head>`") is the stale one; the test documents the resolution. |
| AC-2 | `previewDocument.spec.ts` + **new** `previewShim.spec.ts` | Was **weak** — the string half only. "Installed at that position" was executed nowhere, so a `__genesisAsset` that silently no-op'd for stylesheets passed the whole suite. Four new L1 cases now drive the loader. See finding 6. |
| AC-9 … AC-16 | `previewShim.spec.ts` | Yes, at the strength stated. Pendingness (AC-9, AC-12) is asserted with a real `Promise.race` sentinel, not inferred. AC-13 asserts all three claims separately (rejects, no `hl` post, exactly one `error` post). AC-14 uses fake timers to the full 30 s. |
| AC-17, AC-18 | `previewBridge.spec.ts` | Yes. Both assert `proxy` **and** `post` uncalled. AC-18 covers six malformed shapes against the four the AC names. |
| AC-19 … AC-21 | `stores/preview.spec.ts` | Yes, and stronger than the matrix claims: `fetch` is what is stubbed, not `hlProxy`, so AC-20's "no network request" is a claim about the request that would really have gone out. |
| AC-22 | `api.spec.ts` | Yes, including the 429-override case proving `code` is still lifted from the body. |
| AC-23, AC-24 | `stores/workspace.spec.ts` | Yes. The ordering in AC-23 is genuinely asserted: the refetch is held open with a `deferred()` and both counters are checked at zero *while it is in flight*. |
| AC-25 … AC-36, AC-38 | `PreviewPanel.spec.ts` | Yes. AC-28 asserts the sandbox value as an exact literal. AC-27 now also covers its second cause — see finding 2. |
| AC-37 | `PreviewPanel.spec.ts`, `stores/preview.spec.ts` | Was **weak** — both asserted only after the rebuild had settled, so clearing the banners at the *end* of `build()` would have passed while leaving the previous app's failure on screen for the whole read. The store case now asserts inside the in-flight window. See finding 5. |
| AC-39 | `tests/e2e/preview.spec.ts` | Yes. Two independent lines of evidence, as the AC asks: a 200 on `/api/hl/proxy/contacts/search` (host-visible) and a fixture contact's name read inside the sandboxed frame (user-visible), plus all three banners at count 0. R1's fallback was not needed. |

## Findings

Ordered by leverage. Severity is this reviewer's, taken against the PRD's decisions table —
two lane findings were downgraded because they name a recorded trade-off rather than a defect.

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | **Required** | **Re-opening the same project strands the preview on its empty state.** `WorkspaceView` watches the route param with `immediate: true`, so dashboard → project A → dashboard → project A calls `workspace.open('A')` again. `clearFileState()` empties `files` and zeroes `generationsApplied`; the sync watcher read that zeroing as a rebuild trigger and built against the now-empty list, settling to `empty`. The project id never moved, so nothing reset the preview store, and when the refetched list arrived `ensureBuilt`'s `state !== 'idle'` guard declined to build. A project with twenty files sat on "Describe the app you want in the chat panel" until someone pressed Refresh. | Fixed. The `filesLoaded` watcher became a three-outcome watcher (`loaded` / `failed` / `pending`); the `pending` arm resets, which is also what keeps `ensureBuilt`'s idle guard honest, since every path into `loaded` now passes through `pending`. The counter watcher rebuilds only when the counter **advances**. Two regression tests, both red first. |
| 2 | **Required** | **No error state for a failed file *list*** — the panel's only cause of `error` was a failed *read*. `loadFiles` leaves `filesLoaded` false when it fails, so nothing reached the preview store: the panel sat on its loading skeleton indefinitely, and a Refresh pressed out of impatience read the empty list at face value and announced that the project has no app yet. That is a false statement on screen about a project that may hold twenty files, and the definition of done requires this screen to have an error state. | Fixed. `build()` refuses to call an empty list "no files" while `workspace.filesError` is set, the new `failed` arm settles to `error` with the server's message, and **Try again** asks the workspace for the list — this panel holds no paths and has no business fetching them. Three tests, red first. |
| 3 | **Required** | **The 50-call budget was enforced only inside the frame.** `HL_CALL_LIMIT` lived entirely in the shim's closure; the host forwarded every accepted message to `hlProxy` and counted nothing. The shim runs inside the document it is meant to restrain — its source is an inline `<script>`, so the nonce is there to be read, and anything in the frame can post straight past `hl()`. The control was on the untrusted side of the boundary, and what it guards is the user's own CRM account being throttled and their function invocations being spent. | Fixed. The store keeps its own `brokered` count at the `proxy` seam, rejecting past the limit with an `ApiError` so the refusal travels the path every other failure travels (failure reply to the frame, banner on the panel). Reset by a **build**, not a mount — which also bounds finding 8. Two tests, red first. |
| 4 | **Required** | **`flush: 'sync'` coupled this store to statement order inside another store.** The justifying comment claimed both counters "move in the same statement"; they are two statements in `applyGenerationFiles`, and a sync callback runs *between* them. The rebuild therefore stamped `builtRevision` from whichever counter happened to be written first, and swapping those two lines — in a 1,100-line file, with nothing on either side saying the order mattered — would have made every automatic rebuild land instantly stale. The flash the comment defends against does not exist: a `'pre'` callback runs before the component update in the same flush, and `build()` reaches `state = 'loading'` before its first `await`. | Fixed. Dropped to the default flush and rewrote the comment. A parameterised test asserts "not stale after an automatic rebuild" in **both** counter orders; the reversed order fails against `flush: 'sync'`, which was verified by restoring it. |
| 5 | **Required** | **AC-37's ordering was unpinned, and one assertion was vacuous.** Both AC-37 tests asserted only after `build()` had settled, so an implementation that cleared the banners at the end would have passed while carrying the previous document's failure over the new one for the length of the reads. Separately, `stores/preview.spec.ts` created a `fakeFrame()`, wired it to nothing, and asserted `expect(frame.postMessage).not.toHaveBeenCalled()` — true regardless of what the code does, and it would survive deleting the broker outright. | Fixed. The store case holds the reads open and asserts the clean slate *inside* the in-flight window; the assertion that asserted nothing is gone. |
| 6 | **Required** | **`__genesisAsset` had zero test coverage** — the one function that installs anything, and the whole of AC-2 and AC-3's "and run". `previewDocument.spec.ts` asserts strings and jsdom does not execute the document, so a loader that returned early for `kind: 'css'` would have left every generated page unstyled with the suite green. | Fixed. Four L1 cases drive the loader over a stand-in `document`: a `<style>` and a `<script>` built with the stored content, replacement **in place** rather than appended, the head fallback when there is no `currentScript`, and a no-op for an index the payload does not hold. |
| 7 | **Required** | **`warnings` could hold duplicates.** One is pushed per *reference*, and the panel renders them in a `v-for` keyed on the sentence — so a page naming the same missing file twice produced duplicate keys (Vue's Priority A rule) as well as the same complaint twice. | Fixed. The assembler accumulates into a `Set`. One test. |
| 8 | **Required (documentation)** | **The preview re-runs the generated app on every remount, which three comments and one PRD risk row say it does not.** `reka-ui`'s `Tabs` unmounts hidden content by default, so on the narrow layout every switch away from Preview and back destroys the `<iframe>`; a new element executes its `srcdoc` from scratch and the app's `hl()` calls go out again. The breakpoint crossing at `lg` does the same. The store header claimed "a breakpoint swap re-renders the same document instead of refetching every file and re-running the app's CRM calls" — the refetch is genuinely saved, the re-run is not — and the PRD's R5 says "exactly two triggers, both deliberate". | Comments corrected. The cost is now **bounded** by finding 3: `brokered` is reset by a build and not by a mount, so one document spends at most 50 brokered calls however many times it is remounted. Keeping the frame alive across the swap is deferred — see *Deliberately deferred*. |
| 9 | Required (comments) | Three doc comments stated things the code does not do. `previewShim.ts` twice described the escape as "every `<` written as the escape `<`" — the `<` literal had been lost in editing, leaving a sentence that says the escape is the thing being escaped. `previewBridge.ts`, `stores/preview.ts` and the PRD's D3/R6 all say a reply carries "never a token, a uid or a **location id**" — and R6 leans on that to justify `targetOrigin: '*'`; HighLevel's bodies embed `locationId` in most records and D17 forbids re-shaping them. `api.ts` said the preview bridge reports `detail` back to the generated app; it does not. | All three corrected in place. The `locationId` correction states the accurate invariant — no credential and nothing identifying the Genesis account — and says why a tenant identifier the frame is already rendering is not one. |
| 10 | Consider (applied) | `previewBridge.ts` restated `HlMethod` as a third copy — a type, a `readonly string[]`, and the widening that forced `method as PreviewMethod`. CLAUDE.md names `satisfies` over `as` explicitly, and the cast was a symptom of the widening. | Applied: `PreviewMethod = HlMethod`, `METHODS` as `as const satisfies readonly PreviewMethod[]`, and a type predicate. The cast is gone; behaviour is identical. |
| 11 | Nit (applied) | The error state's **Try again** was the only one of the three rebuild controls without `:disabled="workspace.generating"`. `rebuild()` no-ops, so behaviour was right and the button looked live. | One attribute. |
| 12 | Nit (applied) | `previewDocument.ts`'s header said "`<head>` opens with exactly two elements this module wrote" — true only on the `<head>` path; `insertionPoint` also splices after `<html>` or the doctype. | Reworded. |

### Claims that did not survive verification

- **"The frame can hand the brokered capability to a remote origin."** The exploit is real as
  described — the nonce is readable out of the inline shim, a sandboxed frame may navigate
  itself, and `contentWindow` identity survives that navigation, so `evil.test` loaded into
  the frame passes both halves of the gate. What does not survive is the *severity*: D10
  deliberately leaves `script-src` open, so hostile code in the frame can already load
  `https://evil.test/x.js` and get an adaptive, attacker-controlled channel with `hl()` in
  scope, for the same lifetime. The navigation route grants nothing the simpler one does not.
  Recorded under *Deliberately deferred* with the fix, not raised to Required.
- **"`connect-src 'none'` does not close the exfiltration channel it claims to close."**
  Accurate as a statement about `img-src` and `form-action`, but D10 records the open
  directives as a decision, with its reason. R8's conclusion ("the worst case is a defaced
  preview") is understated and that is worth carrying forward; the code is not wrong.
- **"`defer` / `async` / `type=module` are dropped by `loaderCall`."** Reproduced and real —
  a `<script defer src="app.js">` in `<head>` becomes a synchronous inline script and runs
  before the body exists; `type="module"` becomes an outright `SyntaxError`. Not fixed here:
  the fix is a protocol change to the asset record plus new `__genesisAsset` behaviour, on
  the basis of speculation about model output that no fixture exhibits. Deferred, named.
- **"A rooted reference to a stored file (`/styles.css`) is silently left broken."** Also
  reproduced. But D6 records "absolute and protocol-relative URLs are left exactly as
  written" and AC-5's test pins `/root.js`, `a/b.js` and `x.js?v=1` as untouched. Widening
  the rewriter's grammar is a change to a security-relevant surface against a recorded
  decision. Deferred with the proposed rule.
- **"The generation guard is duplicated across three stores."** True — `hl.ts`,
  `workspace.ts` and `preview.ts`. This is the third use, so a shared helper is now earned,
  but refactoring two stores this slice does not otherwise touch is not a review-stage
  change. Named for Slice 12.
- **"`ENTRY_POINT` is declared twice."** True (`previewDocument.ts` and `preview.ts`). The
  store's pre-check is well motivated — it avoids fanning out reads for a project that
  cannot be previewed — and the second declaration is four characters of duplication behind
  two comments that both say why. Left alone; noted.

## Dead code

Step 9's question, decided here rather than asked:

- **`messageForResponse` → `errorForResponse`.** Renamed, not duplicated; zero remaining
  references anywhere in the repo, verified by grep. Nothing to remove.
- **`ApiError.detail` has no reader.** The tempting call is to delete it. It stays: AC-22
  names it explicitly, the server's envelope emits it (`functions/src/lib/errors.ts`), and
  parsing three of four fields at a boundary is worse than parsing four. What was wrong was
  the comment claiming the preview bridge reads it — corrected to say plainly that it has no
  reader yet, and that Slice 12 either renders it or takes it out.
- **`builtRevision` and `ensureBuilt`** are on the exported store interface with no consumer
  outside the store. Both are genuinely used — `ensureBuilt` by the store's own watcher,
  `builtRevision` by `stale` — and a Pinia setup store has to return what it exposes. Left.

Nothing else became unreachable.

## Manual verification

- `npx prettier --check` over every touched file, after `--write` on the two it flagged.
- The `flush: 'sync'` regression was verified by **restoring** it and watching the new
  reversed-order case fail, then removing it again — a test that pins a decoupling is worth
  nothing unless the coupling actually breaks it.
- E2E `Slice 05` + `Slice 10` re-run against the emulators after the fixes — 7 passed — since
  the panel's rebuild timing is the one thing only L5 exercises end to end.
- **Not done, and on the PR checklist where the PRD put it:** the real-credentials run
  against the sandbox account (generate a dashboard, see real contacts, disconnect and see
  the Reconnect banner), and the production-build check that the shim string is emitted
  intact (D8's rejected alternative is what that guards). Neither is automatable here.

## Deliberately deferred

Each of these was reproduced, and each is recorded rather than done, with the reason.

1. **A remount re-runs the app** (finding 8). The clean fix is `:unmount-on-hide="false"` on
   the narrow layout's `<Tabs>` — Tailwind v4's preflight sets `[hidden] { display: none
   !important }`, so hidden panels stay hidden even with a `display` utility on them. It is
   not taken here because it also mounts `EditorPanel` inside a hidden container, and Monaco
   measuring zero in a hidden box is exactly the trap Slice 7's D19/R4 comment documents —
   trading a bounded quota cost for a plausible editor regression is not a call to make
   unilaterally at review. The breakpoint half needs Slice 4's two component trees to become
   one, which is a larger change again. **Slice 12** owns the cross-screen audit; this is
   its first item.
2. **The frame can hand the brokered capability to a remote origin** by navigating itself and
   passing the nonce along, because a `WindowProxy` survives navigation and the nonce is
   readable out of the inline shim. The cheap mitigation — invalidate the nonce on the
   frame's *second* `load` event — has a false-positive risk (a dynamically created iframe
   may fire an initial `load` for `about:blank`) that would break the demo if wrong. The
   structurally right fix is a transferred `MessagePort`, which cannot be read out of the DOM
   and does not survive to the next document; that is a protocol change touching the shim,
   the bridge, the store, the panel and eight ACs' worth of tests. Severity is bounded by the
   fact that open `script-src` already grants the same capability to the same attacker.
3. **`form-action 'none'` in the assembled CSP.** One directive, no functional cost that
   `connect-src 'none'` does not already impose, and it closes a scripted-form exfiltration
   route. Not added because D10 records "only that directive is set" as a decision, and
   overriding a recorded decision belongs in the slice that revisits it. R8's "worst case is
   a defaced preview" should be corrected there too: the worst case is bulk exfiltration of
   CRM records through an `<img>` beacon.
4. **`defer`, `async` and `type="module"` on a rewritten `<script src>`** are silently
   dropped, changing the script's timing and scope. `type="module"` is the sharp one — it
   becomes a `SyntaxError`. Fix: carry the attributes into the asset record; `type="module"`
   maps straight through (an inline module is deferred and scoped, which is what was asked
   for), `defer` means appending at `DOMContentLoaded` rather than replacing in place.
5. **A rooted or query-bearing reference to a stored file** (`/styles.css`, `app.js?v=1`) is
   left as written and resolves against the parent origin, which the Hosting rewrite answers
   with the SPA's own `index.html` — the "silently HTML" failure D6 exists to prevent, by a
   URL shape the grammar does not cover. Proposed rule, which keeps AC-5 intact: normalise
   one leading `/` and any `?…`/`#…`, and rewrite **only if** the result names a stored file;
   anything else stays exactly as written, as now.
6. **A self-closed `<script src="app.js" />`** matches nothing, so the tag survives; HTML
   parses it as an *open* element and everything after it is swallowed as script text. Rare,
   catastrophic and silent — the same class as R4, which D7 made unrepresentable. One
   alternation branch plus a warning.
7. **References inside HTML comments are processed.** A commented-out `<script src="gone.js">`
   produces a warning naming a file the page does not reference; a commented-out reference to
   a file that *does* exist pushes a duplicate copy into the embedded payload for a loader
   that can never run.
8. **`kind: 'error'` reports are uncapped** where `hl()` calls are not. An app throwing inside
   a `requestAnimationFrame` loop posts ~60 messages a second. Nothing accumulates — the
   store holds a single value — but each one pays a `postMessage` and a bridge dispatch. A
   counter mirroring `HL_CALL_LIMIT` closes it.
9. **The shim's error channel is proven only against a stub listener registry.** AC-15 and
   AC-16 assert that a handler was registered for a name and what it posts, not that a real
   browser delivers `securitypolicyviolation` or `unhandledrejection` to `window` inside a
   sandboxed frame. The e2e asserts the *absence* of every error banner, so no L5 case
   exercises the error path at all. This is the one place D8's "nothing typechecks the shim"
   risk is not fully bought back.
10. **`hl()` ids are never asserted unique.** The shim mints `'c' + seq`; a change to a
    constant id would break concurrent calls — the second reply resolves the first promise —
    and every shim test would still pass.
11. **No in-flight guard on Refresh.** Five impatient clicks during a slow twenty-file build
    are 100 file GETs and 100 function invocations for one document. No CRM cost (a
    superseded build never mounts a frame). One attribute:
    `:disabled="workspace.generating || preview.state === 'loading'"`.
12. **The generation guard, written three times.** `hl.ts`, `workspace.ts`, `preview.ts`, plus
    a fourth shape here (`live<T>`). Third use, so a `lib/generation.ts` is earned.

## Verdict

**Approve.** The slice does what its PRD says: a sandboxed document with no credential in it,
brokered through the parent, rendering real CRM data — and the boundary is implemented the way
D2 describes rather than merely documented that way. The server-side half is untouched, which
is what kept a 3,500-line change reviewable.

The three defects worth the stage were all in the same seam — the preview store's relationship
to the workspace's lifecycle — and none of them had a test: a re-open that stranded the panel,
a list failure with no state, and a call budget on the wrong side of the trust boundary. All
three are fixed test-first. Run `/feature-ship 10`.

---

## Ship-time addendum — 2026-08-18

`main` moved while this branch sat in review: **Slice 11 (snapshots & restore) merged
first**, so `/feature-ship` rebased onto it rather than onto the `main` the review read.
The rebase changed the numbers above and found one defect, and the two are unrelated.

**The conflict was trivial.** Slice 11 and Slice 10 both added fields to `WorkspaceStore`'s
exported interface and to the object the setup store returns; git flagged three hunks, all
resolved by keeping both sides. Nothing about either slice's behaviour was in question.

**The defect was not flagged by anything.** `restoreSnapshot` was written against a `main`
where the preview did not exist. It rewrites the **whole** stored file set — the exact event
`filesRevision` counts — and moved neither counter, so a twenty-file rollback left the
preview rendering the version the user had just replaced, silently, while a one-file save
moved the hint. This slice's own PRD names the obligation in its out-of-scope table
("Slice 11, which owns snapshots — its restore must move `filesRevision`"); Slice 11 could
not discharge it, because the counter was not on `main` yet, and nothing carried the note
across. Typecheck, lint and every other case were green either side of it.

Fixed here, test-first, in `fix: a restore is a change to the files, so the preview says so`
— three L1 cases on the workspace store (changed, unchanged, failed), the first red first.
`filesRevision` moves; `generationsApplied` deliberately does not, on D12's reasoning: the
unasked rebuild re-runs the restored app's HighLevel calls against a 100-request/10-second
budget, and a restore is a deliberate act whose result the user may want to read first. Same
answer a save gets, for the same reason.

**Suite, re-run in full after the rebase and the fix** — not the review's run, and not the
orchestrator's gate:

| Check | At ship |
|---|---|
| `typecheck` | clean |
| `lint` (`--max-warnings 0`) | clean |
| `prettier --check` on every touched file | clean |
| `test:unit` | **2,119** — 1,136 functions · 962 frontend · 21 scripts |
| `test:rules` | **52** |
| `test:integration` | **378** |
| `test:e2e` | **18 passed**, the whole file set, run after the fix |

2,567 cases, all six green. The rules and integration counts are Slice 11's, unchanged —
this slice adds no server file, which is D19 and was measured rather than assumed.

Everything under *Deliberately deferred* stands as written. Nothing in it was touched here.
