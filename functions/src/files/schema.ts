import { z } from 'zod'

import { projectsPath } from '../projects/schema'
import { firestoreTimestamp } from '../users/schema'

/**
 * `users/{uid}/projects/{projectId}/files/{fileId}` — a generated file, and the
 * boundaries around it.
 *
 * Written only by the Admin SDK, from `/generate`'s batch and from
 * `PUT …/files/:path`; `firestore.rules` denies the collection to every client.
 *
 * **The document id *is* the path.** Create-or-update per filename is then a
 * plain `set()` with no query and no chance of two documents claiming one name.
 * The path is stored as a field too, so `orderBy('path')` has something to order
 * by and `id === path` is asserted on parse rather than assumed.
 *
 * **The path is the ownership**: a file lives under its project, which lives
 * under its owner's uid, so there is no `ownerUid` field and no equality check.
 */

export const FILES = 'files'

/**
 * The most files one project may hold, and the most the list returns — the same
 * number on purpose, since an unpaginated list is only honest if it cannot
 * truncate.
 */
export const FILE_LIMIT = 20

/**
 * The most one file may hold, in UTF-8 bytes.
 *
 * An order of magnitude under Firestore's document limit for a file that is
 * realistically 5–40 KB. Enforced identically by the generator's validation and
 * by `PUT`, so no path exists to a document the reader cannot parse.
 */
export const FILE_BYTES_MAX = 100_000

/** A filename's total length, extension included. */
export const PATH_MAX = 64

/**
 * The extensions a generated file may carry.
 *
 * Allowlisted because a file the preview can never run is a file that lies to the
 * user: the `srcdoc` preview has no bundler, no server and no module resolution,
 * so this is the whole set of things a browser can be handed directly.
 */
export const FILE_EXTENSIONS = ['css', 'html', 'js', 'json', 'md'] as const

/** One place composes the path, so the four segments cannot drift. */
export function filesPath(uid: string, projectId: string): string {
  return `${projectsPath(uid)}/${projectId}/${FILES}`
}

/** The one message a refused filename carries. */
export const PATH_REFUSED = 'That is not a file name we can store.'

/**
 * A flat filename, and nothing else.
 *
 * Traversal is refused by **the shape of a name** rather than by a sanitiser that
 * has to be right about every encoding: `../secrets.js`, `/etc/passwd`,
 * `assets/app.js` and `.env` do not fail a traversal check, they simply fail to
 * be filenames. Three clauses: the character set and leading character, no `..`
 * anywhere, and exactly one allowlisted extension over a non-empty base.
 */
export const filePathSchema = z
  .string()
  .min(1, PATH_REFUSED)
  .max(PATH_MAX, PATH_REFUSED)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, PATH_REFUSED)
  .refine((path) => !path.includes('..'), PATH_REFUSED)
  .refine((path) => {
    const dot = path.lastIndexOf('.')
    // Unreachable given the leading-character rule; here so the clause reads as
    // "base plus extension" rather than depending on a rule two lines up.
    if (dot <= 0) return false
    const extension = path.slice(dot + 1)
    return (FILE_EXTENSIONS as readonly string[]).includes(extension)
  }, PATH_REFUSED)

/** What `displayPath` will not exceed, so a pathological path cannot fill a panel. */
const DISPLAY_MAX = 40

/**
 * A path, made safe to put in a sentence.
 *
 * These come straight from the model's output and have already been refused, so
 * they are hostile by construction: a newline would smuggle a second line into an
 * error notice, and a long one would blow up the panel.
 */
export function displayPath(path: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return path.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').slice(0, DISPLAY_MAX)
}

/** UTF-8 bytes, which is what both caps and Firestore's document limit count. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * One file operation as the splitter produced it — **syntax only**.
 *
 * Declared here and re-exported from `llm/fileops.ts`, which already reads
 * `PATH_MAX`: the other direction would be a cycle.
 */
export interface FileOp {
  path: string
  content: string
}

/**
 * One file, ready to be written. `size` is computed here rather than by the
 * writer, so the stored number is the one measured against the cap.
 */
export interface FileWrite {
  path: string
  content: string
  size: number
}

/**
 * Why a turn's files were not written — **a discriminated union, not a string**,
 * which is what makes the copy table exhaustive: a new way to refuse a set cannot
 * be added without a line to go with it. Three are raised outside this file.
 */
export type FileRejection =
  | { reason: 'path'; path: string }
  | { reason: 'duplicate'; path: string }
  | { reason: 'too-large'; path: string }
  | { reason: 'too-many' }
  | { reason: 'unterminated'; path: string }
  | { reason: 'incomplete' }
  | { reason: 'write-failed' }

/** The lead-in every set-level refusal shares, so the seven lines cannot drift. */
const REFUSED = 'Genesis could not save the generated files:'
const UNCHANGED = 'Nothing was changed.'

/**
 * The user-facing sentence for a refusal, and the only thing they are told.
 *
 * Every path goes through `displayPath` first — these come straight from the
 * model's output. The caps are interpolated from their constants, so raising one
 * cannot leave a sentence claiming the old number.
 */
