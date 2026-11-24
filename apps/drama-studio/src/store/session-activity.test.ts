import { expect, test } from 'vitest'
import { SessionActivity } from './session-activity'

test('原生运行快照覆盖所有已知对话，迟到的运行快照不能覆盖完成事件', () => {
  const activity = new SessionActivity()
  activity.reconcile([{ id: 'a', session_key: 'stored-a', status: 'working' }, { id: 'b', session_key: 'stored-b', status: 'idle' }], activity.ticket())
  expect([...activity.running.get()]).toEqual(['stored-a'])
  const stale = activity.ticket()
  activity.observe({ type: 'message.complete', session_id: 'a', payload: { status: 'complete' } })
  activity.reconcile([{ id: 'a', session_key: 'stored-a', status: 'working' }], stale)
  expect([...activity.running.get()]).toEqual([])
  activity.observe({ type: 'message.start', session_id: 'b', payload: {} })
  expect([...activity.running.get()]).toEqual(['stored-b'])
  activity.observe({ type: 'session.info', session_id: 'b', payload: { running: false } })
  expect([...activity.running.get()]).toEqual([])
})

test('切换账号后旧快照失效，删除会话移除运行态，新快照可发现其他标签页的任务', () => {
  const activity = new SessionActivity()
  const old = activity.ticket()
  activity.reset()
  activity.reconcile([{ id: 'old', session_key: 'foreign', status: 'working' }], old)
  expect([...activity.running.get()]).toEqual([])
  activity.reconcile([{ id: 'other-tab', session_key: 'new-task', status: 'working' }], activity.ticket())
  expect([...activity.running.get()]).toEqual(['new-task'])
  activity.forget('new-task')
  expect([...activity.running.get()]).toEqual([])
})


test('父回合结束但子任务仍在等待时保持运行圆圈，最后一条父完成才结束', () => {
  const activity = new SessionActivity(); activity.bind('parent', 'stored', true)
  activity.observe({ type: 'message.complete', session_id: 'parent', payload: { status: 'complete' } }, { runtimeId: 'parent', storedId: 'stored' }, true, 1)
  expect([...activity.running.get()]).toEqual(['stored'])
  activity.observe({ type: 'subagent.complete', session_id: 'child', payload: { status: 'completed' } }, undefined, true, 1)
  expect([...activity.running.get()]).toEqual(['stored'])
  activity.observe({ type: 'message.complete', session_id: 'parent', payload: { status: 'complete' } }, { runtimeId: 'parent', storedId: 'stored' }, true, 0)
  expect([...activity.running.get()]).toEqual([])
})
