<script setup lang="ts">
import { computed, ref } from 'vue'
import { History } from 'lucide-vue-next'

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
import { formatDay, formatTime } from '@/lib/date'
import { originLabel, snapshotSubtitle, versionLabel } from '@/lib/snapshots'
import type { Snapshot } from '@/lib/snapshotsApi'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Version history — the trigger, the sheet and its four states (AC-29, AC-30).
 *
 * **A sheet rather than a dialog** (D17, P9), sliding in from the right. The
 * workspace is three panels and history is a fifth thing to look at, not a
 * decision that has to interrupt: a centred modal covers the code the user is
 * comparing against, while a side sheet leaves it on screen. Right, because the
 * trigger is in the code panel and the code panel is on the right — the panel
 * that opens is the panel the click was in.
 *
 * **The confirm is two states of one row, and there is no second overlay** (D19).
 * A restore overwrites every file in the project, so it is worth a second click;
 * it is not worth a modal *over* a sheet, which is a second focus trap stacked
 * on the first and a second place for Escape to mean two different things. The
 * row already carries the version's identity, so confirming in place asks the
 * question next to the answer — a separate dialog would have to restate "Version
 * 3, 18 Aug, 3 files" to be safe to click at all.
 *
 * **The fetch is the opening, not the mounting.** The list route reads a
 * collection per call, so loading on mount would spend a request on every
 * project opened, whether or not anyone wanted history. `open` and the
 * confirming row's id are local `ref`s (D20): neither survives the sheet
 * closing, and neither is anyone else's business.
 */
const workspace = useWorkspaceStore()

const open = ref(false)
const confirmingId = ref<string | null>(null)

/**
 * Newest first. The server already returns the list ordered by `seq`
 * descending, so this sort changes nothing today — it is here because "newest
 * first" is a *rendering* rule (AC-29) and the component that renders it should
 * not be able to be broken by a change to a query it cannot see. Sorting a list
 * capped at `SNAPSHOT_LIMIT` entries costs nothing worth measuring.
 *
 * A copy, not `.sort()` in place: `workspace.snapshots` is the store's array.
 */
const rows = computed<Snapshot[]>(() => [...workspace.snapshots].sort((a, b) => b.seq - a.seq))

/**
 * One restore at a time, and none at all while a generation is writing the very
 * files a restore would overwrite. The store enforces both (AC-26); this is the
 * half the user can see, so the second click has nothing to aim at rather than
 * being swallowed in silence.
 */
const restoreBlocked = computed(() => workspace.generating || workspace.restoringId !== null)

function onOpenChange(next: boolean): void {
  open.value = next
  // A confirm is a question about *this* visit; closing the sheet withdraws it.
  confirmingId.value = null
  if (next) void workspace.loadSnapshots()
}

function confirmRestore(snapshotId: string): void {
  confirmingId.value = null
  void workspace.restoreSnapshot(snapshotId)
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
        <!-- Reka UI warns when dialog content has no title, and a screen reader
             would announce an unnamed region — so the title is required, not
             decorative. -->
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

      <!-- Error first, `FileTree.vue`'s rule and for its reason: a failed first
           request leaves `snapshotsLoaded` false, so a loading branch above this
           would render a skeleton that never resolves and never show the
           failure. -->
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

      <!-- No answer yet — in flight, or not started. `snapshotsLoading` alone
           cannot say the second: it is still false between the sheet opening and
           the request going out, and an empty state shown then reads as a
           project with no history. -->
      <div
        v-else-if="workspace.snapshotsLoading || !workspace.snapshotsLoaded"
        class="flex flex-col gap-2"
        data-testid="snapshot-loading"
      >
        <div class="h-14 animate-pulse rounded-md bg-secondary" />
        <div class="h-14 w-5/6 animate-pulse rounded-md bg-secondary" />
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
                @click="confirmRestore(snapshot.id)"
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

      <!-- Asked, and there is nothing — a project that has never generated. -->
      <p v-else class="text-sm text-muted-foreground" data-testid="snapshot-empty">
        No versions yet. Generate an app and this is where its versions appear.
      </p>
    </SheetContent>
  </Sheet>
</template>
