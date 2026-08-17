<script setup lang="ts">
import EditorTabs from '@/components/workspace/EditorTabs.vue'
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
 * **The height chain is load-bearing** (D19, R4). Monaco measures its container,
 * so a container sized by its own content collapses the editor to 0 px and
 * renders nothing at all, with no error attached — and jsdom computes no layout,
 * so nothing below L5 can see it. The chain is this section's `h-full min-h-0`,
 * then `FileEditor`'s `min-h-0 flex-1`, then `CodeEditor`'s `h-full`. Any link
 * left out and the box has no definite height. Its spec pins the classes; AC-30
 * measures the real box in a browser.
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

    <!-- Between the tree and the editor, and outside `FileEditor`: the strip is
         what the panel navigates *by*, and it stays put while the editor below
         it swaps between the empty, loading, failed and open states. -->
    <EditorTabs />

    <FileEditor />
  </section>
</template>
