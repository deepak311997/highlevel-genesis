<script setup lang="ts">
import type { TabsListProps } from 'reka-ui'
import { TabsList } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * Upstream forwards with `reactiveOmit`. Its result type carries optional keys
 * whose value may be `undefined`, and exactOptionalPropertyTypes treats "absent"
 * and "present but undefined" as different types — so the spread does not
 * type-check against `loop?: boolean`.
 *
 * Rebuilt omitting undefined keys entirely, which is what the runtime does
 * anyway. Same fix as `ui/label/Label.vue`, which documents it at length.
 */
const props = defineProps<TabsListProps & { class?: HTMLAttributes['class'] }>()

const forwarded = computed<TabsListProps>(() =>
  Object.fromEntries(
    Object.entries(props).filter(([key, value]) => key !== 'class' && value !== undefined),
  ),
)
</script>

<template>
  <TabsList
    v-bind="forwarded"
    :class="
      cn(
        'inline-flex items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
        props.class,
      )
    "
  >
    <slot />
  </TabsList>
</template>
