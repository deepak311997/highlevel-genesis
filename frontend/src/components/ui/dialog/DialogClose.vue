<script setup lang="ts">
import type { DialogCloseProps } from 'reka-ui'
import { DialogClose } from 'reka-ui'
import { computed } from 'vue'

const props = defineProps<DialogCloseProps>()

// Omit-undefined forwarding, as `ui/label/Label.vue` documents.
const forwarded = computed<DialogCloseProps>(() =>
  Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)),
)
</script>

<template>
  <DialogClose v-bind="forwarded">
    <slot />
  </DialogClose>
</template>
