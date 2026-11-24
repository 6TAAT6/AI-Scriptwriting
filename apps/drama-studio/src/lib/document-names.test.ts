import { expect, test } from 'vitest'
import { documentStem, documentVersion } from './document-names'

test('Word 下载名带版本号时能对应回稿件名并读出版本', () => {
  expect(documentStem('第08—10集 剧本正文_第3版.docx')).toBe('第08—10集 剧本正文')
  expect(documentStem('第08—10集 剧本正文.docx')).toBe('第08—10集 剧本正文')
  expect(documentVersion('第08—10集 剧本正文_第3版.docx')).toBe(3)
  expect(documentVersion('第08—10集 剧本正文.docx')).toBeUndefined()
})
