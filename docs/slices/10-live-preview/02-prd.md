# Slice 10 — Live preview · PRD
**Spec:** F6.4, F8.3 · **Branch:** `slice/10-live-preview` · **Depends on:** 9 (and 6, 7, 8 through it) · **Date:** 2026-08-18

## Problem

The generated app cannot be run. Slice 6 stores its files, Slice 7 shows them in Monaco and
Slice 9 teaches the model to call the CRM through `hl(...)` — but the third panel of the
workspace is still a sentence that says a preview arrives in Slice 10. A user describes an
app, watches correct-looking code stream past, and never sees it work. Worse, nothing in the
product has ever executed a line of what the model wrote, so "the generated code calls real
HighLevel endpoints" is a claim about a string in an editor rather than an observed fact.

This is the money shot in `IMPLEMENTATION_PLAN.md` §4, and the last unshipped half of F8.3:
a HighLevel call that fails inside a generated app currently fails nowhere a person can see.

## The demo

Ask a project for a contact dashboard, watch the files stream into the editor, and when the
generation finishes the third panel refreshes by itself and lists the contacts of the
connected HighLevel account — real CRM records, rendered by code that was written seconds
earlier and has never touched a token.

## Decisions

Made from `PRODUCT_SPEC.md`, `HIGHLEVEL_PLATFORM.md`, `IMPLEMENTATION_PLAN.md` and the
merged slice docs, because this stage ran unattended (`--fast`). Each is the answer an
interview would have produced, with the alternative it beat.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Preview runtime? | **A sandboxed `srcdoc` iframe.** No bundler, no third-party runtime, no new dependency. | `IMPLEMENTATION_PLAN.md` §4 and `PRODUCT_SPEC.md` §6.1 both settled this before the slice began; §8 records it as decided. Sandpack ships a bundler and an opinion about React; WebContainers ship a Node runtime for apps that are three flat files of plain HTML/JS/CSS (Slice 6 D1). Both would be weeks of surface for a `srcdoc` string. What was left open — and what this slice actually decides — is D2. |
| D2 | **How does an opaque-origin iframe reach the proxy?** | **It does not. The parent brokers every call over `postMessage`.** The shim's `hl()` posts a request to the parent; the parent calls `hlProxy(...)` on the same page that already holds the session, and posts the JSON body back. **No credential of any kind enters the iframe.** | The two constraints are inherited and not negotiable. A `srcdoc` frame has an **opaque origin**, so its `fetch` carries `Origin: null`, which `api/index.ts`'s allowlist refuses; and the proxy requires **App Check** (Slice 8 D15), which a sandboxed document cannot attest for. The two alternatives `IMPLEMENTATION_PLAN.md` names both fail on that: baking a **short-lived scoped token** into the shim hands a bearer credential to LLM-written code that also renders CRM data, and gets no App Check token anyway; a **`postMessage` handshake that passes the token** is the same thing one hop later. Brokerage satisfies both constraints by never crossing the boundary — the request is same-origin, attested, and made by code we wrote. Slice 8 D16 and R8 recorded this as the recommended shape; this slice takes it. |
| D3 | What is the message protocol, and how is the peer identified? | **Protocol `genesis-preview/1`.** Frame → host: `{ genesis: 'preview', v: 1, nonce, id, kind: 'hl', method, path, payload? }` and `{ …, kind: 'error', message }`. Host → frame: `{ genesis: 'preview-host', v: 1, nonce, id, ok, data }` or `{ …, ok: false, error: { message, status, code } }`. The host accepts a message only when **`event.source === iframe.contentWindow` *and* the `nonce` is the current build's**; anything else is dropped in silence, with no reply. | Origin cannot be used: an opaque origin arrives as the string `"null"`, which every other sandboxed frame on the page also has, so it identifies nothing. `event.source` identifies the frame — but a `WindowProxy` survives navigation, and setting `srcdoc` again *is* a navigation, so identity alone cannot tell the previous document from the current one. The per-build nonce is what does (see *Edge cases*, the stale-document race). Replies must be posted with `targetOrigin: '*'`, because there is no origin string that names an opaque origin — which is exactly why D2's rule that a reply never carries a credential is load-bearing rather than tidy. |
| D4 | Does the shim re-implement the proxy call? | **No. The host broker calls the existing `hlProxy(method, path, payload)`** in `frontend/src/lib/hlProxyApi.ts`, unchanged. | That module was written for this: its header says Slice 10's shim mirrors the signature and the fetch happens in the parent, and its `HL_PATH` grammar is documented as a security control *for the moment the path argument becomes LLM output*. Reusing it means the path grammar, the GET-payload-to-query rule and the `/api/hl/proxy` base have exactly one implementation. Nothing about the proxy, the allowlist or the prompt changes in this slice. |
| D5 | `ApiError` carries no `code`, but Slice 9's prompt promises `err.code`. | **`messageForResponse` becomes `errorForResponse(res): Promise<ApiError>`, and `ApiError` gains optional `code` and `detail` from the envelope.** Three call sites (`apiClient`, `authApi`, `generateApi`) change to `throw await errorForResponse(res)`. | Slice 9 D5 recorded this as the constraint Slice 10 inherits: generated code branches on `err.code === 'hl_reconnect_required'`, and a shim that drops the field makes that branch silently unreachable. The host also needs `code` to decide whether to offer **Reconnect**. Rejected: a second, preview-only fetch that reads the envelope — `api.ts`'s own comment records what happened last time this logic was duplicated (a copy lost its 429 case). Additive: every existing caller keeps the same message. |
| D6 | How is a multi-file project turned into one document? | **Assembled in the browser.** `index.html` is the document; a `<link rel="stylesheet">` or `<script src>` naming a **stored** file is replaced, in place, by a loader that installs that file's content; absolute and protocol-relative URLs are left exactly as written. | Relative URLs in a `srcdoc` document resolve against the *parent's* base URL, so `styles.css` would fetch the SPA's own origin and be answered by the Hosting rewrite's `index.html` fallback — a stylesheet that is silently HTML. Nothing serves the project's files as static assets and nothing in this slice should start: the files live in Firestore, reachable only through an authenticated route the frame cannot call. Rejected: a `<base>` tag (there is no URL to point it at), and per-file `blob:` URLs (a blob URL belongs to the creator's origin and an opaque origin cannot fetch it). |
| D7 | How is a file's content embedded without HTML eating it? | **As data, never as markup.** The shim carries `JSON.stringify(files)` with every `<` re-escaped as the JSON escape `\u003c` — so the embedded blob contains no `<` character at all — and each replaced tag becomes a one-line loader that builds a `<script>` or `<style>` **element** with `textContent` and swaps itself for it. | HTML has no escape for `</script>` inside a script element: a generated `app.js` containing that string would terminate the tag early and spray the rest of the file into the page as markup. That is rare, catastrophic and invisible — the preview simply breaks and nothing says why. Building the element through the DOM means the HTML parser never sees the content at all, and a DOM-inserted inline script executes synchronously, in global scope, at the position it replaced — so declaration sharing between two generated `.js` files behaves as it would with real script tags. Rejected: escaping `</script` to `<\/script` (valid inside a JS string, a syntax error anywhere else); rejected: `data:` URL scripts (they load from an opaque origin, so their errors reach `window.onerror` as `"Script error."` — which would gut F8.3, the reason this slice exists). |
| D8 | Where does the shim source live? | **A string constant** — `buildShim(nonce)` in `frontend/src/lib/previewShim.ts` — written against `window`, `document`, `parent` and nothing else, and L1-tested by evaluating it with `new Function('window','document','parent', src)` over stubs. | Rejected: authoring it as a real TypeScript function and serialising it with `.toString()`. That buys typechecking and loses correctness: esbuild's `keepNames` wraps functions in `__name(...)`, so the serialised body can reference a helper that does not exist inside the iframe — a bug that appears only in a production build, which no test here runs. A string cannot be rewritten by a bundler. The evaluation test recovers most of what typechecking would have caught, and L5 proves it runs in a real browser. |
| D9 | What sandbox attributes? | **`sandbox="allow-scripts allow-forms"`.** | `allow-scripts` is the point. `allow-forms` because a lead-capture form is one of the three app shapes the system prompt names, and without it the submission is blocked. **`allow-same-origin` is deliberately absent and is the whole boundary**: with it the frame would share our origin, read the Firebase session out of IndexedDB, and call the API as the user — every property D2 buys would be handed back. `allow-modals`, `allow-popups` and `allow-top-navigation` are absent because nothing a small CRM dashboard does needs them and each is a way for generated code to take over the tab. |
| D10 | Anything else stopping the frame reaching the network? | **Yes — `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`** in the assembled document, and the shim reports `securitypolicyviolation` through the same error channel as any other runtime error. | The preview's only network verb is `hl()`, which is `postMessage` and not a connection, so `connect-src` has nothing legitimate to allow. Blocking it turns "the generated app made its own request" from an invisible event into a named one. Only that directive is set: `script-src`/`img-src`/`style-src` stay open, so a generated page that references a CDN or an image still works. Rejected: `default-src 'none'` — it would break those, silently, for a threat the sandbox already contains. |
| D11 | Where does preview state live? | **A new `stores/preview.ts`**, not the workspace store and not the component. | The `lg` breakpoint swaps one component tree for another (Slice 4 D16), so anything held in `PreviewPanel` is destroyed by a window resize — the same argument that put the composer draft in a store (Slice 4 D17). The workspace store is already ~1,000 lines and owns the project, the transcript, the files and the stream; the preview is a different lifecycle (it is rebuilt, they are not). Cached in a store, a breakpoint swap re-renders the same document instead of refetching every file. |
| D12 | What makes the preview rebuild? | **Two signals, one rule each.** The workspace store gains `generationsApplied` (incremented at `done`, after the refetch, only when the turn stored at least one file) → the preview **rebuilds by itself**. It also gains `filesRevision` (incremented by the same event *and* by a successful manual save) → when it moves past what was built, the panel shows a **"Files changed — Refresh"** hint and rebuilds only when asked. | F6.4 requires the refresh after generation and this is the whole demo. A save is different: it is frequent, and every rebuild re-runs the app's `hl()` calls against a 100-request/10-second budget (`HIGHLEVEL_PLATFORM.md` §5), so auto-rebuilding on save spends the account's allowance on each keystroke-batch a developer saves. A visible hint is the honest middle: the panel never silently shows stale output, and the user decides when to spend. Two counters rather than one flag because each answers exactly one question and neither has to be interpreted. |
| D13 | Where do the file contents come from? | **The routes that already exist**: the store's `files` metadata for the paths, then `getFile` per path in parallel (≤20, capped by `FILE_LIMIT`). No new endpoint, no new collection, no rules change. | A bundle route would be a new API contract, a new schema, a new integration test and a second way to read files, to save nineteen round trips on a screen a user opens once per generation. The torn-read window it would close does not exist in practice — the only writer is the same browser, and both triggers in D12 fire *after* the write completed. Rejected explicitly so the plan does not reinvent it. |
| D14 | Does the preview show unsaved editor edits? | **No. It shows what is stored, always.** | The preview is the app as it exists; an editor buffer is a proposal. Previewing a dirty buffer would mean the running app and the stored project disagree, and every bug report would start by having to establish which one was on screen. Save then Refresh, which D12's hint already makes a two-click path. |
| D15 | How many HighLevel calls may one preview document make? | **50, then every further `hl()` rejects locally** with a message naming the limit, posts no request, and reports itself to the host so the panel says so. | An LLM-written render loop that calls `hl()` per row or per frame is a plausible generation, and the cost is not ours — it is the user's CRM account hitting `429` and, in the Loom demo, the sandbox account throttling mid-shot. 50 is far above any honest small dashboard (the fixture app makes two) and far below the damage. Rejected: a concurrency limit instead, which bounds the burst but not the total, and needs a second number to explain. |
| D16 | What happens to a call the host never answers? | **The shim rejects it after 30 seconds.** | Slice 9's own prompt says an app showing a spinner forever is worse than one that says what went wrong; a promise that never settles is exactly that, and it is the failure mode of every bug in the broker. The proxy's upstream timeout bounds the honest case well inside 30 s, so this only ever fires when something is genuinely wrong. |
| D17 | How do HighLevel failures become visible (F8.3)? | **The host renders them, not the generated app.** Every brokered failure — caught by the app or not — puts its `message` in a banner under the panel header; `hl_reconnect_required` and `hl_not_connected` additionally render a **Reconnect HighLevel** link to the dashboard. Uncaught errors, unhandled rejections and CSP violations inside the frame arrive over the same channel and render the same way. | F8.3 names the expired connection explicitly, and the brief asks for failures surfaced in the preview. The generated app's own `try`/`catch` is the one thing here we cannot rely on — it is model output. The host sees every failure regardless, so that is where the guarantee belongs. Rejected: rendering only failures the app did *not* handle, which requires knowing whether a `catch` ran — unknowable from outside. A duplicated message is a small cost against a blank screen with no explanation. |
| D18 | Missing referenced file, e.g. `<script src="app.js">` with no stored `app.js`? | **The tag is dropped and the panel names the file in a warning.** | Left in place it resolves against the parent origin, is answered by the SPA's HTML fallback, and the browser reports a syntax error from a file the user believes exists — a confusing lie. Dropping it and saying so is the same information without the misdirection. |
| D19 | Does anything change on the server? | **No.** No route, no schema, no collection, no rules block, no prompt text, no dependency. The slice is frontend-only. | The proxy, its allowlist and its error envelope shipped in Slice 8; the calling convention shipped in Slice 9 and the shim must match it rather than extend it. Consequence for the test matrix: **the plan's "L4 preview fetches proxied data" has nothing new to integrate** — `tests/integration/hl-proxy.spec.ts` already covers that route end to end — so this slice adds no L4 case and proves the browser half at L1, L2 and L5. Recorded rather than quietly skipped. |
| D20 | Does the preview run when HighLevel is not connected? | **Yes.** The document is built and run; the `hl()` calls fail with `hl_not_connected`, and D17's banner offers Reconnect. | Refusing to render would hide the app's own layout behind a connection state, and it would make the workspace header's badge the second place that decision lives. A failing call that says why is more useful than a panel that says nothing. |

