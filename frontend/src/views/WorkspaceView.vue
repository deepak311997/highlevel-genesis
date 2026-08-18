<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { computed, onMounted, watch } from 'vue'
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
import { useHlStore } from '@/stores/hl'
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
const hl = useHlStore()
const route = useRoute()

/** Tailwind's `lg`. Matched in JS because the tree, not the styling, is what changes. */
const isWide = useMediaQuery('(min-width: 1024px)')

/**
 * The loading placeholder's code lines, as widths.
 *
 * Ragged on purpose — a stack of identical full-width bars reads as a table, and
 * the thing behind it is source. The array is the whole of the variation, so
 * nothing here needs a random number that would change on every render.
 */
const CODE_LINES = ['w-3/4', 'w-full', 'w-5/6', 'w-1/2', 'w-11/12', 'w-2/3', 'w-4/5'] as const

/**
 * The explorer rail's rows, same idea — shorter, and fewer, because a filename
 * is not a line of code and a list of seven equal bars beside seven other equal
 * bars reads as a table rather than as two different things.
 */
const FILE_ROWS = ['w-2/3', 'w-5/6', 'w-1/2', 'w-3/4'] as const

watch(
  () => route.params['projectId'],
  (projectId) => {
    if (projectId === undefined) return
    void workspace.open(String(projectId))
  },
  { immediate: true },
)

/**
 * The header badge, from the connection itself.
 *
 * **This used to read the project's stored `locationId`** — a value snapshotted
 * when the project was created — which meant a project made before the account
 * was connected said "Not connected" for ever, while the dashboard said the
 * opposite about the same account. One connection cannot have two answers, so
 * the badge asks the thing that knows. `locationId` keeps its real job: which
 * location this project targets.
 *
 * Red for missing and for expired alike: neither can read your CRM, and both are
 * fixed by the same button on the dashboard. Nothing is claimed while the status
 * request is in flight or after it failed — the badge would otherwise tell a
 * connected user they are not connected.
 */
const connection = computed<{ label: string; variant: 'good' | 'bad' } | null>(() => {
  if (hl.loading || hl.error !== null) return null
  if (hl.needsReconnect) return { label: 'Reconnect needed', variant: 'bad' }
  return hl.isConnected
    ? { label: 'HighLevel connected', variant: 'good' }
    : { label: 'Not connected', variant: 'bad' }
})

/*
 * Asked here as well as on the dashboard: a deep link, a reload or a bookmark
 * opens this route without the connection panel ever having mounted.
 */
onMounted(() => {
  void hl.refresh()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!--
      No answer yet.

      **Still no panels** — AC-20, and three *mounted* panels during a load are
      three components firing their own requests and rendering their own empty
      states, which is three things that look broken. Drawing the space they will
      occupy is a different claim, and the one a placeholder is for: this is the
      workspace's own geometry — full-bleed, header rail, 25/40/35 columns —
      rather than a lone bar in a centred column, which is the shape of no screen
      in this app and turned every load into a layout shift.

      It follows the same `isWide` switch as the real thing, so the skeleton
      never promises three columns to a viewport that is about to get tabs.
    -->
    <div
      v-if="workspace.projectLoading"
      data-testid="workspace-loading"
      role="status"
      aria-busy="true"
      class="flex min-h-0 flex-1 flex-col"
    >
      <span class="sr-only">Loading the workspace…</span>

      <!-- The header rail: name, connection badge, back link. -->
      <header
        data-testid="workspace-loading-header"
        class="flex shrink-0 items-center gap-3 px-6 py-4"
      >
        <Skeleton class="h-6 w-56" />
        <Skeleton class="h-5 w-32 rounded-full" />
        <Skeleton class="ml-auto h-4 w-28" />
      </header>

      <Separator />

      <!-- Wide: the three columns, at the widths they will actually open at. -->
      <div v-if="isWide" class="flex min-h-0 flex-1">
        <!-- Chat: a turn or two, and the composer pinned to the bottom. -->
        <div
          data-testid="workspace-loading-chat"
          class="flex min-h-0 w-1/4 flex-col gap-3 p-4"
          aria-hidden="true"
        >
          <Skeleton class="h-4 w-20" />
          <Skeleton class="h-14 w-full" />
          <Skeleton class="h-10 w-4/5 self-end" />
          <Skeleton class="mt-auto h-16 w-full" />
        </div>

        <Separator orientation="vertical" />

        <!-- Code: the panel header, then the explorer rail beside the source —
             which is the shape the panel actually opens in. A placeholder that
             drew one column would promise a layout that is about to shift. -->
        <div
          data-testid="workspace-loading-code"
          class="flex min-h-0 w-[40%] flex-col gap-3 p-4"
          aria-hidden="true"
        >
          <Skeleton class="h-4 w-24" />
          <div class="flex min-h-0 flex-1 gap-3">
            <div class="flex w-2/5 max-w-56 flex-col gap-2">
              <Skeleton v-for="row in FILE_ROWS" :key="row" class="h-3" :class="row" />
            </div>
            <div class="flex min-h-0 flex-1 flex-col gap-2">
              <Skeleton v-for="line in CODE_LINES" :key="line" class="h-3" :class="line" />
            </div>
          </div>
        </div>

        <Separator orientation="vertical" />

        <!-- Preview: a toolbar over one large surface, which is what it is. -->
        <div
          data-testid="workspace-loading-preview"
          class="flex min-h-0 flex-1 flex-col gap-3 p-4"
          aria-hidden="true"
        >
          <Skeleton class="h-4 w-28" />
          <Skeleton class="min-h-32 flex-1" />
        </div>
      </div>

      <!-- Narrow: the tab strip and the one panel behind it. -->
      <div v-else class="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div data-testid="workspace-loading-tabs" class="flex gap-2" aria-hidden="true">
          <Skeleton v-for="tab in 3" :key="tab" class="h-8 w-20" />
        </div>
        <Skeleton class="min-h-32 flex-1" aria-hidden="true" />
      </div>
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
          Whether this workspace can reach real CRM data, which is a property of
          the account's connection rather than of the project — see `connection`.
        -->
        <Badge v-if="connection" :variant="connection.variant" data-testid="workspace-connection">
          {{ connection.label }}
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
        <ResizablePanel :default-size="25" :min-size="15">
          <ChatPanel />
        </ResizablePanel>
        <ResizableHandle with-handle />
        <ResizablePanel :default-size="40" :min-size="20">
          <EditorPanel />
        </ResizablePanel>
        <ResizableHandle with-handle />
        <ResizablePanel :default-size="35" :min-size="20">
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
