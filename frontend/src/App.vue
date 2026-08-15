<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="min-h-screen">
    <header class="border-b">
      <nav class="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
        <RouterLink to="/" class="text-base font-bold tracking-tight">Genesis</RouterLink>
        <RouterLink to="/health" class="text-sm text-muted-foreground hover:text-foreground">
          Health
        </RouterLink>
      </nav>
    </header>

    <main class="mx-auto max-w-5xl px-6 py-10">
      <RouterView />
    </main>
  </div>
</template>
