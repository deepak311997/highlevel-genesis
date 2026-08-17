import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', '*.config.js'] },

  js.configs.recommended,

  // Type-aware linting. `strictTypeChecked` catches the bugs a syntax-only pass
  // cannot see — floating promises, unsafe `any` propagation, misused awaits.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // All four Vue rule tiers: essential, strongly-recommended, and recommended.
  ...pluginVue.configs['flat/recommended'],

  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        // Without this the TS project service cannot see <script> blocks.
        extraFileExtensions: ['.vue'],
      },
    },
  },

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  {
    rules: {
      // `App` is the documented exception to Vue's multi-word rule, and the
      // shadcn-vue primitives (Button, Card) are named by upstream convention.
      'vue/multi-word-component-names': 'off',

      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // The rule exists to catch `${someObject}`. Numbers in a template are
      // ordinary formatting, not a mistake.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // A non-null assertion is a claim the compiler can't verify. Allowed, but
      // it has to be deliberate enough to write a comment next to.
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Enums emit runtime code and don't tree-shake; prefer union literals.
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',

      // Unhandled rejections are silent failures in a streaming UI.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Vue: an index key makes Vue reuse the wrong node when a list reorders.
      'vue/require-v-for-key': 'error',
      'vue/no-v-html': 'error',
      'vue/component-name-in-template-casing': ['error', 'PascalCase'],
      'vue/define-macros-order': [
        'error',
        { order: ['defineOptions', 'defineProps', 'defineEmits', 'defineSlots'] },
      ],
      'vue/no-unused-refs': 'error',
      'vue/prefer-true-attribute-shorthand': 'warn',

      /**
       * Firebase Auth calls the client must never make.
       *
       * `createUserWithEmailAndPassword` reports EMAIL_EXISTS on the wire, so
       * calling it from the browser reintroduces the account-existence oracle
       * that `/api/auth/register` exists to close — no amount of careful error
       * copy hides what the network tab shows.
       *
       * `fetchSignInMethodsForEmail` answers the same question outright.
       *
       * `sendEmailVerification` and `sendPasswordResetEmail` were banned here
       * too, back when we sent mail ourselves and two senders would have meant
       * two differently-branded emails for one action. Firebase is now the only
       * sender, so they are the intended path and the ban is lifted.
       *
       * `firebase/firestore` is banned outright, with no exception and so no
       * allowlist to keep current. `patterns` rather than `paths` so the
       * subpaths — `firebase/firestore/lite` among them — are covered by the
       * same entry.
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['firebase/firestore', 'firebase/firestore/*'],
              message:
                'The frontend never talks to Firestore directly. Every read and write goes through a Cloud Function route that verifies the ID token and scopes the query by the uid in it — see CLAUDE.md and docs/slices/02b-api-data-access/.',
            },
          ],
          paths: [
            {
              name: 'firebase/auth',
              importNames: ['createUserWithEmailAndPassword', 'fetchSignInMethodsForEmail'],
              message:
                'Account creation is server-side — it is the only way the response can avoid disclosing whether an address is registered. Use @/lib/authApi; see functions/src/auth/register.ts.',
            },
          ],
        },
      ],
    },
  },

  // Test files: relax the rules that fight deliberately-wrong fixtures and
  // test constructs — a never-settling promise for a loading state, or an
  // async stub that satisfies a promise-returning contract without awaiting.
  {
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  // Plain JS (config files) is outside the TS project — typed rules would error.
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Last: disables every stylistic rule that would fight Prettier.
  prettier,
)
