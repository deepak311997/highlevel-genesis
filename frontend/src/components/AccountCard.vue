<script setup lang="ts">
import { computed } from 'vue'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDay } from '@/lib/date'
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

const name = computed(() => {
  const current = profile.profile
  if (current === null) return null
  return current.displayName ?? current.email
})

const memberSince = computed(() => {
  const createdAt = profile.profile?.createdAt
  // A stored timestamp that does not parse is not worth a broken screen; the
  // rest of the card still says who you are, and `formatDay` answers null.
  return createdAt === undefined ? null : formatDay(createdAt)
})
</script>

<template>
  <Card data-testid="account-card">
    <CardHeader>
      <CardTitle>Account</CardTitle>
    </CardHeader>

    <CardContent class="flex flex-col gap-4">
      <!--
        Error first, and before content. Rendering a profile beside a failure
        notice leaves the user unable to tell which of the two is current, and a
        failed first request leaves `loaded` false — so anything testing for "no
        answer yet" has to come after this, or the error is never shown.
      -->
      <div v-if="profile.error" data-testid="account-error" class="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>{{ profile.error }}</AlertDescription>
        </Alert>
        <Button variant="outline" data-testid="account-retry" @click="profile.ensure()">
          Try again
        </Button>
      </div>

      <!--
        No answer yet — the request is in flight, or has not started. `loading`
        alone cannot say the second: it is first-load-only, so a refetch does not
        blank a card that already has content, and it is still false in the tick
        between this component mounting and its parent asking for the profile.
        `loaded` is what separates that from "we asked, and there is nothing".
      -->
      <div
        v-else-if="profile.loading || !profile.loaded"
        data-testid="account-loading"
        class="flex flex-col gap-2"
      >
        <Skeleton class="h-5 w-48 rounded" />
        <Skeleton class="h-4 w-32 rounded" />
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
