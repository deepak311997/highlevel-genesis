<script setup lang="ts">
import type { SplitterResizeHandleEmits, SplitterResizeHandleProps } from 'reka-ui'
import { GripVertical } from 'lucide-vue-next'
import { SplitterResizeHandle, useForwardPropsEmits } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '@/lib/utils'

/**
 * The splitter between two panels.
 *
 * `useForwardPropsEmits` is kept — dropping it would stop the wrapper forwarding
 * its declared emits, which do not fall through — but its result carries keys
 * whose value is `undefined`, and exactOptionalPropertyTypes treats those as
 * different from absent. Stripped here, which is what the runtime does anyway.
 * Same fix as `ui/dialog/DialogContent.vue`, and `ui/label/Label.vue` documents
 * it at length.
 *
 * `withHandle` is omitted from the forwarded object as well as `class`: it is this
 * wrapper's own prop and not one `SplitterResizeHandle` knows about, so forwarding
 * it would put a stray `withhandle` attribute on the DOM node.
 */
const props = defineProps<
  SplitterResizeHandleProps & { class?: HTMLAttributes['class']; withHandle?: boolean }
>()
const emits = defineEmits<SplitterResizeHandleEmits>()

const forwardedProps = useForwardPropsEmits(props, emits)

const forwarded = computed(() =>
  Object.fromEntries(
    Object.entries(forwardedProps.value).filter(
      ([key, value]) => key !== 'class' && key !== 'withHandle' && value !== undefined,
    ),
  ),
)
</script>

<template>
  <SplitterResizeHandle
    v-bind="forwarded"
    :class="
      cn(
        'relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 [&[data-orientation=vertical]]:h-px [&[data-orientation=vertical]]:w-full [&[data-orientation=vertical]]:after:left-0 [&[data-orientation=vertical]]:after:h-1 [&[data-orientation=vertical]]:after:w-full [&[data-orientation=vertical]]:after:-translate-y-1/2 [&[data-orientation=vertical]]:after:translate-x-0 [&[data-orientation=vertical]>div]:rotate-90',
        props.class,
      )
    "
  >
    <template v-if="props.withHandle">
      <div class="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical class="h-2.5 w-2.5" />
      </div>
    </template>
  </SplitterResizeHandle>
</template>
