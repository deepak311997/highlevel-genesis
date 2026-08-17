<script setup lang="ts">
import { computed, ref, watch } from 'vue'

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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useProjectsStore } from '@/stores/projects'
import type { PatchProjectInput, Project } from '@/lib/projectsApi'

/**
 * Create a project, or rename one — one component, parameterised by an optional
 * project (D25).
 *
 * The two paths differ in three things: the title, the submit label, and whether
 * the fields start populated. A second component would be this one and a copy of
 * it, and the copy is where "send only the changed fields" would stop holding.
 *
 * The failure of a submit lives **here**, not in the store's `error`: that one
 * belongs to the list request and is what the card renders. A create refused for
 * an over-long name is this dialog's problem to show, next to the field that
 * caused it, with what the user typed still in place.
 */
const props = withDefaults(defineProps<{ open: boolean; project?: Project | null }>(), {
  project: null,
})

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const projects = useProjectsStore()

const name = ref('')
const description = ref('')
const error = ref<string | null>(null)

const isRename = computed(() => props.project !== null)

/**
 * Re-seeded whenever the dialog opens, not when it mounts.
 *
 * The parent keeps this component alive between openings — what changes is its
 * `open` prop — so without this, reopening would show the last half-typed edit,
 * and switching from Rename to New project would show the previous project's
 * name in an empty create form.
 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = props.project?.name ?? ''
    description.value = props.project?.description ?? ''
    error.value = null
  },
  { immediate: true },
)

/** Empty means "no description", which is `null` — the stored field is nullable. */
const trimmedDescription = computed<string | null>(() => {
  const value = description.value.trim()
  return value === '' ? null : value
})

/**
 * Only what changed, as one expression rather than two branches.
 *
 * With nothing changed this is `{}`, which the server refuses with 400
 * `invalid_body` — so it is also what disables submit, and the UI never issues
 * that request at all.
 */
const patchPayload = computed<PatchProjectInput>(() => {
  const current = props.project
  if (current === null) return {}

  const payload: PatchProjectInput = {}
  if (name.value.trim() !== current.name) payload.name = name.value.trim()
  if (trimmedDescription.value !== current.description) {
    payload.description = trimmedDescription.value
  }
  return payload
})

const canSubmit = computed(() => {
  if (projects.busy) return false
  if (name.value.trim() === '') return false
  return isRename.value ? Object.keys(patchPayload.value).length > 0 : true
})

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  error.value = null

  try {
    const current = props.project
    if (current === null) {
      await projects.create({ name: name.value.trim(), description: trimmedDescription.value })
    } else {
      await projects.rename(current.id, patchPayload.value)
    }
    emit('update:open', false)
  } catch (err) {
    // Stay open, keep what was typed, and say what the server said — it is the
    // message that names the cause.
    error.value = err instanceof Error ? err.message : 'Could not save that project.'
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <!--
      The test id lives on an inner element, not on DialogContent: that
      component's root is a portal rendering an overlay *and* the content, so it
      is a multi-root fragment and Vue drops fallthrough attributes on it.
    -->
    <DialogContent>
      <div data-testid="project-form-dialog" class="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{{ isRename ? 'Rename project' : 'New project' }}</DialogTitle>
          <DialogDescription>
            {{
              isRename
                ? 'Change the name or description of this project.'
                : 'Name your project. You can change it later.'
            }}
          </DialogDescription>
        </DialogHeader>

        <Alert v-if="error" variant="destructive" data-testid="project-form-error">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <form class="flex flex-col gap-4" @submit.prevent="submit()">
          <div class="flex flex-col gap-2">
            <Label for="project-form-name">Name</Label>
            <Input
              id="project-form-name"
              v-model="name"
              data-testid="project-form-name"
              maxlength="80"
              placeholder="Contact dashboard"
            />
          </div>

          <div class="flex flex-col gap-2">
            <Label for="project-form-description">Description</Label>
            <!--
            A plain textarea rather than a vendored shadcn-vue component: the
            slice is scoped to the dialog, and 500 characters in a single-line
            input is worse than either. The classes are Input.vue's.
          -->
            <textarea
              id="project-form-description"
              v-model="description"
              data-testid="project-form-description"
              maxlength="500"
              rows="3"
              placeholder="What this project is for"
              class="flex w-full rounded-md border border-border-strong bg-background px-3 py-2 text-sm text-foreground shadow-[var(--sh-1)] transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45"
            />
          </div>

          <DialogFooter class="gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="project-form-cancel"
              @click="emit('update:open', false)"
            >
              Cancel
            </Button>
            <Button type="submit" :disabled="!canSubmit" data-testid="project-form-submit">
              {{ isRename ? 'Save' : 'Create' }}
            </Button>
          </DialogFooter>
        </form>
      </div>
    </DialogContent>
  </Dialog>
</template>
