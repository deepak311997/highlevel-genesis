<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import MessageBody from '@/components/workspace/MessageBody.vue'
import MessageComposer from '@/components/workspace/MessageComposer.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { formatTime } from '@/lib/date'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The conversation, and the one panel of the three with real behaviour today.
 *
 * Four states, all shipped: loading, bubbles, empty, and error-with-retry. The
 * order of the branches is `ProjectsCard`'s and for its reason — **error first**. A
 * failed first request leaves `messagesLoaded` false, so a loading branch ahead of
 * the error would render a skeleton forever and never show the failure, and a
 * transcript shown beside a failure notice leaves the user unable to tell which of
 * the two is current.
 *
 * Slice 5 replaces Slice 4's stub badge with a `Generating…` one, shown only
 * while a stream is open (D30). That is F6.2's streaming status, and it
 * discharges D14's cost: adaptive thinking means the first token can be seconds
 * away, so the pause is a labelled state rather than a frozen screen.
 *
 * **The streaming placeholder sits inside the transcript list**, after the
 * bubbles, so the existing scroll machinery covers it and there is one mechanism
 * rather than two. It cannot collide with the empty state: the user's own
 * message is appended before the stream opens, so `bubbles.length` is never 0
 * while `generating` is true.
 */
const workspace = useWorkspaceStore()

/**
 * The element that actually scrolls.
 *
 * `ScrollArea` renders Reka UI's viewport *inside* itself, so a `ref` on the
 * component would address the wrapper rather than the overflowing box. The viewport
 * carries `data-reka-scroll-area-viewport` — a documented attribute Reka UI emits
 * into its own injected stylesheet — so it is found by query. A query rather than a
 * ref because the element belongs to a vendored component's internals: reaching for
 * it by attribute is honest about that, where forwarding a ref through the wrapper
 * would mean editing upstream code to expose it.
 */
const scrollRoot = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  const viewport = scrollRoot.value?.querySelector<HTMLElement>('[data-reka-scroll-area-viewport]')
  if (viewport === null || viewport === undefined) return
  viewport.scrollTop = viewport.scrollHeight
}

/*
 * `flush: 'post'` so the DOM has the new bubble in it before the height is read —
 * scrolling to a `scrollHeight` measured before the append lands one message short,
 * every time.
 */
watch(() => workspace.messages.length, scrollToBottom, { flush: 'post' })

/*
 * And again on every token (AC-43). A separate watcher rather than a wider
 * source: the two grow at completely different rates — one message per turn
 * against hundreds of tokens — and measuring once on mount would leave the
 * viewport a screen behind by the third token.
 */
watch(() => workspace.streamingText, scrollToBottom, { flush: 'post' })

// And once on mount, so a reload opens on the newest message rather than the oldest.
onMounted(scrollToBottom)

/**
 * The transcript, each message carrying the time it renders with.
 *
 * Derived once here rather than calling `formatTime` twice per bubble in the
 * template — once to decide whether there is a line and once to fill it — which is
 * two `Intl` formats per message per render, and a condition and its content that
 * could in principle disagree. `null` is the whole of D29: a stored timestamp that
 * will not parse yields no line at all rather than "Invalid Date".
 */
const bubbles = computed(() =>
  workspace.messages.map((message) => ({ ...message, time: formatTime(message.createdAt) })),
)

/**
 * The composer is available in every branch except loading.
 *
 * A failed transcript still gets one: the send route is a different request from the
 * list route, and a user whose history would not load can still say something. What
 * has no composer is the tick before we know whether the project even has a
 * transcript.
 */
const showComposer = computed(
  () =>
    workspace.messagesError !== null || (workspace.messagesLoaded && !workspace.messagesLoading),
)

/**
 * Retry re-opens the stream for the same transcript — no new user message (D26).
 *
 * That is free given D2: the endpoint's whole input is the project id, and the
 * transcript is the server's own record. It is also exactly the case D6's
 * trailing-assistant drop exists for, since an interrupted turn leaves the
 * transcript ending on an assistant message.
 */
function retry(): void {
  void workspace.retryGeneration()
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-testid="chat-panel">
    <header class="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
      <h2 class="text-sm font-semibold">Chat</h2>
      <!-- Only while a stream is open (D30, AC-39). -->
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
    <div v-if="workspace.messagesError" data-testid="chat-error" class="flex flex-col gap-3 p-4">
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
      class="flex flex-col gap-3 p-4"
    >
      <div class="h-10 w-2/3 animate-pulse rounded-md bg-secondary" />
      <div class="h-10 w-1/2 animate-pulse self-end rounded-md bg-secondary" />
    </div>

    <template v-else>
      <div ref="scrollRoot" class="min-h-0 flex-1">
        <ScrollArea class="h-full">
          <ul
            v-if="bubbles.length > 0 || workspace.generating"
            class="flex flex-col gap-3 p-4"
            data-testid="chat-transcript"
          >
            <li
              v-for="message in bubbles"
              :key="message.id"
              data-testid="message-bubble"
              :data-role="message.role"
              class="flex max-w-[85%] flex-col gap-1 rounded-lg border border-border p-3"
              :class="message.role === 'user' ? 'self-end bg-secondary' : 'self-start bg-card'"
            >
              <!-- Prose and chips, never code (D6, D29). The same component the
                   placeholder below uses, because they render the same string. -->
              <MessageBody :content="message.content" />
              <div class="flex items-center gap-2">
                <!-- A timestamp that will not parse yields no line at all (D29). -->
                <span
                  v-if="message.time !== null"
                  data-testid="message-time"
                  class="text-xs text-muted-foreground"
                >
                  {{ message.time }}
                </span>
                <!--
                  One marker for four causes (D23): a client disconnect, a
                  mid-stream failure, `stop_reason: 'max_tokens'` and the byte
                  cap. It says what it means rather than showing a bare icon.
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
              class="flex max-w-[85%] flex-col gap-1 self-start rounded-lg border border-border bg-card p-3"
            >
              <MessageBody :content="workspace.streamingText" />
              <span class="text-xs text-muted-foreground">Generating…</span>
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
      reply rather than about what the user is typing (AC-41). The transcript
      stays visible beside it: a failed generation does not invalidate the
      conversation, and hiding it would hide the partial the server just
      persisted — which is the thing F8.2 exists to preserve.
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
      A turn whose files were refused (D8, D17). Its own notice rather than
      `generateError`'s, and deliberately without a Retry: the reply itself
      succeeded and is in the transcript above, so the action that belongs to a
      failed generation is the wrong action for this problem. What went wrong is
      the model's output, and the fix is the next prompt.
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
