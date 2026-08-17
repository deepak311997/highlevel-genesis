# Slice 05 — Streaming generation · Review

Reviewed as another author's PR: the whole diff against `main` (63 files, +9,680 / −399, of which
~3,900 lines are the PRD, plan and build log and ~3,600 are tests), read against `02-prd.md`'s 44
acceptance criteria and `.claude/skills/feature-review/references/typescript-vue.md`.

Four findings, all fixed. The first two are behavioural and each got a failing test before the fix.

## Suite

Baseline counts are the orchestrator's `gate-post-build.1.log` on `1191825`, which is the run this
stage was gated on. The **after** column is what changed under the review's own fixes: only the
suites those fixes touch were re-run, plus the one integration file that gained a case.

| Check | Baseline | After the review's fixes | Result |
|---|---|---|---|
| `typecheck` (functions, frontend, root) | clean | clean | ✅ |
| `lint` (functions, frontend, `--max-warnings 0`) | clean | clean | ✅ |
| `test:unit` — functions (L1) | 29 files, 424 tests | 29 files, 424 tests (+3 new, −3 redundant) | ✅ |
| `test:unit` — frontend (L1/L2) | 44 files, 513 tests | 44 files, 514 tests (+1) | ✅ |
| `test:unit` — scripts | 3 files, 15 tests | not touched | ✅ |
| `test:rules` (L3) | 1 file, 28 tests | not touched | ✅ |
| `test:integration` (L4) | 11 files, 231 tests | `generate.spec.ts` 33 (was 32) | ✅ |
| `test:e2e` (L5) | 12 tests, 46.4 s | not touched | ✅ |

The L4 re-run was the `generate` file alone, under the same emulator invocation the script uses.
The orchestrator re-runs all six suites after this stage, which is the check on that decision.

## Findings

| # | Severity | Finding | Action taken |
|---|---|---|---|
| 1 | **Required** | **`/generate` wrote into the messages collection without honouring the 200-message cap.** `POST /api/projects/:projectId/messages` refuses at 199 precisely so the reply it triggers has room — but `/generate` writes the assistant turn without going through that route, and **Retry re-opens it with no new user message at all** (D26). A transcript sitting at the cap therefore grew by one document per Retry, and `transcriptQuery`'s own `limit(MESSAGE_LIMIT)` then hid every document past the two-hundredth: the reply arrives on screen and is gone on the next load, while each click is a paid generation. D34 leans on this cap to "bound a single project's spend absolutely", which only holds if the endpoint that spends the money enforces it. Reachable on the mainline: a full turn ends the collection at exactly 200, and one interruption there is all it takes. | Fixed. `handleGenerate` refuses at `transcript.length >= MESSAGE_LIMIT`, before `openStream`, with the message route's own `409 / message_limit` and its exact copy — same limit, one way to be told about it. Test-first: three L1 cases in `functions/src/generate.spec.ts` (at the cap it throws; 409 + `message_limit` + no LLM call + nothing written; and the 199 boundary still generates) and one L4 case in `tests/integration/generate.spec.ts` asserting it through `expectJsonRefusal`, so the refusal is proven to be JSON with a real status rather than an `error` frame on a 200. |
| 2 | **Required** | **`send()`'s guard did not match its own comment.** It re-checked `projectId` and an empty draft — "the store is the boundary a keyboard shortcut cannot go around" — but not `generating`, which is the third reason `canSend` names and the expensive one. A `send()` reaching the store during an open stream posted a message and opened a **second paid generation**; worse, `runGeneration` begins with `abortGeneration()`, and the first run's `catch`/`finally` share the same `generation` counter, so they land on the *second* run's state: `generating` cleared and `generateError` raised for a request that is still running. D27 declines a server-side lock explicitly *because* the client covers the single-tab case, so the client has to actually cover it. | Fixed. One conjunct in `send()`'s guard, with the draft left untouched so the guard costs the user nothing. Test-first in `frontend/src/stores/workspace.spec.ts`: with a stream open, `send()` issues no request, keeps the draft, and the running stream still completes cleanly. |
| 3 | Optional | **`sendHttpError` was an extraction whose second caller never arrived.** It was justified by "`/generate` is an `onRequest` function rather than a route on the `api` Express app, so it has no error-handling middleware to fall through to — one function, two callers". The T9 amendment made `/generate` its own Express app that mounts `errorHandler`, so the comment describes a design that was abandoned during the build, and the count is one caller: a pass-through `errorHandler` wrapping it, plus a 46-line spec block re-asserting the two cases the `errorHandler` block above it already covers. | Fixed, by deletion rather than by polishing. Folded back into `errorHandler`, the redundant spec block removed, and the docstring rewritten to say what is now true — `/generate` is an Express app *so that* it can mount this handler, and `terminalErrorHandler` only takes over once the headers are gone. Net −44 lines. |
| 4 | Nit | `requireAppCheck`'s docstring still scoped itself to `/auth/register`, and the whole argument in it is about account creation. It now guards seven routers, including — new in this slice — the first endpoint whose refusal saves money. | Fixed. Header widened and one paragraph added naming `/generate`; the `register` argument is kept intact below it, because it is still the strongest case for the control. |

