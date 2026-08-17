<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The project's files — four states, all shipped: loading, rows, empty, error.
 *
 * It **reflects** the store rather than deciding anything. The order and the
 * union of stored and streaming paths are `lib/files.ts`'s, with their own L1
 * tests; sorting again in the template would be a second implementation of one
 * rule, free to drift.
 *
 * The branches are ordered **error first**, `ProjectsCard`'s rule and for its
 * reason: a failed first request leaves `filesLoaded` false, so a loading branch
 * ahead of the error would render a skeleton forever and never show the failure.
 *
 * The rows key off `fileTree` rather than off `files`, which is what lets a
 * generation streaming into a brand-new project replace the empty state instead
 * of rendering beside it.
 */
const workspace = useWorkspaceStore()
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
      <div class="h-6 w-2/3 animate-pulse rounded-md bg-secondary" />
      <div class="h-6 w-1/2 animate-pulse rounded-md bg-secondary" />
    </div>

    <ScrollArea v-else-if="workspace.fileTree.length > 0" class="min-h-0 flex-1">
      <ul class="flex flex-col gap-0.5 p-2">
        <li v-for="row in workspace.fileTree" :key="row.path">
          <button
            type="button"
            data-testid="file-row"
            :data-path="row.path"
            :data-selected="String(row.path === workspace.selectedPath)"
            :data-writing="String(row.writing)"
            class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary"
            :class="row.path === workspace.selectedPath ? 'bg-secondary font-medium' : ''"
            @click="workspace.selectFile(row.path)"
          >
            <span class="truncate">{{ row.path }}</span>
            <!--
              The marker is the whole of "the tree fills in as the reply streams".
              Without it a file whose bytes are still arriving is indistinguishable
              from one that is stored, which is the wrong thing to say about
              content that is not saved yet.
            -->
            <span
              v-if="row.writing"
              class="shrink-0 text-xs text-muted-foreground"
              aria-label="Writing"
            >
              Writing…
            </span>
          </button>
        </li>
      </ul>
    </ScrollArea>

    <!-- Asked, and there is nothing — for a project that has never generated. -->
    <div v-else data-testid="file-tree-empty" class="p-3">
      <p class="text-sm text-muted-foreground">No files yet. Describe the app you want.</p>
    </div>
  </div>
</template>
