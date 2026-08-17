/**
 * The script injected at the top of every preview document.
 *
 * The preview frame runs with `sandbox="allow-scripts allow-forms"` and
 * **no `allow-same-origin`**, so it has an opaque origin: it cannot call our
 * API, cannot attest App Check, and has no storage. Everything it needs from
 * HighLevel it asks the parent for over `postMessage`, and the parent brokers
 * the real call. No credential ever enters the frame.
 *
 * **The shim is a string constant, not a function put through `.toString()`**
 * (D8). esbuild's `keepNames` wraps every function in `__name(...)`, so a
 * serialised body can reach for a helper that does not exist inside the iframe
 * — a failure that appears only in a production build, where it is hardest to
 * see. A string cannot be rewritten by a bundler. The price is that nothing
 * typechecks what follows, which is exactly why `previewShim.spec.ts` evaluates
 * it for real over stubbed globals rather than matching its text.
 *
 * **The source contains no `<` character anywhere** (D7), so it can never
 * terminate the `<script>` element that carries it. The assets it embeds are
 * JSON with every `<` written as the escape `<`, which `JSON.parse`
 * restores byte-identically.
 *
 * **The error contract lives in two places.** `err.status` and `err.code` are
 * assigned onto a plain `Error` because that is precisely what Slice 9's system
 * prompt teaches generated code — it branches on
 * `err.code === 'hl_reconnect_required'`. The prompt and this shim are the two
 * implementations of one contract; neither may change without the other, and
 * `hl(` is the seam between them.
 */

/** A file the preview carries inline, moved out of the document body by D7. */
export interface PreviewAsset {
  kind: 'css' | 'js'
  content: string
}

/**
 * HighLevel calls one preview document may make before the shim refuses.
 *
 * Exported rather than inlined so the shim's message, the host's banner and the
 * tests all read the same number — a generated render loop can otherwise turn
 * one preview into a few thousand brokered calls against a real CRM.
 */
export const HL_CALL_LIMIT = 50

/** How long a brokered call waits for the host before it rejects. */
export const HL_TIMEOUT_MS = 30_000

/**
 * A JSON literal safe to embed in a `<script>` element.
 *
 * Every `<` becomes the six characters `<`, so the result cannot contain
 * the one byte that could close the element early — `</script>` inside a string
 * in generated code being the case that matters. The escape is JSON's own, so
 * `JSON.parse` gives the content back unchanged, to the byte.
 */
function embeddable(json: string): string {
  return json.replaceAll('<', '\\u003c')
}

export function encodeAssets(assets: readonly PreviewAsset[]): string {
  return embeddable(JSON.stringify(assets))
}

/**
 * The shim source for one build, with the nonce and assets baked in.
 *
 * The nonce ties every message to the document that is currently mounted: a
 * reply from a previous build arrives with the wrong one and is dropped, which
 * is what keeps a slow call from resolving into a document that no longer
 * exists.
 */
export function buildShim(nonce: string, assets: readonly PreviewAsset[]): string {
  return `;(function () {
  var NONCE = ${embeddable(JSON.stringify(nonce))}
  var ASSETS = ${encodeAssets(assets)}
  var LIMIT = ${HL_CALL_LIMIT}
  var TIMEOUT = ${HL_TIMEOUT_MS}
  var pending = {}
  var seq = 0
  var used = 0

  function post(message) {
    parent.postMessage(message, '*')
  }

  function report(message) {
    post({ genesis: 'preview', v: 1, nonce: NONCE, kind: 'error', message: String(message) })
  }

  window.hl = function (method, path, payload) {
    if (used >= LIMIT) {
      var over = 'This preview reached its limit of ' + LIMIT + ' HighLevel calls.'
      report(over)
      return Promise.reject(new Error(over))
    }
    used += 1
    seq += 1
    var id = 'c' + seq
    return new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () {
        delete pending[id]
        reject(new Error('HighLevel did not answer within ${HL_TIMEOUT_MS / 1000} seconds.'))
      }, TIMEOUT)
      pending[id] = { resolve: resolve, reject: reject, timer: timer }
      var message = {
        genesis: 'preview', v: 1, nonce: NONCE, id: id,
        kind: 'hl', method: method, path: path,
      }
      if (payload !== undefined) message.payload = payload
      post(message)
    })
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.genesis !== 'preview-host' || data.v !== 1 || data.nonce !== NONCE) return
    var entry = pending[data.id]
    if (!entry) return
    delete pending[data.id]
    window.clearTimeout(entry.timer)
    if (data.ok) {
      entry.resolve(data.data)
      return
    }
    var info = data.error || {}
    var err = new Error(info.message || 'That HighLevel call failed.')
    err.status = info.status || 0
    if (info.code) err.code = info.code
    entry.reject(err)
  })

  window.addEventListener('error', function (event) {
    report(event.message || 'The preview raised an error.')
  })

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason
    report((reason && reason.message) || String(reason))
  })

  window.addEventListener('securitypolicyviolation', function (event) {
    report('The preview was blocked by its content security policy: ' + event.violatedDirective + '.')
  })

  window.__genesisAsset = function (index) {
    var asset = ASSETS[index]
    if (!asset) return
    var node = document.createElement(asset.kind === 'css' ? 'style' : 'script')
    node.textContent = asset.content
    var self = document.currentScript
    if (self && self.parentNode) self.parentNode.replaceChild(node, self)
    else document.head.appendChild(node)
  }
})()
`
}
