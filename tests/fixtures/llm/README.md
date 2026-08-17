# LLM fixtures — where these came from, and what they are not evidence of

Every file in this directory is a **hand-authored** sequence of Anthropic
stream events, written to the shape the system prompt specifies. None of them was
recorded from the model.

That distinction is the whole reason this file exists (Slice 9 D20). The sibling
directory `tests/fixtures/highlevel/` holds payloads recorded from the live
HighLevel sandbox, and those fixtures are evidence: they say what HighLevel
really sends. These do not say what Claude really sends. The session that wrote
them had no `ANTHROPIC_API_KEY`, and the real-model check is a definition-of-done
item discharged by hand, with credentials, and pasted into the pull request.

Stated as plainly as it can be:

> **The L1 prompt tests assert what the model is _told_. No automated test in
> this repository can assert what the model _does_.**

So `reply.json` calling two allowlisted HighLevel routes is a statement about the
contract the prompt teaches and the pipeline that carries it — the file
collector, the SSE frames, the editor — and not a claim that a real generation
produces that code. Reading it the other way would turn a green suite into false
confidence about the one thing (F3.2) this project is judged on.

A JSON file cannot carry a comment, which is why the note lives here rather than
in the fixtures themselves.

## The fixtures

| File                   | Marker                                                                                           | What it exercises                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reply.json`           | none, `__slow` (replayed with delays), `__long` (repeated past the byte cap), `__fail_midstream` | The happy path: a thinking delta, five prose deltas, then three `<genesis:file>` blocks — `index.html`, `styles.css`, `app.js` — each split across three text deltas so the streamed path is really streamed |
| `refusal.json`         | `__refuse`                                                                                       | A `stop_reason` of `refusal`, so the handler's refusal branch has something to map                                                                                                                           |
| `max-tokens.json`      | `__max_tokens`                                                                                   | A reply cut short by `max_tokens`, **inside an open file block**, so `truncated` and the unterminated-block path are both driven                                                                             |
| `prose-only.json`      | `__no_files`                                                                                     | A reply that writes no file at all — the "prose is a valid answer" case                                                                                                                                      |
| `bad-path.json`        | `__bad_path`                                                                                     | A block whose `path` the server refuses (`../secrets.js`): the whole op set is rejected and nothing is stored                                                                                                |
| `unterminated.json`    | `__unterminated`                                                                                 | A block the model never closes                                                                                                                                                                               |
| `duplicate-files.json` | `__dup_files`                                                                                    | The same path written twice in one reply                                                                                                                                                                     |

The fake that replays them is `functions/src/llm/fake.ts`, gated on
`FUNCTIONS_EMULATOR` and unreachable in a deploy.

## Editing `reply.json` is a surgical operation (Slice 6 R8)

Five suites depend on it, each on a different property:

- `functions/src/llm/fake.spec.ts` — pins the five prose deltas byte for byte, the
  three block paths, and that the reply arrives in more than fifteen token events
- `tests/integration/generate.spec.ts` — the recorded thinking delta must never
  reach the transcript
- `tests/integration/generate-files.spec.ts` — the frame ordering per path, and
  `document.getElementById` surviving into the stored content
- `tests/e2e/files.spec.ts` — the file tree, the editor, and `hl(` in `app.js`
- `tests/e2e/workspace.spec.ts` — the streamed prose in the chat panel

So change one block's body and leave everything else — the prose, the paths, the
block count, the thinking delta, the closing line — exactly as it is. Slice 9
changed `app.js` alone, from a `fetch('/api/hl/contacts')` call (a route Slice 8
D1 explicitly rejected) to two `hl()` calls against allowlisted routes;
`functions/src/llm/hlCalls.spec.ts` now asserts that every call in this file
resolves to an enabled row, so a future edit that invents a route fails at L1.

After any edit:

```sh
node -e "JSON.parse(require('fs').readFileSync('tests/fixtures/llm/reply.json','utf8'))"
```
