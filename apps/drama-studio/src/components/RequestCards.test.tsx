import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ServerRequest } from '../../../shared/src/json-rpc-channel'
import { workspace } from '../store/workspace'
import { RequestCards } from './RequestCards'

afterEach(() => { cleanup(); workspace.reset() })

test('创作确认保留业务内容与一次确认能力，不展示底层命令', async () => {
  const responses: Record<string, unknown>[] = []
  const request: ServerRequest = {
    id: 'confirm', method: 'approval', params: {
      session_id: 'runtime', tool_name: 'drama_confirm', description: '确认以家人重逢为核心期待。',
      command: 'PRIVATE_APPROVAL_COMMAND', choices: ['once', 'deny']
    }, respond: value => responses.push(value), fail: () => {}
  }
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.requests.set([request])
  render(<RequestCards />)
  expect(await screen.findByText('确认以家人重逢为核心期待。')).toBeTruthy()
  expect(document.body.textContent).not.toContain('PRIVATE_APPROVAL_COMMAND')
  expect(screen.queryByText('查看本次操作')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '确认本次操作' }))
  expect(responses).toEqual([{ choice: 'once' }])
  expect(workspace.requests.get()).toEqual([])
})

test('创作确认不会自动确认，用户必须主动点击按钮', () => {
  vi.useFakeTimers()
  const responses: Record<string, unknown>[] = []
  const request: ServerRequest = {
    id: 'confirm-timeout', method: 'approval', params: {
      session_id: 'runtime', tool_name: 'drama_confirm', description: '确认本次改编方向。', choices: ['once', 'deny']
    }, respond: value => responses.push(value), fail: () => {}
  }
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.requests.set([request])
  render(<RequestCards />)
  expect(screen.queryByRole('status')).toBeNull()
  vi.advanceTimersByTime(60_000)
  expect(responses).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '确认本次操作' }))
  expect(responses).toEqual([{ choice: 'once' }])
  vi.useRealTimers()
})

test('多选创作问题允许切换多个选项并按协议提交 JSON 数组，同时可跳过单题', () => {
  const responses: Record<string, unknown>[] = []
  const request: ServerRequest = {
    id: 'clarify-multi', method: 'clarify', params: {
      session_id: 'runtime', questions: [{ qid: 'q0', question: '需要哪些元素？', choices: ['人物', '场景', '道具'], multi_select: true }]
    }, respond: value => responses.push(value), fail: () => {}
  }
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.requests.set([request])
  render(<RequestCards />)

  const choices = screen.getAllByRole('button', { name: /人物|场景/ })
  expect(choices[0].getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: '人物' }))
  fireEvent.click(screen.getByRole('button', { name: '场景' }))
  expect(screen.getByRole('button', { name: '人物' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '场景' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '跳过本题' }))
  fireEvent.click(screen.getByRole('button', { name: '确认并继续' }))
  expect(responses).toEqual([{ answers: { q0: null } }])
})

test('创作问题支持取消整组确认，并允许跳过后重新选择', () => {
  const responses: Record<string, unknown>[] = []
  const request: ServerRequest = {
    id: 'clarify-cancel', method: 'clarify', params: {
      session_id: 'runtime', questions: [{ qid: 'q0', question: '选择方向', choices: ['方向一', '方向二'] }]
    }, respond: value => responses.push(value), fail: () => {}
  }
  workspace.session.set({ runtimeId: 'runtime', storedId: 'stored', info: {} })
  workspace.requests.set([request])
  render(<RequestCards />)

  fireEvent.click(screen.getByRole('button', { name: '跳过本题' }))
  expect((screen.getByRole('button', { name: '确认并继续' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '方向一' }))
  expect((screen.getByRole('button', { name: '确认并继续' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByRole('button', { name: '方向一' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '取消本次确认' }))
  expect(responses).toEqual([{}])
})
