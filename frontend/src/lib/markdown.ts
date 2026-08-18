/**
 * The markdown a reply actually uses, parsed into a tree of **data**.
 *
 * ## Why this exists, given `messageParts.ts` refused a renderer
 *
 * That refusal had two halves. The first was taste — "the reply's prose is
 * prose" — and it did not survive contact with the model: `**bold**`, `- ` and
 * backticked paths arrive on every turn, and rendered literally they read as a
 * bug in the product rather than as emphasis.
 *
 * The second half was the real argument: "a second parser over content the model
 * controls, with an injection surface". That objection is answered here rather
 * than overruled — **by removing the surface, not by trusting a sanitiser.**
 * These functions return arrays of tagged objects and never a string of HTML, so
 * `MessageBody.vue` renders them through ordinary interpolation and `v-html`
 * appears nowhere in the codebase. Vue escapes every text node it prints, so
 * there is no path from model output to markup at all — which is a stronger
 * guarantee than `marked` + DOMPurify, and it costs no dependency.
 *
 * The single exception is a link's `href`, which is the one value that reaches an
 * attribute. It carries a scheme allowlist (see {@link isSafeHref}) and anything
 * else stays literal text.
 *
 * ## It runs on every streamed token
 *
 * `MessageBody` re-parses the whole accumulated string each time a `token` frame
 * lands, because the placeholder and the persisted bubble render the same string
 * (D7) and only one of them is ever complete. Every rule below therefore has to
 * degrade sensibly on a prefix: an unclosed `**` is literal text, not a bold run
 * that eats the rest of the reply. Each construct requires its closing delimiter
 * to exist before it means anything, which makes that property fall out of the
 * grammar instead of needing a special case.
 *
 * ## Deliberately a subset
 *
 * Headings, lists, fences, quotes, rules, and four inline forms. No tables, no
 * nested lists, no reference links, no HTML passthrough — none of which the
 * system prompt asks for or the model emits into chat prose. A subset that is
 * wholly correct beats a full implementation that is mostly correct, and the
 * omissions all degrade to literal text rather than to a broken bubble.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

export type Block =
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'quote'; inline: Inline[] }
  | { kind: 'rule' }

/**
 * The only schemes a link may carry.
 *
 * `javascript:` is the attack, `data:` is the same attack wearing a hat, and a
 * bare or relative path is meaningless in a chat bubble that lives inside an
 * app whose routes it knows nothing about. Everything else stays literal text,
 * so a refused link is visible rather than silently dropped — the user can still
 * read the URL and decide for themselves.
 */
function isSafeHref(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href)
}

/**
 * The inline grammar, as an ordered list of candidate matches.
 *
 * **Order is precedence at equal position.** `code` first, so a backticked
 * `**x**` is shown rather than interpreted — without it the model could never
 * write about markdown. `strong` before `em`, so `**x**` is not read as an em
 * containing `*x*`.
 *
 * Every pattern requires its closing delimiter, which is what makes a prefix
 * safe: mid-stream, `a **b` matches nothing and falls through to text.
 */
const INLINE_RULES: { pattern: RegExp; build: (match: RegExpExecArray) => Inline | null }[] = [
  {
    pattern: /`([^`\n]+)`/,
    build: (match) => ({ kind: 'code', text: match[1] ?? '' }),
  },
  {
    pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    build: (match) => {
      const href = match[2] ?? ''
      // Not a link, and therefore not anything — returning null puts the raw
      // characters back into the text run rather than dropping them.
      if (!isSafeHref(href)) return null
      return { kind: 'link', text: match[1] ?? '', href }
    },
  },
  {
    pattern: /\*\*([^\n]+?)\*\*|__([^\n]+?)__/,
    build: (match) => ({ kind: 'strong', text: match[1] ?? match[2] ?? '' }),
  },
  {
    pattern: /\*([^*\n]+)\*|_([^_\n]+)_/,
    build: (match) => ({ kind: 'em', text: match[1] ?? match[2] ?? '' }),
  },
]

/** Append to the trailing text run, or start one — never two in a row. */
function pushText(parts: Inline[], text: string): void {
  if (text === '') return
  const last = parts[parts.length - 1]
  if (last?.kind === 'text') last.text += text
  else parts.push({ kind: 'text', text })
}

export function parseInline(text: string): Inline[] {
  const parts: Inline[] = []
  let rest = text

  while (rest !== '') {
    let bestIndex = Number.POSITIVE_INFINITY
    let best: { match: RegExpExecArray; built: Inline } | null = null

    for (const rule of INLINE_RULES) {
      const match = rule.pattern.exec(rest)
      if (match === null || match.index >= bestIndex) continue
      const built = rule.build(match)
      /*
       * A refused link, which must not block a *later* real match: `[a](bad)
       * **b**` still bolds. Skipping the candidate rather than the position is
       * what allows that, and the literal characters are recovered because the
       * loop simply carries on to the next rule and, failing all of them, to the
       * text tail below.
       */
      if (built === null) continue
      bestIndex = match.index
      best = { match, built }
    }

    if (best === null) {
      pushText(parts, rest)
      break
    }

    pushText(parts, rest.slice(0, best.match.index))
    parts.push(best.built)
    rest = rest.slice(best.match.index + best.match[0].length)
  }

  return parts
}

const HEADING = /^(#{1,3})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const FENCE = /^\s*```(\w*)\s*$/

export function parseMarkdown(content: string): Block[] {
  const blocks: Block[] = []
  const lines = content.split('\n')
  let paragraph: string[] = []

  /** Flush the pending paragraph, keeping its own newlines (see the module note). */
  function flushParagraph(): void {
    const text = paragraph.join('\n').trim()
    paragraph = []
    if (text !== '') blocks.push({ kind: 'paragraph', inline: parseInline(text) })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    const fence = FENCE.exec(line)
    if (fence !== null) {
      flushParagraph()
      const body: string[] = []
      index += 1
      // An unterminated fence ends at end of input (see the streaming note):
      // the alternative is hiding every line the model has written since it
      // opened one, which mid-reply is most of the bubble.
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      const lang = fence[1] ?? ''
      blocks.push({ kind: 'code', lang: lang === '' ? null : lang, text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      continue
    }

    /*
     * Before the bullet rule, because `***` and `---` satisfy both and a rule is
     * the more specific reading. `- ` requires the space, so an em-dash line is
     * never a one-item list.
     */
    if (RULE.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'rule' })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      const level = (heading[1] ?? '#').length as 1 | 2 | 3
      blocks.push({ kind: 'heading', level, inline: parseInline(heading[2] ?? '') })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet !== null || ordered !== null) {
      flushParagraph()
      const isOrdered = ordered !== null
      const item = parseInline((isOrdered ? ordered[1] : bullet?.[1]) ?? '')
      /*
       * Appended to the open list of the same kind rather than starting a new
       * one, so a list that grows a token at a time stays one list. A bullet
       * list interrupted by a numbered one starts a second block, which is what
       * the markup says.
       */
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'list' && last.ordered === isOrdered) last.items.push(item)
      else blocks.push({ kind: 'list', ordered: isOrdered, items: [item] })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      flushParagraph()
      blocks.push({ kind: 'quote', inline: parseInline(quote[1] ?? '') })
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()
  return blocks
}
