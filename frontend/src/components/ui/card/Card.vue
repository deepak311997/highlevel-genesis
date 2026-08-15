<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <!--
    A vertical gradient and the project's own shadow scale, rather than
    shadcn's flat `bg-card shadow-sm`. Surfaces in this design have a light
    source; a flat fill next to the gradient buttons reads as a different
    system.
  -->
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
