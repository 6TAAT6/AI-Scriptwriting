import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { workspace } from '../store/workspace'
import { gateway } from '../lib/gateway'
import MarkdownBody from './MarkdownBody'

const handle = '/assets-data/' + 'a'.repeat(32) + '/原文保真验收.docx'

afterEach(() => { cleanup(); workspace.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('已注册的正文文件引用使用当前会话下载真实文件，磁盘和未知协议引用不可下载', async () => {
  workspace.reset()
  workspace.session.set({ storedId: 'saved-export', runtimeId: 'live-export', info: {} })
  gateway.profile = 'export-profile'
  const requests: URL[] = [], saved: { name: string; href: string }[] = [], blobs: Blob[] = []
  vi.stubGlobal('fetch', async (value: string | URL, options?: RequestInit) => {
    const url = new URL(String(value))
    requests.push(url)
    expect(url.pathname).toBe('/api/fs/download')
    expect(url.searchParams.get('path')).toBe(handle)
    expect(url.searchParams.get('session_id')).toBe('saved-export')
    expect(options?.credentials).toBe('same-origin')
    return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } })
  })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:verified-document' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push({ name: this.download, href: this.href }) })
  render(<MarkdownBody streaming={false} text={`[下载《原文保真验收.docx》](${encodeURI(handle)})\n\n[未知文件](sandbox:工作区/workspace/未知.docx)\n\n[磁盘引用](/private/hidden.docx)\n\n[外部资料](https://example.com/reference)`} />)
  const download = await screen.findByRole('button', { name: '下载《原文保真验收.docx》' })
  fireEvent.click(download)
  await waitFor(() => expect(saved).toEqual([{ name: '原文保真验收.docx', href: 'blob:verified-document' }]))
  expect(requests).toHaveLength(1)
  expect(Array.from(new Uint8Array(await blobs[0].arrayBuffer()))).toEqual([80, 75, 3, 4])
  expect(screen.getByRole('link', { name: '外部资料' }).getAttribute('href')).toBe('https://example.com/reference')
  expect(screen.queryByRole('link', { name: '未知文件' })).toBeNull()
  expect(screen.queryByRole('button', { name: '未知文件' })).toBeNull()
  expect(screen.queryByRole('link', { name: '磁盘引用' })).toBeNull()
  expect(document.body.innerHTML).not.toContain('/private/hidden.docx')
})

it('文件下载失败显示可重试提示，重复点击不会启动并发下载', async () => {
  workspace.session.set({ storedId: 'saved-export', runtimeId: 'live-export', info: {} })
  let finish!: (response: Response) => void
  let requests = 0
  vi.stubGlobal('fetch', () => { requests++; return new Promise<Response>(resolve => { finish = resolve }) })
  render(<MarkdownBody streaming={false} text={`[下载稿件](${handle})`} />)
  const button = await screen.findByRole('button', { name: '下载稿件' }) as HTMLButtonElement
  fireEvent.click(button)
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(requests).toBe(1)
  finish(new Response('', { status: 503 }))
  await screen.findByRole('alert')
  expect(button.disabled).toBe(false)
  expect(screen.getByRole('alert').textContent).toContain('下载')
})

it('生成文件链接旁提供稿件面板阅读和下载图标', async () => {
  const onReadFile = vi.fn()
  workspace.session.set({ storedId: 'saved-export', runtimeId: 'live-export', info: {} })
  render(<MarkdownBody streaming={false} onReadFile={onReadFile} text={`[项目档案.docx](${handle})`} />)
  expect(await screen.findByText('项目档案.docx')).toBeTruthy()
  const read = screen.getByRole('button', { name: '在稿件面板阅读：项目档案.docx' })
  expect(screen.getByRole('button', { name: '下载 Word：项目档案.docx' })).toBeTruthy()
  fireEvent.click(read)
  expect(onReadFile).toHaveBeenCalledWith({ path: handle, name: '项目档案.docx' })
})

it('已注册的图片句柄直接读取并显示真实图片', async () => {
  const image = '/assets-data/' + 'b'.repeat(32) + '/scene.png'
  workspace.session.set({ storedId: 'saved-image', runtimeId: 'live-image', info: {} })
  gateway.profile = 'image-profile'
  vi.stubGlobal('fetch', async (value: string | URL) => {
    const url = new URL(String(value))
    expect(url.pathname).toBe('/api/fs/download')
    expect(url.searchParams.get('path')).toBe(image)
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:scene')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  render(<MarkdownBody streaming={false} text={`![欧洲女性人像](${image})`} />)
  expect((await screen.findByRole('img', { name: '欧洲女性人像' })).getAttribute('src')).toBe('blob:scene')
})

it('正文增量更新时保留已有文件按钮节点，避免流式 Markdown 重建整段正文', async () => {
  workspace.session.set({ storedId: 'saved-stream', runtimeId: 'live-stream', info: {} })
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
  const { rerender } = render(<MarkdownBody streaming text={`[下载稿件](${handle})`} />)
  const first = await screen.findByRole('button', { name: '下载稿件' })
  rerender(<MarkdownBody streaming text={`[下载稿件](${handle})\n\n新增的一行正文`} />)
  const second = await screen.findByRole('button', { name: '下载稿件' })
  expect(second).toBe(first)
})

it('加粗紧贴中文标点时照样生效：标点移到加粗外，相邻两段加粗不误连，代码块原样', async () => {
  const text = [
    '**承接与取舍：**保留古装的身份压迫。',
    '文字**「标题」**正文，**观众知道她正在退出。**他却仍以为她会留下。',
    '**甲**中间文字。**乙：**后文',
    '```',
    '**代码：**不改',
    '```',
  ].join('\n\n')
  const { container } = render(<MarkdownBody text={text} streaming={false} />)
  const bold = '[data-streamdown="strong"]'
  await waitFor(() => expect(container.querySelectorAll(bold).length).toBeGreaterThan(0))
  expect([...container.querySelectorAll(`p ${bold}`)].map(node => node.textContent)).toEqual(['承接与取舍', '标题', '观众知道她正在退出', '甲', '乙'])
  expect([...container.querySelectorAll('p')].map(node => node.textContent).join('')).not.toContain('**')
  expect(container.querySelector('pre, code')?.textContent).toContain('**代码：**不改')
})
