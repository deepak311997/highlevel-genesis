import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages'

import { PROJECT_FILE_BUDGET } from './budget'

/**
 * The project's own files, as one `system` block the model reads before it
 * writes (D11, D14, D24).
 *
 * Without this the second prompt in a project cannot modify what the first one
 * wrote: the model is shown a transcript describing files it cannot see, so it
 * writes them again from the description. This block is what makes "add a search
 * box" an edit rather than a rewrite.
 *
 * ## Where it goes, and why not somewhere else
 *
 * It is appended **after** the `cache_control` breakpoint, by `params.ts`, and
 * carries no breakpoint of its own. Volatile content above the last breakpoint
 * invalidates the whole cached prefix — render order is `tools` → `system` →
 * `messages`, and a change anywhere in the prefix invalidates everything after
 * it — so a project-state block one element earlier would turn every generation
 * into a cache write, with the bill as the only symptom.
 *
 * Rejected: a synthetic leading `user` message carrying the same text. It
 * invents a turn in a transcript whose whole value is being a true record — the
 * same reasoning that made Slice 5 D6 drop trailing assistant turns rather than
 * append a "continue". Rejected too: a `{ role: 'system' }` message inside
 * `messages[]`, which `claude-opus-5` supports but which buys nothing here (the
 * transcript is not cached either way) and which the SDK's `MessageParam` role
 * union would force a cast for.
 *
 * ## Whole files or no file (D14, R2)
 *
 * This module never truncates, and that is its single most important property.
 * Handed half a file the model completes it from imagination and writes the
 * whole thing back, so a file the user never mentioned is silently replaced by a
 * plausible reconstruction — a data-loss bug with no error anywhere and no way
 * for the user to know it happened. Files are therefore taken whole while the
 * budget allows and skipped entirely when it does not, and a skipped file is
 * still **named** in the manifest line: a model that cannot see `app.js` at all
 * concludes there is no `app.js` and creates a second one under another name.
 *
 * The loop *continues* past a file that does not fit rather than stopping, so
 * one oversized file does not starve the smaller ones behind it. With ascending
 * order only `index.html` — pinned first whatever it weighs — can be that file,
 * which is precisely a project whose entry point grew.
 *
 * ## Contents are not sanitised (D24)
 *
 * They are the user's own: files reach Firestore only through this user's
 * generations and this user's `PUT` (Slice 6), so there is no cross-tenant path,
 * and the residual prompt-injection exposure is self-injection against controls
 * that sit downstream anyway — the op set is validated and refused whole, and
 * the proxy allowlist decides what generated code can reach regardless of what
 * it was told. Sanitising would corrupt the very code the model is being asked
 * to change, which is the whole point of sending it.
 *
 * What the delimiters do instead is separate, and is why they are emphatically
 * **not** `fileops.ts`'s `<genesis:file>` pair: a file whose own text contains
 * `</genesis:file>` on a line must not read to the model as a worked example of
 * how to close a block it is about to write.
 */

/**
 * The two fields the block needs, and deliberately not a third.
 *
 * `StoredFile` also carries `size`, which is a *stored* number and can disagree
 * with the content it describes. Every length here is measured from `content` at
 * render time, so the block cannot quote a size the budget did not measure.
 */
export interface ProjectFile {
  path: string
  content: string
}

/**
 * The start of a file's opening line, which renders in full as
 * `===== FILE app.js (1234 characters) =====`.
 *
 * Exported because two other things read it: the emulator fake recovers the
 * paths it was shown by scanning for this prefix (D25), so the fake and the
 * builder cannot drift apart.
 */
export const PROJECT_FILE_OPEN = '===== FILE '

/** The whole of a file's closing line. */
export const PROJECT_FILE_CLOSE = '===== END FILE ====='

/** The entry point (Slice 6 D1) — the one file whose absence changes what the app is. */
const ENTRY_POINT = 'index.html'

/**
 * Reading order: `index.html`, then ascending size, ties broken by path.
 *
 * Three rules, one per clause, and each is a decision. `index.html` first
 * because a budget that dropped the entry point would leave the model editing an
 * application it cannot see the shape of. Ascending size because it maximises
 * the number of *complete* files that fit, and complete is the only form a file
 * comes in here. Path as the tie-break because without it two equal-sized files
 * order however the caller's query happened to return them, and the block for an
 * unchanged project would differ between requests — a cache miss's worth of
 * difference for no reason at all.
 */
function orderForReading(files: readonly ProjectFile[]): ProjectFile[] {
  return [...files].sort((left, right) => {
    if (left.path === ENTRY_POINT) return right.path === ENTRY_POINT ? 0 : -1
    if (right.path === ENTRY_POINT) return 1
    return left.content.length - right.content.length || left.path.localeCompare(right.path)
  })
}

const openLine = (file: ProjectFile): string =>
  `${PROJECT_FILE_OPEN}${file.path} (${String(file.content.length)} characters) =====`

const manifestLine = (file: ProjectFile): string =>
  `- ${file.path} (${String(file.content.length)} characters)`

/**
 * One `system` block holding as much of the project as the budget allows, or
 * `null` when the project holds no files at all.
 *
 * `null` rather than an empty block, because it is what lets `params.ts` send
 * the `SYSTEM_PROMPT` array *itself* for a project with no files (AC-13) — an
 * empty block would be a second, pointless shape of request and a cache write
 * for content saying nothing.
 *
 * Pure: the argument is copied before it is ordered, so a caller that goes on to
 * use its own list gets the list it passed.
 */
export function buildProjectState(files: readonly ProjectFile[]): TextBlockParam | null {
  if (files.length === 0) return null

  const included: ProjectFile[] = []
  const omitted: ProjectFile[] = []
  let spent = 0

  for (const file of orderForReading(files)) {
    if (spent + file.content.length <= PROJECT_FILE_BUDGET) {
      included.push(file)
      spent += file.content.length
    } else {
      omitted.push(file)
    }
  }

  const lines = [
    'This is the application as it stands in the project right now. It is the',
    'current content of these files, not a description of them.',
    '',
    'Reply with only the files you are changing or adding. A file you do not',
    'intend to change should not be rewritten — leaving it out leaves it exactly',
    'as it is below.',
    '',
  ]

  for (const file of included) {
    lines.push(openLine(file), file.content, PROJECT_FILE_CLOSE, '')
  }

  if (omitted.length > 0) {
    lines.push(
      'These files are also part of the project. They were not included above,',
      'because the content above already fills the space available for it. They',
      'exist, they have not been deleted, and you should not create replacements',
      'for them:',
      '',
      ...omitted.map(manifestLine),
    )
  }

  return { type: 'text', text: lines.join('\n') }
}
