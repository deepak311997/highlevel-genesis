<script setup lang="ts">
import type { TabsContentProps } from 'reka-ui'
import { TabsContent } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * Upstream forwards with `reactiveOmit`. Its result type carries optional keys
 * whose value may be `undefined`, and exactOptionalPropertyTypes treats "absent"
 * and "present but undefined" as different types — so the spread does not
 * type-check against `forceMount?: boolean`.
 *
 * Rebuilt omitting undefined keys entirely, which is what the runtime does
 * anyway. Same fix as `ui/label/Label.vue`, which documents it at length.
 *
 * `value` is bound explicitly in the template and filtered out of the spread,
 * because it is the one prop this primitive *requires* — a filtered record cannot
 * promise the compiler it is still in there, and binding it separately makes that
 * checked rather than asserted.
 */
const props = defineProps<TabsContentProps & { class?: HTMLAttributes['class'] }>()

const forwarded = computed(() =>
  Object.fromEntries(
    Object.entries(props).filter(
      ([key, value]) => key !== 'class' && key !== 'value' && value !== undefined,
    ),
  ),
)
</script>

<template>
  <TabsContent
    v-bind="forwarded"
    :value="props.value"
    :class="
      cn(
        'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        props.class,
      )
    "
  >
    <slot />
  </TabsContent>
</template>
