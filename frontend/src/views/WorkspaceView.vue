<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import ChatPanel from '@/components/workspace/ChatPanel.vue'
import EditorPanel from '@/components/workspace/EditorPanel.vue'
import PreviewPanel from '@/components/workspace/PreviewPanel.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * The three-panel workspace: chat, code and preview.
 *
 * **The project is fetched before the transcript, not beside it** (D25). The 404 is
 * the reason: fetched in parallel, a deleted project produces two failures and this
 * view has to decide which of them it is rendering, and a request goes out for a
 * transcript that cannot exist. In sequence there is one answer. The store owns that
 * order; this view only says which project.
 *
 * **The layout switch is a `v-if`, not Tailwind's `hidden lg:*`** (D16). CSS-only
 * visibility would leave both trees mounted at once, which makes "all three panels
 * are present" and "one panel is shown at a time" simultaneously true of the same
 * DOM — AC-23 and AC-24 would both pass against a broken screen. Mounting one tree at
 * a time also means one chat panel, so the composer's store-held draft (D17) is the
 * only thing that has to survive the swap.
 *
 * One `watch` with `immediate: true` covers both the first mount and a later param
 * change — a deep link, a reload, and navigating from one project to another are the
 * same event as far as this view is concerned.
 */
const workspace = useWorkspaceStore()
const route = useRoute()

/** Tailwind's `lg`. Matched in JS because the tree, not the styling, is what changes. */
const isWide = useMediaQuery('(min-width: 1024px)')

watch(
  () => route.params['projectId'],
  (projectId) => {
    if (projectId === undefined) return
    void workspace.open(String(projectId))
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!--
      No answer yet. Deliberately **no panels** — three empty panels during a load
      are three things that look broken, and AC-20 is the contract.
    -->
    <div
      v-if="workspace.projectLoading"
      data-testid="workspace-loading"
      class="mx-auto w-full max-w-5xl px-6 py-10"
    >
      <Skeleton class="h-6 w-56 rounded" />
    </div>

    <!--
      Gone: absent, soft-deleted, unreadable or somebody else's — one answer for all
      four (D14). No retry, because there is nothing here to succeed on a second
      attempt; the way out is the dashboard.
    -->
    <div
      v-else-if="workspace.projectMissing"
      data-testid="workspace-missing"
      class="mx-auto flex w-full max-w-5xl flex-col items-start gap-4 px-6 py-10"
    >
      <p class="text-sm text-muted-foreground">That project no longer exists.</p>
      <Button as-child variant="secondary" size="sm">
        <RouterLink to="/dashboard">Back to dashboard</RouterLink>
      </Button>
    </div>

    <!-- Any other failure: the server's own message, and something to retry with. -->
    <div
      v-else-if="workspace.projectError"
      data-testid="workspace-error"
      class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-10"
    >
      <Alert variant="destructive">
        <AlertDescription>{{ workspace.projectError }}</AlertDescription>
      </Alert>
      <Button
        variant="outline"
        class="self-start"
        data-testid="workspace-retry"
        @click="workspace.open(String(route.params['projectId']))"
      >
        Try again
      </Button>
    </div>

    <template v-else-if="workspace.project">
      <header class="flex shrink-0 flex-wrap items-center gap-3 px-6 py-4">
        <h1 class="truncate text-lg font-semibold" data-testid="workspace-name">
          {{ workspace.project.name }}
        </h1>
        <!--
          The first thing in the product to read the locationId Slice 3 stores, and
          informational until Slice 10, where "connected" is the difference between
          real CRM data in the preview and an empty one.
        -->
        <Badge
          :variant="workspace.project.locationId ? 'good' : 'secondary'"
          data-testid="workspace-connection"
        >
          {{ workspace.project.locationId ? 'HighLevel connected' : 'Not connected' }}
        </Badge>
        <RouterLink
          to="/dashboard"
          class="ml-auto text-sm text-muted-foreground hover:text-foreground"
        >
          Back to dashboard
        </RouterLink>
      </header>

      <Separator />

      <!-- Wide: three panels at once, with draggable splitters between them. -->
      <ResizablePanelGroup
        v-if="isWide"
        direction="horizontal"
        class="min-h-0 flex-1"
        data-testid="workspace-panels"
      >
        <ResizablePanel :default-size="20" :min-size="15">
          <ChatPanel />
        </ResizablePanel>
        <ResizableHandle with-handle />
        <ResizablePanel :default-size="30" :min-size="20">
          <EditorPanel />
        </ResizablePanel>
        <ResizableHandle with-handle />
        <ResizablePanel :default-size="50" :min-size="20">
          <PreviewPanel />
        </ResizablePanel>
      </ResizablePanelGroup>

      <!--
        Narrow: one panel at a time. Three panels sharing a 390px viewport are three
        unusable panels, and `tabs` is the component the brief names for exactly this.
      -->
      <Tabs
        v-else
        default-value="chat"
        class="flex min-h-0 flex-1 flex-col"
        data-testid="workspace-tabs"
      >
        <TabsList class="mx-4 mt-3 shrink-0 self-start">
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="code">Code</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="chat" class="mt-0 min-h-0 flex-1">
          <ChatPanel />
        </TabsContent>
        <!--
          `flex flex-col` rather than a plain block, and it is load-bearing (D19,
          R4). `TabsContent` gets its own height from `flex-1`, and a child's
          `height: 100%` does **not** resolve against that — measured: the panel
          fell back to its content height, 255px inside a 642px tab, and Monaco
          rendered a 5px editor with no error. As a flex column it hands the panel
          a real height through `flex-1` instead of a percentage of an auto box.
          The wide layout does not need it: a `ResizablePanel` in a row group is
          stretch-sized, which *is* definite.
        -->
        <TabsContent value="code" class="mt-0 flex min-h-0 flex-1 flex-col">
          <EditorPanel />
        </TabsContent>
        <TabsContent value="preview" class="mt-0 min-h-0 flex-1">
          <PreviewPanel />
        </TabsContent>
      </Tabs>
    </template>
  </div>
</template>
