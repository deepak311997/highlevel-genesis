import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages'

/**
 * The system prompt — the stable prefix, and today the whole of it (D17).
 *
 * ## What is here, and what deliberately is not
 *
 * What Genesis is, that it builds small web apps over a HighLevel CRM, and the
 * response-style constraints. **No HighLevel endpoints and no file-format
 * instructions**: an endpoint list written now would be wrong by Slice 9, which
 * owns the cheat-sheet, and a file-format instruction would describe a parser
 * that does not exist until Slice 6. Stability is the requirement the breakpoint
 * imposes, and the surest way to be stable is to say only what is already true.
 *
 * ## The `cache_control` breakpoint is declared, and is a no-op until Slice 9
 *
 * `CLAUDE.md` requires the cheat-sheet pinned behind a breakpoint. This slice
 * owes the *structure*: a stable prefix, a breakpoint at its end, and nothing
 * volatile above it.
 *
 * The honest note, so a reviewer does not read it as a bug (D16):
 * `claude-opus-5`'s minimum cacheable prefix is **512 tokens**, and this prompt
 * is far shorter — so `cache_creation_input_tokens` will be `0`,
 * `cache_read_input_tokens` will be `0`, and **no error will say so**. That is a
 * silent no-op, not a failure. It becomes a real cache read in Slice 9, when the
 * cheat-sheet is added above this block and the prefix crosses the minimum.
 *
 * A constant, not a function: anything computed per call — a date, a project
 * name, an interpolated id — would make every request a cache miss once caching
 * is real, and the only symptom would be the bill. `prompt.spec.ts` asserts the
 * absence with a pattern rather than trusting this paragraph.
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
    // The breakpoint. Slice 9 adds the HighLevel cheat-sheet *above* this block;
    // it stays the last element of the stable prefix.
    cache_control: { type: 'ephemeral' },
  },
]
