<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import FileIcon from '@/components/workspace/FileIcon.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { groupFileTree, type FileKind } from '@/lib/files'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The project's files — four states: loading, rows, empty, error.
 *
 * It **reflects** the store rather than deciding anything: the order, the union of
 * stored and streaming paths, and the grouping are all `lib/files.ts`'s.
 *
 * **Sections by kind, because a flat namespace has no other hierarchy.** The server
 * refuses slashes outright, so there are no directories to draw. The headings are
 * `label-micro`, so a group of one costs an 11px line rather than a row.
 *
 * **Plain `ul`/`li` with buttons, not `role="tree"`.** A real tree widget owes the
 * user roving tabindex, arrow-key traversal and typeahead, and half of that is
 * worse than none — the role would promise keyboard behaviour this does not have.
 *
 * **Error first**: a failed first request leaves `filesLoaded` false, so a loading
 * branch ahead of it would render a skeleton forever. The rows key off `fileTree`
 * rather than `files`, which is what lets a generation streaming into a new project
 * replace the empty state instead of rendering beside it.
 */
const workspace = useWorkspaceStore()

const groups = computed(() => groupFileTree(workspace.fileTree))

/**
 * Which sections are folded, held as the *exception* rather than the state: a set
 * of what the user closed is empty in the common case and needs no seeding when a
 * generation introduces a kind the project did not have before.
 */
const collapsed = ref(new Set<FileKind>())

function toggle(kind: FileKind): void {
  // A new Set rather than a mutation: `ref` over a Set is not deeply reactive
  // to `add`/`delete`, and the rows would fold with nothing on screen changing.
  const next = new Set(collapsed.value)
  if (!next.delete(kind)) next.add(kind)
  collapsed.value = next
}
</script>

<template>
  <div class="flex min-h-0 flex-col" data-testid="file-tree">
    <!-- Error first: `filesLoaded` is false after a failure, so a loading branch
         above this would render a skeleton that never resolves. -->
    <div v-if="workspace.filesError" data-testid="file-tree-error" class="flex flex-col gap-2 p-3">
      <Alert variant="destructive">
        <AlertDescription>{{ workspace.filesError }}</AlertDescription>
      </Alert>
      <Button
        variant="outline"
        size="sm"
        data-testid="file-tree-retry"
        @click="workspace.loadFiles()"
      >
        Try again
      </Button>
    </div>

    <!-- No answer yet — in flight, or not started. `filesLoading` alone cannot say
         the second: it is still false between mounting and the request going out,
         and an empty state shown then reads as a project with no code. -->
    <div
      v-else-if="workspace.filesLoading || !workspace.filesLoaded"
      data-testid="file-tree-loading"
      class="flex flex-col gap-2 p-3"
    >
      <Skeleton class="h-5 w-2/3 rounded-md" />
      <Skeleton class="h-5 w-1/2 rounded-md" />
    </div>

    <!-- No scroller of its own: the explorer rail is the box with a bounded height
         and therefore the box that scrolls. A second one here would sit in a
         container the height of its own content and could never overflow. -->
    <div v-else-if="groups.length > 0" class="min-h-0 flex-1 py-1.5">
      <ul class="flex flex-col">
        <li v-for="group in groups" :key="group.kind">
          <!-- The heading is a control, so the twenty-file cap can be folded down to
               the kind you are working in. `aria-expanded` on a button is the whole
               of the disclosure semantics. -->
          <button
            type="button"
            data-testid="file-group"
            :data-kind="group.kind"
            :aria-expanded="!collapsed.has(group.kind)"
            class="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left hover:bg-secondary"
            @click="toggle(group.kind)"
          >
            <ChevronRight
              class="size-3 shrink-0 text-muted-foreground transition-transform duration-150"
              :class="collapsed.has(group.kind) ? '' : 'rotate-90'"
              aria-hidden="true"
            />
            <span class="label-micro truncate">{{ group.label }}</span>
            <span class="label-micro tabular ml-auto">{{ group.rows.length }}</span>
          </button>

          <ul v-if="!collapsed.has(group.kind)" class="flex flex-col pb-1">
            <li v-for="row in group.rows" :key="row.path">
              <button
                type="button"
                data-testid="file-row"
                :data-path="row.path"
                :data-selected="String(row.path === workspace.selectedPath)"
                :data-writing="String(row.writing)"
                :aria-current="row.path === workspace.selectedPath ? 'true' : undefined"
                :title="row.path"
                class="group flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 pl-[1.375rem] text-left hover:bg-secondary"
                :class="
                  row.path === workspace.selectedPath
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground'
                "
                @click="workspace.selectFile(row.path)"
              >
                <FileIcon :path="row.path" class="size-3.5 opacity-70" />
                <!-- Mono, because a filename is machine output: a path here and the
                     same path in the tab strip are set in the same face. -->
                <span class="truncate font-mono text-xs">{{ row.path }}</span>
                <!-- The marker is the whole of "the tree fills in as the reply
                     streams": without it a file whose bytes are still arriving is
                     indistinguishable from one that is stored. -->
                <span
                  v-if="row.writing"
                  class="label-micro ml-auto shrink-0 text-primary"
                  aria-label="Writing"
                >
                  Writing…
                </span>
              </button>
            </li>
          </ul>
        </li>
      </ul>
    </div>

    <!-- Asked, and there is nothing — for a project that has never generated. -->
    <div v-else data-testid="file-tree-empty" class="p-3">
      <p class="text-sm text-muted-foreground">No files yet. Describe the app you want.</p>
    </div>
  </div>
</template>
