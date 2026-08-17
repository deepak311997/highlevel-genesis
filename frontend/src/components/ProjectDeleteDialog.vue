<script setup lang="ts">
import { ref, watch } from 'vue'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useProjectsStore } from '@/stores/projects'
import type { Project } from '@/lib/projectsApi'

/**
 * Confirm a delete, by name.
 *
 * Naming the project is the point. A generic "are you sure?" beside a list of
 * rows asks the user to trust that they clicked the right one, and the delete
 * itself gives them nothing to check it against — the row simply goes.
 *
 * The delete is soft on the server, but nothing in this slice reads `deletedAt`
 * back, so from here it is permanent and the copy says so.
 */
const props = defineProps<{ open: boolean; project: Project | null }>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const projects = useProjectsStore()

const error = ref<string | null>(null)

watch(
  () => props.open,
  (open) => {
    if (open) error.value = null
  },
  { immediate: true },
)

async function confirm(): Promise<void> {
  const project = props.project
  if (project === null || projects.busy) return
  error.value = null

  try {
    await projects.remove(project.id)
    emit('update:open', false)
  } catch (err) {
    // Stays open and says what the server said — the user asked from in here,
    // so the answer belongs in here.
    error.value = err instanceof Error ? err.message : 'Could not delete that project.'
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <!--
      The test id lives on an inner element: DialogContent's root is a portal
      rendering an overlay *and* the content, so it is a multi-root fragment and
      Vue drops fallthrough attributes on it.
    -->
    <DialogContent>
      <div v-if="props.project" data-testid="project-delete-dialog" class="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Delete project</DialogTitle>
          <DialogDescription>
            This cannot be undone. Everything in the project goes with it.
          </DialogDescription>
        </DialogHeader>

        <p class="text-sm text-muted-foreground">
          Delete
          <span class="font-medium text-foreground" data-testid="project-delete-name">{{
            props.project.name
          }}</span
          >?
        </p>

        <Alert v-if="error" variant="destructive" data-testid="project-delete-error">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <DialogFooter class="gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="project-delete-cancel"
            @click="emit('update:open', false)"
          >
            Cancel
          </Button>
          <Button
            type="button"
            :disabled="projects.busy"
            data-testid="project-delete-confirm"
            @click="confirm()"
          >
            Delete
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>
</template>
