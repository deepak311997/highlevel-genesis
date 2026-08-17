/**
 * Which monaco tokenizer colours a file (D25).
 *
 * Pure and on its own, because the failure it guards against is invisible: an
 * unmapped extension renders as plaintext, and a file with no colours looks like
 * a file that has no colours rather than like a bug. Its spec pins this map to
 * the server's `FILE_EXTENSIONS` allowlist, so adding an extension there without
 * deciding what colours it here fails a test.
 *
 * The four language ids below are exactly the four `basic-languages`
 * contributions `monacoSetup.ts` imports. Nothing else is registered, so anything
 * else here would name a tokenizer monaco does not have and render grey anyway.
 */

/** What an unknown — or unregistered — extension gets. */
export const PLAINTEXT = 'plaintext'

/**
 * Extension → monaco language id.
 *
 * **`json` is absent on purpose** (D4). monaco ships no `basic-languages/json`:
 * JSON's tokenizer lives only inside the worker-backed language service, and that
 * service is the one thing D3 refuses, because it is what puts red squiggles on
 * LLM-generated code. `.json` is allowlisted by the server but is not a file a
 * generated CRM mini-app leans on, so it renders as plaintext and that cost is
 * recorded rather than discovered later.
 */
export const EDITOR_LANGUAGES = {
  html: 'html',
  css: 'css',
  js: 'javascript',
  md: 'markdown',
  json: PLAINTEXT,
} as const satisfies Record<string, string>

/**
 * The language id for a path, by its last extension.
 *
 * Lower-cased because case is not part of an extension, and read through a
 * bracket with a `??` — which `noUncheckedIndexedAccess` requires anyway, and
 * which is the same expression that makes the miss land on plaintext.
 */
export function editorLanguage(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return PLAINTEXT

  const extension = path.slice(dot + 1).toLowerCase()
  return (EDITOR_LANGUAGES as Record<string, string>)[extension] ?? PLAINTEXT
}
