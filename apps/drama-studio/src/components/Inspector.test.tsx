// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SessionMaterials } from '../lib/creative'
import { workspace } from '../store/workspace'
import { Inspector } from './Inspector'
import { ManuscriptDelivery } from './ManuscriptDelivery'
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

  expect(document.querySelector('.document-status')).toBeNull()
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

test('具有前版身份的稿件在资料栏合并为最新版并注明版本数', () => {
  workspace.project.set({ id: 'p', title: '项目', stage: '', artifacts: [
    { id: 'a1', contentSha256: 'a'.repeat(64), name: '第1集剧本正文', content: '首稿', kind: 'result', downloadPath: '/assets-data/a1', downloadFormat: 'docx' },
    { id: 'a2', previousDocumentId: 'a1', previousContentSha256: 'a'.repeat(64), name: '第1集剧本正文', content: '返修版', kind: 'result', downloadPath: '/assets-data/a2', downloadFormat: 'docx' },
    { id: 'b1', name: '第2集剧本正文', content: '正文', kind: 'result', downloadPath: '/assets-data/b1', downloadFormat: 'docx' },
  ] })
  const selected: unknown[] = []
  render(<Inspector selected={null} onSelect={file => selected.push(file)} onClose={() => {}} />)
  const rows = screen.getAllByRole('button').filter(button => button.classList.contains('file-row'))
  expect(rows.map(row => row.querySelector('strong')?.textContent)).toEqual(['第1集剧本正文', '第2集剧本正文'])
  expect(rows[0].textContent).toContain('第 2 版（最新）')
  fireEvent.click(rows[0])
  expect((selected[0] as { id: string }).id).toBe('a2')
})


test('历史质量状态不在资料栏或稿件卡显示，Word 下载入口仍保留', () => {
  const artifacts = ['checked', 'revision_required'].map((reviewStatus, index) => ({
    id: 'doc-' + index, name: '稿件' + index, content: '第1集\n\n△她推门。', kind: 'result' as const,
    documentKind: 'script', downloadPath: '/assets-data/doc-' + index + '.docx', downloadName: '稿件' + index + '.docx',
    downloadFormat: 'docx', reviewStatus: reviewStatus as 'checked' | 'revision_required'
  }))
  workspace.project.set({ id: 'p', title: '项目', stage: '', artifacts })
  render(<><Inspector selected={null} onSelect={() => {}} onClose={() => {}} />{artifacts.map(artifact => <ManuscriptDelivery key={artifact.id} artifact={artifact} showDownload />)}</>)
  expect(document.body.textContent).not.toMatch(/通过|核验/)
  expect(screen.getByRole('button', { name: /稿件0.*可下载/ })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: /稿件[01]\.docx/ })).toHaveLength(2)
})
