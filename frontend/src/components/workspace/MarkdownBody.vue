<script setup lang="ts">
import type { Block } from '@/lib/markdown'

/**
 * A parsed reply, rendered as elements.
 *
 * **Nothing here is a string of markup.** Every value arrives as text in a
 * `{{ }}` slot or as a link's `href`, which `markdown.ts` has already restricted
 * to `http(s)`. That is the security argument in `markdown.ts`'s module comment,
 * and `no-v-html.spec.ts` is what keeps it true as this file grows.
 *
 * Split out from `MessageBody` so the file-marker grouping and the prose grammar
 * are separately readable — this component knows nothing about files, and the
 * other knows nothing about emphasis.
 */
const props = defineProps<{
  blocks: Block[]
  /**
   * Draw a terminal-style caret after the last paragraph.
   *
   * **Paragraph only, deliberately.** A caret means "the next character lands
   * here", which is true at the end of running prose and misleading anywhere
   * else — parked after a list item it suggests that item is still growing when
   * the model has usually moved on to the next block. When the reply ends on a
   * list or a fence there is simply no caret, and `StreamingStatus`'s spinner is
   * what carries liveness. A cursor that is sometimes right is worse than one
   * that is only ever drawn where it is right.
   */
  caret?: boolean
}>()

/** The last block, so the caret can be appended to it rather than after it. */
function isLast(index: number): boolean {
  return props.caret && index === props.blocks.length - 1
}
</script>

<template>
  <template v-for="(block, index) in blocks" :key="index">
    <!--
      `whitespace-pre-line` rather than `pre-wrap`: the parser has already
      collapsed blank lines into block boundaries, so what is left inside a
      paragraph is the model's own line breaks, which are meaningful. `pre-wrap`
      would additionally preserve the indentation of a wrapped bullet.
    -->
    <p v-if="block.kind === 'paragraph'" class="whitespace-pre-line text-sm leading-relaxed">
      <template v-for="(part, at) in block.inline" :key="at">
        <strong v-if="part.kind === 'strong'" class="font-semibold text-foreground">{{
          part.text
        }}</strong>
        <em v-else-if="part.kind === 'em'" class="italic">{{ part.text }}</em>
        <code
          v-else-if="part.kind === 'code'"
          class="box-decoration-clone rounded border border-border-strong bg-secondary px-1 py-px font-mono text-[0.8125em]"
          >{{ part.text }}</code
        >
        <a
          v-else-if="part.kind === 'link'"
          :href="part.href"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium underline underline-offset-2 hover:text-primary"
          >{{ part.text }}</a
        >
        <template v-else>{{ part.text }}</template>
      </template>
      <span
        v-if="isLast(index)"
        data-testid="stream-caret"
        aria-hidden="true"
        class="animate-caret ml-px inline-block w-[0.45em] translate-y-px bg-foreground align-baseline text-transparent"
        >&nbsp;</span
      >
    </p>

    <component
      :is="block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5'"
      v-else-if="block.kind === 'heading'"
      class="mt-1 text-sm font-semibold tracking-tight text-foreground"
    >
      <template v-for="(part, at) in block.inline" :key="at">{{ part.text }}</template>
    </component>

    <component
      :is="block.ordered ? 'ol' : 'ul'"
      v-else-if="block.kind === 'list'"
      class="flex flex-col gap-1 pl-5 text-sm leading-relaxed"
      :class="block.ordered ? 'list-decimal' : 'list-disc'"
    >
      <li v-for="(item, at) in block.items" :key="at" class="pl-0.5 marker:text-muted-foreground">
        <template v-for="(part, sub) in item" :key="sub">
          <strong v-if="part.kind === 'strong'" class="font-semibold text-foreground">{{
            part.text
          }}</strong>
          <em v-else-if="part.kind === 'em'" class="italic">{{ part.text }}</em>
          <code
            v-else-if="part.kind === 'code'"
            class="box-decoration-clone rounded border border-border-strong bg-secondary px-1 py-px font-mono text-[0.8125em]"
            >{{ part.text }}</code
          >
          <a
            v-else-if="part.kind === 'link'"
            :href="part.href"
            target="_blank"
            rel="noopener noreferrer"
            class="font-medium underline underline-offset-2 hover:text-primary"
            >{{ part.text }}</a
          >
          <template v-else>{{ part.text }}</template>
        </template>
      </li>
    </component>

    <!-- Its own scroller, so a long line scrolls the block and never the panel. -->
    <pre
      v-else-if="block.kind === 'code'"
      class="overflow-x-auto rounded-md border border-border-strong bg-secondary/60 p-3 font-mono text-xs leading-relaxed"
    ><code>{{ block.text }}</code></pre>

    <blockquote
      v-else-if="block.kind === 'quote'"
      class="border-l-2 border-border pl-3 text-sm italic text-muted-foreground"
    >
      <template v-for="(part, at) in block.inline" :key="at">{{ part.text }}</template>
    </blockquote>

    <hr v-else class="border-border" />
  </template>
</template>
