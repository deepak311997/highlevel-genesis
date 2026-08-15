<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'

import ThemeToggle from '@/components/ThemeToggle.vue'
</script>

<template>
  <div class="min-h-screen">
    <header class="border-b bg-gradient-to-b from-raised to-card">
      <nav class="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
        <RouterLink to="/" class="flex items-center gap-2 text-base font-bold tracking-tight">
          <svg viewBox="0 0 96 96" class="h-5 w-5" aria-hidden="true">
            <g fill="none" stroke="var(--primary)" stroke-width="9" stroke-linecap="round">
              <path d="M67.80 28.20 A 28 28 0 1 0 57.58 74.31" />
              <path d="M69.45 66.00 A 28 28 0 0 0 73.38 59.83" />
            </g>
            <circle cx="75.89" cy="45.56" r="4.5" fill="var(--primary)" />
            <circle cx="48" cy="48" r="8.5" fill="var(--accent)" />
          </svg>
          Genesis
        </RouterLink>
        <RouterLink to="/health" class="text-sm text-muted-foreground hover:text-foreground">
          Health
        </RouterLink>
        <div class="ml-auto">
          <ThemeToggle />
        </div>
      </nav>
    </header>

    <main class="mx-auto max-w-5xl px-6 py-10">
      <RouterView />
    </main>
  </div>
</template>
