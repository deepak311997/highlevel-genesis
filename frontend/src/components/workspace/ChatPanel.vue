<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

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
 * The `Echo mode` badge is not decoration (D7, D19): it says out loud that the
 * reply is a stub rather than intelligence. It and the echo disappear together in
 * Slice 5.
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
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-testid="chat-panel">
    <header class="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
      <h2 class="text-sm font-semibold">Chat</h2>
      <Badge variant="secondary">Echo mode</Badge>
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
            v-if="bubbles.length > 0"
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
              <p class="whitespace-pre-wrap text-sm">{{ message.content }}</p>
              <!-- A timestamp that will not parse yields no line at all (D29). -->
              <span
                v-if="message.time !== null"
                data-testid="message-time"
                class="text-xs text-muted-foreground"
              >
                {{ message.time }}
              </span>
            </li>
          </ul>

          <!-- Empty: asked, and there is nothing. -->
          <div v-else data-testid="chat-empty" class="p-4">
            <p class="text-sm text-muted-foreground">No messages yet. Describe the app you want.</p>
          </div>
        </ScrollArea>
      </div>
    </template>

    <MessageComposer v-if="showComposer" />
  </section>
</template>