## AC coverage

44 criteria, every one mapping to a named passing test. Rows marked ✅ were verified by reading the
test, not by trusting the matrix.

| AC | Level | Test | Verified |
|---|---|---|---|
| AC-1, AC-2, AC-3 | L4 | `tests/integration/generate.spec.ts` — frame sequence, the persisted document, transcript order | ✅ |
| AC-4 | L4/L1 | `tests/integration/messages.spec.ts`; `messages/handlers.spec.ts`; `ChatPanel.spec.ts` scans `frontend/src` for "Echo mode" | ✅ |
| AC-5 | L1 | `generate.spec.ts` › `logGeneration` — the eight fields, and the negative case that forces an extra key in at runtime | ✅ |
| AC-6 | L1 | `llm/params.spec.ts` — model, `max_tokens`, effort, and a source scan proving `messages.create` appears nowhere | ✅ |
| AC-7 | L1 | `llm/prompt.spec.ts` — one breakpoint, on the last block; nothing volatile at or above it | ✅ |
| AC-8, AC-9 | L1 | `llm/context.spec.ts` — order and shape; one, three and mid-transcript assistant turns | ✅ |
| AC-10 | L1 + L4 | `context.spec.ts` (both empty inputs); `generate.spec.ts` L4 (`400 empty_context`, nothing written) | ✅ |
| AC-11 | L1 + L4 | `llm/stream.spec.ts` (thinking deltas dropped); L4 asserts the recorded thinking text is in no token | ✅ |
| AC-12, AC-13 | L1 + L4 | `stream.spec.ts` throw-cases; L4 `__fail_midstream` / `__fail_upfront` with the persisted partial | ✅ |
| AC-14 | L4 | `__refuse` → one `error` frame, code `refused`, nothing written | ✅ |
| AC-15, AC-16 | L1 + L4 | `stream.spec.ts` — `max_tokens`, the cap, the exact-boundary delta, the multi-byte whole-delta drop; L4 `__long` asserts stored text ≤ 800,000 B **and** byte-identical to the frames the client saw | ✅ |
| AC-17, AC-18 | L1 | `generate.spec.ts` › "the client goes away" — abort, partial persisted `truncated`, no frame on the dead socket, and the `writableEnded` guard that stops a completed turn reading as an abandonment | ✅ (see *Deliberately deferred*) |
| AC-19 | L1 + L4 | `lib/sse.spec.ts` comment bytes; L4 asserts a comment frame precedes the first token on `__slow`, and that more than one arrives | ✅ |
| AC-20 – AC-24 | L1 + L4 | `llm/schema.spec.ts` `.strict()` cases; L4 asserts each refusal on **both** channels — status *and* `content-type` is not an event stream | ✅ |
| AC-25 | L1 | `index.spec.ts` — secret binding, 540 s, 512 MiB off `__endpoint`, plus a source scan for the two guards; the comment states the structural test's own weakness | ✅ |
| AC-26, AC-27 | L3 | `tests/rules/firestore.spec.ts` — every operation denied, including a forged truncated assistant turn and flipping `truncated` on an existing one | ✅ |
| AC-28, AC-29 | L1 | `frontend/src/lib/sse.spec.ts` — every two-chunk **and** three-chunk split of the same stream; comments, unknown names and bad JSON | ✅ |
| AC-30, AC-31 | L1 | `generateApi.spec.ts` — method, path, exactly `{ projectId }`, both credentials, abort signal; non-ok rejects and yields nothing; `no-firestore.spec.ts` for the ban | ✅ |
| AC-32, AC-33 | L1 | `stores/workspace.spec.ts` › "the two requests of a turn" — order, no `GET`, and a failed write opening no stream | ✅ |
| AC-34, AC-35 | L1 | `workspace.spec.ts` › "the stream" — a hand-pushed body, so accumulation is observable rather than only its final value | ✅ |
| AC-36, AC-37 | L1 | `workspace.spec.ts` › `retryGeneration` and "a stream that outlives the screen it was opened for" | ✅ |
| AC-38 – AC-41, AC-43 | L2 | `ChatPanel.spec.ts` — badge, placeholder position, interrupted marker with words not an icon, error + Retry called once, scroll on both watchers | ✅ |
| AC-42 | L2 | `MessageComposer.spec.ts` › "while a stream is open" — disabled, Enter issues nothing, usable again after | ✅ |
| AC-44 | L5 | `tests/e2e/workspace.spec.ts` — failed open → Retry → progressive text → reload → dashboard round trip; and `__fail_midstream` → partial + marker + Retry | ✅ |

