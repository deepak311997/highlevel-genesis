import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

/**
 * A reply, rendered.
 *
 * Two things are asserted here that the parser's own suite cannot see: that the tree reaches
 * **real elements** — `<strong>`, `<li>`, `<code>` — rather than a string of markup, and that a
 * file marker becomes a control that opens the file rather than a decorative pill. The second is
 * the whole reason the chips stopped being `Badge`s: a turn's output is the most likely thing a
 * reader wants to look at next, and it was the one thing in the bubble they could not click.
 */

const store = reactive({ selectFile: vi.fn(), files: [] as { path: string }[] })

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

const MessageBody = (await import('./MessageBody.vue')).default

beforeEach(() => {
  store.selectFile = vi.fn()
})

describe('markdown', () => {
  it('renders bold as a strong element, not as literal asterisks', () => {
    const wrapper = mount(MessageBody, { props: { content: 'a **b** c' } })

    expect(wrapper.find('strong').text()).toBe('b')
    expect(wrapper.text()).not.toContain('**')
  })

  it('renders a bullet list as list items', () => {
    const wrapper = mount(MessageBody, { props: { content: '- one\n- two' } })

    const items = wrapper.findAll('li')
    expect(items).toHaveLength(2)
    expect(items[0]?.text()).toBe('one')
  })

  it('renders inline code as a code element', () => {
    const wrapper = mount(MessageBody, { props: { content: 'use `hl()` here' } })

    expect(wrapper.find('code').text()).toBe('hl()')
  })

  it('renders a fenced block as a pre', () => {
    const wrapper = mount(MessageBody, { props: { content: '```js\nconst a = 1\n```' } })

    expect(wrapper.find('pre').text()).toContain('const a = 1')
  })

  /*
   * Headings are **demoted**, not mapped one-to-one. A bubble sits inside a panel that already
   * owns its own heading, so a reply opening with `#` would otherwise put an `<h1>` in the
   * middle of the document outline — and the model chooses that character, not us.
   */
  it.each([
    ['# Title', 'h3'],
    ['## Title', 'h4'],
    ['### Title', 'h5'],
  ])('demotes %o to %s so a reply cannot outrank the page', (content, tag) => {
    const wrapper = mount(MessageBody, { props: { content } })

    expect(wrapper.find(tag).text()).toBe('Title')
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.find('h2').exists()).toBe(false)
  })

  /*
   * The escaping property, asserted rather than assumed. The parser produces no markup and Vue
   * prints text nodes escaped, so a reply containing a tag shows the tag.
   */
  it('shows markup in the reply as text rather than executing it', () => {
    const wrapper = mount(MessageBody, {
      props: { content: 'try <img src=x onerror=alert(1)> now' },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
  })

  it('renders an http link with a safe rel', () => {
    const wrapper = mount(MessageBody, { props: { content: '[docs](https://example.com)' } })

    const link = wrapper.find('a')
    expect(link.attributes('href')).toBe('https://example.com')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('leaves a javascript: link as text, with no anchor at all', () => {
    const wrapper = mount(MessageBody, { props: { content: '[x](javascript:alert(1))' } })

    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toContain('javascript:alert(1)')
  })
})

describe('file markers', () => {
  const CONTENT = 'Here it is.\n\n[file: index.html]\n[file: app.js]\n\nDone.'

  it('groups a run of markers into one list with a count', () => {
    const wrapper = mount(MessageBody, { props: { content: CONTENT } })

    expect(wrapper.findAll('[data-testid="file-chip"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="file-group"]').text()).toContain('2 files')
  })

  it('opens the file when a chip is clicked', async () => {
    const wrapper = mount(MessageBody, { props: { content: CONTENT } })

    await wrapper.findAll('[data-testid="file-chip"]')[1]?.trigger('click')

    expect(store.selectFile).toHaveBeenCalledWith('app.js')
  })

  it('says "1 file" rather than "1 files"', () => {
    const wrapper = mount(MessageBody, { props: { content: '[file: index.html]' } })

    expect(wrapper.get('[data-testid="file-group"]').text()).toContain('1 file')
    expect(wrapper.get('[data-testid="file-group"]').text()).not.toContain('1 files')
  })

  it('keeps the prose either side of the group', () => {
    const wrapper = mount(MessageBody, { props: { content: CONTENT } })

    expect(wrapper.text()).toContain('Here it is.')
    expect(wrapper.text()).toContain('Done.')
  })
})
