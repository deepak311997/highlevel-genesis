import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages'

import { PROJECT_FILE_BUDGET } from './budget'

/**
 * The project's own files, as one `system` block the model reads before it writes.
 *
 * Without it the second prompt in a project cannot modify what the first one
 * wrote: the model is shown a transcript describing files it cannot see, so it
 * writes them again from the description. This block is what makes "add a search
 * box" an edit rather than a rewrite.
 *
 * **Appended after the `cache_control` breakpoint**, carrying none of its own.
 * Volatile content above the last breakpoint invalidates the whole cached prefix,
 * so a block one element earlier would turn every generation into a cache write,
 * with the bill as the only symptom.
 *
 * **Whole files or no file**, which is the module's single most important
 * property. Handed half a file the model completes it from imagination and writes
 * the whole thing back — a file the user never mentioned silently replaced by a
 * plausible reconstruction, with no error anywhere. A skipped file is still
 * *named* in the manifest, because a model that cannot see `app.js` concludes
 * there is no `app.js` and creates a second one under another name. The loop
 * continues past a file that does not fit, so one oversized file does not starve
 * the smaller ones behind it.
 *
 * **Contents are not sanitised.** They are the user's own, so the residual
 * exposure is self-injection against controls that sit downstream anyway — and
 * sanitising would corrupt the very code the model is being asked to change. The
 * delimiters are emphatically not `fileops.ts`'s `<genesis:file>` pair: a file
 * whose own text contains that closing tag must not read as a worked example of
 * how to close a block the model is about to write.
 */

/**
 * The two fields the block needs, and deliberately not `size` — a stored number
 * can disagree with the content it describes, so every length here is measured
 * from `content` at render time.
 */
export interface ProjectFile {
  path: string
  content: string
}

/**
 * The start of a file's opening line, which renders as
 * `===== FILE app.js (1234 characters) =====`. Exported because the emulator fake
 * recovers the paths it was shown by scanning for it, so the two cannot drift.
 */
export const PROJECT_FILE_OPEN = '===== FILE '

/** The whole of a file's closing line. */
export const PROJECT_FILE_CLOSE = '===== END FILE ====='

/** The entry point — the one file whose absence changes what the app is. */
const ENTRY_POINT = 'index.html'

/**
 * Reading order: `index.html`, then ascending size, ties broken by path.
 *
 * The entry point first, because a budget that dropped it would leave the model
 * editing an application it cannot see the shape of. Ascending size because it
 * maximises the number of *complete* files that fit. Path as the tie-break,
 * because otherwise two equal-sized files order however the query returned them
 * and an unchanged project renders differently between requests — a cache miss
 * for no reason.
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
 * `null` when the project holds no files.
 *
 * `null` rather than an empty block, so a project with no files sends the stable
 * prefix array itself — an empty block would be a second shape of request and a
 * cache write for content saying nothing.
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
