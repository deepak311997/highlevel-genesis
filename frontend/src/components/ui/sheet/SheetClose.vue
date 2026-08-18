<script setup lang="ts">
import type { DialogCloseProps } from 'reka-ui'
import { DialogClose } from 'reka-ui'
import { computed } from 'vue'

const props = defineProps<DialogCloseProps>()

/*
 * **Deviation from upstream** (§7.2): omit-undefined forwarding, exactly as
 * `ui/dialog/DialogClose.vue` does and `ui/label/Label.vue` documents.
 */
const forwarded = computed<DialogCloseProps>(() =>
  Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)),
)
</script>

<template>
  <DialogClose v-bind="forwarded">
    <slot />
  </DialogClose>
</template>
