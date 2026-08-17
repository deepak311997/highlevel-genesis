import { isRouteEnabled, matchRoute } from '../hl/routes'

/**
 * How many HighLevel calls a generation wrote, and how many of them the proxy
 * would actually answer — **a metric, not a parser** (D19).
 *
 * This is the one signal outside a fixture that says whether F3.2 landed. The
 * cheat-sheet teaches the model a calling convention and an allowlist; nothing in
 * this repository can observe whether the model complied, because every automated
 * test stubs it (D20). Two integers on `generation.complete` can: a run of
 * generations reporting `hlCallsKnown: 0` means the prompt is not working, and a
 * run reporting unknown calls means it is teaching something the proxy refuses.
 * The rejected alternative was keeping the extractor test-only, which leaves the
 * project with no signal at all outside the golden fixture.
 *
 * ## What it deliberately does not know
 *
 * It is a regular expression over generated code. It knows nothing about
 * comments, string context or scope, so a commented-out `hl('GET', '/x')` is
 * counted, and so is one inside a string literal in a code sample the model
 * wrote. That is a limitation, it is asserted in the spec rather than merely
 * mentioned here, and it is the right trade: refining these numbers would mean
 * parsing JavaScript — a second implementation of a language — to sharpen a
 * signal whose value is entirely in its order of magnitude. Read the counters as
 * "the model wrote about this many calls, about this many of them reachable",
 * never as ground truth about what the generated app does at runtime.
 *
 * ## Why the method is captured loosely
 *
 * `[A-Z]+`, not `GET|POST|PUT`. A verb the allowlist does not carry — `DELETE`,
 * the case Slice 8 D4 turned down explicitly — is precisely the thing worth
 * counting, so it must be *extracted* and then found unknown. An alternation of
 * the three allowed methods would make the most interesting failure invisible and
 * report a clean generation.
 *
 * Nothing user- or model-written leaves this module: `countHlCalls` returns two
 * integers, which is what lets them join `GenerationLogContext` without
 * disturbing its guarantee that no content reaches Cloud Logging (D19).
 */

/** One literal `hl(method, path, …)` call found in generated code. */
export interface HlCall {
  method: string
  path: string
}

/**
 * `hl(` `'METHOD'` `,` `'/path'`, single- or double-quoted, whitespace-tolerant.
 *
 * The leading `\b` is what makes `myhl('GET', '/x')` a miss: there is no word
 * boundary inside an identifier. Both string literals must open and close on the
 * same quote character (the `\1`/`\3` back-references), and the path must start
 * with `/` and contain no quote or newline — so a template literal and a variable
 * are misses rather than half-read paths.
 *
 * The trailing `(?=\s*[,)])` is what makes a **concatenation** a miss too, and it
 * is load-bearing rather than tidy. Without it the pattern stops at the first
 * closing quote, so `hl('GET', '/calendars/' + id + '/events')` yields the path
 * `/calendars/` — a prefix of the real route which happens to be an enabled row
 * of its own. `countHlCalls` then scores as **known** a call the proxy would
 * refuse, which is the one outcome that makes the metric worse than no metric.
 * Requiring the closing quote to be followed by the end of the argument (`,` or
 * `)`) means a computed path yields nothing at all.
 *
 * Under-reporting a computed path is the correct bias: the counter would
 * otherwise report a route nobody wrote.
 */
const HL_CALL = /\bhl\s*\(\s*(['"])([A-Z]+)\1\s*,\s*(['"])(\/[^'"\n]*)\3(?=\s*[,)])/g

/** Every literal `hl()` call in `code`, in source order. */
export function extractHlCalls(code: string): HlCall[] {
  const calls: HlCall[] = []

  // `matchAll` rather than a `exec` loop on a module-level global regex: it works
  // on an internal clone, so `lastIndex` cannot leak between two callers.
  for (const match of code.matchAll(HL_CALL)) {
    const method = match[2]
    const path = match[4]
    // `noUncheckedIndexedAccess`: both groups are unconditional in the pattern, so
    // this cannot happen — and a guard is cheaper than a claim that it cannot.
    if (method === undefined || path === undefined) continue
    calls.push({ method, path })
  }

  return calls
}

/**
 * How many of those calls the proxy would answer.
 *
 * "Known" is the runtime question, not the table question: a row exists **and**
 * is enabled in this environment. A flag-gated row with its flag unset answers
 * `403 route_disabled` at runtime, so counting it as known would report a
 * generated app as working when its one action fails (D3).
 *
 * The environment is an argument rather than a read of `process.env`, matching
 * `isRouteEnabled`'s own reasoning: this module stays pure, and the caller in
 * `generate.ts` passes `process.env` at the one place it belongs.
 */
export function countHlCalls(
  calls: readonly HlCall[],
  env: Record<string, string | undefined>,
): { known: number; unknown: number } {
  let known = 0

  for (const call of calls) {
    const match = matchRoute(call.method, call.path)
    if (match.kind === 'matched' && isRouteEnabled(match.row, env)) known += 1
  }

  return { known, unknown: calls.length - known }
}
