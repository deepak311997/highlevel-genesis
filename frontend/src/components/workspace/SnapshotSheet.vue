<script setup lang="ts">
import { computed, ref } from 'vue'
import { History } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDay, formatTime } from '@/lib/date'
import { originLabel, snapshotSubtitle, versionLabel } from '@/lib/snapshots'
import type { Snapshot } from '@/lib/snapshotsApi'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Version history — the trigger, the sheet and its four states.
 *
 * **A sheet rather than a dialog**, sliding in from the right: history is a fifth
 * thing to look at, not a decision that has to interrupt, and a centred modal
 * covers the code the user is comparing against. Right, because the trigger is in
 * the code panel — the panel that opens is the panel the click was in.
 *
 * **The confirm is two states of one row, and there is no second overlay.** A
 * restore overwrites every file, so it is worth a second click; it is not worth a
 * modal *over* a sheet, which is a second focus trap and a second meaning for
 * Escape. Confirming in place also asks the question next to the answer, where a
 * separate dialog would have to restate the version's identity to be safe to click.
 *
 * **The fetch is the opening, not the mounting**: loading on mount would spend a
 * request on every project opened, whether or not anyone wanted history.
 */
const workspace = useWorkspaceStore()

const open = ref(false)
const confirmingId = ref<string | null>(null)

/**
 * Newest first. The server already orders by `seq` descending, so this changes
 * nothing today — it is here because "newest first" is a *rendering* rule, and the
 * component that renders it should not be breakable by a change to a query it
 * cannot see. A copy, not `.sort()` in place: the array is the store's.
 */
const rows = computed<Snapshot[]>(() => [...workspace.snapshots].sort((a, b) => b.seq - a.seq))

/**
 * One restore at a time, and none at all while a generation is writing the very
 * files a restore would overwrite. The store enforces both; this is the half the
 * user can see, so the second click has nothing to aim at rather than being
 * swallowed in silence.
 */
const restoreBlocked = computed(() => workspace.generating || workspace.restoringId !== null)

function onOpenChange(next: boolean): void {
  open.value = next
  // A confirm is a question about *this* visit; closing the sheet withdraws it.
  confirmingId.value = null
  // And so is a failed restore — but on the way *out*, because while the sheet is
  // open the banner is the only report the user gets. Left in the store it would
  // outlive the visit and greet the next one with a failure long since abandoned.
  if (next) void workspace.loadSnapshots()
  else workspace.restoreError = null
}

/**
 * The two notices this app has, and both are here.
 *
 * A restore is the one action in the workspace whose outcome leaves nothing on
 * screen to read: it succeeded and the files were already rendered, or it changed
 * nothing because the project already *was* that version — which looks identical.
 * So they are told transiently, next to the click that caused them.
 *
 * Anything else is deliberately silent: a failure renders in the sheet and stays
 * until it closes, because an error that disappears after four seconds is one the
 * user cannot act on.
 *
 * The copy goes through `versionLabel`, the same helper the row's heading uses. The
 * seq is read from the row and not sent to the store: the route identifies the
 * version by id, and a second client-derived identifier is a way for the two to
 * differ.
 */
async function confirmRestore(snapshot: Snapshot): Promise<void> {
  confirmingId.value = null
  const outcome = await workspace.restoreSnapshot(snapshot.id)
  const label = versionLabel(snapshot.seq)

  if (outcome === 'restored') toast.success(`Restored ${label}.`)
  else if (outcome === 'unchanged') toast(`Already on ${label}. Nothing changed.`)
}
</script>

