import { render } from '@testing-library/react'
import { expect, test } from 'vitest'
import MarkdownBody from './MarkdownBody'

test('列表项里没有只含换行的文本节点：嵌套列表和松散列表不出现整行空白', () => {
  const text = '### 本轮说明：\n\n1. **精确控字**：\n   - **第 1 集**：精简至 1031 汉字；\n   - **第 2 集**：精简至 1010 汉字。\n\n2. **文档交付**：\n   - 正文 Word 文档已生成。\n'
  const { container } = render(<MarkdownBody text={text} streaming={false} />)
  const items = [...container.querySelectorAll('li')]
  expect(items.length).toBeGreaterThanOrEqual(5)
  for (const item of items) {
    for (const node of item.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        expect(node.textContent!.trim()).not.toBe('')
        expect(node.textContent!.startsWith('\n') || node.textContent!.endsWith('\n')).toBe(false)
      }
    }
  }
  expect(container.textContent).toContain('第 1 集')
})

test('粗体紧贴中文引号时仍显示为粗体，不露出星号', () => {
  const { container } = render(<MarkdownBody text={'替换为北美语境的**“战利品献礼、领地缔约仪式”**；改为**（领地议事会）**。'} streaming={false} />)
  expect(container.textContent).not.toContain('**')
  expect(container.textContent).toContain('“战利品献礼、领地缔约仪式”')
  expect(container.querySelectorAll('strong, .font-semibold').length).toBeGreaterThanOrEqual(2)
})

test('对话中的剧本排成稿页：集标题带字数，场次号与日夜内外拆开，台词说话人单独排版', () => {
  const text = '第04集\n\n4-1场  冰峰堡垒前庭院  日  外\n人物：艾拉、卢卡斯\n△寒风卷起冰屑。\n卢卡斯：（嗓音沙哑）艾拉，' + '你可想过后果'.repeat(30) + '？'
  const { container } = render(<MarkdownBody text={text} streaming={false} chat />)
  expect(container.querySelector('.episode-heading')?.textContent).toMatch(/第04集\d+ 汉字/)
  const slug = container.querySelector('.scene-slug')!
  expect(slug.querySelector('.scene-no')?.textContent).toBe('4-1')
  expect(slug.querySelector('.scene-place')?.textContent).toBe('冰峰堡垒前庭院')
  expect([...slug.querySelectorAll('.scene-tag')].map(node => node.textContent)).toEqual(['日', '外'])
  expect(container.querySelector('.script-cast')).toBeTruthy()
  expect(container.querySelector('.script-act')).toBeTruthy()
  const line = container.querySelector('.script-line')!
  expect(line.querySelector('.speaker')?.textContent).toBe('卢卡斯：')
  expect(line.querySelector('.cue')?.textContent).toBe('（嗓音沙哑）')
  // 稿件阅读面板（非对话）不改写
  const plain = render(<MarkdownBody text={text} streaming={false} />).container
  expect(plain.querySelector('.scene-slug, .episode-heading, .script-line')).toBeNull()
})
