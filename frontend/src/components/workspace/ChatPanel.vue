<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import MessageBody from '@/components/workspace/MessageBody.vue'
import StreamingStatus from '@/components/workspace/StreamingStatus.vue'
import MessageComposer from '@/components/workspace/MessageComposer.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTime } from '@/lib/date'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The conversation.
 *
 * Four states: loading, bubbles, empty, and error-with-retry. **Error first**,
 * because a failed first request leaves `messagesLoaded` false — a loading branch
 * ahead of it would render a skeleton forever and never show the failure.
 *
 * **The streaming placeholder sits inside the transcript list**, after the bubbles,
 * so the existing scroll machinery covers it. It cannot collide with the empty
 * state: the user's own message is appended before the stream opens.
 */
const workspace = useWorkspaceStore()

/**
 * The element that actually scrolls.
 *
 * `ScrollArea` renders Reka UI's viewport *inside* itself, so a `ref` on the
 * component would address the wrapper rather than the overflowing box. The viewport
 * carries a documented attribute, so it is found by query — which is honest about
 * reaching into a vendored component's internals.
 */
const scrollRoot = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  const viewport = scrollRoot.value?.querySelector<HTMLElement>('[data-reka-scroll-area-viewport]')
  if (viewport === null || viewport === undefined) return
  viewport.scrollTop = viewport.scrollHeight
}

/*
 * `flush: 'post'` so the DOM has the new bubble in it before the height is read:
 * a `scrollHeight` measured before the append lands one message short, every time.
 */
watch(() => workspace.messages.length, scrollToBottom, { flush: 'post' })

/*
 * And again on every token. A separate watcher rather than a wider source: the two
 * grow at completely different rates — one message per turn against hundreds of
 * tokens.
 */
watch(() => workspace.streamingText, scrollToBottom, { flush: 'post' })

// And once on mount, so a reload opens on the newest message rather than the oldest.
onMounted(scrollToBottom)

/**
 * The transcript, each message carrying the time it renders with — derived once
 * rather than calling `formatTime` twice per bubble in the template. `null` is a
 * stored timestamp that will not parse, which yields no line at all rather than
 * "Invalid Date".
 */
const bubbles = computed(() =>
  workspace.messages.map((message) => ({ ...message, time: formatTime(message.createdAt) })),
)

/**
 * The composer is available in every branch except loading. A failed transcript
 * still gets one: the send route is a different request from the list route, and a
 * user whose history would not load can still say something.
 */
const showComposer = computed(
  () =>
    workspace.messagesError !== null || (workspace.messagesLoaded && !workspace.messagesLoading),
)

/**
 * What a stored failure says out loud.
 *
 * The wire carries a code rather than a sentence, because the sentence is a product
 * decision and the code is a fact — and a transcript written today should still
 * read correctly after the copy is rewritten tomorrow.
 */
function failureCopy(code: string): string {
  if (code === 'refused') return 'The model declined to answer that.'
  if (code === 'upstream') return 'The reply was interrupted. Try again.'
  return 'Something went wrong generating that reply.'
}

