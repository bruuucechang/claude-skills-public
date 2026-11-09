import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Reading } from '../types'

// 跟 home/claude/hooks/context-tier.mjs 同一組門檻，面板才對得上它
const TIER1 = 500_000
const TIER2 = 800_000
const PANE = 'ctx-panel'

const readings = atom({ plugin: 'ctx-panel', key: 'readings' } as const, [])
const cum = atom({ plugin: 'ctx-panel', key: 'cum' } as const, 0)
const turns = atom({ plugin: 'ctx-panel', key: 'turns' } as const, 0)

const K = (n: number) => `${Math.round(n / 1000)}k`
const M = (n: number) => `${(n / 1e6).toFixed(1)}M`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ctx-panel', description: '打開 context 用量面板' })
    void $.ui.open({ id: PANE, title: 'Context' })

    return next(e)
  })

  on('command.run', { command: 'ctx-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Context' })

    return { text: 'Context 面板已打開。' }
  })

  // 只看不改：記下每次 context 變動，寫一份 jsonl 給實測時跟 context-tier.log 對
  on('session.measure', async ($, e, next) => {
    const { tokens, window, percent } = e.context
    if (e.changed.includes('context') && tokens !== undefined) {
      // percent 沒給時自己算，不要畫成 0%
      const pct = percent ?? Math.round((tokens / window) * 100)
      const one: Reading = { at: await $.clock.now(), tokens, window, percent: pct }
      const list = await update($, readings, l => [...l, one].slice(-200))
      // context-tier 濾掉 < 1k 的零星呼叫，這裡照做
      if (tokens >= 1000) {
        await update($, cum, n => n + tokens)
        await update($, turns, n => n + 1)
      }
      // 對帳用的檔寫不出去不該讓面板停住
      try {
        const sid = await $.session.id()
        await $.fs.write(
          `${$.plugin.root}/measure-${sid.slice(0, 8)}.jsonl`,
          list.map(r => JSON.stringify(r)).join('\n') + '\n',
        )
      } catch {}
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, readings)
    const last = list[list.length - 1]
    if (!last) return <Text dimColor>還沒有回應，等第一輪。</Text>

    const tier = last.tokens >= TIER2 ? 2 : last.tokens >= TIER1 ? 1 : 0
    const hint = ['', '過 500k：適合 /compact', '過 800k：寫交接單換手'][tier]

    return (
      <Box flexDirection="column">
        <Text bold>{K(last.tokens)} / {K(last.window)}（{last.percent}%）</Text>
        <Text color={tier === 2 ? 'red' : tier === 1 ? 'yellow' : undefined}>
          {tier === 0 ? '門檻以下' : hint}
        </Text>
        <Text dimColor>累積 {M(await read($, cum))}，{await read($, turns)} 輪（只算這個面板載入後）</Text>
      </Box>
    )
  })
}
