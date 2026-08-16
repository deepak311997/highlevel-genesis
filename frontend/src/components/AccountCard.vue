<script setup lang="ts">
import { computed } from 'vue'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useProfileStore } from '@/stores/profile'

/**
 * The account, on the dashboard.
 *
 * Four states, all of them shipped: loading, loaded, empty and error-with-retry.
 * The empty one is not a theoretical case — a user sits in it between verifying
 * their address and their first ensure — and the error one is not either, since
 * the card's only source of truth is an endpoint, so "we could not ask" is a
 * state the card has to be able to say out loud.
 *
 * Nothing here writes. `displayName` is rendered and never edited; a profile
 * settings surface is out of this slice's scope.
 */
const profile = useProfileStore()

/**
 * Locale and time zone are pinned deliberately.
 *
 * Left to the environment, the rendered date depends on whichever machine the
 * page — or the test — happens to run on, which turns a stable assertion into a
 * machine-dependent one and shows two users different text for the same day.
 */
const MEMBER_SINCE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

const name = computed(() => {
  const current = profile.profile
  if (current === null) return null
  return current.displayName ?? current.email
})

const memberSince = computed(() => {
  const createdAt = profile.profile?.createdAt
  if (createdAt === undefined) return null

  const date = new Date(createdAt)
  // A stored timestamp that does not parse is not worth a broken screen; the
  // rest of the card still says who you are.
  return Number.isNaN(date.getTime()) ? null : MEMBER_SINCE.format(date)
})
</script>

<template>
  <Card data-testid="account-card">
    <CardHeader>
      <CardTitle>Account</CardTitle>
    </CardHeader>

    <CardContent class="flex flex-col gap-4">
      <!-- Loading: first load only, so a refetch does not blank the card. -->
      <div v-if="profile.loading" data-testid="account-loading" class="flex flex-col gap-2">
        <div class="h-5 w-48 animate-pulse rounded bg-secondary" />
        <div class="h-4 w-32 animate-pulse rounded bg-secondary" />
      </div>

      <!--
        Error before content. Rendering a profile beside a failure notice leaves
        the user unable to tell which of the two is current.
      -->
      <div v-else-if="profile.error" data-testid="account-error" class="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>{{ profile.error }}</AlertDescription>
        </Alert>
        <Button variant="outline" data-testid="account-retry" @click="profile.ensure()">
          Try again
        </Button>
      </div>

      <div v-else-if="profile.profile" data-testid="account-loaded" class="flex flex-col gap-1">
        <p class="font-medium" data-testid="account-name">{{ name }}</p>
        <p class="text-sm text-muted-foreground" data-testid="dashboard-email">
          {{ profile.profile.email }}
        </p>
        <p
          v-if="memberSince"
          class="text-xs text-muted-foreground"
          data-testid="account-member-since"
        >
          Member since {{ memberSince }}
        </p>
      </div>

      <!-- Empty: verified, signed in, and the ensure has not landed yet. -->
      <p v-else data-testid="account-empty" class="text-sm text-muted-foreground">
        Setting up your profile…
      </p>
    </CardContent>
  </Card>
</template>
