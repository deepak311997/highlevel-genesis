import { defineConfig } from 'vitest/config'

/**
 * The root suite: the repo's own build scripts.
 *
 * `test:unit` runs the `functions` and `frontend` projects, and `tests/` has its
 * own configs for rules, integration and e2e — which left `scripts/` with no
 * runner at all. A spec with no runner is precisely the failure mode
 * `check-no-firestore.spec.mjs` exists to prevent, so it gets one here and
 * `test:unit` calls it.
 *
 * `.mjs`, and outside the root tsconfig's `include`, matching how
 * `scripts/test-emulator-config.mjs` is already treated.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.spec.mjs'],
  },
})
