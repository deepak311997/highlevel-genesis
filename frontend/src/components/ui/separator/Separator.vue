<script setup lang="ts">
import type { SeparatorProps } from 'reka-ui'
import { Separator } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * Upstream forwards with `reactiveOmit`. Its result type carries optional keys
 * whose value may be `undefined`, and exactOptionalPropertyTypes treats "absent"
 * and "present but undefined" as different types — so the spread does not
 * type-check against `orientation?: DataOrientation`.
 *
 * Rebuilt omitting undefined keys entirely, which is what the runtime does
 * anyway. Same fix as `ui/label/Label.vue`, which documents it at length.
 *
 * `class` also gets an explicit default, which upstream leaves off, for
 * `vue/require-default-prop`.
 */
const props = withDefaults(defineProps<SeparatorProps & { class?: HTMLAttributes['class'] }>(), {
  orientation: 'horizontal',
  decorative: true,
  class: undefined,
})

const forwarded = computed<SeparatorProps>(() =>
  Object.fromEntries(
    Object.entries(props).filter(([key, value]) => key !== 'class' && value !== undefined),
  ),
)
</script>

<template>
  <Separator
    v-bind="forwarded"
    :class="
      cn(
        'shrink-0 bg-border',
        props.orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        props.class,
      )
    "
  />
</template>
