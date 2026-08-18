# Slice 14 — Targeted edits · PRD

**Spec:** F10.1 (stretch S1), F3.3, F4.2 · **Branch:** `slice/14-targeted-edits` ·
**Depends on:** 6, 7, 9, 10, 11 · **Date:** 2026-08-18

## Problem

A follow-up prompt already reaches the model with the project's files in context, so it knows
not to rewrite files it is not changing (`llm/projectState.ts`). What it cannot do is change
*part* of a file. The only thing it can write is a `<genesis:file>` block, which is a whole
file, so "add a dark theme" makes the model re-emit all 8 KB of `styles.css` and all 6 KB of
`index.html` to change forty lines.

That costs three things. **Money** — output tokens are 5× the price of input on
`claude-opus-5` ($25 vs $5 per MTok), so the re-emitted bytes are the single most expensive
line on the bill. **Time** — output is generated serially, so a 3,500-token rewrite is about a
minute of watching, where the change itself is five seconds. And **fidelity** — a file
reconstructed from context is a file the model can silently alter: a hand-edit the user made
last week, a comment, a fetch parameter, anything it did not think to carry across. The
product's own guard against this today is `projectState.ts`'s "whole files or no file", which
protects the *input* side of exactly this failure and can do nothing about the output side.

Underneath that is a vocabulary problem. The model has exactly one verb — *write this file* —
and users ask for at least four different things: create something, add something to what is
there, change something that is there, remove something. Collapsing all four onto one verb is
what forces a rewrite: "add one more theme" is an **insertion**, and the only way to express an
insertion with a rewrite is to re-emit everything around it.

This slice gives the model the missing verbs — `append`, `after`, `before`, `edit` beside the
existing `file` — resolves each of them to a line range on the server, and reshapes the request
around them so the parts that do not change are not paid for twice.

## The demo

Generate a contact dashboard, then say *"add a dark theme"*: the chat says it changed
`styles.css` and `index.html`, the new rules appear **at the end** of the stylesheet and the
toggle button appears **after the heading** — landing in place in Monaco while the rest of each
file sits still on screen — and the turn emits about 400 output tokens where the same turn on
`main` emits about 3,500.

## Prior art — what coding agents actually do

The approach here is not invented. Five shapes exist in the field and each was considered
against this codebase before D1–D3 were settled.

| System | Edit format | Matching | Note |
|---|---|---|---|
| **Anthropic text editor tool** (`str_replace_based_edit_tool`) | a tool call: `old_str` / `new_str` | **exact, and must match exactly once** — the documented error for 2+ is *"Found 3 matches for replacement text. Please provide more context to make a unique match."* | This is the shape `claude-opus-5` is trained on, and the one Claude Code itself uses |
| **Aider** | `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` inside a fence, filename on the line before | a ladder: exact → whitespace-insensitive → indentation-preserving → fuzzy (`difflib`) | Also ships `udiff`, which cut GPT-4 Turbo's "lazy coding" 3× (20% → 61% on its benchmark). Failures are fed back to the model for a repair round |
| **OpenAI Codex** | `*** Begin Patch` with `@@` context markers, deliberately **no line numbers** | exact → trimmed line endings → whitespace-ignored | Structured JSON errors naming the specific mismatch |
| **RooCode / Cline** | search/replace blocks | "middle-out" fuzzy matching by Levenshtein distance from an estimated region | Robust to drift in large files; correspondingly able to land in the wrong place |
| **Cursor** | the frontier model writes a **lazy** sketch (`// ... existing code ...`); a specialised *apply* model merges it | speculative edits — the original file is fed as the draft, so unchanged chunks are accepted in bulk at ~1000 tok/s | Two models. Solves the same cost problem from the other end |

Three conclusions this slice takes from that table.

**Cursor's answer is out, and for a structural reason rather than a budgetary one.** It needs a
second, specialised model to do the merge. Genesis has one model and one streaming call per
turn (`CLAUDE.md`: streaming is mandatory, never request/response), and adding a fast-apply
model would be a second vendor, a second key and a second failure mode for a saving this slice
gets without any of them.

**Line numbers are out, unanimously.** Codex avoids them on purpose, Aider never had them, the
text editor tool's `str_replace` does not use them. Models miscount, and a number is stale the
moment an earlier edit in the same reply lands. Echoing the text is also a *verification* the
model is changing what it thinks it is changing, which a line number is not.

**Aider's fuzzy tail is out; its exact head is in.** Anthropic's own guidance for the tool our
model is trained on is exact-match-or-fail with a uniqueness requirement, and that is the rule
D3 adopts. A fuzzy matcher that lands three lines off produces a broken app with no error
anywhere — which is precisely the failure this feature exists to prevent — and our recovery is
cheap in a way Aider's is not (D12).

## The cost model

The arithmetic below is the reason this slice exists, so it is stated before the decisions
rather than after them. Rates are `claude-opus-5`: **$5/MTok input, $25/MTok output, cache read
$0.50/MTok (0.1×), 5-minute cache write $6.25/MTok (1.25×), 1-hour cache write $10/MTok (2×)**.
The minimum cacheable prefix is **512 tokens**, and a request may carry at most **4**
`cache_control` breakpoints, checked in the order **tools → system → messages** — a change at
any level invalidates that level and everything after it.

A representative project after turn one: `index.html` 6 KB, `styles.css` 8 KB, `app.js` 14 KB —
28 KB, about 7,000 tokens. Turn two is *"add a dark theme"*.

**On `main` today:**

| Part | Where it sits | Tokens | Rate | Cost |
|---|---|---|---|---|
| System prompt | `system[0..2]`, breakpoint on the last block | 2,000 | read, $0.50/M | $0.0010 |
| Project state | `system[3]`, **after** the breakpoint | 7,000 | full, $5/M | $0.0350 |
| Transcript | `messages` — **downstream of a block that changes every turn** | 1,500 | full, $5/M | $0.0075 |
| Reply | `index.html` + `styles.css` re-emitted whole, 14 KB | 3,500 | $25/M | $0.0875 |
| | | | | **$0.131** |

**After this slice:**

| Part | Where it sits | Tokens | Rate | Cost |
|---|---|---|---|---|
| System prompt | `system`, breakpoint, `ttl: '1h'` | 2,000 | read, $0.50/M | $0.0010 |
| Transcript | `messages`, breakpoint on the last **assistant** turn | 1,500 | read, $0.50/M | $0.0008 |
| Project state | tail of the final **user** message — after everything | 7,000 | full, $5/M | $0.0350 |
| Reply | two edit blocks, ~1.6 KB | 400 | $25/M | $0.0100 |
| | | | | **$0.047** |

