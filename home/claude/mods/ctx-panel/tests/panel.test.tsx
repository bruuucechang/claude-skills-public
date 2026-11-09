import { expect, test } from 'claude-code/testing'

const PANE = {
  title: 'Context', isFocused: false, bodyColumns: 60, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 }, view: {},
}

const at = (tokens: number) => ({
  context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
  rateLimits: [],
  changed: ['context' as const],
})

test('面板顯示最新的 context 與 context-tier 的門檻', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('clock.now', () => ({ value: 0 }))
  on('session.id', () => ({ value: 'test-session' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'ctx-panel', surface, component: 'Pane', props: PANE, requestId: 'ctx-panel' })
    expect(await empty.find({ type: 'Text', text: /還沒有回應/ })).toBeDefined()
    await empty.unmount()
  }

  await $.session.measure(at(420_000))
  await $.session.measure(at(620_000))
  await $.session.measure(at(500))   // < 1k 的零星呼叫不算進累積

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ctx-panel', surface, component: 'Pane', props: PANE, requestId: 'ctx-panel' })
    expect(await ui.find({ type: 'Text', text: /^1k \/ 1000k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /累積 1\.0M，2 輪/ })).toBeDefined()
    await ui.unmount()
  }

  await $.session.measure(at(850_000))
  // percent 沒給時自己算，不能畫成 0%
  await $.session.measure({ ...at(700_000), context: { tokens: 700_000, window: 1_000_000 } })
  const mid = await $.ui.mount({ plugin: 'ctx-panel', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'ctx-panel' })
  expect(await mid.find({ type: 'Text', text: /700k \/ 1000k（70%）/ })).toBeDefined()
  await mid.unmount()
  await $.session.measure(at(850_000))
  const ui = await $.ui.mount({ plugin: 'ctx-panel', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'ctx-panel' })
  expect(await ui.find({ type: 'Text', text: /850k \/ 1000k（85%）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /800k：寫交接單換手/ })).toBeDefined()
  await ui.unmount()
})
