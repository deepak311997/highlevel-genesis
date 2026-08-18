<script setup lang="ts">
import { onMounted } from 'vue'

import AccountCard from '@/components/AccountCard.vue'
import ConnectionPanel from '@/components/ConnectionPanel.vue'
import ProjectsCard from '@/components/ProjectsCard.vue'
import { useProfileStore } from '@/stores/profile'

/**
 * The dashboard: the account, the HighLevel connection, and the projects.
 *
 * Each card owns its own store, its own request and its own four states, and
 * this view owns none of them. The ensure below is fired and not awaited, and
 * its failure is the account card's to render rather than this view's to handle:
 * a profile is a convenience, not a precondition for a session, so a failed
 * request must leave the connection panel, the projects card and sign-out
 * working.
 */
const profile = useProfileStore()

onMounted(() => {
  void profile.ensure()
})
</script>

<template>
  <div class="flex flex-col gap-5">
    <div class="flex flex-col gap-0.5">
      <p class="label-micro">Genesis</p>
      <h1 class="text-lg font-semibold tracking-tight">Dashboard</h1>
    </div>

    <!--
      Projects lead and take two thirds; the account and the connection are
      status, not work, so they move to a rail beside them.

      The old layout stacked all three full-width, which said they were equally
      important and left the thing you actually came for below the fold on a
      short window. `items-start` keeps the rail from stretching to the
      projects column's height — a connection card with three lines in it
      should be three lines tall.
    -->
    <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <ProjectsCard />

      <!--
        Account first, connection under it: the rail is ordered by how often you
        look at it, and "who am I signed in as" is the question the top of a
        rail should answer.
      -->
      <div class="flex flex-col gap-4">
        <AccountCard />
        <ConnectionPanel />
      </div>
    </div>
  </div>
</template>
