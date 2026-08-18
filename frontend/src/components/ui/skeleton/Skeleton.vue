<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * shadcn-vue's Skeleton, with one deliberate departure.
 *
 * Upstream's base is `bg-accent`. `style.css` reserves the ember accent for the
 * one element per view that is *live* — a streaming token, a running generation
 * — and says so explicitly. Nineteen pulsing accent blocks would spend the
 * loudest colour in the palette on the calmest state in the app, so the base is
 * `bg-secondary`, which is what all nineteen hand-rolled placeholders already
 * used.
 */
const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div data-slot="skeleton" :class="cn('animate-pulse rounded-md bg-secondary', props.class)" />
</template>
