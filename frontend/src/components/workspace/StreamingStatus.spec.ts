import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

/**
 * What the panel says while the model is working.
 *
 * The old placeholder said `Generating…` and nothing else, for the whole turn. That is wrong at
 * both ends of a generation: for the first several seconds there is genuinely nothing on screen
 * — `params.ts` leaves adaptive thinking on, and `stream.ts` drops every thinking delta, so the
 * client receives keep-alives and no text — and once code starts flowing the interesting fact is
 * *which file is being written*, which the store already knows and the panel was throwing away.
 */

const store = reactive<{ streamingText: string; streamingStates: Record<string, string> }>({
  streamingText: '',
  streamingStates: {},
})

vi.mock('@/stores/workspace', () => ({ useWorkspaceStore: () => store }))

const StreamingStatus = (await import('./StreamingStatus.vue')).default

function set(text: string, files: Record<string, string> = {}): void {
  store.streamingText = text
  store.streamingStates = files
}

describe('before anything has arrived', () => {
  it('says it is thinking rather than showing an empty bubble', () => {
    set('')

    const wrapper = mount(StreamingStatus)

    expect(wrapper.get('[data-testid="streaming-status"]').text()).toContain('Thinking')
  })

  /*
   * The reason this state exists at all: `effort: 'high'` with thinking on means
   * several seconds of silence, and silence in a chat panel reads as a hang.
   */
  it('shows the animated dots while thinking', () => {
    set('')

    const wrapper = mount(StreamingStatus)

    expect(wrapper.findAll('[data-testid="thinking-dot"]')).toHaveLength(3)
  })
})

describe('once prose is arriving', () => {
  it('stops saying it is thinking', () => {
    set('Here is a contact')

    const wrapper = mount(StreamingStatus)

    expect(wrapper.get('[data-testid="streaming-status"]').text()).not.toContain('Thinking')
  })

  it('says it is writing the reply', () => {
    set('Here is a contact')

    const wrapper = mount(StreamingStatus)

    expect(wrapper.get('[data-testid="streaming-status"]').text()).toContain('Writing')
  })
})

describe('once a file is being written', () => {
  it('names the file currently being written', () => {
    set('prose', { 'index.html': '<h1>', 'app.js': 'const' })

    const wrapper = mount(StreamingStatus)

    expect(wrapper.get('[data-testid="streaming-status"]').text()).toContain('app.js')
  })

  /* The most recent key is the open one — the store inserts on `file_start`. */
  it('follows the newest file rather than the first', () => {
    set('prose', { 'index.html': '<h1>', 'styles.css': 'body' })

    const wrapper = mount(StreamingStatus)

    expect(wrapper.get('[data-testid="streaming-status"]').text()).toContain('styles.css')
    expect(wrapper.get('[data-testid="streaming-status"]').text()).not.toContain('index.html')
  })

  it('counts the files so far', () => {
    set('prose', { 'a.html': 'x', 'b.css': 'y', 'c.js': 'z' })

    const wrapper = mount(StreamingStatus)

    expect(wrapper.get('[data-testid="streaming-file-count"]').text()).toContain('3')
  })

  it('shows no count before any file has started', () => {
    set('prose')

    const wrapper = mount(StreamingStatus)

    expect(wrapper.find('[data-testid="streaming-file-count"]').exists()).toBe(false)
  })
})