**64% cheaper, and the output-token count falls 8.75×** — which is the latency term, because
output is serial where input is parallel. Two things this table is careful not to oversell:
thinking tokens at `effort: 'high'` are billed as output and are unchanged here, and the
project-state block is now the dominant line, which is named as the follow-up rather than
claimed as solved (D22).

The pathological case is where it bites hardest: a 100 KB file rewritten to change ten lines is
25,000 output tokens — $0.63 and several minutes of streaming — against about 400 tokens for
the same change as an edit.

## Decisions

No interview was run: this slice ships under the unattended loop, so every question below was
answered from `PRODUCT_SPEC.md` §4 (F3.3, F4.2, F8.1, F10.1), `IMPLEMENTATION_PLAN.md` §4
(Slices 5, 6, 7, 11) and §8, `CLAUDE.md`'s non-negotiables, the merged code of Slices 0–13, the
published behaviour of the systems in *Prior art* above, and Anthropic's documentation for the
text editor tool and prompt caching. Load-bearing decisions carry the alternative that was
rejected.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | **What can the model write?** | **Five verbs, not two** — because *adding* something and *changing* something are different requests and collapsing them makes both worse. Every one is a line-oriented tag block carrying `path` and nothing else. `<genesis:file>` writes a file whole. `<genesis:append>` adds new text at the end of an existing one. `<genesis:after>` and `<genesis:before>` add new text at an anchor, without touching it. `<genesis:edit>` replaces an anchor. Three grammars: one section (`file`, `append`), two sections separated by `<genesis:add>` (`after`, `before`), two sections separated by `<genesis:with>` (`edit`). | Slice 6 settled *why* the shape is a namespaced tag pair rather than a fence: the model emits fences inside generated markdown and they have no unambiguous close. What is new is the verb set, and it is the same set Anthropic's own text editor tool exposes — `create`, `insert`, `str_replace` — which is the strongest available evidence, since that is the tool `claude-opus-5` is post-trained on. **The insert verbs are not sugar.** Expressed as a replace, "add one more theme" makes the model echo the neighbouring rule *twice* — once as the anchor and again inside the replacement — which costs tokens and, far worse, invites it to paraphrase the copy it is re-emitting and silently alter code the user never mentioned. `append` is the cheapest op in the set: no anchor at all, no matching, and therefore no way to land in the wrong place — and "add one more X" to a stylesheet or a script is the single most common iterative request. Rejected: **one `edit` verb for everything** (above); rejected: **`prepend`** — expressible as `before` the first lines, and the anchor is a feature there: prepending blind to `index.html` puts text in front of the doctype; rejected: **a `where="after"` attribute instead of two tags** — the splitter's hold-back predicate reasons character by character about what a partial line could still become, and a second attribute makes the fiddliest code in the module materially harder, on exactly the property where Slice 6 found a real bug. A tag name is a fixed prefix; an attribute is not. Rejected: **splitting `file` into create-versus-rewrite** — it adds a failure mode without catching a realistic error, and the distinction the user actually wants to see is delivered by D9's `mode` flag instead. Rejected: **Aider's `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`** — better represented in training data, and `=======` alone on a line is a setext H1 underline in Markdown, an extension we allow. Rejected: **a `str_replace` tool call** — JSON-escaping a code blob costs tokens and invites escaping mistakes, `input_json_delta` streams partial JSON that cannot be spliced into an editor as it arrives, and Slice 9 D1 already settled that this product does not put tools in front of the model. |
| D1b | **Five verbs — how many shapes reach the browser?** | **Two.** `file` keeps `file_start` / `file_chunk` / `file_end`. All four of the others collapse to `edit_start { path, from, to }` / `edit_chunk` / `edit_end`, where **`from === to` is a pure insertion** and `from < to` is a replacement. The server resolves every verb to a range before the first chunk goes out. | The authoring surface and the wire are different problems. The model needs verbs that match intent, because picking the right one is a judgement it makes token by token; the browser needs one contract — *this file, these lines, this text* — because it has to splice into a Monaco model. Resolving the verb to a range on the server puts the arithmetic where it is reliable and leaves the client with a single code path for four verbs. It is also what makes the whole set extensible: a sixth verb would be a new grammar and no new frame. |
| D2 | **Search-and-replace, or a line range?** | **Search and replace by the model; a line range to the browser.** The model echoes the text it is changing and emits no number; the **server** resolves that text to `from`/`to` and puts the range on the wire (D9). Line numbers exist in exactly one direction — outward, computed in code. | The obvious cheaper shape is `{ path, from, to, text }`: the model has the whole file in context, so why not have it say *where*? Four reasons, and the fourth is the one that decides it. **(1) The arithmetic does not actually favour it.** To emit line 42 the model must be *shown* line 42, so `projectState.ts` has to number every line — about 1,200 extra input tokens for a 300-line app, on every turn, against roughly 200 output tokens saved by not echoing the anchor. At $5 in / $25 out that is $0.006 spent to save $0.005: a wash, before anything else is counted. **(2) Numbering makes the cached prefix worse.** An unnumbered file that gains a line changes bytes only from that line on; a numbered one renumbers everything below it, so a one-line insertion at the top rewrites the whole block. **(3) Two edits in one reply break it.** Edit 1 replaces ten lines with five, and edit 2's range now means something different — so either the model must do arithmetic mid-generation, or it must understand that all ranges refer to the file as *shown* and the server must apply them in reverse. A text anchor has no such coupling: it stays valid whatever happened above it. **(4) A line range is an assertion with no checksum.** Off by two lines, the server splices confidently at the wrong place and stores a silently corrupt file — which is the exact failure D3 rejects fuzzy matching for. The echoed text is not overhead; it *is* the checksum, and it is what turns a stale view (a file omitted by the budget, or changed by a concurrent `PUT`, D8) into a loud refusal instead of a confident wrong write. Anthropic had every opportunity to make `str_replace` line-based and did not; `insert_line` exists only for pure insertion, after a `view` that prints the numbers. Rejected: **numbering the files in `projectState.ts`** (above); rejected: **unified diff** — Aider found it cut GPT-4 Turbo's laziness threefold, but it costs *more* output than search/replace (context lines carry a per-line prefix) and a mis-typed prefix in whitespace-sensitive content fails silently. |
| D3 | **How is the anchor matched?** | **Exact, and unique.** Normalise CRLF to LF on both sides, then count exact occurrences: one applies, zero is `edit-no-match`, more than one is `edit-ambiguous`. One fallback only, tried when the exact pass finds zero: the same comparison with **trailing** whitespace stripped per line and a trailing newline ignored, again requiring exactly one match. No leading-whitespace flexibility, no similarity matching, no `difflib`. | This is the documented contract for `str_replace`, which is the shape `claude-opus-5` is trained on — *"Your application should ensure that there is exactly one match for the old text"*. The fallback covers the one failure that is a transcription artefact rather than a mistake (trailing spaces, a missing final newline) and cannot move where the patch lands. Rejected: **Aider's and RooCode's fuzzy tails** — a Levenshtein match that lands three lines off writes a broken app and reports success, and the whole argument for this feature is that a silent wrong write is worse than a loud refusal. Rejected: **indentation-flexible matching** — indentation is semantic in the anchor; a search block that matched at any indentation would match the same CSS rule inside and outside a media query. |
| D4 | **What does an edit become on the server?** | **A whole-file `FileOp`.** Every edit is applied to a working copy and what leaves the LLM layer is `{ path, content }` — the same shape a `<genesis:file>` block produces. | This is the decision that keeps the slice small. `validateFileOps`, the path rules, the 100 KB byte cap, the 20-file cap, `stageFileWrites`' merge-vs-create, the single `WriteBatch`, `mergeSnapshotFiles` and the snapshot of the *resulting* set are all untouched, and every invariant Slices 6 and 11 paid for holds by construction rather than by a second implementation agreeing with the first. Rejected: **a patch persisted as a patch** — it would make the stored file a function of its history, which is the one thing Firestore-for-files was chosen to avoid. |
| D5 | **Several ops on one file in one reply?** | Allowed, and they apply **in reply order** to a per-turn working copy seeded from the stored files. A `<genesis:file>` block replaces the working copy for that path; every other verb operates on whatever is currently there. The existing duplicate rule still refuses two whole-file blocks for one path, and it is now the *only* op that may not repeat. | A theme change is realistically an `append` to the stylesheet, an `after` in the markup and an `append` to the script — three ops, two of them on files the same turn also touched. Sequencing against the working copy rather than the stored file is what makes the second op's anchor mean what the model meant: it wrote it while looking at the result of the first. |
| D6 | **Can a modify verb create a file?** | **No.** `append`, `after`, `before` and `edit` all refuse a path the project does not hold, with `edit-unknown-file`. Only `<genesis:file>` creates. | The four modify verbs are defined by text that is already there, and there is no text in a file that does not exist. Keeping creation to one verb means none of the others has a mode. It also catches the realistic model error — inventing `theme.css` and then appending to it — as a refusal rather than as a file whose entire content is one CSS rule. |
| D7 | **What deletes?** | An **empty `<genesis:with>` section deletes** the matched text. An **empty anchor is malformed** for every verb that takes one, and an **empty payload is malformed** for `append`, `after` and `before` — an insert that inserts nothing is a no-op the model did not mean. | Deletion falls out of `edit`'s shape for free and is a change users ask for. An empty anchor does not: it matches everywhere and nowhere, and the positions it might have meant now have verbs of their own. Whole-*file* deletion stays out of scope (D22): no operation in the product deletes a file document except restore, and that is Slice 11's on purpose. |
| D8 | **The file can change between the anchor being resolved and the turn being written.** | **The write-time application is the authoritative one.** Anchors are resolved during the stream against the files read before it, purely so `edit_start` can carry a range for the UI; the ops are then re-derived inside `planFileWrites` against the files it *already re-reads*, and a turn whose anchor no longer resolves there refuses whole with `edit-stale`. | A generation may run for nine minutes. The editor is read-only for the length of a stream (Slice 6 D21), but that closes one tab, not a second device or a `PUT` from another window. Without re-resolution the turn would commit a whole file computed from stale content and silently revert the user's save — worse than the whole-file rewrite it replaces, because the user asked for a surgical change and got a rollback. It costs nothing: `planFileWrites` already reads the current files for the cap check and the snapshot merge. Rejected: **last-write-wins**, which is right for `PUT` (Slice 6) and wrong here, because a patch carries a claim about what it is patching. |
| D9 | **What does the client see?** | Three new SSE frames: **`edit_start { path, from, to }`** the moment the anchor resolves — which is at the separator for `after` / `before` / `edit`, and at the open tag for `append` — then **`edit_chunk { path, text }`** carrying the new text as it streams and **`edit_end { path }`** at the close. `from` and `to` are 1-based lines, `to` exclusive; `from === to` is an insertion. `file_start` gains **`mode: 'create' \| 'rewrite'`**, which the server knows from the read it has already done. Chat markers are `[file: <path>]` and `[edit: <path>]` — two, not five. | F4.2 requires the protocol to carry file boundaries, and a located change is a boundary of a different kind: without a frame the chat panel and the tree would show nothing for the length of the reply's most interesting part. Lines rather than character offsets because a line range is what both Monaco and a sentence in the UI want. `mode` is what makes "a new file" and "your file, rewritten" different on screen without a fifth verb (D1). Two markers rather than five because a transcript needs the distinction that survives — *written whole* versus *changed in place* — and the finer verb is visible live, in the editor, where it means something. Rejected: **resolving the patch server-side and re-sending the whole file as `file_chunk`s** — zero client work, and it throws away the entire point on screen: the user would watch the file be rewritten, which is the thing we just stopped paying for. |
| D10 | **How does the browser render an edit it only has a fragment of?** | The store composes `prefix + accumulated + suffix` into `streamingFiles[path]`, where the two halves come from the content the client already holds. If it holds none, it fetches the file once at `edit_start` and splices when that resolves, buffering chunks meanwhile; if the fetch fails it shows the replacement alone. `done` refetches either way, as it already does. | `streamingFiles` and `activeContent` already exist and already win over the stored buffer during a stream, so an edit is a different way to fill the same slot rather than a second display path. The degraded case is honest rather than clever: something arrives on screen, and the authoritative refetch is one event away. |
| D11 | **How does Monaco apply it?** | `editorContent.ts` gains a third case: a **splice** — common prefix, common suffix, and the minimal range between them — applied through `model.applyEdits` over that range. `append` is unchanged; `replace` over `getFullModelRange()` is gone. The editor reveals the spliced range rather than the tail. | Slice 7 D8 established that the *decision* about how bytes reach the document is a pure module with its own tests, because the wrong answer is invisible below L5. A full-range replace per chunk is the same class of mistake as `setValue`: it re-tokenises the whole document for a ten-line change and moves the viewport away from what changed. This is also the user-visible half of the whole slice — *only the segments that need updating are updated*, in the editor as well as in the model's output. It improves whole-file rewrites too, since a rewrite that shares a prefix now splices rather than replacing. |
| D12 | **A refused edit — repair it automatically?** | **No second model call.** The refusal sentence is written into the assistant message as an `[error: …]` marker line, so it survives a reload, renders as an error chip in the bubble, **and is in the transcript the next turn sends** — which makes the existing **Retry** button the repair loop, at the cost of one click. | Aider, Cline and Codex all feed the failure back to the model, and they are right that the feedback is what makes edits usable. What they need that we do not is an *automatic* round trip, because they are editing files the model has only seen partially. Our model was shown every file verbatim in the same request, so a failed exact match is rare, and buying an unconditional second streaming call to cover it would spend on every turn what a click spends on few. It also keeps `/generate` one call per turn, which is what everything from the message cap to the SSE contract is built on. Rejected: **an in-turn repair round** — a second `messages.stream()` inside one request, a synthetic transcript turn, and a turn that can bill twice with nothing on screen to say why. |
| D13 | **Where does the project-state block go?** | Out of `system`, to the **tail of the final user message**, before the prompt text within it. `system` becomes `SYSTEM_PROMPT` by identity on every request, unconditionally. | The caching hierarchy is `tools → system → messages`, and a change at one level invalidates everything after it. The project state changes on every turn that writes a file — which is most turns — so as a `system` block it invalidates the entire transcript behind it, and no breakpoint anywhere in `messages` can ever hit. Moving it past the transcript costs nothing (documents-before-query is the recommended placement for long context anyway) and makes D14 possible. Rejected: **keeping it in `system` and caching it there** — it would cache a block that changes every turn: a 1.25× write on 7,000 tokens, read back only on a retry. |
| D14 | **Where do the breakpoints go?** | **Two.** One on the last block of `SYSTEM_PROMPT`, with `ttl: '1h'`. One on the **last assistant message** of the transcript, at the default 5-minute TTL. The project-state block carries none. | `buildContext` already drops trailing assistant turns, so the last assistant message is the second-to-last message — exactly the position Anthropic's multi-turn pattern names, and the last block that is byte-identical between consecutive turns. Turn *n+1* then reads the whole conversation up to turn *n−1* at 0.1× and writes a new entry two blocks along; the ~20-block lookback is never approached. The system prompt gets `ttl: '1h'` because it is ~2,000 tokens that never change and a user who thinks for six minutes should not repay the write; the 2× premium on 2,000 tokens is $0.004 an hour. Mixed TTLs are legal in this order — 1-hour entries must precede 5-minute ones, and `system` precedes `messages`. Rejected: **top-level automatic caching** — it places the breakpoint on the *last* cacheable block, which here is the volatile project state: a 1.25× write every turn that only a retry ever reads. |
| D15 | **`projectState.ts`'s file ordering.** | **Selection** stays by ascending content length (it maximises the number of complete files that fit the budget). **Rendering** becomes stable: `index.html`, then path. | Today the two are one, so a file that grows past its neighbour reorders the block, and a change to `app.js` moves `styles.css`'s bytes. Under a prefix-matched cache that turns a localised change into a total one — and the same reordering makes an unchanged project render differently between requests, which `orderForReading` already calls out as a cache miss for no reason. Splitting selection from rendering is four lines and keeps both properties. |
| D16 | **Does the system prompt change, and what does that cost?** | Yes — the edit format, its worked example and the policy in D17 go into the second `SYSTEM_PROMPT` block, inside the cached prefix. **One cache write, once**, then stable. | The alternative is putting the instructions after the breakpoint, where they would be re-sent at full price on every generation for ever. A stable prefix that changes on deploy is what a cached prefix is for. |
| D17 | **How does the model choose a verb?** | The prompt states it as a question about intent, in this order: **adding something new to a file that already exists → `append` if it belongs at the end, `after` or `before` if it belongs somewhere specific. Changing something that is already there → `edit`. Creating a file, or restructuring one so thoroughly that most of it changes → `file`.** With the anchor rules stated plainly — copy the text exactly as shown, include enough surrounding lines that it appears once, and you cannot touch a file that was not shown to you. | Ordering the guidance by *what the user asked for* rather than by verb is the whole of it: the model has already understood the request in those terms by the time it writes the first tag. This is the lever that decides whether the slice pays, and it is a prompt — so no automated test here can assert what it does, only what it says (`tests/fixtures/llm/README.md`'s standing warning), and the DoD carries a hand-check against the real model. "Most of it" rather than a byte threshold: a percentage invites the model to compute rather than judge, and the failure mode of judging wrong is a rewrite, which is exactly today's behaviour. |
| D18 | **What happens to `generateFileError`?** | The store's separate file-error banner goes; the refusal renders inside the assistant bubble as an error chip, from the marker D12 stores. `done` keeps carrying `fileError` on the wire. | #28 established the direction — a failed turn is written into the transcript rather than shown beside it — for exactly the reason that applies here: a banner is cleared by a reload and a transcript is not. Two surfaces showing one refusal would be worse than either. |
| D19 | **Does anything new go in Firestore?** | **No.** No collection, no field, no index, no rules change. The stored file document is unchanged, because D4 makes an edit resolve to a normal write. | Stated as a decision because it is the thing to *measure* rather than assume — `git diff main...HEAD --stat -- firestore.rules tests/rules` listing nothing is the evidence, as it was for Slice 12's D14. |
| D20 | **Effort, model, `max_tokens`?** | Unchanged: `claude-opus-5`, `messages.stream()`, `max_tokens: 64000`, `output_config: { effort: 'high' }`. | Effort is Slice 9's to tune and needs a sweep against real generations to move. It is worth naming that an edit turn is small, well-specified work where a lower effort would plausibly do — and that choosing per turn requires knowing whether the turn is an edit *before* the model has decided, which nothing here can. Follow-up, not scope. |
| D21 | **Fixtures.** | Four new hand-authored fixtures — `reply-edit.json` (one `edit` and one `append`), `reply-insert.json` (`after` and `before`), `edit-no-match.json`, `edit-ambiguous.json` — behind six markers: `__edit`, `__insert`, `__edit_missing`, `__edit_ambiguous`, `__edit_unknown_file`, `__edit_unterminated`. **`reply.json` is not touched.** | `reply.json` is load-bearing for five suites (`tests/fixtures/llm/README.md`), and every anchor below must be text it actually contains, so these are read *against* it rather than replacing it — the same relationship `reply-alt.json` has. This is Slice 11 D24's lesson: a fixture that could pass while the feature did nothing is not a fixture. `reply-edit.json`'s anchor is the literal `body { … }` rule from `reply.json`'s `styles.css`, and `fake.spec.ts` asserts that substring relationship directly, so a change to that block breaks the fixture loudly instead of quietly making the L4 assertion vacuous. `edit-ambiguous.json` anchors on `}` alone, which occurs three times in the same file — a realistic under-anchoring rather than a contrived one. |
| D22 | **What is explicitly not here?** | A diff view of the turn (F10.3 / stretch S3); deleting a whole file; an automatic in-turn repair round (D12); per-turn effort selection (D20); shrinking or retrieving the project-state block, which the cost table shows is now the dominant input line; a fast-apply model. | Each is a slice, and each is cheaper *after* this one: the diff view is nearly free once ops carry a located change, and project-state retrieval is the obvious next cost lever now that the transcript and the output are both handled. |

## In scope

- Four new blocks in the reply grammar — `<genesis:append>`, `<genesis:after>`,
  `<genesis:before>`, `<genesis:edit>` — split as they stream, with the same line-start rule,
  hold-back bound and chunking-invariance property as `<genesis:file>`.
- A pure applier: exact-unique anchor matching with one trailing-whitespace fallback, one range
  resolution per verb, sequential application to a per-turn working copy, and typed refusals.
- Write-time re-resolution against freshly-read files, so the committed content is derived
  once, authoritatively.
- Five new `FileRejection` reasons with user-facing copy, and the refusal written into the
  assistant message so it survives a reload and reaches the next turn.
- `edit_start` / `edit_chunk` / `edit_end` SSE frames, `mode` on `file_start`, and the
  `[edit: <path>]` marker.
- Client rendering: the composed streaming buffer, the *Creating* / *Rewriting* / *Editing* tree
  states, the edit chip and the error chip.
- A minimal-splice editor edit, so Monaco touches only the changed range — for edits and for
  whole-file rewrites alike.
- The request reshaped for caching: project state moved out of `system`, two breakpoints, a
  stable render order.
- System-prompt instructions for the format and the edit-vs-rewrite policy.

## Out of scope

| Not here | Picked up by |
|---|---|
| A per-generation diff view | Stretch S3 (F10.3) — much cheaper once ops carry a range |
| Deleting a whole file from a generation | Nothing yet; restore remains the only deleting operation (Slice 11 D7) |
| An automatic repair round-trip on a failed edit | A later slice, if the hand-check in the DoD shows failures are common enough to pay for |
| Shrinking or retrieving the project-state block | The next cost slice — it is the dominant input line after this one |
| Per-turn `effort` selection | A generation-quality slice, with a sweep (Slice 9's territory) |
| A fast-apply model | Rejected outright, D1 |

## User flow

1. The user opens a project that already has `index.html`, `styles.css` and `app.js`.
2. They type *"add a dark theme"* and send.
3. The reply streams. Prose appears first.
4. `edit_start` arrives for `styles.css`. The tree row reads **Editing**, the chat gains an
   edit chip, and — if the panel is empty — the file opens.
5. The editor shows `styles.css` with the anchored lines replaced by text that grows as
   `edit_chunk`s arrive. Everything above the anchor stays exactly where it is on screen; the
   viewport reveals the changed range.
6. `edit_end`, then a second edit against `index.html`, rendered the same way.
7. `done`. The store refetches the file list and the changed files, `filesRevision` moves, and
   the preview rebuilds with the dark theme against real HighLevel data.
8. Opening **History** shows a new version holding the project's whole file set, as for any
   other generation.

**The refusal flow (steps 4 onward):** the anchor does not resolve. No file is written, the
tree is byte-identical to before, and the assistant bubble carries an error chip reading
*"Genesis could not apply the change to `styles.css`: the text it was changing is no longer in
the file. Nothing was changed."* **Retry** re-runs the turn with that sentence in the
transcript.

## Data model

**Unchanged.** No new collection, no new field, no new index, no change to `firestore.rules`
(D19). `users/{uid}/projects/{projectId}/files/{fileId}` stores exactly what it stores today,
because an edit resolves to a whole-file write before it reaches the write path (D4). The
snapshot subcollection is likewise untouched: a turn containing edits snapshots the project's
resulting file set, on the turn's own batch, exactly as Slice 11 D1 and D4 specify.

The one storage-visible change is the **content of an assistant message**, which may now carry
an `[error: …]` marker line alongside its `[file: …]` and `[edit: …]` markers (D12, D18). The
`messages` schema does not change; the string does.

## API contracts

### `POST /generate` — unchanged request, three new frames and one new field

Request, auth, status codes and the two-channel error rule are exactly as they are today.
`PUT /api/projects/:projectId/files/:path` and the snapshot routes are untouched.

| Frame | Payload | When |
|---|---|---|
| `file_start` | `{ path: string, mode: 'create' \| 'rewrite' }` | **`mode` is new.** The server knows it from the file read it already does before the stream |
| `edit_start` | `{ path: string, from: number, to: number }` | The anchor resolved — at the separator for `after` / `before` / `edit`, at the open tag for `append`. 1-based lines, `to` exclusive, `from === to` for an insertion |
| `edit_chunk` | `{ path: string, text: string }` | The new text, as it streams. Trailing newlines held back and normalised exactly as `file_chunk`'s are |
| `edit_end` | `{ path: string }` | The block closed |

Frame order per located change is exactly `edit_start` → `edit_chunk`* → `edit_end`. A
`[edit: <path>]` token is emitted into the message text immediately after `edit_start`,
mirroring `[file: <path>]`.

A block whose anchor does **not** resolve emits **no** `edit_start` and no chunks — its content
never reaches the client — and the turn ends with `done` carrying a non-null `fileError`, no
written paths, and a message whose content holds the `[error: …]` marker.

### The reply grammar — five verbs, three shapes

**Write a file whole** (creates it, or replaces it) — unchanged since Slice 6:

```
<genesis:file path="app.js">
const rows = document.querySelector('#rows')
</genesis:file>
```

**Add new text at the end of an existing file.** No anchor, so nothing can be matched wrongly.
This is the cheapest op in the set and the answer to "add one more theme":

```
<genesis:append path="styles.css">
.theme-dark .card { background: #111; }
</genesis:append>
```

**Add new text at a place.** The anchor is kept, exactly as written; the new text goes after it
or before it:

```
<genesis:after path="index.html">
  <h1>Contacts</h1>
<genesis:add>
  <button id="theme">Dark mode</button>
</genesis:after>
```

**Change text that is already there.** An empty replacement deletes it:

```
<genesis:edit path="styles.css">
.card {
  background: #ffffff;
}
<genesis:with>
.card {
  background: var(--surface);
}
</genesis:edit>
```

Every delimiter line is alone on its line, with at most eight leading spaces or tabs — Slice 6's
rule, unchanged. `<genesis:before>` takes `<genesis:after>`'s shape exactly.

| Verb | Sections | Anchor | Resolves to | Refuses on |
|---|---|---|---|---|
| `file` | content | — | the whole file | path shape · byte cap · file cap |
| `append` | new text | — | `from = to = EOF` | unknown file · empty payload |
| `after` | anchor, new text | kept | `from = to =` line after the anchor | unknown file · no match · ambiguous · empty anchor or payload · missing `<genesis:add>` |
| `before` | anchor, new text | kept | `from = to =` the anchor's first line | as `after` |
| `edit` | anchor, replacement | replaced | `from`..`to` spanning the anchor | unknown file · no match · ambiguous · empty anchor · missing `<genesis:with>` |

## Edge cases and failure modes

| Case | What happens | User sees | AC |
|---|---|---|---|
| Anchor matches once | Applied | The change, in place | AC-9 |
| Anchor matches once only after trailing whitespace is stripped | Applied; the file keeps its own line endings | The change, in place | AC-10 |
| `append` to an existing file | Applied at EOF; no matching runs at all | The new text at the end | AC-9a |
| `after` / `before` resolve | The anchor is **kept**; the new text lands beside it | Both, in place | AC-9b |
| Anchor matches zero times | Whole turn's files refused | *"…the text it was changing is no longer in the file. Nothing was changed."* | AC-11 |
| Anchor matches more than once | Whole turn's files refused | *"…appears more than once in the file, so Genesis could not tell which one to change."* | AC-12 |
| `path` is not a file in the project — for any of the four modify verbs | Whole turn's files refused | *"…"theme.css" is not a file in this project."* | AC-13 |
| Missing separator, empty anchor, or empty payload on an insert | Whole turn's files refused | *"…the change was written in a form Genesis could not read."* | AC-5, AC-6 |
| The block never closes | Whole turn's files refused | *"The reply ended in the middle of a change to "styles.css", so nothing was saved. Try again."* | AC-4 |
| The file changed under the stream (another tab, another device) | Whole turn's files refused at write time | *"…"styles.css" changed while Genesis was writing. Nothing was changed."* | AC-19 |
| Applying every op exceeds the 100 KB byte cap | The existing `too-large` refusal, unchanged | Today's sentence | AC-16 |
| The turn is truncated or the stream fails mid-block | The existing `incomplete` refusal, unchanged | Today's sentence | AC-4 |
| The client holds no content for a changed path | Fetched once; chunks buffer until it lands | The change appears a beat later, or the new text alone if the fetch fails; `done` repairs it | AC-26 |
| Several ops on one file, each anchored in the last one's output | Applied in reply order against the working copy | Every change | AC-14 |
| A whole-file block and then an `append` to the same path | The append lands on the just-written content | Both | AC-15 |
| `<genesis:file>` on a path that exists | Written whole, `createdAt` preserved | The tree row reads *Rewriting* rather than *Creating* | AC-27 |

Every refusal keeps the two properties Slice 6 D9 established: **the whole turn's files are
refused together**, and **the assistant message still commits** — now carrying the reason.

## Acceptance criteria

**Grammar and streaming**

- **AC-1** — Given a reply containing one well-formed block of each of the four modify verbs,
  when it is collected, then each produces exactly one op for its path, of the right kind, and
  the ops carry the section text byte for byte.
- **AC-2** — Given a delimiter line with more than eight leading spaces, or with any other text
  on the line, when it is split, then it is treated as ordinary content, not as a delimiter.
  This holds for all nine delimiters — the five opens, their closes, and the two separators.
- **AC-3** — Given a reply containing every verb, when it is pushed to the splitter split at
  every offset from 1 to its length, then every split produces the identical frame sequence and
  the identical ops.
- **AC-4** — Given a block of any verb that never closes, when the turn ends, then no file
  document is written, the stored files are byte-identical to before, and the message carries
  the unterminated sentence naming that path.
- **AC-5** — Given an `edit` that closes with no `<genesis:with>` line, or an `after` / `before`
  that closes with no `<genesis:add>` line, when the turn ends, then the turn's files are
  refused with `edit-malformed`.
- **AC-6** — Given a block whose anchor section is empty or whitespace only, or an `append` /
  `after` / `before` whose payload section is empty, when the turn ends, then the turn's files
  are refused with `edit-malformed`.
- **AC-7** — Given an `edit` whose replacement section is empty, when it is applied, then the
  matched text is removed and nothing else changes.
- **AC-8** — Given a reply containing all five verbs, when it is collected, then each produces
  its ops and its frames, correctly ordered and correctly attributed by path.

**Matching and application**

- **AC-9** — Given an `edit` anchor appearing exactly once, when it is applied, then the
  resulting content equals the original with that occurrence replaced, and every other byte is
  identical.
- **AC-9a** — Given an `append`, when it is applied, then the resulting content is the original
  followed by the payload, no matching is attempted, and the resolved range is `from === to ===`
  one past the last line.
- **AC-9b** — Given an `after` and a `before` on one anchor, when they are applied, then the
  anchor text survives byte for byte and the payload lands immediately after it and immediately
  before it respectively, with `from === to` in both resolved ranges.
- **AC-10** — Given an anchor that matches only when trailing whitespace is ignored per line,
  when it is applied, then it applies, and the stored file's own line endings are preserved.
- **AC-11** — Given an anchor appearing zero times, when the turn ends, then the turn's files
  are refused with `edit-no-match` and the stored files are byte-identical to before.
- **AC-12** — Given an anchor appearing twice, when the turn ends, then the turn's files are
  refused with `edit-ambiguous` and nothing is written.
- **AC-13** — Given `append`, `after`, `before` or `edit` naming a path the project does not
  hold, when the turn ends, then the turn's files are refused with `edit-unknown-file` — one
  case per verb.
- **AC-14** — Given three ops on one path where each anchors on text the previous one produced,
  when they are applied, then all three land and the resulting content holds every change.
- **AC-15** — Given a `<genesis:file>` block for a path followed by an `append` to that path,
  when they are applied, then the append lands on the block's content, not on the stored file's.
- **AC-16** — Given a set of ops whose result exceeds `FILE_BYTES_MAX`, when it is validated,
  then it is refused with the existing `too-large` rejection and its existing sentence.

**Write path**

- **AC-17** — Given a turn whose only op is an edit, when it commits, then the stored file is
  byte-identical to the original outside the matched region, `size` matches the new content, and
  `createdAt` is unchanged.
- **AC-18** — Given a turn containing edits, when it commits, then it writes one snapshot
  holding the project's whole resulting file set, on the turn's own batch.
- **AC-19** — Given a file changed by a `PUT` after the generation read it and before the turn
  is written, when the turn is written, then its files are refused with `edit-stale` and every
  file document is byte-identical to the `PUT`'s result.
- **AC-20** — Given any refused edit, when the turn ends, then no file document is written and
  the assistant message still commits, carrying the refusal as an `[error: …]` marker line.

**Protocol**

- **AC-21** — Given an `edit` whose anchor resolves at lines 40–48, when the separator line is
  reached, then exactly one `edit_start` is written carrying `{ path, from: 40, to: 48 }`; and
  given an `append`, `after` or `before`, then its `edit_start` carries `from === to` at the
  resolved position.
- **AC-22** — Given a block whose anchor does not resolve, when the reply is streamed, then no
  `edit_start`, `edit_chunk` or `edit_end` is written for that path and no part of the block's
  content appears in any `token` frame.
- **AC-23** — Given a resolved block, when it streams, then exactly one `[edit: <path>]` marker
  appears in the message text, and `messageText` equals the concatenation of the `token` frames —
  including the `[error: …]` marker on a refused turn, which is emitted as a `token` frame before
  `done` rather than appended to the stored content behind the client's back.
- **AC-24** — Given a resolved block, when it streams, then its frames arrive in the order
  `edit_start`, zero or more `edit_chunk`, `edit_end`, and every chunk names that path.
- **AC-24a** — Given a `<genesis:file>` block, when it streams, then its `file_start` carries
  `mode: 'create'` for a path the project does not hold and `mode: 'rewrite'` for one it does.

**Client**

- **AC-25** — Given the store holds the content of a changed path, when `edit_start` and chunks
  arrive, then `streamingFiles[path]` equals prefix + accumulated new text + suffix at every
  step — and for `from === to` the prefix and suffix together are the whole original file.
- **AC-26** — Given the store holds no content for a changed path, when `edit_start` arrives,
  then it fetches the file once, buffers chunks meanwhile, splices when the fetch resolves, and
  — if the fetch rejects — shows the accumulated new text alone without throwing.
- **AC-27** — Given an open block, when the tree renders, then the row reads *Editing* for a
  located change, *Creating* for a `file_start` with `mode: 'create'`, and *Rewriting* for one
  with `mode: 'rewrite'`.
- **AC-28** — Given a message containing an `[edit: …]` marker, when the bubble renders, then it
  shows an edit chip visually distinct from a file chip, and the marker text never appears raw.
- **AC-29** — Given a turn refused for any file reason, when the bubble renders, then the reason
  appears as an error chip inside the bubble, it survives a reload, and no separate file-error
  banner is rendered anywhere.

**Editor**

- **AC-30** — Given a current document and a next document differing only in the middle, when
  `editorEdit` is called, then it returns a splice carrying the offset, the deleted length and
  the inserted text — the minimal changed range — and never a full-document replace. The fake
  model records no `setValue` call, ever.
- **AC-31** — Given an edit landing at line 40 of a 300-line file in a real browser, when the
  chunks apply, then the lines above line 40 do not move on screen, the changed range is
  revealed, and the file's colouring is intact.

**Cost and caching**

- **AC-32** — Given any request, when `buildParams` builds it, then it carries exactly two
  `cache_control` breakpoints: the last block of `SYSTEM_PROMPT` with `ttl: '1h'`, and the last
  assistant message of the context with the default TTL. No breakpoint sits on the
  project-state block.
- **AC-33** — Given any request, when `buildParams` builds it, then `system` is the
  `SYSTEM_PROMPT` array **by identity** — nothing volatile is ever appended to it.
- **AC-34** — Given a context whose files are unchanged, when two requests are built from it,
  then the project-state block is byte-identical; and given a file whose length changes, then
  the order of the other files' sections does not move.
- **AC-35** — Given a transcript with at least one assistant turn, when two consecutive requests
  are built, then every message before the breakpoint is byte-identical between them.
- **AC-36** — Given the `__edit` fixture, when the turn completes, then the total bytes the
  model emitted inside blocks is under a tenth of the resulting file's bytes.
- **AC-37** — Given any completed generation, when it is logged, then `generation.complete`
  carries `cacheReadInputTokens` and `cacheCreationInputTokens`.

**Existing surfaces**

- **AC-38** — Given the workspace, when the slice is complete, then no new screen exists, the
  code panel keeps its loading, empty and error states, and
  `git diff main...HEAD --stat -- firestore.rules tests/rules` lists nothing.

## Test matrix

| AC | Level | Test file | What it asserts |
|---|---|---|---|
| AC-1, AC-2, AC-8 | L1 | `functions/src/llm/blocks.spec.ts` | All nine delimiters, the line-start and indent rules, the three grammars, all five verbs interleaved |
| AC-3 | L1 | `functions/src/llm/blocks.spec.ts` | Chunking invariance over a reply using every verb, driven split at every offset |
| AC-4, AC-5, AC-6, AC-7 | L1 | `functions/src/llm/blocks.spec.ts` | Unterminated, missing separator per verb, empty anchor, empty payload, empty replacement |
| AC-9, AC-9a, AC-9b, AC-10, AC-11, AC-12, AC-13 | L1 | `functions/src/llm/patch.spec.ts` | One case per verb for the happy path and the resolved range; exact-unique matching, the trailing-whitespace fallback, and each typed refusal |
| AC-14, AC-15 | L1 | `functions/src/llm/patch.spec.ts` | Sequential application against the working copy, mixing verbs |
| AC-16 | L1 | `functions/src/files/schema.spec.ts` | Resolved ops go through `validateFileOps` unchanged |
| AC-20 (copy) | L1 | `functions/src/files/schema.spec.ts` | `fileErrorCopy` is exhaustive over the five new reasons |
| AC-21 – AC-24a | L1 | `functions/src/llm/fileops.spec.ts` | Frame order, the resolved range per verb, `mode` on `file_start`, the markers, `messageText` equality |
| AC-32, AC-33 | L1 | `functions/src/llm/params.spec.ts` | Breakpoint count, position and TTL; `system` by identity |
| AC-34 | L1 | `functions/src/llm/projectState.spec.ts` | Stable render order, selection still by size |
| AC-35 | L1 | `functions/src/llm/context.spec.ts` | The breakpoint lands on the last assistant turn; the prefix is stable across turns |
| AC-17, AC-18, AC-20 | L4 | `tests/integration/generate-edits.spec.ts` | The stored file after an `edit` and after an `append`, the snapshot, the committed message |
| AC-9a, AC-9b | L4 | `tests/integration/generate-edits.spec.ts` | `__insert` — the anchor survives byte for byte and the payload lands beside it |
| AC-11, AC-12, AC-13, AC-19 | L4 | `tests/integration/generate-edits.spec.ts` | Each refusal leaves every file document byte-identical |
| AC-22, AC-36 | L4 | `tests/integration/generate-edits.spec.ts` | No frames and no leaked content for an unresolved anchor; the emitted-bytes ratio |
| AC-37 | L4 | `tests/integration/generate.spec.ts` | The log line's cache fields (existing, re-asserted) |
| AC-25, AC-26 | L2 | `frontend/src/stores/workspace.spec.ts` | Composition, the lazy fetch, the buffered chunks, the failed fetch |
| AC-29 | L2 | `frontend/src/stores/workspace.spec.ts`, `ChatPanel.spec.ts` | The refusal in the bubble; no separate banner |
| AC-27 | L2 | `frontend/src/lib/files.spec.ts`, `FileTree.spec.ts` | *Editing* · *Creating* · *Rewriting* |
| AC-28 | L2 | `frontend/src/lib/messageParts.spec.ts`, `MessageBody.spec.ts` | The edit chip and the error chip |
| AC-30 | L1 | `frontend/src/lib/editorContent.spec.ts` | The splice, the minimal range, no `setValue` |
| AC-31 | L5 | `tests/e2e/edits.spec.ts` | The demo path in a real browser: lines above the edit do not move |
| AC-38 | — | the diff itself | Measured with `git diff --stat`, recorded in the build log |

L5 is one walk, covering the demo line, per §2's rule.

## Definition of done

The checklist from `docs/IMPLEMENTATION_PLAN.md` §3, plus:

- [ ] Every AC above maps to a named, passing test
- [ ] Full suite green: typecheck · lint · unit · rules · integration · e2e
- [ ] `git diff main...HEAD --stat -- firestore.rules tests/rules` lists nothing — **measured,
      not assumed** (D19)
- [ ] `tests/fixtures/llm/README.md` updated with the three new fixtures and four new markers,
      and `reply.json`'s row unchanged
- [ ] `fake.spec.ts` asserts the `__edit` anchor is a literal substring of `reply.json`'s
      `styles.css`, so the L4 assertion cannot go vacuous (D21)
- [ ] **Hand-check against the real model, with credentials, pasted into the PR** (D17): a
      second prompt on a real project produces edit blocks rather than whole files, and a third
      prompt within five minutes shows a non-zero `cacheReadInputTokens` in
      `generation.complete` — neither is assertable in CI
- [ ] The before/after output-token count for one real turn recorded in the PR, against the
      cost table above
- [ ] No new screen; the code panel's loading, empty and error states re-checked

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The model does not adopt the format.** D17 is a prompt, and no test here can assert what the model does — only what it is told. A model that keeps writing whole files leaves the slice inert. | The worked example is in the cached prefix beside the `<genesis:file>` example that already works; the hand-check in the DoD is the only real evidence, and it is required before merge. Fallback if it fails: the format is the variable, not the architecture — everything below the grammar is unaffected |
| R2 | **Anchor failures are more common than expected**, making refusals routine. | D12's transcript feedback plus Retry is the cheap repair; if the hand-check shows failures are common, the automatic round-trip in D22 becomes the next slice rather than a guess made now |
| R3 | **A file's own content contains a delimiter line.** `<genesis:with>` alone on a line inside generated code would split a block. | The same exposure `</genesis:file>` has carried since Slice 6, mitigated by the same thing: a namespaced tag no realistic HTML/CSS/JS/Markdown file emits. It is why D1 rejected `=======`, which Markdown really does emit |
| R4 | **The splice makes the editor worse, invisibly.** Slice 7's lesson: `setValue`-class mistakes pass every test below L5. | The decision stays a pure module with its own tests (D11), and AC-31 is a real-browser assertion about screen positions, not about the function |
| R5 | **The cache reshaping regresses quality**, by moving the project state from `system` into a user message. | Documents-before-query in the final user turn is the recommended placement for long context; the DoD's hand-check is against real generations, and the change is four lines to revert |
| R6 | **Write-time re-resolution disagrees with stream-time resolution** in a way the user cannot understand — the editor showed a change that then refuses. | D8 is deliberate and the copy names the cause (*"changed while Genesis was writing"*). The window is narrow and the alternative is a silent revert |
| R7 | **PR size.** Two halves — the edit protocol and the request reshaping — in one branch. | They are one subject (the cost of a follow-up turn) and the caching half is four files and mostly tests. If review says otherwise, D13–D16 lift out cleanly as their own PR, since nothing in the edit protocol depends on them |
