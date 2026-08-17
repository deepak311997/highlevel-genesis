import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages'

import { FILE_BYTES_MAX, FILE_EXTENSIONS, FILE_LIMIT } from '../files/schema'
import { CLOSE_TAG, OPEN_HEAD, OPEN_TAIL } from './fileops'
import { HL_KNOWLEDGE } from './hlKnowledge'

/**
 * The system prompt — the stable prefix, whole: who the model is, how it writes
 * files, and how the app it writes talks to HighLevel.
 *
 * ## Three blocks, in the order they became true
 *
 * Identity and response style (Slice 5), the file format (Slice 6), and the
 * HighLevel cheat-sheet (Slice 9, F3.2). Each was added only once the thing it
 * describes existed — an endpoint list written in Slice 5 would have been wrong
 * by Slice 8's allowlist, and a file-format instruction would have described a
 * parser that did not exist. Stability is the requirement the breakpoint imposes,
 * and the surest way to be stable is to say only what is already true.
 *
 * The cheat-sheet is one block rather than several, and it is last. That is what
 * keeps "the breakpoint is the last element of the stable prefix" a one-line
 * assertion, and it is the property `params.ts` depends on when it appends the
 * volatile project-state block *after* this array (D11).
 *
 * ## The `cache_control` breakpoint, which is real from here (D18)
 *
 * Slice 5 declared the breakpoint and recorded it as a **silent no-op**:
 * `claude-opus-5` caches nothing below a 512-token prefix, the two-block prompt
 * was far shorter, and nothing errors when a prefix is too short —
 * `cache_creation_input_tokens` and `cache_read_input_tokens` simply both read
 * `0`. That note was a promissory one, and this is the slice it comes due in.
 *
 * What changed: the cheat-sheet is roughly a thousand tokens of allowlist,
 * parameter notes and response shapes, so the prefix now clears the minimum, and
 * the breakpoint moved from the file-format block down onto it — a breakpoint in
 * the middle would cache a prefix shorter than the stable one, which is a subtler
 * bug than no breakpoint at all. `prompt.spec.ts` asserts the prefix estimates to
 * at least **1,024** tokens: twice the minimum, because `estimateTokens` is four
 * characters per token rather than the tokenizer, and a margin is what makes an
 * estimate safe to build on.
 *
 * The estimate is not the confirmation. The confirmation is
 * `cacheReadInputTokens > 0` on the second generation of a session, which the
 * `generation.complete` log line already carries and which the definition of done
 * checks by hand against real credentials — no automated test in this repo can
 * observe it.
 *
 * A constant, not a function: anything computed per call — a date, a project
 * name, an interpolated id — makes every request a cache miss now that caching is
 * real, and the only symptom is the bill. `prompt.spec.ts` asserts the absence
 * with a pattern rather than trusting this paragraph.
 */
export const SYSTEM_PROMPT: TextBlockParam[] = [
  {
    type: 'text',
    text: [
      'You are the code-generation engine inside Genesis, a builder for small',
      'web applications that run against a HighLevel CRM account. A user',
      'describes the app they want in a chat panel; you answer, and what you',
      'write becomes the application they see.',
      '',
      'The apps are small and single-purpose: a dashboard over their contacts, a',
      'view of upcoming appointments, a form that captures a lead. They are used',
      'by the account owner and their team, not by the public.',
      '',
      'How to answer:',
      '',
      '- Write for the person who asked. They know their business and may not',
      '  write code, so explain what you are building in plain language.',
      '- Be brief. A short paragraph beats a long one, and a list beats a',
      '  paragraph when the content is a list.',
      '- Say what you assumed when the request is ambiguous, rather than asking a',
      '  question and producing nothing.',
      '- If a request is outside what a small CRM app can do, say so plainly and',
      '  describe the closest thing you can build.',
      '- Never invent data. If a value has to come from the CRM, say that it will',
      '  be read from the account rather than making one up.',
    ].join('\n'),
  },
  {
    type: 'text',
    text: [
      'How to write the application:',
      '',
      'You write a small web application as plain HTML, CSS and JavaScript. There',
      'is no build step, no bundler and no framework — the files are handed to a',
      'browser exactly as you write them, so anything that would need compiling',
      'cannot run at all.',
      '',
      `The entry point is always \`index.html\`. It may reference the other files by`,
      'name.',
      '',
      'To write a file, put its opening tag on a line of its own, the file’s',
      'contents on the lines after it, and the closing tag on a line of its own:',
      '',
      `${OPEN_HEAD}index.html${OPEN_TAIL}`,
      '<!doctype html>',
      '<h1>Contacts</h1>',
      CLOSE_TAG,
      '',
      'Rules for these tags:',
      '',
      '- Each tag goes on its own line, with nothing else on that line.',
      '- Everything between the tags is the file, copied exactly as you write it.',
      '- Everything outside the tags is your reply to the person, and they read it',
      '  as ordinary prose. Do not repeat the code there.',
      '',
      'Rules for file names:',
      '',
      `- Names are flat. No directories, no slashes — \`assets/app.js\` is refused,`,
      '  and so is anything that is not stored as written.',
      '- Lowercase letters, digits, dots, dashes and underscores, starting with a',
      '  letter or a digit.',
      `- One of these extensions: ${FILE_EXTENSIONS.map((extension) => `.${extension}`).join(', ')}.`,
      '',
      'Limits:',
      '',
      `- At most ${String(FILE_LIMIT)} files in a project, counting the ones already there.`,
      `- At most ${String(FILE_BYTES_MAX / 1000)} KB per file.`,
      '',
      'Write every file the application needs in one reply: a reply is applied',
      'whole or not at all, so a set that breaks one of the rules above saves',
      'nothing. When a request calls for an explanation, a question answered or a',
      'limitation described, reply without any file at all — that is a complete',
      'answer, not a failure.',
    ].join('\n'),
  },
  {
    type: 'text',
    // Rendered from `HL_ROUTES` and `proxyError.ts` at module load, so the
    // allowlist has one source and this is a view of it (D2). Included whole
    // rather than assembled here: what it says is `hlKnowledge.ts`'s business,
    // and what this file decides is where it sits and what is pinned to it.
    text: HL_KNOWLEDGE,
    // The breakpoint, on the last element of the stable prefix — and from this
    // slice a real cache read rather than a declared one (D18).
    cache_control: { type: 'ephemeral' },
  },
]
