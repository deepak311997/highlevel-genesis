<script setup lang="ts">
import { onMounted } from 'vue'

import ConnectionPanel from '@/components/ConnectionPanel.vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuthStore } from '@/stores/auth'

/**
 * Placeholder. Slice 3 replaces the body with the project list; what matters
 * here is that a protected route exists for the guard to protect, and that the
 * profile write is triggered once per verified session.
 */
const auth = useAuthStore()

onMounted(() => {
  void auth.ensureProfile()
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-2">
      <h1 class="text-2xl font-bold tracking-tight">Dashboard</h1>
      <p class="text-sm text-muted-foreground">
        You're signed in as
        <span class="font-medium text-foreground" data-testid="dashboard-email">{{
          auth.email
        }}</span
        >.
      </p>
    </div>

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
