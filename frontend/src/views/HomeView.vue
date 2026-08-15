<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
</script>

<template>
  <div class="flex flex-col gap-8">
    <div class="flex flex-col gap-3">
      <h1 class="text-3xl font-bold tracking-tight">Genesis</h1>
      <p class="max-w-prose text-muted-foreground">
        AI-powered app builder for the HighLevel ecosystem. Describe an app, watch it stream into
        the editor, and see it render real CRM data.
      </p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Slice 0 — Rails</CardTitle>
      </CardHeader>
      <CardContent class="flex flex-col items-start gap-4">
        <p class="text-sm text-muted-foreground">
          The scaffold is in place. The health check proves the full path works: browser → Cloud
          Function → Firestore → back.
        </p>
        <RouterLink to="/health">
          <Button>Run the health check</Button>
        </RouterLink>
      </CardContent>
    </Card>
  </div>
</template>
