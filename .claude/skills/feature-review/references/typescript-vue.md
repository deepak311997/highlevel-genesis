# TypeScript & Vue 3 — review checklist

What to look for when reviewing a Genesis slice. Sourced from the official Vue style guide,
the typescript-eslint shared configs, and the TypeScript compiler-option docs; project-specific
notes are marked **Genesis**.

Most of what follows is enforced automatically by `npm run lint` and `npm run typecheck`. This
file covers the judgement calls a linter cannot make.

---

## TypeScript

### Types at boundaries

- **`any` is a review finding, every time.** Use `unknown` at the boundary and narrow. If a
  third-party type forces it, the cast gets a comment naming why.
- **Parse, don't validate.** Anything crossing a boundary — HTTP body, LLM output, Firestore
  document, `import.meta.env` — goes through a Zod schema that returns a typed value. A type
  assertion on unparsed input is a lie the compiler believes.
- **`satisfies` over `as`.** `satisfies` checks the value against the type and keeps the narrow
  literal type; `as` silences the compiler. A bare `as` outside a test is suspect.
- **No non-null assertion (`!`) without a one-line comment** explaining the invariant. If the
  invariant is real, prefer restructuring so the compiler can see it.
- **`catch (err)` is `unknown`.** Narrow with `instanceof` before touching properties.

### Modelling

- **Discriminated unions over optional-field soup.** Four optional fields where only certain
  combinations are legal is a union of three shapes wearing a disguise. This is the single
  highest-leverage TypeScript review comment.
- **Make illegal states unrepresentable.** If `status: 'error'` requires `message`, the type
  should say so rather than leaving both optional.
- **Union literals over `enum`.** Enums emit runtime code, which `erasableSyntaxOnly` rejects
  and bundlers cannot tree-shake as well. `type Status = 'loading' | 'ok' | 'error'` is better
  in every respect. Use a `const` object with `as const` when a runtime value is genuinely needed.
- **Exported functions carry explicit return types.** Inference is fine internally; on a module
  boundary an explicit type is the contract and stops an accidental widening from rippling out.

### Compiler settings in use

`strict` plus four options that are off by default. Each catches a real class of bug:

| Option | Catches |
|---|---|
| `noUncheckedIndexedAccess` | `arr[0]` and `record[key]` are `T \| undefined`, because they are |
| `exactOptionalPropertyTypes` | `{ a?: string }` stops silently accepting `{ a: undefined }` |
| `noPropertyAccessFromIndexSignature` | Forces `obj['dynamicKey']` so typo'd dotted access fails |
| `verbatimModuleSyntax` | Type-only imports must say `import type` — no phantom runtime imports |

`noUncheckedIndexedAccess` is the one that produces the most diff. Resist the urge to silence it
with `!`; the undefined is usually real.

---

## Vue 3

### Priority A — essential (the linter enforces these; know why)

1. **Multi-word component names.** `Card` collides with a future HTML element; `ProjectCard`
   cannot. `App` is the only exemption.
2. **Detailed prop definitions.** Typed props, not `defineProps(['a','b'])`. In `<script setup>`
   that means the generic form: `defineProps<{ project: Project }>()`.
3. **Keyed `v-for`** — and the key must be a **stable id, never the array index**. An index key
   makes Vue reuse the wrong DOM node when the list reorders, which shows up as state attached to
   the wrong row.
4. **Never `v-if` and `v-for` on the same element.** `v-if` has higher precedence, so the
   condition evaluates before the loop variable exists. Filter in a computed instead.
5. **Scoped styles** on every component except `App` and layout roots.

### Priority B — strongly recommended

One component per file · PascalCase filenames · `Base`/`App`/`V` prefix for base components ·
child components prefixed with their parent · component names ordered general-to-specific ·
self-closing tags for empty components · PascalCase in SFC templates · full words over
abbreviations · camelCase prop declarations · one attribute per line on multi-attribute elements ·
simple template expressions (push logic into computed) · split complex computed properties ·
quoted attribute values · directive shorthands (`:`, `@`, `#`) used consistently.

### Reactivity

- **`ref` by default, `reactive` rarely.** `reactive` loses reactivity on destructure and cannot
  hold primitives. One consistent access pattern beats two.
- **`computed` for derived state; `watch` only for side effects.** A watcher that assigns to
  another ref is a computed that has not realised it yet.
- **`watch` vs `watchEffect`:** use `watch` when you need the old value or explicit sources;
  `watchEffect` when the dependencies are obvious and you want them tracked automatically.
- **Props are readonly.** Mutating a prop is a data-flow bug — emit an event or use `defineModel`.
- **Clean up in `onUnmounted`** — every listener, interval, `AbortController`, and Firestore
  `onSnapshot` unsubscribe. A component that starts a stream and does not stop it leaks a
  connection per mount.

**Genesis — two that matter here specifically:**

- **Accumulate stream tokens outside deep reactivity.** A `ref<string>` that is re-assigned per
  token is fine; an array of objects pushed to thousands of times is not. Reach for `shallowRef`
  when the payload is large and only the identity changes.
- **Never make the Monaco editor instance reactive.** Wrapping it in `ref` makes Vue walk a huge
  third-party object graph on every access. Hold it in `shallowRef` or a plain module-scoped
  variable.

### Templates and safety

- **`v-html` is a review-blocking finding in this codebase.** It renders unescaped HTML, and our
  primary input is LLM-generated code. Generated apps render inside the sandboxed iframe, never
  through `v-html`.
- **Iframe sandboxing is explicit.** The preview iframe declares its `sandbox` attributes; adding
  `allow-same-origin` alongside `allow-scripts` defeats the sandbox entirely.
- **Every new screen ships loading, empty, and error states.** They are acceptance criteria in the
  PRD, so they have tests.
- **Interactive elements are reachable by keyboard** and have an accessible name. A `div` with a
  `@click` is a finding — use a `button`.

### Components and structure

- **`<script setup lang="ts">` throughout**, with typed `defineProps` / `defineEmits`.
- **Composables own reusable logic**, named `useX`, returning refs rather than reactive objects.
- **Genesis — a Pinia store holding server state is a snapshot, and must be treated as one.**
  Data access is API-only (`CLAUDE.md`), so there are no Firestore listeners to own it: a store
  is filled by a fetch and goes stale the moment the server moves. Two things follow. Refetch
  after every mutation rather than patching the store to match what you think the server did.
  And **clear it when the session ends** — Pinia survives sign-out, which is a route change and
  not a page load, so a store left populated renders one user's data to the next one who signs
  in on the same browser. `stores/auth.ts`'s `signOutNow` is where that clearing lives.

---

## Sources

- [Vue Style Guide — Priority A](https://vuejs.org/style-guide/rules-essential) ·
  [Priority B](https://vuejs.org/style-guide/rules-strongly-recommended)
- [typescript-eslint shared configs](https://typescript-eslint.io/users/configs/) ·
  [typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
- [TSConfig reference](https://www.typescriptlang.org/tsconfig/)
