<script setup lang="ts">
import type { TabsRootEmits, TabsRootProps } from 'reka-ui'
import { TabsRoot, useForwardPropsEmits } from 'reka-ui'
import { computed } from 'vue'

/**
 * shadcn-vue's Tabs, on Reka UI's primitive.
 *
 * `useForwardPropsEmits` is kept — dropping it would stop the wrapper forwarding
 * its declared emits, which do not fall through — but its result carries keys
 * whose value is `undefined`, and exactOptionalPropertyTypes treats those as
 * different from absent. Stripped here, which is what the runtime does anyway.
 * Same fix as `ui/dialog/DialogContent.vue`, and `ui/label/Label.vue` documents
 * it at length.
 */
const props = defineProps<TabsRootProps>()
const emits = defineEmits<TabsRootEmits>()

const forwardedProps = useForwardPropsEmits(props, emits)

const forwarded = computed(() =>
  Object.fromEntries(
    Object.entries(forwardedProps.value).filter(([, value]) => value !== undefined),
  ),
)
</script>

<template>
  <TabsRoot v-bind="forwarded">
    <slot />
  </TabsRoot>
</template>
