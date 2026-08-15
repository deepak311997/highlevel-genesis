<script setup lang="ts">
import { cn } from '@/lib/utils'

/**
 * `for` defaults to '' rather than undefined. Two rules pull opposite ways
 * here: eslint-plugin-vue wants every optional prop to have a default, and
 * exactOptionalPropertyTypes rejects `undefined` as one — an absent property
 * and a property set to undefined are different types. An empty string
 * satisfies both, and the binding below omits the attribute when it is blank.
 */
const props = withDefaults(defineProps<{ for?: string; class?: string }>(), {
  for: '',
  class: '',
})
</script>

<template>
  <label
    :for="props.for === '' ? undefined : props.for"
    :class="cn('text-sm font-medium leading-none text-foreground', props.class)"
  >
    <slot />
  </label>
</template>
