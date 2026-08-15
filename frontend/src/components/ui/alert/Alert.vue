<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'
import { alertVariants, type AlertVariants } from '.'

const props = defineProps<{
  class?: HTMLAttributes['class']
  variant?: AlertVariants['variant']
}>()
</script>

<template>
  <!--
    The role follows the variant. Upstream hardcodes role="alert", which makes a
    screen reader interrupt for a success message the same way it does for a
    failure — `status` is the polite equivalent and is what a confirmation wants.
  -->
  <div
    :role="props.variant === 'destructive' ? 'alert' : 'status'"
    :class="cn(alertVariants({ variant: props.variant }), props.class)"
  >
    <slot />
  </div>
</template>