Two extra L5 cases beyond AC-44, both earned: a refusal, and **two prompts in a row** — the case
that caught the hand-set `Connection` header, where every single-turn test passed and the second
prompt of every conversation failed in the running app.

## What I checked and found clean

Saying "no further findings" is only worth anything with the list attached.

- **Token boundary.** No OAuth token, ID token or API key reaches the client, the logs or a frame.
  `logGeneration` projects eight named fields off an `LlmEvent` that *carries the reply text*, and
  its test forces an extra key in at runtime to prove the projection is real rather than typed.
  `redact`'s `isSecret` excludes numbers so `inputTokens` survives the sensitive-name net — a real
  trap, handled, with the reasoning written down.
- **Secrets.** `defineSecret` bound to `generate` alone and asserted off `__endpoint`; `api` asserted
  to carry none. `.secret.local` is gitignored (two patterns), only `.secret.local.example` is
  tracked, and its value is a placeholder that the emulator path never reads. `.env.example` now
  says LEAVE THIS BLANK rather than merely naming the variable.
- **Streaming mechanics.** Headers flushed before the first byte; a comment written immediately so
  the client sees bytes before the model has thought; `X-Accel-Buffering: no` and
  `no-cache, no-transform`; keep-alive suppressed while tokens are flowing; and `Connection`
  deliberately *not* set, with the second-prompt e2e standing over that decision permanently.
- **Nothing partial is persisted by accident.** The one partial that *is* written is the deliberate
  one, marked `truncated`, and `clientGone` forces the flag rather than trusting the mapper — so a
  stream that stopped cleanly after an abandonment is still not recorded as complete.
- **The byte cap is whole-delta**, which keeps the stored text valid UTF-8 *and* byte-identical to
  the concatenation of frames the client received. Both halves are asserted, at L1 and L4.
- **Rules.** No rules change was needed and none was made (D35); the denial is re-proven anyway,
  including the two forgeries a client would most want — an assistant turn it never earned, and
  flipping `truncated` on one that exists.
- **States.** Loading, empty, error and now streaming all render in `ChatPanel`, all still tested,
  and the composer survives a failed transcript because sending is a different request from listing.
- **Reactivity.** `streamingText` is a re-assigned `ref<string>`, not an array pushed to per token —
  the trap `typescript-vue.md` names, avoided. The `AbortController` and the generation counter live
  in the store rather than the component, because the `lg` breakpoint swaps the tree.
- **No `as` casts papering over the SDK.** R8 anticipated one for `output_config`; the typings carry
  it and `tsc --noEmit` is the proof.
