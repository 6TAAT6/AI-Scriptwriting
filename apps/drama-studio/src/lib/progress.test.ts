import { expect, it } from 'vitest'
import { beginTurn, progressEvent, restoreTurn } from './progress'

it('恢复计时使用后台秒时间戳，失败保留的旧起点不会重新启动计时', () => {
  const restored = restoreTurn({ running: true, turn_started_at: 1200 })
  expect(restored?.startedAt).toBe(1_200_000)
  expect(restored?.timingSource).toBe('server')
  expect(restoreTurn({ running: false, turn_started_at: 1200 })).toBeUndefined()
  const ended = progressEvent(restored, { type: 'message.complete', payload: { status: 'complete' } }, 1_270_000)
  expect(ended?.endedAt).toBe(1_270_000)
  expect(ended?.state).toBe('complete')
  const lateTool = progressEvent(ended, { type: 'tool.complete', payload: {} }, 1_999_000)
  expect(lateTool).toEqual(ended)
})

it('消息开始不会重置已开始的计时，断线补到完成事件不伪造准确结束时刻', () => {
  const start = beginTurn(1000)
  expect(progressEvent(start, { type: 'session.info', payload: { running: false } }, 1500)).toEqual(start)
  const active = progressEvent(start, { type: 'message.start', payload: {} }, 5000)
  expect(active?.startedAt).toBe(1000)
  const calibrated = progressEvent(active, { type: 'session.info', payload: { running: true, turn_started_at: 2 } }, 6000)
  expect(calibrated?.startedAt).toBe(2000)
  const replayed = progressEvent(calibrated, { type: 'message.complete', replayed: true, payload: { status: 'interrupted' } }, 999_000)
  expect(replayed?.state).toBe('interrupted')
  expect(replayed?.endedAt).toBeUndefined()
})

it('公开进度说明显示为中文，内部推理事件只更新分析状态且不存储原文', () => {
  const turn = progressEvent(beginTurn(1000), { type: 'thinking.delta', payload: { text: 'Preparing episode drafts' } }, 3000)
  expect(turn?.status).toBe('正在准备分集草稿')
  const thinking = progressEvent(turn, { type: 'reasoning.delta', payload: { text: 'PRIVATE_REASONING_DO_NOT_DISPLAY' } }, 5000)
  expect(thinking?.phase).toBe('model')
  expect(JSON.stringify(thinking)).not.toContain('PRIVATE_REASONING_DO_NOT_DISPLAY')
})

it('等待动画不堆积为步骤，真实操作按回执更新同一条进展', () => {
  let turn = beginTurn(1000)
  for (const text of ['(¬‿¬) 推敲...', '٩(｡•ω•｡)۶ 归纳...', 'ಠ_ಠ 头脑风暴...', '🧠 分析…']) {
    turn = progressEvent(turn, { type: 'thinking.delta', payload: { text } }, 2000)!
  }
  expect(turn.steps).toHaveLength(0)
  expect(turn.status).not.toMatch(/推敲|归纳|头脑风暴|ಠ|🧠/)
  turn = progressEvent(turn, { type: 'tool.start', payload: { tool_id: 'source', name: 'read_file', args: { path: '/private/原稿.txt' } } }, 3000)!
  expect(turn.status).toContain('阅读资料')
  expect(turn.steps?.[0].text).toContain('原稿.txt')
  expect(JSON.stringify(turn)).not.toContain('/private/')
  turn = progressEvent(turn, { type: 'tool.complete', payload: { tool_id: 'source', name: 'read_file', result: { ok: true }, summary: '已读取 12 场原稿', duration_s: 1.2 } }, 5000)!
  expect(turn.steps).toHaveLength(1)
  expect(turn.steps?.[0]).toMatchObject({ state: 'complete', text: expect.stringContaining('已读取 12 场原稿') })
  turn = progressEvent(turn, { type: 'thinking.delta', payload: { text: '(¬‿¬) 权衡...' } }, 6000)!
  expect(turn.steps).toHaveLength(1)
  expect(turn.status).not.toContain('权衡')
  turn = progressEvent(turn, { type: 'tool.start', payload: { tool_id: 'save', name: 'write_file' } }, 7000)!
  turn = progressEvent(turn, { type: 'message.complete', payload: { status: 'interrupted' } }, 8000)!
  expect(turn.steps?.find(step => step.id === 'tool:save')?.state).toBe('interrupted')
  expect(turn.steps?.find(step => step.id === 'tool:source')?.state).toBe('complete')
})
