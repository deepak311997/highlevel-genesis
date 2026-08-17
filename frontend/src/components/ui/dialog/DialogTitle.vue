<script setup lang="ts">
import type { DialogTitleProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { DialogTitle } from 'reka-ui'
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<DialogTitleProps & { class?: HTMLAttributes['class'] }>()

/*
 * Upstream forwards with `reactiveOmit` + `useForwardProps`. Its result type
 * carries optional keys whose value may be `undefined`, and
 * exactOptionalPropertyTypes treats "absent" and "present but undefined" as
 * different types — so the spread does not type-check against `as?: AsTag`.
 *
 * Rebuilt omitting undefined keys entirely, which is what the runtime does
 * anyway. Same fix as `ui/label/Label.vue`, which documents it at length.
 */
const forwardedProps = computed<DialogTitleProps>(() =>
  Object.fromEntries(
    Object.entries(props).filter(([key, value]) => key !== 'class' && value !== undefined),
  ),
)
</script>

<template>
  <DialogTitle
    v-bind="forwardedProps"
    :class="cn('text-lg font-semibold leading-none tracking-tight', props.class)"
  >
    <slot />
  </DialogTitle>
</template>