<template>
  <Sheet :open="open" @update:open="onOpenChange">
    <SheetTrigger as-child>
      <Button variant="ghost" size="sm" data-testid="snapshot-trigger">
        <History class="h-4 w-4" />
        History
      </Button>
    </SheetTrigger>

    <SheetContent
      side="right"
      class="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md"
      data-testid="snapshot-sheet"
    >
      <SheetHeader>
        <!-- Required rather than decorative: Reka UI warns when dialog content has
             no title, and a screen reader would announce an unnamed region. -->
        <SheetTitle>Version history</SheetTitle>
        <SheetDescription>
          Every generation saves the project’s files. Restoring replaces them with that version.
        </SheetDescription>
      </SheetHeader>

      <!-- The reason, not just a dead button. A generation is mid-flight over
           the same files, and the list stays on screen: "come back when this
           finishes" is a different message from "there is no history", and a
           blanked sheet says the second. -->
      <p
        v-if="workspace.generating"
        class="text-sm text-muted-foreground"
        data-testid="snapshot-generating"
      >
        Restoring is unavailable while a generation is running.
      </p>

      <!-- A failed *restore*, which is about one attempt rather than about the
           history — so it renders above the list and the list stays. -->
      <Alert
        v-if="workspace.restoreError"
        variant="destructive"
        data-testid="snapshot-restore-error"
      >
        <AlertDescription>{{ workspace.restoreError }}</AlertDescription>
      </Alert>

      <!-- Above the list rather than instead of it: the store keeps the versions it
           already has when a refetch fails, and rendering the error in place of the
           rows would throw that away at the last step. -->
      <div v-if="workspace.snapshotsError" class="flex flex-col gap-2" data-testid="snapshot-error">
        <Alert variant="destructive">
          <AlertDescription>{{ workspace.snapshotsError }}</AlertDescription>
        </Alert>
        <Button
          variant="outline"
          size="sm"
          data-testid="snapshot-retry"
          @click="workspace.loadSnapshots()"
        >
          Try again
        </Button>
      </div>

      <!-- No answer yet — in flight, or not started. `snapshotsLoading` alone cannot
           say the second: it is still false between the sheet opening and the
           request going out. The `snapshotsError` term keeps a failed *first* load
           from sitting under a skeleton that never resolves. -->
      <div
        v-if="
          workspace.snapshotsLoading || (!workspace.snapshotsLoaded && !workspace.snapshotsError)
        "
        class="flex flex-col gap-2"
        data-testid="snapshot-loading"
      >
        <Skeleton class="h-14 rounded-md" />
        <Skeleton class="h-14 w-5/6 rounded-md" />
      </div>

      <ul v-else-if="rows.length > 0" class="flex flex-col gap-2">
        <li
          v-for="snapshot in rows"
          :key="snapshot.id"
          :data-id="snapshot.id"
          data-testid="snapshot-row"
          class="flex flex-col gap-2 rounded-md border border-border p-3"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-sm font-medium">{{ versionLabel(snapshot.seq) }}</span>
            <span class="text-xs text-muted-foreground">
              {{ formatDay(snapshot.createdAt) }} · {{ formatTime(snapshot.createdAt) }}
            </span>
          </div>

          <p class="text-xs text-muted-foreground">
            {{ originLabel(snapshot.origin) }} ·
            {{ snapshotSubtitle(snapshot.fileCount, snapshot.totalBytes) }}
          </p>

          <!-- The row being restored says so, so the disabled buttons elsewhere
               have a visible cause. -->
          <p
            v-if="workspace.restoringId === snapshot.id"
            class="text-xs text-muted-foreground"
            data-testid="snapshot-restoring"
          >
            Restoring this version…
          </p>

          <!-- The two states of the row. Nothing opens, nothing moves, and the
               question sits beside the version it is about. -->
          <div v-if="confirmingId === snapshot.id" class="flex flex-col gap-2">
            <p class="text-xs text-muted-foreground">
              This replaces the project’s current files. The files as they are now are saved as a
              version first.
            </p>
            <div class="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                data-testid="snapshot-cancel"
                @click="confirmingId = null"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                :disabled="restoreBlocked"
                data-testid="snapshot-confirm"
                @click="confirmRestore(snapshot)"
              >
                Restore this version
              </Button>
            </div>
          </div>

          <div v-else>
            <Button
              variant="outline"
              size="sm"
              :disabled="restoreBlocked"
              data-testid="snapshot-restore"
              @click="confirmingId = snapshot.id"
            >
              Restore
            </Button>
          </div>
        </li>
      </ul>

      <!-- Asked, answered, and there is nothing. Guarded on `snapshotsLoaded` so a
           first load that failed says so above rather than claiming the project has
           no versions. -->
      <p
        v-else-if="workspace.snapshotsLoaded"
        class="text-sm text-muted-foreground"
        data-testid="snapshot-empty"
      >
        No versions yet. Generate an app and this is where its versions appear.
      </p>
    </SheetContent>
  </Sheet>
</template>
