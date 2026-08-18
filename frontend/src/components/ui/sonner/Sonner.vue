<script setup lang="ts">
import { Toaster as Sonner } from 'vue-sonner'

import { useDarkClass } from '@/composables/useDarkClass'

/**
 * shadcn-vue's Sonner, themed off this project's own dark-mode signal.
 *
 * Upstream's template derives the theme from `@vueuse/core`'s `useColorMode`.
 * This project already owns `useDarkClass()`, which *observes* the `dark` class
 * that `useTheme` and the pre-paint script in `index.html` both write — so
 * reading it here is reading the answer rather than deriving it a second time.
 * A second derivation is exactly what `useDarkClass`'s doc comment exists to
 * prevent: it is how one surface ends up light inside a dark app with no error
 * attached.
 *
 * Mounted once, at the shell root in `App.vue`, outside `<main>` so the
 * contained/full layout switch cannot unmount it mid-toast.
 */
const dark = useDarkClass()
</script>

<template>
  <Sonner class="toaster group" position="bottom-right" :theme="dark ? 'dark' : 'light'" />
</template>
