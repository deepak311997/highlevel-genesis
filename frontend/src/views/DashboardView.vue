<script setup lang="ts">
import { onMounted } from 'vue'

import AccountCard from '@/components/AccountCard.vue'
import ConnectionPanel from '@/components/ConnectionPanel.vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useProfileStore } from '@/stores/profile'

/**
 * Placeholder. Slice 3 replaces the projects card with the real list; what
 * matters here is that a protected route exists for the guard to protect, and
 * that the profile is ensured once per verified session.
 *
 * The ensure is fired and not awaited, and the failure is the account card's to
 * render rather than this view's to handle: a profile is a convenience, not a
 * precondition for a session, so a failed request must leave the connection
 * panel and sign-out working.
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

    <Card>
      <CardHeader>
        <CardTitle>Projects</CardTitle>
      </CardHeader>
      <CardContent>
        <p data-testid="dashboard-empty" class="text-sm text-muted-foreground">
          No projects yet. Creating them arrives in the next slice.
        </p>
      </CardContent>
    </Card>
  </div>
</template>
