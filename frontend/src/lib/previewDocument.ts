import { buildShim } from './previewShim'
import type { PreviewAsset } from './previewShim'

/**
 * One project's stored files, assembled into a single self-contained document.
 *
 * **Why assembly is needed at all.** Relative URLs in a `srcdoc` document resolve
 * against the *parent's* base URL, so `styles.css` would be fetched from the SPA's
 * origin and answered by the Hosting rewrite's `index.html` fallback — a
 * stylesheet that is silently HTML. Nothing serves a project's files as static
 * assets: they live in Firestore behind an authenticated route a frame with an
 * opaque origin cannot call, a `<base>` tag has no URL to point at, and a `blob:`
 * URL belongs to the origin that created it. So every reference is resolved here
 * and travels inside the document as data.
 *
 * **What is injected, and in what order.** The document opens with the CSP
 * `<meta>` then the one shim `<script>`, spliced in at the first anchor
 * `insertionPoint` finds. A CSP meta governs only what comes after it, and the
 * shim has to precede everything generated so `hl()` exists before the app's first
 * line runs.
 *
 * A generated `<meta charset>` then lands past the 1024 bytes a parser scans for
 * an encoding declaration, which costs nothing: a `srcdoc` document decodes no
 * bytes off a network and takes its encoding from the container.
 */

/** A file as the preview reads it: the stored flat path and its content. */
export interface PreviewFile {
  path: string
  content: string
}

/**
 * A discriminated union rather than `{ html?: string; reason?: string }`. A failed
 * assembly has no document at all, and the union is what stops a caller reading
 * `html` off a failure and rendering the empty string into an iframe.
 */
export type AssemblyResult =
  { ok: true; html: string; warnings: string[] } | { ok: false; reason: 'no_entry_point' }

/** The one file a project must have for there to be anything to preview. */
const ENTRY_POINT = 'index.html'

/** AC-7's literal, with exactly one home. */
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`

/**
 * Why `connect-src 'none'` and only that directive.
 *
 * The preview's one network verb is `hl()`, which is a `postMessage` and not a
 * connection, so `connect-src` has nothing legitimate left to allow — and blocking
 * it turns "the generated app made its own request" into a named event, because
 * the shim listens for `securitypolicyviolation`. `script-src`, `img-src` and
 * `style-src` stay open so a page referencing a CDN still works.
 */
function injection(nonce: string, assets: readonly PreviewAsset[]): string {
  return `${CSP_META}\n<script>\n${buildShim(nonce, assets)}</script>\n`
}

/** The doctype prepended to a source that does not declare one. */
const DOCTYPE = '<!doctype html>\n'

/** Where the injection goes, best anchor first. */
const HEAD_OPEN = /<head\b[^>]*>/i
const HTML_OPEN = /<html\b[^>]*>/i
const DOCTYPE_DECL = /^\s*<!doctype[^>]*>/i

/**
 * The offset the injected elements are spliced in at: after `<head>` when there is
 * one, else after `<html>`, else after the doctype — a fragment with neither
 * wrapper still has to keep its declaration first, since a doctype preceded by
 * anything is ignored and the document is parsed in quirks mode.
 */
function insertionPoint(source: string): number {
  for (const anchor of [HEAD_OPEN, HTML_OPEN, DOCTYPE_DECL]) {
    const match = anchor.exec(source)
    if (match !== null) return match.index + match[0].length
  }
  return 0
}

/**
 * The two references worth rewriting, and how a candidate is recognised.
 *
 * **A regex rather than `DOMParser`.** A parser normalises the markup it is handed
 * — reordering attributes, requoting, closing what the model left open — so a
 * round-tripped document would no longer be the bytes the model wrote, and there
 * would be a second HTML parser between its output and the browser's. These
 * patterns match a *tag* and nothing else.
 *
 * `LINK` and `SCRIPT` are one alternation because the assets have to be numbered
 * in **document order**: two passes would number every stylesheet ahead of every
 * script, whatever the source said.
 */
const LINK = /<link\b[^>]*>/gi
const SCRIPT = /<script\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>\s*<\/script\s*>/gi
const REFERENCE = new RegExp(`${LINK.source}|${SCRIPT.source}`, 'gi')

/** One attribute of one tag, quoted however the model felt like quoting it. */
const ATTR = (name: string): RegExp =>
  new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i')

/**
 * The stored path grammar, mirrored from the server's schema — what makes "a bare
 * filename" precise. A reference is a candidate for rewriting **iff** it matches
 * this after at most one leading `./` is stripped, so `https://…`, `/foo.js`,
 * `a/b.js` and `x.js?v=1` are left exactly as written: the frame may well be able
 * to load them, and guessing otherwise would break a page that works.
 */
