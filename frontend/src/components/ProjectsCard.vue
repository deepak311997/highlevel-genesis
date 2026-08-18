<script setup lang="ts">
import { Pencil, Search, Trash2, X } from 'lucide-vue-next'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import ProjectDeleteDialog from '@/components/ProjectDeleteDialog.vue'
import ProjectFormDialog from '@/components/ProjectFormDialog.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDay } from '@/lib/date'
import { useProjectsStore } from '@/stores/projects'
import type { Project } from '@/lib/projectsApi'

/**
 * The projects list, on the dashboard.
 *
 * Four states, all of them shipped: loading, rows, empty and error-with-retry.
 * The error one is not theoretical — the card's only source of truth is an
 * endpoint, so "we could not ask" is a state it has to be able to say out loud.
 *
 * **The project's name is a link to its workspace; the row is not** (Slice 4, D23).
 * Slice 3's D12 said rows would become links the moment the workspace existed, and
 * it does. Linking the name rather than the whole row is what keeps a mis-aimed tap
 * away from Rename and Delete — two destructive-ish actions sitting inside the same
 * rectangle.
 */
const projects = useProjectsStore()

/**
 * How many rows a page holds.
 *
 * The server already caps a list at 100, so this is a reading problem rather
 * than a fetching one: a hundred rows in a card is a scroll, not a list you can
 * find anything in.
 */
const PAGE_SIZE = 10

const page = ref(0)
const query = ref('')

/**
 * The filter, over the loaded list rather than over a request.
 *
 * Same reasoning as the pager: everything the card could show is already in
 * memory, so filtering costs no round trip and cannot fail. Name *and*
 * description, because the row renders both — a search that ignored the line
 * the user is reading would look broken.
 */
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (needle === '') return projects.projects
  return projects.projects.filter(
    (project) =>
      project.name.toLowerCase().includes(needle) ||
      (project.description ?? '').toLowerCase().includes(needle),
  )
})

const pageCount = computed(() => Math.ceil(filtered.value.length / PAGE_SIZE))
const visible = computed(() =>
  filtered.value.slice(page.value * PAGE_SIZE, page.value * PAGE_SIZE + PAGE_SIZE),
)

/** `1–10 of 23`, in the card's own words rather than "page 1 of 3": the rows are
 *  what you are looking at, so the count should be of rows — and while a search
 *  is on, of the rows that matched. */
const range = computed(() => {
  const first = page.value * PAGE_SIZE + 1
  const last = Math.min(first + PAGE_SIZE - 1, filtered.value.length)
  return `${first}–${last} of ${filtered.value.length}`
})

/* A new query is a new list, and page 3 of the old one is nowhere in it. */
watch(query, () => {
  page.value = 0
})

/*
 * Delete the last project on the last page and the page you are standing on
 * stops existing. Without this the card renders an empty list with rows behind
 * it, which reads as "your projects are gone" rather than "you were on the last
 * page". Clamping rather than resetting to zero keeps your place when the list
 * shrinks by one somewhere above you.
 */
watch(pageCount, (count) => {
  if (page.value > Math.max(count - 1, 0)) page.value = Math.max(count - 1, 0)
})

// A stored timestamp that does not parse yields no line at all; the name and
// description still say what the project is.
function updatedLabel(updatedAt: string): string | null {
  const day = formatDay(updatedAt)
  return day === null ? null : `Updated ${day}`
}

/**
 * Whether the card is showing a list at all — what the header's two controls
 * hang on. Searching a card that is loading, failed, or empty is a control over
 * nothing.
 */
const hasProjects = computed(
  () => projects.loaded && projects.error === null && projects.projects.length > 0,
)

const formOpen = ref(false)
const deleteOpen = ref(false)
/** Which project the open dialog is about — `null` means the create path. */
const selected = ref<Project | null>(null)

function startCreate(): void {
  selected.value = null
  formOpen.value = true
}

function startRename(project: Project): void {
  selected.value = project
  formOpen.value = true
}

function startDelete(project: Project): void {
  selected.value = project
  deleteOpen.value = true
}

onMounted(() => {
  void projects.load()
})
</script>

