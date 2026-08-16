<script setup lang="ts">
import { useVModel } from '@vueuse/core'
import type { HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * shadcn-vue's Input, with this project's sizing and an `invalid` state.
 *
 * Upstream has no invalid styling, so a field that failed validation looks
 * exactly like one that did not — the error text below it is the only signal,
 * and on a form with several fields that is not enough to say *which* one.
 * `aria-invalid` carries the same information to assistive technology.
 */
const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  invalid?: boolean
  class?: HTMLAttributes['class']
}>()

const emits = defineEmits<{
  'update:modelValue': [payload: string | number]
}>()

// The option object is built conditionally: under exactOptionalPropertyTypes,
// passing `defaultValue: undefined` is not the same as omitting it, and
// useVModel's overloads reject the former. Same pattern as lib/firebase.ts.
const modelValue = useVModel(props, 'modelValue', emits, {
  passive: true,
  ...(props.defaultValue === undefined ? {} : { defaultValue: props.defaultValue }),
})
</script>

<template>
  <input
    v-model="modelValue"
    :aria-invalid="props.invalid || undefined"
    :class="
      cn(
        'flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm text-foreground',
        'shadow-[var(--sh-1)] transition-[border-color,box-shadow] duration-150',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-45',
        props.invalid ? 'border-destructive' : 'border-border-strong',
        props.class,
      )
    "
  />
</template>
