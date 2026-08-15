<script setup lang="ts">
import { cn } from '@/lib/utils'

/**
 * Somewhere to put a failure that is not attached to one field — a network
 * error, a throttle refusal, an expired link. The role follows the tone, so a
 * screen reader interrupts for an error but not for a confirmation.
 */
const props = withDefaults(defineProps<{ tone?: 'error' | 'info' | 'success'; class?: string }>(), {
  tone: 'info',
  class: '',
})

const TONES = {
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
  info: 'border-border-strong bg-secondary text-muted-foreground',
  success: 'border-accent/40 bg-accent/10 text-accent',
} as const
</script>

<template>
  <div
    :role="props.tone === 'error' ? 'alert' : 'status'"
    :class="cn('rounded-md border px-3 py-2 text-sm', TONES[props.tone], props.class)"
  >
    <slot />
  </div>
</template>
