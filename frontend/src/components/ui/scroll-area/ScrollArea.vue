<script setup lang="ts">
import type { ScrollAreaRootProps } from 'reka-ui'
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'
import ScrollBar from './ScrollBar.vue'

/**
 * shadcn-vue's ScrollArea, on Reka UI's primitive.
 *
 * Upstream forwards with `reactiveOmit`. Its result type carries optional keys
 * whose value may be `undefined`, and exactOptionalPropertyTypes treats "absent"
 * and "present but undefined" as different types — so the spread does not
 * type-check against `type?: ScrollType`.
 *
 * Rebuilt omitting undefined keys entirely, which is what the runtime does
 * anyway. Same fix as `ui/label/Label.vue`, which documents it at length.
 *
 * The scrolling element is `ScrollAreaViewport`'s root, which Reka UI marks with
 * `data-reka-scroll-area-viewport` — that attribute is how `ChatPanel` finds it to
 * scroll the transcript to the bottom.
 */
const props = defineProps<ScrollAreaRootProps & { class?: HTMLAttributes['class'] }>()

const forwarded = computed<ScrollAreaRootProps>(() =>
  Object.fromEntries(
    Object.entries(props).filter(([key, value]) => key !== 'class' && value !== undefined),
  ),
)
</script>

<template>
  <ScrollAreaRoot v-bind="forwarded" :class="cn('relative overflow-hidden', props.class)">
    <ScrollAreaViewport class="h-full w-full rounded-[inherit]">
      <slot />
    </ScrollAreaViewport>
    <ScrollBar />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
