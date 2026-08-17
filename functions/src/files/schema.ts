import { z } from 'zod'

import { projectsPath } from '../projects/schema'

/**
 * `users/{uid}/projects/{projectId}/files/{fileId}` — a generated file, and the
 * boundaries around it.
 *
 * The documents are written only by the Admin SDK, from two places: `/generate`'s
 * one batch per turn, and `PUT /api/projects/:projectId/files/:path`.
 * `firestore.rules` denies the collection to every client, owner included.
 *
 * **The document id *is* the path** (D13). Create-or-update per filename is then a
 * plain `set()` with no query and no chance of two documents claiming one name,
 * which is what a generation rewriting the same three files every turn actually
 * needs. The path is stored as a field too, so the collection is legible in a
 * console and `orderBy('path')` has something to order by — and `id === path` is
 * an invariant asserted on parse rather than assumed.
 *
 * **The path is the ownership.** A file lives under its project, which lives under
 * its owner's uid — the one `withVerifiedUser` read off the ID token — so there is
 * no `ownerUid` field here and no equality check anywhere.
 */

export const FILES = 'files'

/**
 * The most files one project may hold, and the most the list returns.
 *
 * The two are the same number on purpose, which is `MESSAGE_LIMIT` /
 * `PROJECT_LIMIT`'s rule: an unpaginated list is only honest if it cannot
 * truncate. Twenty is several times what a single-purpose CRM mini-app needs and
 * keeps the batch, the tree and Slice 11's snapshot all trivially bounded.
 */
export const FILE_LIMIT = 20

/**
 * The most one file may hold, in UTF-8 bytes (D15).
 *
 * An order of magnitude of headroom under Firestore's 1,048,576-byte document
 * limit for a file that is realistically 5–40 KB. Enforced identically by the
 * generator's validation and by `PUT`, so no path exists to a document the reader
 * cannot parse.
 */
export const FILE_BYTES_MAX = 100_000

/** A filename's total length, extension included. */
export const PATH_MAX = 64

/**
 * The extensions a generated file may carry, sorted.
 *
 * Allowlisted because a file the preview can never run is a file that lies to the
 * user: no `.ts`, no `.vue`, no `.php`. Slice 10's `srcdoc` preview has no
 * bundler, no server and no module resolution, so this is the whole set of things
 * a browser can be handed directly.
 */
export const FILE_EXTENSIONS = ['css', 'html', 'js', 'json', 'md'] as const

export type FileExtension = (typeof FILE_EXTENSIONS)[number]

/**
 * One place composes the path, from `projectsPath` rather than a second `'users'`
 * literal, so the four segments cannot drift.
 */
export function filesPath(uid: string, projectId: string): string {
  return `${projectsPath(uid)}/${projectId}/${FILES}`
}

/**
 * The one message a refused filename carries.
 *
 * Exported so the copy table has a single home: `fileErrorCopy()` names the path
 * and this names the rule, and neither restates the other.
 */
export const PATH_REFUSED = 'That is not a file name we can store.'

/**
 * A flat filename, and nothing else (D12, AC-11).
 *
 * Traversal is refused by **the shape of a name** rather than by a sanitiser that
 * has to be right about every encoding. `../secrets.js`, `/etc/passwd`,
 * `assets/app.js`, `..` and `.env` do not fail a traversal check — they simply
 * fail to be filenames, because the first character must be a letter or a digit
 * and no character may be a slash.
 *
 * Three clauses, in the order a reader needs them:
 *
 * 1. the character set and the leading character, which is what excludes `/`,
 *    `\`, whitespace, control characters, uppercase and dotfiles;
 * 2. no `..` anywhere, which is belt and braces given (1) but is the clause a
 *    reader looks for and would otherwise have to derive;
 * 3. exactly one allowlisted extension, over a non-empty base.
 */
export const filePathSchema = z
  .string()
  .min(1, PATH_REFUSED)
  .max(PATH_MAX, PATH_REFUSED)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, PATH_REFUSED)
  .refine((path) => !path.includes('..'), PATH_REFUSED)
  .refine((path) => {
    const dot = path.lastIndexOf('.')
    // A base of zero length is unreachable given the leading-character rule; the
    // check is here so the clause reads as "base plus extension" rather than
    // depending on a rule two lines up.
    if (dot <= 0) return false
    const extension = path.slice(dot + 1)
    return (FILE_EXTENSIONS as readonly string[]).includes(extension)
  }, PATH_REFUSED)

/** What `displayPath` will not exceed, so a pathological path cannot fill a panel. */
const DISPLAY_MAX = 40

/**
 * A path, made safe to put in a sentence.
 *
 * The paths that reach the copy table come **straight from the model's output**
 * and have already been refused, so they are hostile strings by construction: a
 * newline would smuggle a second line into an error notice and an arbitrarily
 * long one would blow up the panel. Control characters go, and what is left is
 * truncated.
 */
export function displayPath(path: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return path.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').slice(0, DISPLAY_MAX)
}