## In scope

- A real `PreviewPanel`: idle/loading, empty, error, ready — plus the failure and warning banners.
- Assembling a stored project into one self-contained HTML document (D6, D7, D18).
- The injected shim: `hl()`, the error channel, the call budget, the timeout (D8, D15, D16).
- The host broker: identity and nonce checks, `hlProxy` forwarding, replies (D2, D3, D4).
- Automatic rebuild after a generation, manual **Refresh**, the stale hint (D12).
- `ApiError` carrying `code` and `detail` (D5).
- `generationsApplied` and `filesRevision` on the workspace store (D12).

## Out of scope

| Not in this slice | Where it goes |
|---|---|
| A console panel forwarding the frame's `console.log` | Slice 12 if the error audit shows it is needed; otherwise never |
| Previewing unsaved editor buffers (D14) | Not planned |
| Open-the-preview-in-a-new-tab, device-width toggles, a reload-on-save toggle | Not planned — none is in F6.4 |
| Serving project files as static assets | Not planned; D6 records why |
| Snapshot-aware preview ("preview version 2") | Slice 11, which owns snapshots — its restore must move `filesRevision` |
| `sonner`/`skeleton` for these banners and the loading state | Slice 12, which introduces both and audits every screen |
| The README architecture bullet naming `srcdoc` (asked for by `IMPLEMENTATION_PLAN.md` §4) | Slice 13, which writes the README; the decision is recorded here as its source |
| Any change to the proxy, the allowlist, the system prompt or `hlKnowledge.ts` | Nowhere — D19 |

