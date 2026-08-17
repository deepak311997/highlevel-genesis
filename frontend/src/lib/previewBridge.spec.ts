import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from './api'
import {
  FRAME_TAG,
  HOST_TAG,
  PREVIEW_V,
  handlePreviewMessage,
  type BridgeContext,
} from './previewBridge'

/**
 * The host half of the preview channel, tested as the acceptance gate it is.
 *
 * Every case below is written from the frame's side of a boundary we do not
 * trust: the preview runs in a sandboxed `srcdoc` iframe with no
 * `allow-same-origin`, so its origin is opaque and arrives as the literal
 * string `"null"` — which every other sandboxed frame on the page also has, and
 * which therefore identifies nothing. `event.source` and the per-build nonce
 * are the only two things that say "this is the document I am showing right
 * now", so the tests that matter most are the ones where a message is
 * well-formed and still ignored.
 */

const NONCE = 'n'

/** A real `Window`, so `event.source` identity is the same check it is in a browser. */
function makeFrame(): Window {
  const element = document.createElement('iframe')
  document.body.appendChild(element)
  const frame = element.contentWindow
  if (frame === null) throw new Error('jsdom gave the iframe no contentWindow')
  return frame
}

function makeContext(frame: Window | null) {
  const proxy = vi.fn<BridgeContext['proxy']>()
  const post = vi.fn<BridgeContext['post']>()
  const onFailure = vi.fn<BridgeContext['onFailure']>()
  const onRuntimeError = vi.fn<BridgeContext['onRuntimeError']>()
  const ctx: BridgeContext = { nonce: NONCE, frame, proxy, post, onFailure, onRuntimeError }
  return { ctx, proxy, post, onFailure, onRuntimeError }
}

function messageFrom(source: Window, data: unknown): MessageEvent {
  // A real MessageEvent rather than a cast: `source` is the field the gate turns
  // on, and jsdom's own event is the only construction that proves the identity
  // comparison works on the type a listener actually receives.
  return new MessageEvent('message', { data, source })
}

/** A request that must be brokered, so each rejection case can spoil one field. */
const REQUEST = {
  genesis: FRAME_TAG,
  v: PREVIEW_V,
  nonce: NONCE,
  id: 'r1',
  kind: 'hl',
  method: 'GET',
  path: '/contacts',
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('handlePreviewMessage', () => {
  // AC-17. The previous build's document survives the `srcdoc` swap long enough
  // to post, and its request is indistinguishable from the current one's by
  // origin — the nonce is the whole of the difference.
  it("ignores a request carrying the previous build's nonce", async () => {
    const frame = makeFrame()
    const { ctx, proxy, post } = makeContext(frame)

    await handlePreviewMessage(messageFrom(frame, { ...REQUEST, nonce: 'n-1' }), ctx)

    expect(proxy).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('ignores a message whose source is not the frame', async () => {
    const frame = makeFrame()
    const other = makeFrame()
    const { ctx, proxy, post } = makeContext(frame)

    await handlePreviewMessage(messageFrom(other, REQUEST), ctx)

    expect(proxy).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  // AC-18. Every one of these is dropped in silence: no reply tells a caller
  // which field it got wrong, and no HighLevel call is made on its behalf.
  const malformed: [string, unknown][] = [
    [
      'a request with no id',
      {
        genesis: FRAME_TAG,
        v: PREVIEW_V,
        nonce: NONCE,
        kind: 'hl',
        method: 'GET',
        path: '/contacts',
      },
    ],
    ['an unrecognised kind', { ...REQUEST, kind: 'console' }],
    ['a method outside the three', { ...REQUEST, method: 'DELETE' }],
    ['a path that is not a string', { ...REQUEST, path: 42 }],
    ["the host's own tag echoed back", { ...REQUEST, genesis: HOST_TAG }],
    ['a protocol version we do not speak', { ...REQUEST, v: 2 }],
  ]

  it.each(malformed)('ignores %s', async (_case, data) => {
    const frame = makeFrame()
    const { ctx, proxy, post } = makeContext(frame)

    await handlePreviewMessage(messageFrom(frame, data), ctx)

    expect(proxy).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('forwards an accepted request and posts the reply', async () => {
    const frame = makeFrame()
    const { ctx, proxy, post, onFailure } = makeContext(frame)
    const body = { contacts: [{ id: 'c1' }], total: 1 }
    proxy.mockResolvedValue(body)

    await handlePreviewMessage(
      messageFrom(frame, {
        ...REQUEST,
        method: 'POST',
        path: '/contacts/search',
        payload: { pageLimit: 1 },
      }),
      ctx,
    )

    expect(proxy).toHaveBeenCalledWith('POST', '/contacts/search', { pageLimit: 1 })
    expect(post).toHaveBeenCalledWith({
      genesis: HOST_TAG,
      v: PREVIEW_V,
      nonce: NONCE,
      id: 'r1',
      ok: true,
      data: body,
    })
    expect(onFailure).not.toHaveBeenCalled()
  })

  // Both, always: the reply lets the generated app render its own error state,
  // and `onFailure` is how the host reports a failure the generated app's
  // try/catch — model output we cannot rely on — may have swallowed.
  it('posts a failure reply and reports the failure when the proxy rejects', async () => {
    const frame = makeFrame()
    const { ctx, post, onFailure } = makeContext(frame)
    ctx.proxy = vi
      .fn<BridgeContext['proxy']>()
      .mockRejectedValue(
        new ApiError('Your HighLevel connection expired.', 409, 'hl_reconnect_required'),
      )

    await handlePreviewMessage(messageFrom(frame, REQUEST), ctx)

    expect(post).toHaveBeenCalledWith({
      genesis: HOST_TAG,
      v: PREVIEW_V,
      nonce: NONCE,
      id: 'r1',
      ok: false,
      error: {
        message: 'Your HighLevel connection expired.',
        status: 409,
        code: 'hl_reconnect_required',
      },
    })
    expect(onFailure).toHaveBeenCalledWith({
      message: 'Your HighLevel connection expired.',
      status: 409,
      code: 'hl_reconnect_required',
    })
  })

  // Anything that is not an ApiError reached us through a path that has no
  // status to report, so the reply says status 0 and omits `code` entirely —
  // an absent key rather than a null one, matching the server's envelope.
  it('reports a rejection that is not an ApiError as a status-0 failure', async () => {
    const frame = makeFrame()
    const { ctx, proxy, post, onFailure } = makeContext(frame)
    proxy.mockRejectedValue('a string, thrown')

    await handlePreviewMessage(messageFrom(frame, REQUEST), ctx)

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: { message: expect.any(String) as unknown as string, status: 0 },
      }),
    )
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 0, code: null }) as unknown as never,
    )
  })

  it('routes an error report to onRuntimeError and calls nothing else', async () => {
    const frame = makeFrame()
    const { ctx, proxy, post, onFailure, onRuntimeError } = makeContext(frame)

    await handlePreviewMessage(
      messageFrom(frame, {
        genesis: FRAME_TAG,
        v: PREVIEW_V,
        nonce: NONCE,
        kind: 'error',
        message: "TypeError: Cannot read properties of undefined (reading 'map')",
      }),
      ctx,
    )

    expect(onRuntimeError).toHaveBeenCalledWith(
      "TypeError: Cannot read properties of undefined (reading 'map')",
    )
    expect(proxy).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })
})
