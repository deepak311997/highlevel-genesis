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
 *
 * **Named so it is not auto-discovered, and passed with `--config`.** Vitest
 * resolves its config by walking *up* from the working directory, so a plain
 * `vitest.config.mts` at the repo root becomes the config for every package
 * below that has none of its own — which silently redirected `functions`' suite
 * at this file's `include` and left it reporting "no test files found". A config
 * only reachable by name cannot leak downward at all, and no future package has
 * to remember to declare one to defend itself.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.spec.mjs'],
  },
})
