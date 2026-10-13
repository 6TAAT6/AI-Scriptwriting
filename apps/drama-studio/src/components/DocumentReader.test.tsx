// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DocumentReader } from './DocumentReader'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('剧本按集场进入目录，正文单换行在实际 Markdown 中保留', async () => {
  const { container } = render(<DocumentReader text={'第03集\n\n3-1场  接待室  日  内\n\n人物：人物甲、人物乙\n△人物甲坐在桌边。\n人物甲：（起身）你来了。\n人物乙：先看看这个。'} />)
  await screen.findByRole('heading', { name: '第03集', level: 2 })
  expect(screen.getByRole('heading', { name: '3-1场 接待室 日 内', level: 3 })).toBeTruthy()
  const paragraph = container.querySelector('p')!
  expect(getComputedStyle(paragraph).whiteSpace).toBe('pre-wrap')
  expect(paragraph.textContent?.split('\n')).toHaveLength(4)
  expect(container.textContent).toContain('人物甲：（起身）你来了。')
})

test('目录包含真实章节，搜索后可跳转到唯一标题，切换稿件重新建立目录', async () => {
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  const { rerender } = render(<DocumentReader text={'第1集 初见\n林安：请进。\n顾言：谢谢。\n第 2 集 重逢\n人物重新见面。\n## 第2集 重逢\n另一版本。'} />)
  fireEvent.click(await screen.findByRole('button', { name: /章节目录/ }))
  const directory = screen.getByRole('navigation', { name: '章节目录' })
  expect(within(directory).getAllByRole('button')).toHaveLength(3)
  expect(screen.getByText(/林安：请进。/).textContent).toContain('林安：请进。\n顾言：谢谢。')
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索章节' }), { target: { value: '第2集' } })
  const matches = within(directory).getAllByRole('button')
  expect(matches).toHaveLength(2)
  fireEvent.click(matches[1])
  expect(scroll).toHaveBeenCalledOnce()
  const headings = screen.getAllByRole('heading', { name: /第\s*2\s*集 重逢/ })
  expect(headings[0].id).not.toBe(headings[1].id)
  expect(document.activeElement).toBe(headings[1])
  rerender(<DocumentReader text={'# 改编大纲\n\n## 第3集\n新事件。'} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /章节目录/ }).textContent).toContain('2'))
  fireEvent.click(screen.getByRole('button', { name: /章节目录/ }))
  expect(within(screen.getByRole('navigation', { name: '章节目录' })).getAllByRole('button')).toHaveLength(2)
  expect(screen.queryByText('林安：请进。')).toBeNull()
})
