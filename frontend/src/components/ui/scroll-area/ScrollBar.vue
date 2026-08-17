<script setup lang="ts">
import type { ScrollAreaScrollbarProps } from 'reka-ui'
import { ScrollAreaScrollbar, ScrollAreaThumb } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * Upstream forwards with `reactiveOmit`. Its result type carries optional keys
 * whose value may be `undefined`, and exactOptionalPropertyTypes treats "absent"
 * and "present but undefined" as different types — so the spread does not
 * type-check against `forceMount?: boolean`.
 *
 * Rebuilt omitting undefined keys entirely, which is what the runtime does
 * anyway. Same fix as `ui/label/Label.vue`, which documents it at length.
 *
 * `class` also gets an explicit default, which upstream leaves off: this project's
 * ESLint runs eslint-plugin-vue's three rule tiers, and `vue/require-default-prop`
 * is one of them.
 */
const props = withDefaults(
  defineProps<ScrollAreaScrollbarProps & { class?: HTMLAttributes['class'] }>(),
  { orientation: 'vertical', class: undefined },
)

const forwarded = computed<ScrollAreaScrollbarProps>(() =>
  Object.fromEntries(
    Object.entries(props).filter(([key, value]) => key !== 'class' && value !== undefined),
  ),
)
</script>

<template>
  <ScrollAreaScrollbar
    v-bind="forwarded"
    :class="
      cn(
        'flex touch-none select-none transition-colors',
        props.orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-px',
        props.orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-px',
        props.class,
      )
    "
  >
    <ScrollAreaThumb class="relative flex-1 rounded-full bg-border" />
  </ScrollAreaScrollbar>
</template>