function retry(): void {
  void workspace.retryGeneration()
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-testid="chat-panel">
    <header class="flex shrink-0 items-center justify-between gap-3 px-3 py-2.5">
      <h2 class="label-micro">Chat</h2>
      <!-- Only while a stream is open. -->
      <Badge v-if="workspace.generating" variant="secondary" data-testid="chat-generating">
        Generating…
      </Badge>
    </header>

    <Separator />

    <!--
      Error first, and before content. A failed first request leaves
      `messagesLoaded` false, so a loading branch ahead of this would render a
      skeleton forever and never show the failure.
    -->
    <div v-if="workspace.messagesError" data-testid="chat-error" class="flex flex-col gap-2.5 p-3">
      <Alert variant="destructive">
        <AlertDescription>{{ workspace.messagesError }}</AlertDescription>
      </Alert>
      <Button variant="outline" data-testid="chat-retry" @click="workspace.loadMessages()">
        Try again
      </Button>
    </div>

    <!--
      No answer yet — in flight, or not started. `messagesLoading` alone cannot say
      the second: it is still false in the tick between mounting and the request
      starting.
    -->
    <div
      v-else-if="workspace.messagesLoading || !workspace.messagesLoaded"
      data-testid="chat-loading"
      class="flex flex-col gap-2.5 p-3"
    >
      <Skeleton class="h-10 w-2/3 rounded-md" />
      <Skeleton class="h-10 w-1/2 self-end rounded-md" />
    </div>

    <template v-else>
      <div ref="scrollRoot" class="min-h-0 flex-1">
        <ScrollArea class="h-full">
          <ul
            v-if="bubbles.length > 0 || workspace.generating"
            class="flex flex-col gap-2.5 p-3"
            data-testid="chat-transcript"
          >
            <li
              v-for="message in bubbles"
              :key="message.id"
              data-testid="message-bubble"
              :data-role="message.role"
              class="flex max-w-[85%] flex-col gap-1 rounded-md border px-3 py-2"
              :class="[
                message.role === 'user' ? 'self-end bg-secondary' : 'self-start bg-raised',
                message.error !== null
                  ? 'border-destructive/40 bg-destructive/5'
                  : 'border-border-strong',
              ]"
            >
              <!-- Prose and chips, never code. The same component the placeholder
                   below uses, because they render the same string. -->
              <MessageBody v-if="message.content !== ''" :content="message.content" />

              <!--
                **The failure, in the transcript rather than beside it.** A turn
                that failed is written down, carrying why, so it survives a refresh
                and reads in order with everything else — where before, the reply
                vanished, a banner appeared, and reloading swallowed the whole turn.

                The Retry sits on the message it belongs to, so a transcript with
                two failures offers two.
              -->
              <div
                v-if="message.error !== null"
                data-testid="message-failure"
                class="flex flex-col items-start gap-2"
              >
                <p class="text-sm text-destructive">{{ failureCopy(message.error) }}</p>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="message-retry"
                  :disabled="workspace.generating"
                  @click="retry()"
                >
                  Retry
                </Button>
              </div>
              <div class="flex items-center gap-2">
                <!-- A timestamp that will not parse yields no line at all. -->
                <span
                  v-if="message.time !== null"
                  data-testid="message-time"
                  class="tabular font-mono text-[11px] text-muted-foreground"
                >
                  {{ message.time }}
                </span>
                <!--
                  One marker for four causes: a client disconnect, a mid-stream
                  failure, `max_tokens` and the byte cap.
                -->
                <span
                  v-if="message.truncated"
                  data-testid="message-interrupted"
                  class="text-xs font-medium text-muted-foreground"
                >
                  · Interrupted
                </span>
              </div>
            </li>

            <!--
              The placeholder, inside the list so one scroll mechanism covers it
              too. Keyed by a synthetic id, since it has no server id yet.
            -->
            <li
              v-if="workspace.generating"
              key="__streaming"
              data-testid="streaming-bubble"
              data-role="assistant"
              class="flex max-w-[94%] flex-col gap-2 self-start rounded-md border border-border-strong bg-raised px-3 py-2"
            >
              <!-- `streaming` draws the caret. The same component as the persisted
                   bubble: one string, one rendering. -->
              <MessageBody
                v-if="workspace.streamingText !== ''"
                :content="workspace.streamingText"
                streaming
              />
              <!--
                Below the prose and separated, because it describes the turn rather
                than being part of the reply. It is the whole bubble while the model
                is still thinking.
              -->
              <StreamingStatus />
            </li>
          </ul>

          <!-- Empty: asked, and there is nothing. -->
          <div v-else data-testid="chat-empty" class="p-4">
            <p class="text-sm text-muted-foreground">No messages yet. Describe the app you want.</p>
          </div>
        </ScrollArea>
      </div>
    </template>

    <!--
      Below the transcript and above the composer, so it reads as being about the
      reply rather than what the user is typing. The transcript stays visible: a
      failed generation does not invalidate the conversation, and hiding it would
      hide the partial the server just persisted.
    -->
    <div
      v-if="workspace.generateError"
      data-testid="generate-error"
      class="flex flex-col gap-2 border-t border-border p-3"
    >
      <Alert variant="destructive">
        <AlertDescription>{{ workspace.generateError }}</AlertDescription>
      </Alert>
      <Button variant="outline" size="sm" data-testid="generate-retry" @click="retry()">
        Retry
      </Button>
    </div>

    <!--
      A turn whose files were refused. Its own notice, and deliberately without a
      Retry: the reply itself succeeded and is in the transcript above, so what went
      wrong is the model's output and the fix is the next prompt.
    -->
    <div
      v-if="workspace.generateFileError"
      data-testid="generate-file-error"
      class="border-t border-border p-3"
    >
      <Alert>
        <AlertDescription>{{ workspace.generateFileError }}</AlertDescription>
      </Alert>
    </div>

    <MessageComposer v-if="showComposer" />
  </section>
</template>
