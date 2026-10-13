// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SessionMaterials } from '../lib/creative'
import { workspace } from '../store/workspace'
import { Inspector } from './Inspector'
import { gateway } from '../lib/gateway'
import * as downloads from '../lib/download'
import { strToU8, zipSync } from 'fflate'

beforeEach(() => {
  workspace.reset()
  workspace.session.set({ storedId: 'stored-session', runtimeId: 'runtime-session', info: {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('创作资料的 Office 文档通过真实阅读器分行显示', async () => {
  const docx = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第03集</w:t></w:r></w:p><w:p><w:r><w:t>3-1场  接待室  日  内</w:t></w:r></w:p><w:p><w:r><w:t>人物：人物甲、人物乙</w:t><w:br/><w:t>△人物甲坐下。</w:t><w:br/><w:t>人物甲：你来了。</w:t></w:r></w:p></w:body></w:document>') })
  vi.spyOn(gateway, 'file').mockResolvedValue(new Response(docx, { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }))
  const { container } = render(<Inspector selected={{ id: 'doc', name: '剧本.docx', path: '/workspace/剧本.docx', kind: 'document' }} onSelect={() => {}} onClose={() => {}} />)
  await screen.findByRole('heading', { name: '第03集' })
  const paragraph = container.querySelector('.document-reader p')!
  expect(getComputedStyle(paragraph).whiteSpace).toBe('pre-wrap')
  expect(paragraph.textContent?.split('\n')).toHaveLength(3)
})

test('阶段稿存在 Word 回执时，预览工具栏提供 Word 下载', async () => {
  const read = vi.spyOn(gateway, 'file').mockResolvedValue(new Response('word-bytes', { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }))
  const save = vi.spyOn(downloads, 'saveBlob').mockResolvedValue()
  render(<Inspector selected={{
    id: 'script-1', name: '剧本正文 · 第 1 批', content: '第1集\n\n△她推门。', kind: 'result',
    downloadPath: '/assets-data/abc/第1批正文.docx', downloadName: '第1批正文.docx', downloadFormat: 'docx', downloadStatus: 'draft',
  }} onSelect={() => {}} onClose={() => {}} />)

  fireEvent.click(screen.getAllByRole('button', { name: '下载 Word' })[0])
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.any(Blob), '第1批正文.docx'))
  expect(read).toHaveBeenCalledWith('/assets-data/abc/第1批正文.docx', 'stored-session')
  expect(save).toHaveBeenCalledWith(expect.any(Blob), '第1批正文.docx')
})

test('迟到的下载在账号切换后不会保存旧文件，并且等待期间正文仍可读', async () => {
  let finish!: (blob: Blob) => void
  vi.spyOn(gateway, 'file').mockResolvedValue({ blob: () => new Promise(resolve => { finish = resolve }) } as Response)
  const save = vi.spyOn(downloads, 'saveBlob').mockResolvedValue()
  render(<Inspector selected={{ id: 'script', name: '第1批正文', content: '△她推门。', kind: 'result', downloadPath: '/assets-data/a/正文.docx', downloadName: '正文.docx', downloadFormat: 'docx' }} onSelect={() => {}} onClose={() => {}} />)
  await screen.findByText('△她推门。')
  fireEvent.click(screen.getAllByRole('button', { name: '下载 Word' })[0])
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.getByText('△她推门。')).toBeTruthy()
  act(() => { workspace.reset(); workspace.session.set({ storedId: 'stored-session', runtimeId: 'runtime-session', info: {} }) })
  await act(async () => finish(new Blob(['旧账号正文'])))
  expect(save).not.toHaveBeenCalled()
})

test('资料刷新期间阻止重复请求并在真实资料返回后恢复操作', async () => {
  let finish!: (materials: SessionMaterials) => void
  const materials = vi.spyOn(workspace.api, 'materials').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<Inspector selected={null} onSelect={() => {}} onClose={() => {}} />)
  const refresh = screen.getByRole('button', { name: '刷新创作资料' }) as HTMLButtonElement
  fireEvent.click(refresh)
  expect(refresh.disabled).toBe(true)
  fireEvent.click(refresh)
  expect(materials).toHaveBeenCalledTimes(1)
  await act(async () => finish({ project: null, sources: [{ id: 'source', name: '新原稿.md', kind: 'source', path: '/workspace/新原稿.md' }] }))
  expect(refresh.disabled).toBe(false)
  expect(screen.getByRole('button', { name: /新原稿.md/ })).toBeTruthy()
})

test('资料面板不再显示创作流程页签', () => {
  render(<Inspector selected={null} onSelect={() => {}} onClose={() => {}} />)

  expect(screen.queryByRole('tab', { name: '创作流程' })).toBeNull()
  expect(screen.getByRole('button', { name: '刷新创作资料' })).toBeTruthy()
})

test('稿件预览只保留顶部下载入口，并为下载和刷新提供即时提示', () => {
  const { container } = render(<Inspector selected={{
    id: 'script', name: '第1批正文', content: '△她推门。', kind: 'result',
    downloadPath: '/assets-data/a/正文.docx', downloadName: '正文.docx', downloadFormat: 'docx'
  }} onSelect={() => {}} onClose={() => {}} />)
  expect(screen.getAllByRole('button', { name: '下载 Word' })).toHaveLength(1)
  const download = screen.getByRole('button', { name: '下载 Word' })
  expect(download.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('下载 Word')
  expect(container.querySelector('.document-download')).toBeNull()
})

test('资料刷新按钮禁用时说明需要先准备会话', () => {
  workspace.session.set({ storedId: '', runtimeId: '', info: {} })
  render(<Inspector selected={null} onSelect={() => {}} onClose={() => {}} />)
  expect(screen.getByRole('button', { name: '刷新创作资料' }).closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('连接创作服务后才能刷新资料。')
})
