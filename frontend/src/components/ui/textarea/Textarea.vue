<script setup lang="ts">
import { useVModel } from '@vueuse/core'
import type { HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * shadcn-vue's Textarea — the composer's input control (D21).
 *
 * Two deviations from upstream, both forced by this project's compiler and linter
 * rather than chosen, and both already established by `ui/input/Input.vue`:
 *
 * The emits declaration is a function type rather than a call-signature object
 * literal, for typescript-eslint's `prefer-function-type`.
 *
 * The `useVModel` option object is built conditionally, because under
 * exactOptionalPropertyTypes passing `defaultValue: undefined` is not the same as
 * omitting it, and `useVModel`'s overloads reject the former.
 */
const props = defineProps<{
  class?: HTMLAttributes['class']
  defaultValue?: string | number
  modelValue?: string | number
}>()

const emits = defineEmits<{
  'update:modelValue': [payload: string | number]
}>()

const modelValue = useVModel(props, 'modelValue', emits, {
  passive: true,
  ...(props.defaultValue === undefined ? {} : { defaultValue: props.defaultValue }),
})
</script>

<template>
  <textarea
    v-model="modelValue"
    :class="
      cn(
        'flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  />
</template>
