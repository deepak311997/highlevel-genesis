<script setup lang="ts">
import FileEditor from '@/components/workspace/FileEditor.vue'
import FileTree from '@/components/workspace/FileTree.vue'
import { Separator } from '@/components/ui/separator'

/**
 * The code panel — a screen now rather than a labelled placeholder (D18's debt,
 * paid).
 *
 * Composition and nothing else: the tree and the editor each own their four
 * states, and this holds the header and decides only where the two sit. The
 * split is horizontal at every width, because the tree is short and the editor
 * wants the height — and because the narrow layout already spends its width on
 * one panel at a time.
 *
 * The editor is a textarea until Slice 7 swaps in Monaco. That swap touches
 * `FileEditor.vue` and nothing here.
 */
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-testid="editor-panel">
    <header class="flex shrink-0 items-center px-4 py-3">
      <h2 class="text-sm font-semibold">Code</h2>
    </header>

    <Separator />

    <!-- Capped rather than free-growing: a project at the 20-file limit would
         otherwise take the whole panel and leave the editor a sliver.

         **The cap scrolls.** `max-height` alone leaves the tree its content
         height, so `FileTree`'s own scroller never overflows and never scrolls —
         and `overflow-hidden` here would then clip the rows past 14rem with
         nothing to reach them by. The scrolling belongs on the element that
         imposes the limit, which is this one. -->
    <div class="max-h-56 shrink-0 overflow-y-auto">
      <FileTree />
    </div>

    <Separator />

    <FileEditor />
  </section>
</template>
