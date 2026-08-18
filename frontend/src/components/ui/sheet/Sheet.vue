<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from 'reka-ui'
import { DialogRoot, useForwardPropsEmits } from 'reka-ui'

/**
 * shadcn-vue's Sheet, added with `npx shadcn-vue@latest add sheet` (§7.2).
 *
 * A sheet *is* a dialog — Reka UI's `DialogRoot` under both — which is why this
 * root is byte-for-byte `ui/dialog/Dialog.vue`. The two are kept separate all
 * the same, because upstream ships them as two components and §7.2's rule is
 * that provenance stays checkable by diffing against upstream.
 *
 * No omit-undefined fix here: `DialogRootProps` has no exactOptionalProperty
 * problem to fix, since `useForwardPropsEmits`'s result is spread onto a
 * component that accepts the same optional keys. The wrappers that *do* need it
 * say so where they need it.
 */
const props = defineProps<DialogRootProps>()
const emits = defineEmits<DialogRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <DialogRoot v-bind="forwarded">
    <slot />
  </DialogRoot>
</template>
