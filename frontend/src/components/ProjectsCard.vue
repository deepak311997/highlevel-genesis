<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import ProjectDeleteDialog from '@/components/ProjectDeleteDialog.vue'
import ProjectFormDialog from '@/components/ProjectFormDialog.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

// A stored timestamp that does not parse yields no line at all; the name and
// description still say what the project is.
function updatedLabel(updatedAt: string): string | null {
  const day = formatDay(updatedAt)
  return day === null ? null : `Updated ${day}`
}

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
    <CardHeader class="flex flex-row items-center justify-between gap-4">
      <CardTitle>Projects</CardTitle>
      <Button
        v-if="projects.loaded && !projects.error && projects.projects.length > 0"
        size="sm"
        data-testid="projects-new"
        @click="startCreate()"
      >
        New project
      </Button>
    </CardHeader>

    <CardContent class="flex flex-col gap-4">
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

      <ul v-else-if="projects.projects.length > 0" class="flex flex-col gap-3">
        <li
          v-for="project in projects.projects"
          :key="project.id"
          data-testid="project-row"
          class="flex items-start justify-between gap-4 rounded-md border border-border p-3"
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

          <div class="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="project-rename"
              @click="startRename(project)"
            >
              Rename
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="project-delete"
              @click="startDelete(project)"
            >
              Delete
            </Button>
          </div>
        </li>
      </ul>

      <!-- Empty: asked, and there is nothing. -->
      <div v-else data-testid="projects-empty" class="flex flex-col items-start gap-3">
        <p class="text-sm text-muted-foreground">
          No projects yet. Create one to start building against your CRM data.
        </p>
        <Button data-testid="projects-new" @click="startCreate()">New project</Button>
      </div>
    </CardContent>

    <ProjectFormDialog v-model:open="formOpen" :project="selected" />
    <ProjectDeleteDialog v-model:open="deleteOpen" :project="selected" />
  </Card>
</template>
