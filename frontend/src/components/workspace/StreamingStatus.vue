<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next'
import { computed } from 'vue'

import { useWorkspaceStore } from '@/stores/workspace'

/**
 * What is happening right now, in one line under the streaming bubble.
 *
 * The placeholder used to say `Generating…` for the entire turn. That is least
 * informative exactly when the user needs it most:
 *
 * - **For the first several seconds there is nothing on screen at all.**
 *   `params.ts` leaves adaptive thinking on and `stream.ts` drops every thinking
 *   delta, so the client receives keep-alive comments and no text. An empty
 *   bubble labelled "Generating…" is indistinguishable from a hang, and the pause
 *   is measured in seconds, not milliseconds.
 * - **Once files start, the interesting fact is which one.** The store already
 *   routes every chunk by path (`streamingFiles`), and the panel was discarding
 *   that to print a fixed string.
 *
 * Three states, read from the same two pieces of state the bubble renders, so
 * nothing new has to be plumbed through the stream to support it.
 */
const workspace = useWorkspaceStore()

/**
 * The file being written, or `null`.
 *
 * The **last** key: the store inserts one on `file_start` and then appends
 * chunks, so insertion order is the order the model opened them and the newest
 * is the open one. `file_end` is not recorded separately — it does not need to
 * be, since a file that has ended is only ever followed by another `file_start`
 * or by the terminal frame, which unmounts this component.
 */
const paths = computed(() => Object.keys(workspace.streamingFiles))
const currentFile = computed(() => paths.value[paths.value.length - 1] ?? null)

/** Nothing has arrived yet — the thinking pause (see above). */
const thinking = computed(() => workspace.streamingText === '' && paths.value.length === 0)

const label = computed(() => {
  if (thinking.value) return 'Thinking'
  if (currentFile.value !== null) return 'Writing'
  return 'Writing the reply'
})
</script>

<template>
  <div
    data-testid="streaming-status"
    class="flex items-center gap-2 text-xs text-muted-foreground"
    role="status"
    aria-live="polite"
  >
    <!--
      Dots while thinking, spinner once bytes are flowing. Two different facts —
      "nothing yet" and "arriving" — so two different shapes rather than one
      indicator that means both.
    -->
    <span v-if="thinking" class="flex items-center gap-1" aria-hidden="true">
      <span
        v-for="dot in 3"
        :key="dot"
        data-testid="thinking-dot"
        class="animate-thinking size-1 rounded-full bg-current"
        :style="{ animationDelay: `${String((dot - 1) * 160)}ms` }"
      />
    </span>
    <Loader2 v-else class="size-3 animate-spin" aria-hidden="true" />

    <span>{{ label }}</span>

    <code v-if="currentFile !== null" class="font-mono text-[0.6875rem] text-foreground">{{
      currentFile
    }}</code>

    <span v-if="paths.length > 0" data-testid="streaming-file-count" class="ml-auto tabular-nums">
      {{ paths.length }} {{ paths.length === 1 ? 'file' : 'files' }}
    </span>
  </div>
</template>
