<script setup lang="ts">
/**
 * Where the live preview goes — **a labelled placeholder** (D18), on the same terms
 * as `EditorPanel`: structure rather than a screen, so there is no request to have a
 * loading, empty or error state for.
 *
 * Slice 10 fills it, and that is where the workspace header's connection badge stops
 * being informational: "connected" is the difference between real CRM data in here
 * and an empty one.
 */
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" data-testid="preview-panel">
    <header class="flex shrink-0 items-center px-4 py-3">
      <h2 class="text-sm font-semibold">Preview</h2>
    </header>

    <div class="flex flex-1 items-center justify-center p-6">
      <p class="max-w-xs text-center text-sm text-muted-foreground">
        A live preview against your CRM data arrives in Slice 10.
      </p>
    </div>
  </section>
</template>
