<script setup lang="ts">
/**
 * Where the file tree and the editor go — **a labelled placeholder** (D18).
 *
 * It is structure, not a screen: no request, no data and no failure mode, so the
 * loading/empty/error rule has nothing to attach to. That rule applies in full to
 * the workspace route and to the chat panel, which do have all three.
 *
 * It names the slices that fill it so the empty space reads as planned rather than
 * unfinished — files and the tree in Slice 6, Monaco in Slice 7.
 */
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-testid="editor-panel">
    <header class="flex shrink-0 items-center px-4 py-3">
      <h2 class="text-sm font-semibold">Code</h2>
    </header>

    <div class="flex flex-1 items-center justify-center p-6">
      <p class="max-w-xs text-center text-sm text-muted-foreground">
        Generated files arrive in Slice 6, and the editor in Slice 7.
      </p>
    </div>
  </section>
</template>
