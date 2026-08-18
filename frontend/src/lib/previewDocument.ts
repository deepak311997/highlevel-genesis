import { buildShim } from './previewShim'
import type { PreviewAsset } from './previewShim'

/**
 * One project's stored files, assembled into a single self-contained document.
 *
 * **Why assembly is needed at all.** Relative URLs in a `srcdoc` document
 * resolve against the *parent's* base URL, so `styles.css` would be fetched
 * from the SPA's own origin and answered by the Hosting rewrite's `index.html`
 * fallback — a stylesheet that is silently HTML. Nothing serves a project's
 * files as static assets: they live in Firestore behind an authenticated route
 * that a frame with an opaque origin cannot call. A `<base>` tag has no URL to
 * point at, and a `blob:` URL belongs to the origin that created it, which an
 * opaque origin may not fetch from (D6). So every reference the project holds
 * is resolved here, at assembly time, and travels inside the document as data.
 *
 * **What is injected, and in what order.** The document opens with exactly two
 * elements this module wrote — the CSP `<meta>`, then the one shim `<script>` —
 * spliced in at the first anchor `insertionPoint` finds, which is `<head>` when
 * the model wrote one and `<html>` or the doctype when it did not. Everything
 * the model generated follows. That order is the reading of AC-1 and
 * AC-7 that satisfies both — a CSP meta governs only what comes after it, and
 * the shim has to precede everything generated so `hl()` exists before the
 * first line of the app runs.
 *
 * **The charset that is no longer in the first 1024 bytes.** The shim is around
 * 2.5 KB, so a generated `<meta charset>` lands well past the window an HTML
 * parser scans for an encoding declaration. That costs nothing here: a `srcdoc`
 * document decodes no bytes off a network — it takes its character encoding
 * from the container document, which the SPA serves as UTF-8 — so the
 * declaration is inert whether or not the parser ever reaches it. Which is why
 * both injections are safe to put first.
 */

/** A file as the preview reads it: the stored flat path and its content. */
export interface PreviewFile {
  path: string
  content: string
}

/**
 * A discriminated union rather than `{ html?: string; reason?: string }`.
 *
 * A failed assembly has no document at all — AC-8 is that we refuse rather than
 * guess an entry point — and the union is what stops a caller reading `html`
 * off a failure and rendering the empty string into an iframe.
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
 * connection, so `connect-src` has nothing legitimate left to allow. Blocking it
 * turns "the generated app made its own request" from an invisible event into a
 * named one, because the shim listens for `securitypolicyviolation` and reports
 * it through the same error channel as an uncaught throw. `script-src`,
 * `img-src` and `style-src` stay open so a generated page that references a CDN
 * or an image still works; `default-src 'none'` was rejected for breaking those
 * silently, against a threat the sandbox already contains.
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
 * The offset the injected elements are spliced in at.
 *
 * After `<head>` when there is one, else after `<html>`, else after the doctype
 * — a generated fragment with neither wrapper still has to keep its declaration
 * first, since a doctype preceded by anything is ignored and the document is
 * parsed in quirks mode.
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
 * **A regex rather than `DOMParser`.** A parser normalises the markup it is
 * handed — it reorders attributes, requotes them, closes what the model left
 * open — so a document round-tripped through one would no longer be the bytes
 * the model wrote, which is precisely what AC-5 asserts about a reference we
 * leave alone. It would also put a second HTML parser between the model's
 * output and the browser's, so what we test and what the frame renders would be
 * two different documents. These patterns match a *tag* and nothing else, so
 * every byte outside a rewritten tag is copied through untouched.
 *
 * `LINK` and `SCRIPT` are composed into a single alternation because the assets
 * have to be numbered in **document order** (AC-3): two passes would number
 * every stylesheet ahead of every script, whatever the source said.
 */
const LINK = /<link\b[^>]*>/gi
const SCRIPT = /<script\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>\s*<\/script\s*>/gi
const REFERENCE = new RegExp(`${LINK.source}|${SCRIPT.source}`, 'gi')

/** One attribute of one tag, quoted however the model felt like quoting it. */
const ATTR = (name: string): RegExp =>
  new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i')

/**
 * The stored path grammar, mirrored from `functions/src/files/schema.ts`.
 *
 * This is what makes "a bare filename" precise. Stored paths are flat and
 * lowercase with no slash, so a reference is a candidate for rewriting **iff**
 * it matches this after at most one leading `./` is stripped. `https://…`,
 * `//…`, `/foo.js`, `a/b.js`, `x.js?v=1` and `#top` all fail it and are left
 * exactly as written — the frame may well be able to load them, and guessing
 * otherwise would break a page that works.
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
 * Pure, and deliberately so — the nonce is a parameter rather than something
 * generated here, so a build is reproducible and the store stays the one place
 * that decides when a new document identity begins. `warnings` is what the
 * panel shows the user (AC-36): every reference we could neither resolve nor
 * safely leave alone gets named, so a stylesheet that quietly did not load is a
 * sentence on screen rather than an unstyled page.
 */
export function assemblePreview(files: readonly PreviewFile[], nonce: string): AssemblyResult {
  const entry = files.find((file) => file.path === ENTRY_POINT)
  if (entry === undefined) return { ok: false, reason: 'no_entry_point' }

  const stored = new Map(files.map((file) => [file.path, file.content]))
  const assets: PreviewAsset[] = []
  /*
   * A `Set`, because the same missing file can be referenced more than once and
   * the panel renders these in a `v-for` keyed on the sentence — a repeat is a
   * duplicate key as well as the same complaint twice.
   */
  const warnings = new Set<string>()

  /**
   * The absolute / bare / missing decision, in exactly one place.
   *
   * Both scanners route through here, so `<link>` and `<script>` cannot drift
   * apart on what counts as a local file. A `null` url — an attribute the tag
   * does not carry — is a tag we have nothing to say about, so it is kept.
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
      // AC-6: dropped rather than left in, because leaving it in means the
      // frame fetches the SPA's index.html and applies HTML as a stylesheet.
      // The panel shows this sentence, so it names the file and the effect.
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