const BARE = /^[a-z0-9][a-z0-9._-]*$/

/** An attribute's value, unquoted, or `null` when the tag does not carry it. */
function attribute(tag: string, name: string): string | null {
  const raw = ATTR(name).exec(tag)?.[1]
  if (raw === undefined) return null
  return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw
}

/** Only `rel="stylesheet"` is a reference to a file; `icon`, `preconnect` and the rest are not. */
function isStylesheet(tag: string): boolean {
  return attribute(tag, 'rel')?.toLowerCase().includes('stylesheet') === true
}

/** What a rewritten reference leaves behind: a call, carrying no content of its own. */
function loaderCall(index: number): string {
  return `<script>window.__genesisAsset(${String(index)})</script>`
}

/**
 * One build: the project's files in, one `srcdoc` string out.
 *
 * Pure, and deliberately so — the nonce is a parameter rather than generated here,
 * so a build is reproducible and the store stays the one place that decides when a
 * new document identity begins. `warnings` names every reference we could neither
 * resolve nor safely leave alone, so a stylesheet that quietly did not load is a
 * sentence on screen rather than an unstyled page.
 */
export function assemblePreview(files: readonly PreviewFile[], nonce: string): AssemblyResult {
  const entry = files.find((file) => file.path === ENTRY_POINT)
  if (entry === undefined) return { ok: false, reason: 'no_entry_point' }

  const stored = new Map(files.map((file) => [file.path, file.content]))
  const assets: PreviewAsset[] = []
  /*
   * A `Set`, because the same missing file can be referenced more than once and the
   * panel renders these keyed on the sentence.
   */
  const warnings = new Set<string>()

  /**
   * The absolute / bare / missing decision, in exactly one place, so `<link>` and
   * `<script>` cannot drift apart on what counts as a local file. A `null` url is a
   * tag we have nothing to say about, so it is kept.
   */
  const rewriteReference = (
    tag: string,
    url: string | null,
    kind: PreviewAsset['kind'],
  ): string => {
    if (url === null) return tag

    const name = url.startsWith('./') ? url.slice(2) : url
    if (!BARE.test(name)) return tag

    const content = stored.get(name)
    if (content === undefined) {
      // Dropped rather than left in, because leaving it means the frame fetches the
      // SPA's index.html and applies HTML as a stylesheet.
      warnings.add(
        `${name} is referenced by index.html but is not one of this project's files, so it was left out.`,
      )
      return ''
    }

    assets.push({ kind, content })
    return loaderCall(assets.length - 1)
  }

  const rewritten = entry.content.replace(REFERENCE, (tag) =>
    /^<link/i.test(tag)
      ? rewriteReference(tag, isStylesheet(tag) ? attribute(tag, 'href') : null, 'css')
      : rewriteReference(tag, attribute(tag, 'src'), 'js'),
  )

  const source = DOCTYPE_DECL.test(rewritten) ? rewritten : DOCTYPE + rewritten
  const at = insertionPoint(source)
  const html = source.slice(0, at) + injection(nonce, assets) + source.slice(at)

  return { ok: true, html, warnings: [...warnings] }
}
