import { expect, test } from 'vitest'
import { publicText, reduceEvent, historyEntries } from './transcript'

test('实时错误保留失败状态并转换为中文，不展示底层身份与地址', () => {
  const raw = "Hermes can't reach the model provider. You may be offline. Check your internet connection and try again."
  const state = reduceEvent({ runtimeId: 's', running: true, error: '', entries: [] }, { type: 'error', session_id: 's', payload: { message: raw } })
  expect(state.running).toBe(false)
  expect(publicText(state.error)).toBe('暂时无法连接创作服务，请稍后重试。')
  expect(historyEntries([{ role: 'assistant', text: raw }])[0].text).toBe('暂时无法连接创作服务，请稍后重试。')
  for (const error of ['Hermes request timed out at https://private.invalid/v1', 'Unknown OpenAI SDK exception', '创作失败：Hermes provider api_key']) {
    const text = publicText(error)
    expect(text).toMatch(/[\u3400-\u9fff]/)
    expect(text).not.toMatch(/Hermes|OpenAI|provider|api_key|https?:/i)
  }
  expect(publicText('请先上传原稿。')).toBe('请先上传原稿。')
})
