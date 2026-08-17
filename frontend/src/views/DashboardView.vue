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
  <div class="flex flex-col gap-6">
    <h1 class="text-2xl font-bold tracking-tight">Dashboard</h1>

    <AccountCard />

    <ConnectionPanel />

    <ProjectsCard />
  </div>
</template>
