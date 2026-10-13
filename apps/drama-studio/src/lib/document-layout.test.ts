import { expect, test } from 'vitest'
import { prepareDocument } from './document-layout'

test('原稿和改编大纲按集与场识别标题，保留对白、空行和正文内容', () => {
  const original = '原始剧本\r\n第 1 集\r\n场景：书店\r\n林安：请进。\r\n△她放下书。\r\n\r\n第十二集 重逢\r\n12-1 夜 内 书店\r\n原作事件：等待来信。\r\n新纲事件：主动追查。'
  const rendered = prepareDocument(original)
  expect(rendered).toContain('## 第 1 集')
  expect(rendered).toContain('## 第十二集 重逢')
  expect(rendered).toContain('### 12-1 夜 内 书店')
  expect(rendered).toContain('林安：请进。\n△她放下书。')
  expect(rendered.replace(/^#{1,6} /gm, '').replace(/\s/g, '')).toBe(original.replace(/\s/g, ''))
})

test('已有标题、表格与代码块保留结构，正文里提及某一集不变成标题', () => {
  const original = '# 改编大纲\n\n## 第一批\n\n| 集数 | 原作 | 新纲 |\n| --- | --- | --- |\n| 第1集 | 等待 | 追查 |\n\n第2集中，人物发现证据。\n\n```text\n第3集\n1-1 夜 内\n```\n\n结论\n---\n保留证据链。'
  expect(prepareDocument(original)).toBe(original)
})
