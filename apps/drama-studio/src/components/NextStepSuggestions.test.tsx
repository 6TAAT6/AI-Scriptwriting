import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { NextStepSuggestion } from '../lib/suggestions'
import { availableSuggestions } from '../lib/suggestions'
import { NextStepSuggestions } from './NextStepSuggestions'

afterEach(cleanup)

const suggestions: NextStepSuggestion[] = [
  { label: '继续下一步', prompt: '按当前确认的方向继续，并说明这一步的交付内容。' },
  { label: '修改刚才的稿件', prompt: '先调整上一阶段的人物动机，保留已经确认的故事方向。' },
  { label: '回看当前成果', prompt: '整理本阶段已经完成的内容和仍需处理的问题。' }
]

test('直接发送所选完整建议，填入编辑不提前发送', () => {
  const sent: NextStepSuggestion[] = []
  const edited: NextStepSuggestion[] = []
  render(<NextStepSuggestions suggestions={suggestions} onSend={suggestion => sent.push(suggestion)} onEdit={suggestion => edited.push(suggestion)} />)

  const cards = screen.getAllByRole('listitem')
  fireEvent.click(within(cards[0]).getByRole('button', { name: /直接发送/ }))
  expect(sent).toEqual([{ label: '继续下一步', prompt: '按当前确认的方向继续，并说明这一步的交付内容。' }])
  expect(edited).toEqual([])

  fireEvent.click(within(cards[1]).getByRole('button', { name: /填入编辑/ }))
  expect(edited).toEqual([{ label: '修改刚才的稿件', prompt: '先调整上一阶段的人物动机，保留已经确认的故事方向。' }])
  expect(sent).toHaveLength(1)
  expect(within(cards[1]).getByText(suggestions[1].prompt).getAttribute('title')).toBe(suggestions[1].prompt)
})

test('旧回复中较长的标题和提示词仍完整呈现，点击时不丢失内容', () => {
  const original = { label: '保留当前对话中已经确认的全部要求并检查这次修改是否符合既定的人物和故事设定',
    prompt: '请检查本轮修改是否符合当前对话已经确认的所有要求。'.repeat(20) }
  expect(original.label.length).toBeGreaterThan(30)
  expect(original.label.length).toBeLessThanOrEqual(40)
  expect(original.prompt.length).toBeGreaterThan(300)
  expect(original.prompt.length).toBeLessThanOrEqual(1200)
  const available = availableSuggestions({ runtimeId: 'runtime', running: false, error: '', entries: [
    { id: 'reply', role: 'assistant', text: '内容已调整。\n```studio-suggestions\n' + JSON.stringify([original]) + '\n```', calls: [] }
  ] })!
  const sent: NextStepSuggestion[] = [], edited: NextStepSuggestion[] = []
  render(<NextStepSuggestions suggestions={available.suggestions} onSend={suggestion => sent.push(suggestion)} onEdit={suggestion => edited.push(suggestion)} />)
  expect(screen.getByText(original.label)).toBeTruthy()
  expect(screen.getByText(original.prompt).getAttribute('title')).toBe(original.prompt)
  fireEvent.click(screen.getByRole('button', { name: `填入编辑：${original.label}` }))
  fireEvent.click(screen.getByRole('button', { name: `直接发送：${original.label}` }))
  expect(edited).toEqual([original])
  expect(sent).toEqual([original])
})

test('已有草稿时只允许填入编辑，忙碌时两种操作都不可用', () => {
  const sent: NextStepSuggestion[] = []
  const edited: NextStepSuggestion[] = []
  const props = { suggestions, onSend: (suggestion: NextStepSuggestion) => { sent.push(suggestion) }, onEdit: (suggestion: NextStepSuggestion) => { edited.push(suggestion) } }
  const { rerender } = render(<NextStepSuggestions {...props} hasDraft />)

  expect(screen.getByRole('status').textContent).toContain('草稿')
  const send = screen.getAllByRole<HTMLButtonElement>('button', { name: /直接发送/ })[0]
  expect(send.disabled).toBe(true)
  fireEvent.click(send)
  fireEvent.click(screen.getAllByRole('button', { name: /填入编辑/ })[0])
  expect(sent).toEqual([])
  expect(edited).toEqual([suggestions[0]])

  rerender(<NextStepSuggestions {...props} disabled />)
  for (const button of screen.getAllByRole<HTMLButtonElement>('button')) {
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
  }
  expect(sent).toEqual([])
  expect(edited).toHaveLength(1)
})

test('推荐方案经过重渲染和长时间等待也不会自动发送，必须由用户点击操作', () => {
  vi.useFakeTimers()
  const sent: NextStepSuggestion[] = []
  const edited: NextStepSuggestion[] = []
  const recommended = { ...suggestions[0], recommended: true }
  const props = { suggestions: [recommended, ...suggestions.slice(1)], onSend: (suggestion: NextStepSuggestion) => sent.push(suggestion), onEdit: (suggestion: NextStepSuggestion) => edited.push(suggestion) }
  const { rerender, unmount } = render(<NextStepSuggestions {...props} />)
  try {
    vi.advanceTimersByTime(60_000)
    expect(sent).toEqual([])
    expect(edited).toEqual([])
    expect(screen.queryByText(/秒后自动/)).toBeNull()
    expect(screen.getByText('推荐')).toBeTruthy()
    rerender(<NextStepSuggestions {...props} suggestions={props.suggestions.map(value => ({ ...value }))} />)
    vi.advanceTimersByTime(60_000)
    expect(sent).toEqual([])
    fireEvent.click(screen.getAllByRole('button', { name: /填入编辑/ })[0])
    expect(edited).toEqual([recommended])
    expect(sent).toEqual([])
    fireEvent.click(screen.getAllByRole('button', { name: /直接发送/ })[0])
    expect(sent).toEqual([recommended])
  } finally {
    unmount()
    vi.useRealTimers()
  }
})
