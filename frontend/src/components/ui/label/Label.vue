<script setup lang="ts">
import { Label, type LabelProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * shadcn-vue's Label, on Reka UI's primitive.
 *
 * Upstream forwards with `reactiveOmit`. Its result type carries optional keys
 * whose value may be `undefined`, and exactOptionalPropertyTypes treats "absent"
 * and "present but undefined" as different types — so neither the spread nor
 * per-prop bindings type-check against `for?: string`.
 *
 * Rebuilt omitting undefined keys entirely, which is what the runtime does
 * anyway. The assertion states exactly that and nothing more.
 */
const props = defineProps<LabelProps & { class?: HTMLAttributes['class'] }>()

const forwarded = computed<LabelProps>(() =>
  Object.fromEntries(
    Object.entries(props).filter(([key, value]) => key !== 'class' && value !== undefined),
  ),
)
</script>

<template>
  <Label
    v-bind="forwarded"
    :class="
      cn(
        'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        props.class,
      )
    "
  >
    <slot />
  </Label>
</template>