export function fileErrorCopy(rejection: FileRejection): string {
  switch (rejection.reason) {
    case 'path':
      return `${REFUSED} "${displayPath(rejection.path)}" is not a file name we can store. ${UNCHANGED}`
    case 'duplicate':
      return `${REFUSED} "${displayPath(rejection.path)}" was written twice. ${UNCHANGED}`
    case 'too-large':
      return `${REFUSED} "${displayPath(rejection.path)}" is larger than ${String(FILE_BYTES_MAX / 1000)} KB. ${UNCHANGED}`
    case 'too-many':
      return `${REFUSED} a project can hold at most ${String(FILE_LIMIT)} files. ${UNCHANGED}`
    case 'unterminated':
      return `The reply ended in the middle of "${displayPath(rejection.path)}", so nothing was saved. Try again.`
    case 'incomplete':
      return 'The reply was cut short, so no files were saved. Try again.'
    case 'write-failed':
      return 'The generated files could not be saved. Try again.'
  }
}

export type ValidateFileOpsResult =
  { ok: true; writes: FileWrite[] } | { ok: false; error: FileRejection }

/**
 * The whole turn's ops, validated once, at one boundary.
 *
 * **All or nothing.** A generated app is a set of files that reference each
 * other, so writing two of three produces an app broken in a way the user cannot
 * see until the preview fails.
 *
 * The order is deterministic, so a refusal is reproducible from a fixture: per op,
 * path shape → duplicate → byte cap; then the union with what the project already
 * holds against `FILE_LIMIT`. Path first, because the other two messages name it.
 *
 * `existingPaths` is read immediately before the write and is not transactional:
 * two simultaneous generations at the cap can both land.
 */
export function validateFileOps(
  ops: readonly FileOp[],
  existingPaths: readonly string[],
): ValidateFileOpsResult {
  const writes: FileWrite[] = []
  const seen = new Set<string>()

  for (const op of ops) {
    if (!filePathSchema.safeParse(op.path).success) {
      return { ok: false, error: { reason: 'path', path: op.path } }
    }
    if (seen.has(op.path)) {
      return { ok: false, error: { reason: 'duplicate', path: op.path } }
    }

    const size = byteLength(op.content)
    if (size > FILE_BYTES_MAX) {
      return { ok: false, error: { reason: 'too-large', path: op.path } }
    }

    seen.add(op.path)
    writes.push({ path: op.path, content: op.content, size })
  }

  // The **union**, not the count of ops: a turn that rewrites five existing files
  // adds nothing to the project's total.
  const union = new Set([...existingPaths, ...seen])
  if (union.size > FILE_LIMIT) {
    return { ok: false, error: { reason: 'too-many' } }
  }

  return { ok: true, writes }
}

/** What `PUT`'s refusal says when the body is over the cap. */
const BODY_TOO_LARGE = `That file is larger than ${String(FILE_BYTES_MAX / 1000)} KB.`

/**
 * `PUT`'s body — `content`, and nothing else.
 *
 * `.strict()` is load-bearing: `path` comes from the URL, and `size` and the
 * timestamps are the server's to write. The cap is checked in **bytes**, in a
 * `superRefine` rather than `.max()`, which counts UTF-16 code units and would let
 * 60,000 three-byte characters through at 180,000 bytes.
 */
export const putFileBodySchema = z
  .object({ content: z.string() })
  .strict()
  .superRefine((body, ctx) => {
    if (byteLength(body.content) > FILE_BYTES_MAX) {
      ctx.addIssue({ code: 'custom', message: BODY_TOO_LARGE, path: ['content'] })
    }
  })

export type PutFileBody = z.infer<typeof putFileBodySchema>

/**
 * The stored document, **parsed rather than asserted** — and nothing carries a
 * `.catch`: a document missing any of these cannot be shown, so it is omitted from
 * the list, 404 by id, and logged once.
 *
 * **`content` carries no maximum**, where the body schema has one. Both writers
 * enforce the cap, and refusing to read an oversized document would lose the
 * user's file rather than protect anything.
 */
export const storedFileSchema = z.object({
  path: filePathSchema,
  content: z.string(),
  size: z.number().int().min(0),
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
})

export type StoredFile = z.infer<typeof storedFileSchema>

/**
 * The same document as the list reads it — a projection with **no `content`**.
 *
 * Its own schema rather than an `.omit(...)`, because the omission is the point:
 * a schema that could parse a `content` would let one arrive.
 */
export const storedFileMetaSchema = storedFileSchema.omit({ content: true }).strict()

export type StoredFileMeta = z.infer<typeof storedFileMetaSchema>

/**
 * The wire shapes. Timestamps are ISO-8601 strings.
 *
 * **There is no `id` field**, because the id *is* the path — carrying both would
 * be two names for one thing and one more pair that can disagree.
 */
export interface FileMeta {
  path: string
  size: number
  createdAt: string
  updatedAt: string
}

export interface FileContent extends FileMeta {
  content: string
}

export function toFileMeta(stored: StoredFileMeta): FileMeta {
  return {
    path: stored.path,
    size: stored.size,
    createdAt: stored.createdAt.toDate().toISOString(),
    updatedAt: stored.updatedAt.toDate().toISOString(),
  }
}

export function toFile(stored: StoredFile): FileContent {
  return { ...toFileMeta(stored), content: stored.content }
}