## User flow

1. The user opens a project in the workspace. The preview panel asks for the stored files.
2. **No files yet** — the panel says so and points at the chat box. (Every project starts here.)
3. The user types "build a contact dashboard" and the reply streams into chat and the editor.
4. The generation reaches `done`; the store refetches the file list and increments
   `generationsApplied`.
5. The panel rebuilds without being asked: it reads each stored file, assembles one document
   with a fresh nonce, and sets it as the iframe's `srcdoc`.
6. The document's shim defines `hl()`. The generated `app.js` calls
   `hl('POST', '/contacts/search', { pageLimit: 20 })`.
7. The shim posts the request to the parent. The host checks the frame identity and the
   nonce, calls `hlProxy` — same origin, ID token, App Check — and posts HighLevel's body
   back.
8. The generated app renders the account's contacts. **That is the demo.**
9. If a call fails, the host's banner carries HighLevel's own message; if the connection is
   dead, it carries a **Reconnect HighLevel** link to the dashboard.
10. The user edits a file in Monaco and saves. The panel shows **Files changed — Refresh**;
    pressing it rebuilds from the stored files.

## Data model

**Nothing changes.** No new collection, no new document shape, no new field, no index, and
no edit to `firestore.rules`. The preview reads files through the routes Slice 6 shipped and
HighLevel through the proxy Slice 8 shipped; it stores nothing of its own, in Firestore or
anywhere else. The build nonce and the assembled document live in the Pinia store for the
lifetime of the page.

