<script setup lang="ts">
import { cn } from '@/lib/utils'
import { buttonVariants, type ButtonSize, type ButtonVariant } from './index'

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant
    size?: ButtonSize
    disabled?: boolean
    class?: string
  }>(),
  { variant: 'default', size: 'default', disabled: false, class: '' },
)
</script>

<template>
  <button
    :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)"
    :disabled="props.disabled"
  >
    <slot />
  </button>
</template>
