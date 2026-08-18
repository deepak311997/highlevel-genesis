<script setup lang="ts">
import { PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import EditorTabs from '@/components/workspace/EditorTabs.vue'
import FileEditor from '@/components/workspace/FileEditor.vue'
import FileTree from '@/components/workspace/FileTree.vue'
import SnapshotSheet from '@/components/workspace/SnapshotSheet.vue'
import { Separator } from '@/components/ui/separator'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The code panel — a header, an explorer rail, and the editor beside it.
 *
 * Composition and nothing else: the tree and the editor each own their four
 * states, and this holds the header and decides only where the two sit.
 *
 * **The tree is beside the editor, not above it** — the arrangement every editor
 * a user has already learned puts it in, and the fix for what the stacked
 * version cost. A list capped at 14rem across the top spent the panel's scarcest
 * axis on its least important content: the panel is 35% of a viewport, so a
 * 224px band of filenames plus a tab strip plus a footer left the editor a
 * sliver, and a project at the twenty-file cap scrolled a list inside a column
 * that was itself already short. Sideways, the rail spends *width*, which the
 * splitter can give back and which the user can reclaim entirely — see below.
 *
 * **The rail collapses**, from a control in the header. Two-fifths of a narrow
 * panel is a real cost when you are reading code rather than navigating it, and
 * the tab strip already names every file that is open — so the tree is
 * genuinely optional once you are in a file. `v-if` rather than a width of zero:
 * a collapsed rail must leave the focus order too, or tabbing through the panel
 * walks a list nobody can see.
 *
 * **The height chain is load-bearing** (D19, R4). Monaco measures its container,
 * so a container sized by its own content collapses the editor to 0 px and
 * renders nothing at all, with no error attached — and jsdom computes no layout,
 * so nothing below L5 can see it. The chain is this section's `h-full min-h-0`,
 * then the row's `min-h-0 flex-1`, then the editor column's, then
 * `FileEditor`'s `min-h-0 flex-1`, then `CodeEditor`'s `h-full`. Any link left
 * out and the box has no definite height. Its spec pins the classes; AC-30
 * measures the real box in a browser.
 *
 * **The rail is the box that scrolls**, because it is the box with a bounded
 * height: it is a flex item in a row whose height comes from the panel, so its
 * overflow is real and `FileTree` needs no scroller of its own. The stacked
 * version had to say this the hard way — a `max-height` alone left the tree its
 * content height, so the inner scroller never overflowed and the rows past the
 * cap were simply unreachable.
 */
const workspace = useWorkspaceStore()

/**
 * Open on arrival, in both layouts.
 *
 * A code panel whose file list is hidden until you find the control is a panel
 * that opens on an empty grey box for anyone who has not been told about the
 * button. The narrow layout gets the same default and the same rail, sized as a
 * fraction rather than a fixed width, so a 390px viewport gives the tree 160px
 * instead of the 224 a desktop rail would have taken.
 *
 * Local rather than in the store, unlike the composer's draft (D17): losing a
 * fold on a window resize costs a click, where losing a half-typed message costs
 * the message.
 */
const explorerOpen = ref(true)

/** For the header's count — the tree's own rows, so a streaming file is in it. */
const fileCount = computed(() => workspace.fileTree.length)
</script>

<template>
  <!-- `h-full` **and** `flex-1`, because the two layouts hand this section its
       height differently: the wide one puts it in a stretch-sized
       `ResizablePanel` (a percentage resolves), the narrow one in a `TabsContent`
       sized by `flex-grow` (a percentage does not — it collapses to content, and
       Monaco to 5px). Each class is inert in the other layout. -->
  <section class="flex h-full min-h-0 flex-1 flex-col" data-testid="editor-panel">
    <!-- The header is the panel's only chrome: what this is, how much of it there
         is, and the two controls that act on the whole panel. `SnapshotSheet`
         owns everything past its click — this panel neither knows nor stores
         whether the sheet is open (D20). -->
    <header class="flex shrink-0 items-center gap-2 px-3 py-2.5">
      <button
        type="button"
        data-testid="explorer-toggle"
        :aria-expanded="explorerOpen"
        :aria-label="explorerOpen ? 'Hide the file list' : 'Show the file list'"
        class="rounded-sm p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        @click="explorerOpen = !explorerOpen"
      >
        <PanelLeftClose v-if="explorerOpen" class="size-4" aria-hidden="true" />
        <PanelLeftOpen v-else class="size-4" aria-hidden="true" />
      </button>

      <h2 class="label-micro">Code</h2>

      <!-- Withheld at zero: "0 files" over the tree's own empty state says the
           same thing twice, and says it first in the language of a counter. -->
      <span v-if="fileCount > 0" class="label-micro tabular" data-testid="editor-file-count">
        {{ fileCount }}
      </span>

      <div class="ml-auto">
        <SnapshotSheet />
      </div>
    </header>

    <Separator />

    <!-- The row: rail, hairline, editor. `min-h-0` on both the row and the
         column, or the chain above breaks at the first link that can grow. -->
    <div class="flex min-h-0 flex-1">
      <aside
        v-if="explorerOpen"
        data-testid="file-explorer"
        aria-label="Project files"
        class="w-2/5 min-w-40 max-w-56 shrink-0 overflow-y-auto border-r border-border"
      >
        <FileTree />
      </aside>

      <!-- The strip sits above the editor and outside `FileEditor`: it is what
           the panel navigates *by*, and it stays put while the editor below it
           swaps between the empty, loading, failed and open states. -->
      <div class="flex min-h-0 flex-1 flex-col">
        <EditorTabs />
        <FileEditor />
      </div>
    </div>
  </section>
</template>
