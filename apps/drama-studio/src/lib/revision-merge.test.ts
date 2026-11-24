import { expect, test } from 'vitest'
import { episodeNumbers, mergeRevision } from './revision-merge'

const evidence = { documentId: 'doc', previousDocumentId: 'base', previousContentSha256: 'a'.repeat(64), qualityStatus: 'fail' as const }

const episode = (n: number, tag: string) => `第${n}集\n\n${n}-1场 书房 夜 内\n\n△${tag}${n}。\n\n林岚：（低声）走。\n`

test('说明里的“第 1 集：汉字数……”不是集标题', () => {
  const notes = '### 本轮返修说明\n\n- **第 1 集**：汉字数精简至 1031 汉字（原 1537 字），删除冗余心理自白；\n- **第 2 集**：精简至 1010 汉字。'
  expect(episodeNumbers(episode(1, '甲') + episode(2, '乙') + '\n' + notes)).toEqual([1, 2])
  const merged = mergeRevision(episode(1, '甲') + episode(2, '乙'), episode(2, '乙改') + '\n' + notes, false, evidence)!
  expect(merged.indexOf('乙改2')).toBeLessThan(merged.indexOf('本轮返修说明'))
  expect(merged).not.toContain('△乙2')
})

test('补上初稿缺的集按集号插入，与前稿无共同集数时不合并', () => {
  const merged = mergeRevision(episode(1, '甲') + episode(3, '丙'), episode(2, '乙') + episode(3, '丙改'), false, evidence)!
  expect(merged.indexOf('甲1')).toBeLessThan(merged.indexOf('乙2'))
  expect(merged.indexOf('乙2')).toBeLessThan(merged.indexOf('丙改3'))
  expect(mergeRevision(episode(1, '甲'), episode(4, '丁'), false, evidence)).toBeNull()
})

test('进度说明和集标题粘在同一行时仍能认出这一集；流式写出中的返修集立即放回原位', () => {
  expect(episodeNumbers('正在创作第8集至第9集剧本正文。第08集\n\n8-1场 主卧 夜 内\n\n△她盯着他。\n\n' + episode(9, '乙'))).toEqual([8, 9])
  const streaming = mergeRevision(episode(1, '甲') + episode(2, '乙'), '第2集\n', true, evidence)!
  expect(streaming.indexOf('甲1')).toBeLessThan(streaming.indexOf('第2集'))
  expect(streaming).not.toContain('乙2')
})

test('没有质量核验和稿件身份回执时，同集内容不应被推断为返修', () => {
  const before = episode(2, '初稿')
  const revised = episode(2, '普通续写')
  expect(mergeRevision(before, revised)).toBeNull()
  expect(mergeRevision(before, revised, false, { documentId: 'doc-2', previousDocumentId: 'doc-1', previousContentSha256: 'a'.repeat(64), qualityStatus: 'fail' })).toContain('普通续写2')
})
