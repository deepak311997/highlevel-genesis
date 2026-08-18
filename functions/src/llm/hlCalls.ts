import { isRouteEnabled, matchRoute } from '../hl/routes'

/**
 * How many HighLevel calls a generation wrote, and how many the proxy would
 * answer — **a metric, not a parser**.
 *
 * It is the one signal outside a fixture that says whether the cheat-sheet is
 * working: every automated test stubs the model, so nothing here can observe
 * whether it complied. A run of generations reporting no known calls means the
 * prompt is not working; a run reporting unknown ones means it is teaching
 * something the proxy refuses.
 *
 * **It knows nothing about comments, string context or scope.** A commented-out
 * call is counted. Refining that would mean parsing JavaScript to sharpen a signal
 * whose value is entirely in its order of magnitude — read the counters as "about
 * this many calls, about this many reachable", never as ground truth.
 *
 * The method is captured loosely (`[A-Z]+`, not an alternation of the allowed
 * verbs): a verb the allowlist does not carry is precisely the thing worth
 * counting, so it must be extracted and *then* found unknown.
 *
 * Nothing user- or model-written leaves this module — two integers, which is what
 * lets them join the generation log line.
 */

/** One literal `hl(method, path, …)` call found in generated code. */
export interface HlCall {
  method: string
  path: string
}

/**
 * `hl(` `'METHOD'` `,` `'/path'`, single- or double-quoted, whitespace-tolerant.
 *
 * The leading `\b` makes `myhl('GET', '/x')` a miss. The trailing `(?=\s*[,)])` is
 * load-bearing rather than tidy: without it, `hl('GET', '/calendars/' + id)`
 * yields the path `/calendars/` — a prefix that happens to be an enabled row of
 * its own — so a call the proxy would refuse scores as *known*, which is the one
 * outcome that makes the metric worse than no metric. Under-reporting a computed
 * path is the correct bias.
 */
const HL_CALL = /\bhl\s*\(\s*(['"])([A-Z]+)\1\s*,\s*(['"])(\/[^'"\n]*)\3(?=\s*[,)])/g

/** Every literal `hl()` call in `code`, in source order. */
export function extractHlCalls(code: string): HlCall[] {
  const calls: HlCall[] = []

  // `matchAll` rather than an `exec` loop on a module-level global regex: it works
  // on an internal clone, so `lastIndex` cannot leak between two callers.
  for (const match of code.matchAll(HL_CALL)) {
    const method = match[2]
    const path = match[4]
    // Both groups are unconditional in the pattern, so this cannot happen — and a
    // guard is cheaper than a claim that it cannot.
    if (method === undefined || path === undefined) continue
    calls.push({ method, path })
  }

  return calls
}

/**
 * How many of those calls the proxy would answer.
 *
 * "Known" is the runtime question, not the table question: a row must exist *and*
 * be enabled here. A flag-gated row with its flag unset answers 403 at runtime, so
 * counting it as known would report an app as working when its one action fails.
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
