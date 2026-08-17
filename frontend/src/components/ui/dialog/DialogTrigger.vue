<script setup lang="ts">
import type { DialogTriggerProps } from 'reka-ui'
import { DialogTrigger } from 'reka-ui'
import { computed } from 'vue'

const props = defineProps<DialogTriggerProps>()

// Omit-undefined forwarding, as `ui/label/Label.vue` documents.
const forwarded = computed<DialogTriggerProps>(() =>
  Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)),
)
</script>

<template>
  <DialogTrigger v-bind="forwarded">
    <slot />
  </DialogTrigger>
</template>
