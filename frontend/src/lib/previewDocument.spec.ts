import { describe, expect, it } from 'vitest'

import type { PreviewAsset } from './previewShim'
import { assemblePreview } from './previewDocument'
import type { PreviewFile } from './previewDocument'

/**
 * The assembled preview document (AC-1 … AC-8).
 *
 * Everything here is a **string** property of the document, never a behaviour of it. jsdom in
 * this repo does not execute a script inserted into a document, so the loader calls the
 * assembler emits cannot be run at this level; that they really install the file they name is
 * proven at L5, in a real browser. What is provable here is the whole of the contract that
 * matters to the browser: what is injected, in what order, what is rewritten, what is left byte-
 * identical, and that no file's content ever reaches the markup.
 */

/**
 * The CSP meta AC-7 names, written out here rather than imported.
 *
 * The literal is the acceptance criterion; importing the module's own constant
 * would let the two drift together and still pass.
 */
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`

/** The entry point, which every case needs and only its content varies. */
function index(content: string): PreviewFile {
  return { path: 'index.html', content }
}

/**
 * `assemblePreview` narrowed to its success branch.
 *
 * A failed assembly carries no `html` at all — that is the point of the union — so a test that
 * means to read the document says so once, here, rather than casting at every call site.
 */
function assemble(
  files: readonly PreviewFile[],
  nonce = 'n1',
): { html: string; warnings: string[] } {
  const result = assemblePreview(files, nonce)
  if (!result.ok) throw new Error(`expected an assembled document, got ${result.reason}`)
  return { html: result.html, warnings: result.warnings }
}

/** Where the document's first `<script` opens, and the source it carries. */
function firstScript(html: string): { at: number; source: string } {
  const at = html.indexOf('<script')
  const opens = html.indexOf('>', at) + 1
  return { at, source: html.slice(opens, html.indexOf('</script', opens)) }
}

describe('assemblePreview — the entry point', () => {
  it('reports no entry point when the project has files but no index.html', () => {
    const result = assemblePreview(
      [
        { path: 'app.js', content: 'console.log(1)' },
        { path: 'readme.md', content: '# hi' },
      ],
      'n1',
    )

    expect(result).toEqual({ ok: false, reason: 'no_entry_point' })
    // No document at all, rather than a guessed one built from some other file.
    expect('html' in result).toBe(false)
  })

  it('reports no entry point for an empty file list', () => {
    expect(assemblePreview([], 'n1')).toEqual({ ok: false, reason: 'no_entry_point' })
  })
})

describe('assemblePreview — the injected envelope', () => {
  it('prepends the doctype when the generated source has none', () => {
    const { html } = assemble([index('<html><head></head><body>hi</body></html>')])

    expect(html.startsWith('<!doctype html>')).toBe(true)
  })

  it('leaves a source that already declares a doctype with exactly one', () => {
    const { html } = assemble([index('<!DOCTYPE html><html><head></head><body>hi</body></html>')])

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html.toLowerCase().split('<!doctype').length - 1).toBe(1)
  })

  it('opens head with the CSP meta and then the shim, ahead of anything generated', () => {
    const { html } = assemble([
      index('<!doctype html><html><head><title>App</title></head><body></body></html>'),
    ])

    const headOpensAt = html.indexOf('<head>') + '<head>'.length
    const shim = firstScript(html)

    // AC-1, read as the plan resolves it against AC-7: the shim is the first
    // *script* in head, and the only thing ahead of it is the CSP meta.
    expect(html.slice(headOpensAt, shim.at).trim()).toBe(CSP_META)
    expect(shim.source).toContain('window.__genesisAsset')
    expect(shim.at).toBeLessThan(html.indexOf('<title>'))
  })

  it('carries the CSP meta ahead of the shim script', () => {
    const { html } = assemble([index('<html><head></head><body></body></html>')])

    expect(html).toContain(CSP_META)
    expect(html.indexOf(CSP_META)).toBeLessThan(firstScript(html).at)
  })

  it('injects into a source with no head at all', () => {
    const { html } = assemble([index('<html><body><p>hi</p></body></html>')])

    const shim = firstScript(html)

    expect(html.indexOf(CSP_META)).toBeGreaterThan(html.indexOf('<html>'))
    expect(html.indexOf(CSP_META)).toBeLessThan(shim.at)
    expect(shim.at).toBeLessThan(html.indexOf('<p>'))
  })

  it('injects at the front of a fragment with neither html nor head', () => {
    const { html } = assemble([index('<p>hi</p>')])

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.indexOf(CSP_META)).toBeLessThan(html.indexOf('<p>'))
    expect(firstScript(html).at).toBeLessThan(html.indexOf('<p>'))
  })

  it('bakes the build nonce into the shim, so a reply for an older build cannot match', () => {
    const { html } = assemble([index('<html><head></head></html>')], 'build-7')

    expect(firstScript(html).source).toContain('"build-7"')
  })

  it('reports no warnings for a document that references nothing', () => {
    const { warnings } = assemble([index('<html><head></head><body>hi</body></html>')])

    expect(warnings).toEqual([])
  })
})

/**
 * The assets the document is carrying, read back out of the shim's JSON literal.
 *
 * This is the round trip AC-4 turns on: the assembler writes the files as JSON
 * with every `<` escaped to `<`, and `JSON.parse` is what restores them.
 * Reading them back the same way the browser will is what proves the content
 * survives byte-identical rather than merely "looks present".
 */
function assetsOf(html: string): PreviewAsset[] {
  const literal = /var ASSETS = (.+)/.exec(html)
  if (literal?.[1] === undefined) throw new Error('the document carries no assets literal')
  return JSON.parse(literal[1]) as PreviewAsset[]
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** The whole of what a rewritten reference leaves behind. */
function loader(index: number): string {
  return `<script>window.__genesisAsset(${String(index)})</script>`
}

/** What sits between the end of the injected shim and the close of `<head>`. */
function restOfHead(html: string): string {
  const afterShim = html.indexOf('</script>') + '</script>'.length
  return html.slice(afterShim, html.indexOf('</head>')).trim()
}

describe('assemblePreview — rewriting references to stored files', () => {
  it('replaces a stylesheet link with a loader call carrying the stored CSS', () => {
    const { html, warnings } = assemble([
      index('<html><head><link rel="stylesheet" href="styles.css"></head><body>hi</body></html>'),
      { path: 'styles.css', content: 'body { color: red }' },
    ])

    expect(html).not.toContain('<link')
    expect(restOfHead(html)).toBe(loader(0))
    expect(assetsOf(html)).toEqual([{ kind: 'css', content: 'body { color: red }' }])
    expect(warnings).toEqual([])
  })

  it('replaces a script src in place, and numbers the assets in document order', () => {
    const { html } = assemble([
      index(
        '<html><head><link rel="stylesheet" href="styles.css"></head>' +
          '<body><p>hi</p><script src="app.js"></script></body></html>',
      ),
      { path: 'app.js', content: 'console.log(1)' },
      { path: 'styles.css', content: 'body { color: red }' },
    ])

    // The CSS is referenced first in the document, so it is asset 0 — even
    // though `app.js` comes first in the file list.
    expect(assetsOf(html)).toEqual([
      { kind: 'css', content: 'body { color: red }' },
      { kind: 'js', content: 'console.log(1)' },
    ])
    expect(html).not.toContain('src="app.js"')
    const afterParagraph = html.indexOf('<p>hi</p>') + '<p>hi</p>'.length
    expect(html.slice(afterParagraph, html.indexOf('</body>')).trim()).toBe(loader(1))
  })

  it('reads an attribute however it is quoted, and whatever the tag case', () => {
    const { html } = assemble([
      index(
        "<html><head><LINK REL='stylesheet' HREF='styles.css'></head>" +
          '<body><Script src=app.js></Script></body></html>',
      ),
      { path: 'styles.css', content: 'a{}' },
      { path: 'app.js', content: 'b()' },
    ])

    expect(assetsOf(html)).toEqual([
      { kind: 'css', content: 'a{}' },
      { kind: 'js', content: 'b()' },
    ])
  })

  it('carries content that would close its own element back out byte-identical', () => {
    const css = "body::after { content: '</style>' }"
    const js = "console.log('</script>')"

    const { html } = assemble([
      index(
        '<html><head><link rel="stylesheet" href="styles.css"></head>' +
          '<body><script src="app.js"></script></body></html>',
      ),
      { path: 'styles.css', content: css },
      { path: 'app.js', content: js },
    ])

    expect(assetsOf(html)).toEqual([
      { kind: 'css', content: css },
      { kind: 'js', content: js },
    ])
    // Neither has escaped into markup: the `<` of each closer is gone from the
    // document entirely, having been written as JSON's `<`.
    expect(html).not.toContain(css)
    expect(html).not.toContain(js)
    // And every script closer in the document belongs to a script that was
    // opened — three: the shim and the two loaders. A leak would make the
    // closers outnumber the openers.
    expect(count(html, '</script')).toBe(3)
    expect(count(html, '<script')).toBe(3)
  })

  it('leaves an absolute, rooted, nested or query-bearing reference exactly as written', () => {
    const untouched = [
      '<link rel="stylesheet" href="https://cdn.test/x.css">',
      '<script src="//cdn.test/x.js"></script>',
      '<script src="/root.js"></script>',
      '<script src="a/b.js"></script>',
      '<script src="x.js?v=1"></script>',
    ]

    const { html, warnings } = assemble([
      index(`<html><head>${untouched.join('')}</head><body></body></html>`),
    ])

    for (const element of untouched) expect(html).toContain(element)
    // None of them is a candidate, so none of them is a missing file either.
    expect(warnings).toEqual([])
    expect(assetsOf(html)).toEqual([])
  })

  /** One sentence per missing file, not one per reference to it. */
  it('names a missing file once however many times it is referenced', () => {
    const { warnings } = assemble([
      index(
        '<html><head><link rel="stylesheet" href="gone.css">' +
          '<link rel="stylesheet" href="gone.css"></head>' +
          '<body><script src="gone.css"></script></body></html>',
      ),
    ])

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('gone.css')
  })

  it('drops a reference to a bare filename the project does not hold, and names it', () => {
    const { html, warnings } = assemble([
      index(
        '<html><head><link rel="stylesheet" href="gone.css"></head>' +
          '<body><script src="missing.js"></script></body></html>',
      ),
    ])

    expect(html).not.toContain('missing.js')
    expect(html).not.toContain('gone.css')
    expect(html).not.toContain('<link')
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('gone.css')
    expect(warnings[1]).toContain('missing.js')
  })

  it('resolves a reference written with one leading ./ against the same stored file', () => {
    /*
     * Beyond the acceptance criteria, deliberately. `./styles.css` is a reference the browser
     * would resolve against the *parent's* base URL and silently answer with the SPA's
     * index.html; stripping the one leading `./` can only turn that silent breakage into either
     * a working stylesheet or a warning naming the file.
     */
    const { html, warnings } = assemble([
      index('<html><head><link rel="stylesheet" href="./styles.css"></head><body></body></html>'),
      { path: 'styles.css', content: 'body { color: red }' },
    ])

    expect(assetsOf(html)).toEqual([{ kind: 'css', content: 'body { color: red }' }])
    expect(warnings).toEqual([])
  })

  it('leaves a link that is not a stylesheet alone', () => {
    const favicon = '<link rel="icon" href="favicon.png">'

    const { html, warnings } = assemble([
      index(`<html><head>${favicon}</head><body></body></html>`),
      { path: 'favicon.png', content: 'not really a png' },
    ])

    expect(html).toContain(favicon)
    expect(warnings).toEqual([])
    expect(assetsOf(html)).toEqual([])
  })

  it('leaves a reference with no URL to read alone', () => {
    const { html, warnings } = assemble([
      index('<html><head><link rel="stylesheet"></head><body></body></html>'),
    ])

    expect(html).toContain('<link rel="stylesheet">')
    expect(warnings).toEqual([])
  })
})