<template>
  <Card data-testid="projects-card">
    <!--
      Title, search, action — one row, in the order you use them. The search sat
      between the header and the first row before, where a full-width field read
      as another row of the list rather than as a control over it.

      `flex-wrap` with a `basis` on the field rather than a breakpoint: the card
      is two thirds of a grid on a wide window and full width below it, so what
      decides whether three things fit is the card's width, which a media query
      does not know.
    -->
    <CardHeader
      class="flex flex-row flex-wrap items-center gap-x-3 gap-y-2 border-b border-border"
      data-testid="projects-card-header"
    >
      <CardTitle class="mr-auto">Projects</CardTitle>

      <template v-if="hasProjects">
        <div class="relative max-w-64 flex-1 basis-36">
          <Search
            class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <!--
            `type="search"` for the semantics and the keyboard's Escape, with the
            native clear affordance hidden: it renders differently in every
            browser and lands on top of the reset below.
          -->
          <Input
            v-model="query"
            type="search"
            placeholder="Search projects"
            aria-label="Search projects"
            data-testid="projects-search"
            class="h-8 px-8 text-sm [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            v-if="query !== ''"
            type="button"
            aria-label="Clear search"
            data-testid="projects-search-reset"
            class="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="query = ''"
          >
            <X class="size-3.5" />
          </button>
        </div>

        <Button size="sm" data-testid="projects-new" @click="startCreate()">New project</Button>
      </template>
    </CardHeader>

    <CardContent class="flex flex-col gap-4 pt-4">
      <!--
        Error first, and before content. A failed first request leaves `loaded`
        false, so a loading branch ahead of this would render a skeleton forever
        and never show the failure — and rows shown beside a failure notice leave
        the user unable to tell which of the two is current.
      -->
      <div v-if="projects.error" data-testid="projects-error" class="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>{{ projects.error }}</AlertDescription>
        </Alert>
        <Button variant="outline" data-testid="projects-retry" @click="projects.load()">
          Try again
        </Button>
      </div>

      <!--
        No answer yet — in flight, or not started. `loading` alone cannot say the
        second: it is first-load-only, so a refetch does not blank a card that
        already has rows, and it is still false in the tick between mounting and
        the request starting.
      -->
      <div
        v-else-if="projects.loading || !projects.loaded"
        data-testid="projects-loading"
        class="flex flex-col gap-3"
      >
        <Skeleton class="h-5 w-48 rounded" />
        <Skeleton class="h-5 w-40 rounded" />
      </div>

      <template v-else-if="projects.projects.length > 0">
        <ul v-if="visible.length > 0" class="flex flex-col divide-y divide-border">
          <li
            v-for="project in visible"
            :key="project.id"
            data-testid="project-row"
            class="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div class="flex min-w-0 flex-col gap-1">
              <RouterLink
                :to="`/projects/${project.id}`"
                class="truncate font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                data-testid="project-name"
              >
                {{ project.name }}
              </RouterLink>
              <p
                v-if="project.description"
                class="text-sm text-muted-foreground"
                data-testid="project-description"
              >
                {{ project.description }}
              </p>
              <p
                v-if="updatedLabel(project.updatedAt)"
                class="tabular text-xs text-muted-foreground"
                data-testid="project-updated"
              >
                {{ updatedLabel(project.updatedAt) }}
              </p>
            </div>

            <!--
              Icons, and each one names the project it acts on. Two text buttons
              per row set "Rename" and "Delete" in the same weight as the project
              name, so the column read as a list of buttons with names attached;
              ghost icons let the name lead and keep the destructive one from
              shouting until you are on it.
            -->
            <div class="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon"
                :aria-label="`Rename ${project.name}`"
                :title="`Rename ${project.name}`"
                data-testid="project-rename"
                @click="startRename(project)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="hover:bg-destructive/10 hover:text-destructive"
                :aria-label="`Delete ${project.name}`"
                :title="`Delete ${project.name}`"
                data-testid="project-delete"
                @click="startDelete(project)"
              >
                <Trash2 class="size-4" />
              </Button>
            </div>
          </li>
        </ul>

        <!--
          Matched nothing. Said out loud rather than left as a blank space under
          a filled-in box, which reads as "your projects are gone" rather than
          "no project has that in its name".
        -->
        <div v-else data-testid="projects-no-matches" class="flex flex-col items-start gap-3">
          <p class="text-sm text-muted-foreground">No projects match “{{ query.trim() }}”.</p>
          <Button
            variant="outline"
            size="sm"
            data-testid="projects-clear-search"
            @click="query = ''"
          >
            Clear search
          </Button>
        </div>
      </template>

      <!-- Empty: asked, and there is nothing. -->
      <div v-else data-testid="projects-empty" class="flex flex-col items-start gap-3">
        <p class="text-sm text-muted-foreground">
          No projects yet. Create one to start building against your CRM data.
        </p>
        <Button data-testid="projects-new" @click="startCreate()">New project</Button>
      </div>

      <!--
        Only when there is more than one page. A pager that says "1–5 of 5" is
        chrome describing the absence of a problem.
      -->
      <div
        v-if="pageCount > 1"
        data-testid="projects-pager"
        class="flex items-center justify-between gap-3 pt-3"
      >
        <span class="tabular font-mono text-xs text-muted-foreground" data-testid="projects-range">
          {{ range }}
        </span>
        <div class="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="page === 0"
            data-testid="projects-prev"
            @click="page -= 1"
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="page >= pageCount - 1"
            data-testid="projects-next"
            @click="page += 1"
          >
            Next
          </Button>
        </div>
      </div>
    </CardContent>

    <ProjectFormDialog v-model:open="formOpen" :project="selected" />
    <ProjectDeleteDialog v-model:open="deleteOpen" :project="selected" />
  </Card>
</template>