The definition of done therefore checks that the L3 rules count is **unchanged**, measured
against `main` rather than assumed — the practice Slice 9 established for a slice that adds
no collection.

## API contracts

### HTTP — all existing, all unchanged

| Method | Path | Auth | Used for |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/files` | ID token + `email_verified` + App Check | The paths to assemble (already in the store) |
| `GET` | `/api/projects/:projectId/files/:path` | same | Each file's content, ≤20 in parallel (D13) |
| `<M>` | `/api/hl/proxy/**` | same | Every brokered `hl()` call, via `hlProxy` (D4) |

No user identifier appears in any of them; the uid comes from the verified token, server-side.

### `postMessage` — the one new contract (D3)

**Frame → host** (`window.parent.postMessage(msg, '*')`)

```
{ genesis: 'preview', v: 1, nonce: string, id: string,
  kind: 'hl', method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown }

{ genesis: 'preview', v: 1, nonce: string, kind: 'error', message: string }
```

**Host → frame** (`frame.contentWindow.postMessage(msg, '*')` — D3 explains the `'*'`)

```
{ genesis: 'preview-host', v: 1, nonce: string, id: string, ok: true, data: unknown }

{ genesis: 'preview-host', v: 1, nonce: string, id: string, ok: false,
  error: { message: string, status: number, code?: string } }
```

**Host acceptance rules.** A message is handled only if `event.source` is the current
iframe's `contentWindow`, `genesis === 'preview'`, `v === 1`, the `nonce` equals the current
build's, `id` is a non-empty string, `method` is one of the three, and `path` is a string.
Anything else is ignored with no reply and no HighLevel call. The host never puts a token, a
uid or a location id in a reply.

**Shim-side contract, fixed by Slice 9's prompt and not re-negotiable here:** `hl()` takes
`(method, path, payload?)`; the payload is the query string on `GET` and the JSON body
otherwise; it resolves with HighLevel's body **unwrapped**; it rejects with an `Error`
carrying `message`, `status` and `code`.

## Edge cases and failure modes

| Situation | What happens | Retry? | AC |
|---|---|---|---|
| Project has no files | Empty state naming what to do; no iframe | — | AC-26 |
| Files exist, no `index.html` | Empty state saying there is no entry point | — | AC-8, AC-26 |
| A file read fails | Error state with the server's message and **Try again** | Yes, by button | AC-27 |
| Referenced file not stored | Tag dropped, file named in a warning banner | — | AC-6, AC-36 |
| Generated JS contains `</script>` | Content is delivered as data; the document is intact | — | AC-4 |
| Relative `href`/`src` that is not a stored file | Left as written if absolute; dropped and named if a bare name | — | AC-5, AC-6 |
| **Stale document answers late** — a reply arrives for the previous build | Nonce mismatch: dropped, no HighLevel call, no reply | — | AC-12, AC-17 |
| A message from another frame or the opener | `event.source` mismatch: ignored | — | AC-38 |
| Generated code asks for a path outside the grammar | Failure reply from `hlProxy`; nothing sent | — | AC-20 |
| HighLevel call fails (any proxy code) | Failure reply with `message`/`status`/`code`; banner shows the message | App's own choice | AC-21, AC-33 |
| Connection expired or absent | Banner adds **Reconnect HighLevel** → dashboard | Reconnect | AC-34 |
| Generated code throws, or leaves a rejection unhandled | Error report → runtime banner | Refresh | AC-15, AC-35 |
| Generated code tries `fetch`/XHR | Blocked by `connect-src 'none'`; violation reported and shown | — | AC-16, AC-35 |
| App exceeds 50 CRM calls | Further calls reject locally; banner names the limit | Refresh | AC-13 |
| Host never replies | Shim rejects after 30 s with a message | — | AC-14 |
| Refresh pressed during a generation | Control is disabled | — | AC-30 |
| Files changed by a save | **Files changed — Refresh** hint; no automatic rebuild | By button | AC-32 |
| Generation ends in an error, an abort, or writes no file | No rebuild | — | AC-23 |
| Breakpoint swap or tab switch destroys the iframe | Rebuilt from the cached document; no refetch | — | AC-28 (store-held) |

## Acceptance criteria

**Assembling the document**

- **AC-1** — Given a project whose files include `index.html`, when the preview document is assembled, then it begins with `<!doctype html>` and the shim `<script>` is the first element of `<head>`.
- **AC-2** — Given `index.html` carrying `<link rel="stylesheet" href="styles.css">` and a stored `styles.css`, when assembled and run, then no `<link>` remains and the stored CSS is installed at that position.
- **AC-3** — Given `index.html` carrying `<script src="app.js">` and a stored `app.js`, when assembled and run, then the stored JS executes at that position, in document order, in global scope.
- **AC-4** — Given a stored `app.js` containing the text `</script>` and a stored `styles.css` containing `</style>`, when assembled, then both files' content is recoverable byte-identical from the document and neither has escaped into markup.
- **AC-5** — Given a reference whose URL is absolute or protocol-relative (`https://…`, `//…`), when assembled, then the element is left exactly as written.
- **AC-6** — Given a reference to a bare filename the project does not hold, when assembled, then the element is removed and the assembly reports a warning naming that filename.
- **AC-7** — Given any assembled document, then it carries `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">` ahead of the shim.
- **AC-8** — Given a project with files but no `index.html`, when assembly is attempted, then it produces no document and reports "no entry point" rather than guessing one.

**The shim, evaluated**

- **AC-9** — Given the shim running under a nonce, when generated code calls `hl('POST', '/contacts/search', { pageLimit: 20 })`, then exactly one message is posted to the parent carrying that nonce, a unique id, `kind: 'hl'`, the method, the path and the payload, and the call's promise is still pending.
- **AC-10** — Given a pending call, when a success reply for its id and nonce arrives, then the promise resolves with the reply's `data` exactly as sent, unwrapped.
- **AC-11** — Given a pending call, when a failure reply arrives, then the promise rejects with an `Error` whose `message`, `status` and `code` are the reply's.
- **AC-12** — Given a pending call, when a reply arrives carrying an unknown id or a different nonce, then it is ignored and the promise stays pending.
- **AC-13** — Given 50 calls already made in one document, when a 51st is attempted, then it rejects with a message naming the limit, posts no `kind: 'hl'` message, and posts one `kind: 'error'` report.
- **AC-14** — Given a call whose reply never arrives, when 30 seconds pass, then it rejects with a message rather than remaining pending.
- **AC-15** — Given the shim installed, when the document raises an uncaught error or an unhandled promise rejection, then exactly one `kind: 'error'` message carrying its text is posted to the parent.
- **AC-16** — Given the shim installed, when a `securitypolicyviolation` fires, then a `kind: 'error'` message naming the blocked directive is posted.

**The host broker**

- **AC-17** — Given the host holding build nonce *N*, when a well-formed request arrives carrying nonce *N−1*, then no HighLevel call is made and no reply is posted.
- **AC-18** — Given the host, when a message arrives that is malformed — missing `id`, unknown `kind`, a method outside `GET`/`POST`/`PUT`, or a non-string `path` — then it is ignored with no reply.
- **AC-19** — Given a well-formed request, when it is handled, then `hlProxy` is called with the same method, path and payload, and a success reply carrying the returned body is posted to the frame.
- **AC-20** — Given a request whose path fails the `HL_PATH` grammar (e.g. `/../../projects`), when it is handled, then a failure reply is posted and no network request is made.
- **AC-21** — Given a request whose proxied call fails, when it is handled, then the failure reply carries the `message`, `status` and `code` from the API's error envelope.
- **AC-22** — Given an API response of `{ error, code, detail }` with a non-2xx status, when a client call fails, then the thrown `ApiError` carries that message, `code` and `detail`.

**The workspace store's signals**

- **AC-23** — Given a generation, when it reaches `done` having stored at least one file, then `generationsApplied` increments **after** the file list has been refetched; when it errors, is aborted, or stores no file, `generationsApplied` does not move.
- **AC-24** — Given an open file, when a manual save succeeds, then `filesRevision` increments and `generationsApplied` does not.

**The panel**

- **AC-25** — Given a project with files, while their contents are being fetched, then the panel shows a loading state and renders no iframe.
- **AC-26** — Given a project with no files (or none named `index.html`), then the panel shows the empty state naming what to do next, and renders no iframe.
- **AC-27** — Given a file read that fails, then the panel shows an error state carrying the server's message and a **Try again** control that refetches.
- **AC-28** — Given an assembled document, then the panel renders exactly one iframe whose `sandbox` is `allow-scripts allow-forms` — with no `allow-same-origin` — and whose `srcdoc` is that document.
- **AC-29** — Given a ready preview, when **Refresh** is pressed, then the stored files are re-read and the document is rebuilt under a new nonce.
- **AC-30** — Given a generation in progress, then **Refresh** is disabled.
- **AC-31** — Given a ready preview, when `generationsApplied` increments, then the preview rebuilds without being asked.
- **AC-32** — Given a ready preview, when `filesRevision` moves past the built revision without a generation, then the panel shows a **Files changed — Refresh** hint and does not rebuild by itself.
- **AC-33** — Given a brokered HighLevel failure, then the panel shows a banner carrying its message.
- **AC-34** — Given a brokered failure whose `code` is `hl_reconnect_required` or `hl_not_connected`, then the banner additionally offers **Reconnect HighLevel**, linking to the dashboard.
- **AC-35** — Given an error report from the frame, then the panel shows a runtime-error banner carrying its message.
- **AC-36** — Given an assembly warning (AC-6), then the panel shows it, naming the missing file.
- **AC-37** — Given any banner or hint on screen, when the preview rebuilds, then it is cleared before the new document runs.
- **AC-38** — Given a `message` event whose `source` is not the current iframe's `contentWindow`, then the panel ignores it entirely.

**The demo**

- **AC-39** — Given a verified account with HighLevel connected and a new project, when the user asks for a contact dashboard and the generation completes, then the preview refreshes by itself and the iframe shows contact names read from the connected account, with no error banner on the panel.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1 | L1 | `frontend/src/lib/previewDocument.spec.ts` | Doctype emitted; shim script is `head`'s first element |
| AC-2 | L1 | `previewDocument.spec.ts` | No `<link>` survives; the CSS reaches the loader payload at that index |
| AC-3 | L1 | `previewDocument.spec.ts` | `<script src>` replaced in place by a loader call naming the file |
| AC-4 | L1 | `previewDocument.spec.ts` | `</script>`/`</style>` content round-trips out of the embedded JSON unchanged |
| AC-5 | L1 | `previewDocument.spec.ts` | `https://` and `//` references are byte-identical in the output |
| AC-6 | L1 | `previewDocument.spec.ts` | Unknown bare filename: element gone, warning names it |
| AC-7 | L1 | `previewDocument.spec.ts` | CSP meta present and precedes the shim |
| AC-8 | L1 | `previewDocument.spec.ts` | No `index.html` → no document, `no_entry_point` reported |
| AC-9 | L1 | `frontend/src/lib/previewShim.spec.ts` | One posted message with nonce, id, method, path, payload; promise pending |
| AC-10 | L1 | `previewShim.spec.ts` | Resolves with `data`, identity-compared |
| AC-11 | L1 | `previewShim.spec.ts` | Rejects with `message`/`status`/`code` |
| AC-12 | L1 | `previewShim.spec.ts` | Wrong id and wrong nonce both leave the promise pending |
| AC-13 | L1 | `previewShim.spec.ts` | 51st call: rejects, no `hl` post, one `error` post |
| AC-14 | L1 | `previewShim.spec.ts` | Fake timers to 30 s → rejection |
| AC-15 | L1 | `previewShim.spec.ts` | `error` and `unhandledrejection` each post once |
| AC-16 | L1 | `previewShim.spec.ts` | `securitypolicyviolation` posts, naming the directive |
| AC-17 | L1 | `frontend/src/lib/previewBridge.spec.ts` | Stale nonce → `hlProxy` not called, nothing posted |
| AC-18 | L1 | `previewBridge.spec.ts` | Four malformed shapes, each ignored |
| AC-19 | L1 | `frontend/src/stores/preview.spec.ts` | `hlProxy` called with the same three arguments; success reply posted |
| AC-20 | L1 | `stores/preview.spec.ts` | `/../../projects` → failure reply, `fetch` never called |
| AC-21 | L1 | `stores/preview.spec.ts` | `ApiError` fields land in the reply's `error` |
| AC-22 | L1 | `frontend/src/lib/api.spec.ts` | `errorForResponse` carries `code` and `detail` |
| AC-23 | L1 | `frontend/src/stores/workspace.spec.ts` | Increment on `done`-with-files only, and after the refetch |
| AC-24 | L1 | `stores/workspace.spec.ts` | Save moves `filesRevision`, not `generationsApplied` |
| AC-25 | L2 | `frontend/src/components/workspace/PreviewPanel.spec.ts` | Loading state, no iframe |
| AC-26 | L2 | `PreviewPanel.spec.ts` | Empty state, both causes, no iframe |
| AC-27 | L2 | `PreviewPanel.spec.ts` | Error state, message, retry refetches |
| AC-28 | L2 | `PreviewPanel.spec.ts` | One iframe; `sandbox` exactly as specified; `srcdoc` is the document |
| AC-29 | L2 | `PreviewPanel.spec.ts` | Refresh re-reads and the nonce changes |
| AC-30 | L2 | `PreviewPanel.spec.ts` | Disabled while `generating` |
| AC-31 | L2 | `PreviewPanel.spec.ts` | `generationsApplied` bump rebuilds unasked |
| AC-32 | L2 | `PreviewPanel.spec.ts` | Stale hint shown; no rebuild |
| AC-33 | L2 | `PreviewPanel.spec.ts` | Failure banner carries the message |
| AC-34 | L2 | `PreviewPanel.spec.ts` | Both codes render the Reconnect link to `/dashboard` |
| AC-35 | L2 | `PreviewPanel.spec.ts` | Runtime-error banner from an `error` report |
| AC-36 | L2 | `PreviewPanel.spec.ts` | Warning banner names the missing file |
| AC-37 | L2 | `PreviewPanel.spec.ts` | Rebuild clears banners and hint |
| AC-38 | L2 | `PreviewPanel.spec.ts` | Foreign `event.source` ignored |
| AC-39 | L5 | `tests/e2e/preview.spec.ts` | Connect → generate → preview self-refreshes → fixture contact names visible inside the frame, no banner |

L4 adds nothing: D19 records why (no new server surface; `tests/integration/hl-proxy.spec.ts`
already covers the only route the preview uses).

## Definition of done

- [ ] Every acceptance criterion above maps to a named, passing test
- [ ] Full suite green: `typecheck`, `lint`, `test:unit`, `test:rules`, `test:integration`, `test:e2e`
- [ ] **No new Firestore collection** — `firestore.rules` untouched and the L3 case count unchanged, *measured against `main`* rather than assumed (D19)
- [ ] **No functions change** — `functions/src` untouched and the L4 case count unchanged, measured the same way
- [ ] F8.3 for this surface: every failure row in *Edge cases* renders a message a person can act on, and the two connection codes offer Reconnect
- [ ] `PreviewPanel` ships loading, empty and error states (AC-25 to AC-27)
- [ ] No secrets in source; no new environment variable, so `.env.example` is unchanged
- [ ] Runs clean on `npm run dev` from a fresh clone
- [ ] **Manual check, unautomatable:** with real credentials and the real sandbox account, generate a contact dashboard and confirm real contacts render in the preview, then disconnect HighLevel and confirm the Reconnect banner appears. Paste the result into the PR.
- [ ] **Manual check:** confirm in a production build (`npm run build && npm run preview`) that the shim string is emitted intact — D8's rejected alternative is the failure this guards
- [ ] No new dependency added (D1)
- [ ] PR opened with demo evidence; human approves before merge

## Constraints later slices inherit

- **Slice 11 (snapshots) must move `filesRevision`** when a restore writes files, or the
  preview will show the pre-restore app with no hint that it is stale. A restore is a
  file-set change of exactly the kind D12 defines; whether it should also rebuild
  automatically is Slice 11's call.
- **Slice 12 owns the banner styling.** The panel's failure, warning and stale surfaces are
  hand-rolled `Alert`s here because `sonner` and `skeleton` do not exist yet; Slice 12's
  audit introduces both and should fold these in rather than leave two idioms.
- **Slice 13's README** must carry the `srcdoc` architecture bullet
  `IMPLEMENTATION_PLAN.md` §4 asks for, and the one-sentence version of D2 — that the
  credential never enters the sandbox — is the sharpest architecture decision in the build
  to put in the Loom.
- **`hl()`'s contract is now implemented in two places** — the prompt (Slice 9) and the shim
  (here). Neither may change without the other; the string `hl(` is the seam.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Playwright may not be able to read inside a sandboxed `srcdoc` frame**, which is exactly where AC-39's evidence lives. | It drives frames over CDP rather than through the DOM, so an opaque origin should be reachable; if it is not, AC-39 falls back to asserting the host-visible evidence (a successful brokered call and no banner) *and* the demo is verified by hand in the definition of done. The fallback is named now so the build stage does not have to invent one under time pressure. |
| R2 | **The shim is a string, so nothing typechecks it** (D8). A typo ships. | It is evaluated for real in eight L1 cases (AC-9 to AC-16) with stubbed globals, and executed in a browser at L5. Its surface is deliberately tiny: three globals, one exported function, no imports. |
| R3 | **Generated code can hang the tab** — `while (true)` in an iframe that shares the event loop. The sandbox does not stop it. | Out of scope to fix and honestly so: a preview runs the user's own generated code. D15's call budget stops the version of this that costs money; a busy loop costs a reload. Named here so it is not discovered as a surprise. |
| R4 | **`</script>` in generated JS would corrupt the document** — rare, catastrophic, invisible. | D7's design makes it unrepresentable rather than unlikely: content never passes through the HTML parser. AC-4 asserts it with a file that contains the string. |
| R5 | **Every rebuild re-spends the CRM rate-limit budget** (§5: 100 requests / 10 s). | Exactly two triggers, both deliberate (D12): a completed generation and a button. Saves get a hint, not a rebuild. D15 caps one document at 50 calls. |
| R6 | **Replies must be posted with `targetOrigin: '*'`**, because an opaque origin has no name. Anything in a reply is readable by whatever occupies that frame. | D2 is what makes this safe: replies carry HighLevel response bodies and error text, never a token, a uid or a location id — and the nonce plus `event.source` check means a document that is not ours is not answered at all. |
| R7 | **No `allow-same-origin` means `localStorage`, `sessionStorage` and cookies throw** inside the preview, and generated code may use them. | The throw is caught by the shim's error channel and shown (AC-15), so it fails loudly rather than silently. Teaching the model to avoid them is a prompt change, which D19 puts out of scope; if it proves common, it is a one-line addition to Slice 9's cheat-sheet, noted for Slice 12. |
| R8 | **CRM data rendered by generated code is an XSS sink** — a contact named with a `<script>` tag reaches `innerHTML`. | Contained by construction: the sandbox has no origin, no credential and no storage, so the worst case is a defaced preview of the user's own data. Nothing to fix here; recorded so a reviewer does not have to work it out. |
| R9 | **This is a large PR for one review** — four new modules, a rewritten panel, and a shared error-path change. | The error-path change (D5) is three call sites and additive. The rest is one new screen and its pure helpers, with no server surface at all (D19), which is what keeps it reviewable. If it still reads as too big at plan time, the honest split is *assembly + shim + panel* first and *the broker + HighLevel* second — but that first half cannot be demoed, which is the rule this project does not break, so it ships whole. |
