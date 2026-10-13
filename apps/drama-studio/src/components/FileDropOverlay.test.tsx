// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App } from '../App'
import { workspace, type WorkspaceApi } from '../store/workspace'

interface Receipt { method: string; params: Record<string, unknown> }
let receipts: Receipt[]

beforeEach(() => {
  localStorage.clear()
  workspace.reset()
  workspace.connection.set('open')
  receipts = []
  const project = { title: '我的剧本', pinned: false, hidden: false }
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url !== '/studio/sidebar/sessions/drop-stored' || init?.method !== 'PATCH' || JSON.parse(String(init.body)).projectId !== null) throw new Error('意外项目请求')
    return new Response(JSON.stringify({ project, projects: [{ id: 'default', ...project }], sessions: [{ id: 'drop-stored', projectId: null }], canReveal: false }))
  })
  vi.spyOn(workspace.api, 'rpc').mockImplementation((async (method, params) => {
    const payload = params as Record<string, unknown>
    receipts.push({ method, params: payload })
    if (method === 'session.create') return { session_id: 'drop-runtime', stored_session_id: 'drop-stored', info: {}, messages: [], message_count: 0 }
    if (method === 'session.list') return { sessions: [] }
    if (method === 'file.attach') return { attached: true, name: payload.name, path: `/attachments/${payload.name}`, ref_path: `attachments/${payload.name}`, ref_text: `@file:attachments/${payload.name}`, uploaded: true }
    throw new Error(`拖入原稿不应调用 ${method}`)
  }) as WorkspaceApi['rpc'])
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); workspace.reset() })

function fileTransfer(files: File[], directory = false) {
  return {
    types: ['Files'], files, dropEffect: 'none',
    items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: directory, isFile: !directory }) }))
  }
}

function drag(type: string, dataTransfer: unknown, target: Window | Element = window) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  fireEvent(target, event)
  return event
}

test('拖入和文件选择都添加真实原稿附件，保留输入且不会自动发送', async () => {
  workspace.editComposer({ text: '保留这段创作要求' })
  render(<App />)
  const input = screen.getByRole('textbox', { name: '给巨豹智能体发送消息' })
  const files = [new File(['first draft'], '第一份原稿.txt', { type: 'text/plain' }), new File(['second draft'], '人物说明.md', { type: 'text/markdown' })]
  const transfer = fileTransfer(files)

  drag('dragenter', transfer)
  expect(screen.getByRole('status').textContent).toContain('松开鼠标，添加文档或图片')
  drag('dragenter', transfer, input)
  drag('dragleave', transfer, input)
  expect(document.querySelector('[data-file-drop="active"]')).not.toBeNull()
  expect(drag('dragover', transfer, input).defaultPrevented).toBe(true)
  expect(drag('drop', transfer, input).defaultPrevented).toBe(true)
  // 同一次拖放冒泡到全页以及上传期间再次拖入，均不能重复上传。
  drag('drop', transfer, input)

  await waitFor(() => expect(workspace.composer.get().busy).toBe(false))
  expect(screen.getByRole('button', { name: '移除附件 第一份原稿.txt' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '移除附件 人物说明.md' })).toBeTruthy()
  expect(workspace.composer.get().attachments).toHaveLength(2)
  expect((input as HTMLTextAreaElement).value).toBe('保留这段创作要求')
  expect(document.querySelector('[data-file-drop="active"]')).toBeNull()
  expect(receipts.filter(row => row.method === 'session.create')).toHaveLength(1)
  expect(receipts.filter(row => row.method === 'file.attach').map(row => ({ session: row.params.session_id, name: row.params.name, data: row.params.data_url }))).toEqual([
    { session: 'drop-runtime', name: '第一份原稿.txt', data: 'data:text/plain;base64,Zmlyc3QgZHJhZnQ=' },
    { session: 'drop-runtime', name: '人物说明.md', data: 'data:text/markdown;base64,c2Vjb25kIGRyYWZ0' }
  ])

  const picker = screen.getByLabelText('选择原稿或图片文件')
  fireEvent.change(picker, { target: { files: [new File(['picked draft'], '选择上传.csv', { type: 'text/csv' })] } })
  await waitFor(() => expect(workspace.composer.get().busy).toBe(false))
  expect(screen.getByRole('button', { name: '移除附件 选择上传.csv' })).toBeTruthy()
  expect(workspace.composer.get().attachments).toHaveLength(3)
  expect(receipts.filter(row => row.method === 'file.attach').at(-1)?.params).toMatchObject({ session_id: 'drop-runtime', name: '选择上传.csv', data_url: 'data:text/csv;base64,cGlja2VkIGRyYWZ0' })
  expect(receipts.some(row => row.method === 'prompt.submit')).toBe(false)
  expect((input as HTMLTextAreaElement).value).toBe('保留这段创作要求')
})

test('文本拖拽保持原行为，不可上传状态和非法整批原稿都不产生上传', async () => {
  render(<App />)
  const textTransfer = { types: ['text/plain'], files: [], items: [], getData: () => '拖动的文字' }
  for (const type of ['dragenter', 'dragover', 'drop']) expect(drag(type, textTransfer).defaultPrevented).toBe(false)
  expect(document.querySelector('[data-file-drop="active"]')).toBeNull()

  const valid = new File(['valid'], '合法原稿.txt', { type: 'text/plain' })
  const blockedStates = [
    () => workspace.editComposer({ busy: true }),
    () => workspace.conversation.set({ ...workspace.conversation.get(), running: true }),
    () => workspace.navigation.set({ ...workspace.navigation.get(), loading: true }),
    () => workspace.connection.set('closed')
  ]
  for (const block of blockedStates) {
    act(() => {
      workspace.editComposer({ busy: false })
      workspace.conversation.set({ ...workspace.conversation.get(), running: false, error: '' })
      workspace.navigation.set({ ...workspace.navigation.get(), loading: false })
      workspace.connection.set('open')
      block()
    })
    expect(drag('dragover', fileTransfer([valid])).defaultPrevented).toBe(true)
    expect(drag('drop', fileTransfer([valid])).defaultPrevented).toBe(true)
    expect(receipts).toEqual([])
    expect(workspace.composer.get().attachments).toEqual([])
  }

  act(() => { workspace.reset(); workspace.connection.set('open') })
  const oversized = new File([new Uint8Array(20 * 1024 * 1024 + 1)], '过大原稿.txt', { type: 'text/plain' })
  const unsupported = new File(['not supported'], '无法导入.exe')
  const rejectedTransfers = [fileTransfer([new File([], '原稿文件夹.txt')], true), fileTransfer([valid, unsupported]), fileTransfer([valid, oversized])]
  for (const transfer of rejectedTransfers) {
    act(() => workspace.conversation.set({ ...workspace.conversation.get(), error: '' }))
    expect(drag('drop', transfer).defaultPrevented).toBe(true)
    await waitFor(() => expect(workspace.composer.get().busy).toBe(false))
    expect(workspace.conversation.get().error).not.toBe('')
    expect(receipts).toEqual([])
    expect(workspace.composer.get().attachments).toEqual([])
  }
})
