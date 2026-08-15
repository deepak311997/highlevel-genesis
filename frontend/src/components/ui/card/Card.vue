<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{ class?: string }>(), { class: '' })
</script>

<template>
  <div
    :class="
      cn(
        'rounded-lg border bg-gradient-to-b from-raised to-card text-card-foreground shadow-e1',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
