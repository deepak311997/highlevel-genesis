import type { FileWriteMode, GenerateEvent } from './generateApi'
import type { Message } from './messagesApi'

/**
 * Everything a generation can say, as one method each.
 *
 * The store used to read the stream with a chain of `if (event.type === …)`
 * branches inside its own `for await`. That works for three frames and rots at
 * ten: the branches share a scope, the terminal ones return out of the middle of
 * it, and adding a frame means finding the right place in a hundred-line
 * function.
 *
 * Here the protocol is an interface and the routing is one exhaustive `switch`.
 * A new frame is a new method and a new `case` — and until both exist the file
 * does not compile, which is the only kind of reminder worth having.
 */
export interface GenerationSink {
  /** The prompt as the server stored it, replacing the optimistic bubble. */
  onUserMessage(message: Message): void

  /** One delta of the reply's prose. */
  onToken(text: string): void

  /** A whole file is arriving — `mode` says whether it is new. */
  onFileStart(path: string, mode: FileWriteMode): void
  onFileChunk(path: string, text: string): void
  onFileEnd(path: string): void

  /**
   * A located change is arriving at lines `[from, to)`, 1-based and `to`
   * exclusive. `from === to` is an insertion.
   */
  onEditStart(path: string, from: number, to: number): void
  onEditChunk(path: string, text: string): void
  onEditEnd(path: string): void

  /** The turn succeeded. Terminal: nothing follows. */
  onDone(message: Message, files: string[], fileError: string | null): Promise<void>

  /** The turn failed mid-stream. Terminal: nothing follows. */
  onFailure(error: string, code: string, message: Message | null): Promise<void>
}

/** Whether the stream is still open after this event. */
export type SinkState = 'open' | 'closed'

/**
 * Route one event to its method.
 *
 * Exhaustive over `GenerateEvent['type']` — the `never` in the default arm is
 * what makes a new frame a compile error here rather than a frame silently
 * dropped at runtime.
 */
export async function dispatchGenerationEvent(
  sink: GenerationSink,
  event: GenerateEvent,
): Promise<SinkState> {
  switch (event.type) {
    case 'user':
      sink.onUserMessage(event.message)
      return 'open'
    case 'token':
      sink.onToken(event.text)
      return 'open'
    case 'file_start':
      sink.onFileStart(event.path, event.mode)
      return 'open'
    case 'file_chunk':
      sink.onFileChunk(event.path, event.text)
      return 'open'
    case 'file_end':
      sink.onFileEnd(event.path)
      return 'open'
    case 'edit_start':
      sink.onEditStart(event.path, event.from, event.to)
      return 'open'
    case 'edit_chunk':
      sink.onEditChunk(event.path, event.text)
      return 'open'
    case 'edit_end':
      sink.onEditEnd(event.path)
      return 'open'
    case 'done':
      await sink.onDone(event.message, event.files, event.fileError)
      return 'closed'
    case 'error':
      await sink.onFailure(event.error, event.code, event.message)
      return 'closed'
  }
}
