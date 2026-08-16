<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'
import { alertVariants, type AlertVariants } from '.'

/**
 * shadcn-vue's Alert, with the role following the variant.
 *
 * Upstream hardcodes `role="alert"`, which makes a screen reader interrupt for
 * a success message the same way it does for a failure — `status` is the
 * polite equivalent and is what a confirmation wants.
 *
 * The note lives here rather than in the template on purpose: a comment node
 * beside the root element makes this a *fragment*, and while Vue still applies
 * attribute fallthrough past sibling comments, the component then has no single
 * root to address — `mount(Alert).element` resolves to the comment.
 */
const props = defineProps<{
  class?: HTMLAttributes['class']
  variant?: AlertVariants['variant']
}>()
</script>

<template>
  <div
    :role="props.variant === 'destructive' ? 'alert' : 'status'"
    :class="cn(alertVariants({ variant: props.variant }), props.class)"
  >
    <slot />
  </div>
</template>
