<script setup lang="ts">
import { Braces, Brackets, CodeXml, File, FileText, Palette } from 'lucide-vue-next'
import { computed, type Component } from 'vue'

import { fileKind, type FileKind } from '@/lib/files'

/**
 * A file's glyph — one component, so the tree and the tab strip cannot disagree.
 *
 * The kind itself is `lib/files.ts`'s, tested there; all that is decided here is
 * which shape stands for it. **Monochrome on purpose**: Instrument has one blue
 * and spends it on links, focus and the primary action, so a five-colour
 * file-type palette would be the decoration this language exists to remove. The
 * kinds are told apart by shape, and the caller decides size and tone — an
 * inactive tab dims its glyph, an active one does not.
 *
 * Decorative, always. `Icon` marks itself `aria-hidden` when it is given no
 * accessible name, which is the right default here: every row and every tab
 * already carries the filename as text, and an icon that announced "code" first
 * would read the same file twice.
 */
const props = defineProps<{ path: string }>()

const ICONS = {
  markup: CodeXml,
  style: Palette,
  script: Braces,
  data: Brackets,
  doc: FileText,
  other: File,
} as const satisfies Record<FileKind, Component>

const icon = computed<Component>(() => ICONS[fileKind(props.path)])
</script>

<template>
  <component :is="icon" class="size-3.5 shrink-0" />
</template>
