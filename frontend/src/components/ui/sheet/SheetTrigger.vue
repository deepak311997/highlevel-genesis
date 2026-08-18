<script setup lang="ts">
import type { DialogTriggerProps } from 'reka-ui'
import { DialogTrigger } from 'reka-ui'
import { computed } from 'vue'

const props = defineProps<DialogTriggerProps>()

/*
 * **Deviation from upstream** (§7.2): upstream binds `props` straight through.
 * Omit-undefined forwarding instead, as `ui/label/Label.vue` documents at
 * length and `ui/dialog/DialogTrigger.vue` already does — this project's
 * exactOptionalPropertyTypes treats a key present and `undefined` as different
 * from a key absent, and the straight spread does not type-check against
 * `as?: AsTag`. Stripping them is what the runtime does anyway.
 */
const forwarded = computed<DialogTriggerProps>(() =>
  Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)),
)
</script>

<template>
  <DialogTrigger v-bind="forwarded">
    <slot />
  </DialogTrigger>
</template>
