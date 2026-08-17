<script setup lang="ts">
import type { TabsTriggerProps } from 'reka-ui'
import { TabsTrigger } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * Upstream forwards with `reactiveOmit` + `useForwardProps`. Its result type
 * carries optional keys whose value may be `undefined`, and
 * exactOptionalPropertyTypes treats "absent" and "present but undefined" as
 * different types — so the spread does not type-check against `disabled?: boolean`.
 *
 * Rebuilt omitting undefined keys entirely, which is what the runtime does
 * anyway. Same fix as `ui/label/Label.vue`, which documents it at length.
 *
 * `value` is bound explicitly in the template and filtered out of the spread,
 * because it is the one prop this primitive *requires* — a filtered record cannot
 * promise the compiler it is still in there, and binding it separately makes that
 * checked rather than asserted.
 */
const props = defineProps<TabsTriggerProps & { class?: HTMLAttributes['class'] }>()

const forwarded = computed(() =>
  Object.fromEntries(
    Object.entries(props).filter(
      ([key, value]) => key !== 'class' && key !== 'value' && value !== undefined,
    ),
  ),
)
</script>

<template>
  <TabsTrigger
    v-bind="forwarded"
    :value="props.value"
    :class="
      cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        props.class,
      )
    "
  >
    <span class="truncate">
      <slot />
    </span>
  </TabsTrigger>
</template>
