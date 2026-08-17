<script setup lang="ts">
import type { SplitterGroupEmits, SplitterGroupProps } from 'reka-ui'
import { SplitterGroup, useForwardPropsEmits } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * shadcn-vue's ResizablePanelGroup, on Reka UI's Splitter.
 *
 * `useForwardPropsEmits` is kept — dropping it would stop the wrapper forwarding
 * its declared emits, which do not fall through — but its result carries keys
 * whose value is `undefined`, and exactOptionalPropertyTypes treats those as
 * different from absent. Stripped here, which is what the runtime does anyway.
 * Same fix as `ui/dialog/DialogContent.vue`, and `ui/label/Label.vue` documents
 * it at length.
 *
 * `direction` is bound explicitly in the template and filtered out of the spread,
 * because it is the one prop `SplitterGroup` *requires* — a filtered record cannot
 * promise the compiler it is still in there, and binding it separately makes that
 * checked rather than asserted.
 */
const props = defineProps<SplitterGroupProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<SplitterGroupEmits>()

const forwardedProps = useForwardPropsEmits(props, emits)

const forwarded = computed(() =>
  Object.fromEntries(
    Object.entries(forwardedProps.value).filter(
      ([key, value]) => key !== 'class' && key !== 'direction' && value !== undefined,
    ),
  ),
)
</script>

<template>
  <SplitterGroup
    v-bind="forwarded"
    :direction="props.direction"
    :class="cn('flex h-full w-full data-[orientation=vertical]:flex-col', props.class)"
  >
    <slot />
  </SplitterGroup>
</template>