- **Size.** ~2,150 lines of new source against ~3,600 lines of new test. The largest new source file
  is `generate.ts` at 427 lines and `fake.ts` at 265; nothing is near the 1,000-line inspection
  signal. The mapper, the context builder, the prompt and the parameters are separate pure modules
  with their own L1 tests, which is what keeps the endpoint itself readable.
- **Dependencies.** One added: `@anthropic-ai/sdk@^0.117.1`, the brief's own choice, lockfile
  committed (73 lines), used lazily so the `api` function never loads it.
- **Scope.** Nothing in the diff the PRD did not ask for.

## Dead code

Step 9's question, decided here rather than asked.

- `sendHttpError()` in `functions/src/lib/errors.ts` — one production caller after the T9 amendment,
  and a rationale describing a design that no longer exists. **Removed**, folded into `errorHandler`.
- Everything else the slice deleted (`echoFor`, `messagePair`, the `Echo mode` badge) is gone with no
  residue: two source scans — `frontend/src` for "Echo mode", `functions/src` for `messages.create` —
  are permanent tests rather than review notes.
- `file_start` / `file_end` stay declared and unused in `SseEventName`. **Kept**: D8 assigns them to
  Slice 6, and a declared name with no emitter is a vocabulary, not dead code.
- `functions/src/generate.ts:323`'s `if (!res.writableEnded) res.end()` is unreachable — `mapStream`
  always yields a terminal event. **Kept**: it is the guard that makes "always" a property of the
  handler rather than a property of a file two modules away, and it costs one line.

## Manual verification

Not performed in this session: it is unattended and headless, and the emulator run in the definition
of done is a fresh-clone check a person has to look at. The e2e suite drives the SPA through the Vite
dev proxy and asserts the placeholder is visible with *less* text than the finished reply, which is
the assertion a fully buffered proxy cannot satisfy — so R3 has automated cover even without the
hand-check. The deployed-path risks (R2's Hosting rewrite, and AC-17/AC-18's disconnect signal) stay
on Slice 13's hand-check list.

## Deliberately deferred

- **AC-17/AC-18 remain L1-only.** T11 measured that the functions emulator terminates the client
  connection at its own proxy and never propagates it to the function runtime — no `req` event, no
  `aborted` event, the generation running to completion. The build's call is right: a test that
  cannot fail for the right reason is worse than no test. The half we own is driven at L1 where the
  signal can be delivered; the half the platform owns is Slice 13's.
- **The `runGeneration`-vs-`runGeneration` overlap is closed for `send()` and left unguarded for
  `retryGeneration()`.** With finding 2 fixed, the only remaining way in is two Retry clicks landing
  in the same Vue flush, which the render cycle rules out — the button unmounts when `generateError`
  is cleared. I did **not** add a `controller === ours` guard to the `catch`/`finally`: it is
  machinery for a path nothing reaches, and every path that *does* change projects is already covered
  by the generation counter. Recorded so a future caller of `retryGeneration()` knows the invariant
  it has to keep — do not open a second stream while `generating` is true.
- **A cap of 200 documents where one is corrupt allows one more generation.** `readTranscript`
  filters unparseable documents, so 200 stored with one corrupt parses to 199 and passes the new
  check, taking the collection to 201. The overflow is bounded at one document per corrupt one, and
  the filtering is the same rule that already decides what the user's own transcript contains — two
  answers to "what is in this transcript" would be the worse bug.
- **At the cap, the panel still offers a Retry that now always answers 409.** The message is
  truthful and the composer already says the project is full. Suppressing the button on that code
  would be new client state for a project at end of life; named rather than built.
- Rate limiting (D34 / stretch S4), a server-side concurrency lock (D27) and refusal fallbacks (D18)
  are all PRD-scoped out and stay out.

## Verdict

**Approved.** The slice does what its PRD says, the hazard it named as its one real hazard (D6's
trailing-assistant prefill) is tested from both ends, and the test suite is the strongest in the
repository so far — the split-chunk parser cases, the whole-delta cap, the two-prompts-in-a-row e2e
and the log-line negative are all tests that would have caught real bugs, and two of them did.

Run `/feature-ship 05`.
