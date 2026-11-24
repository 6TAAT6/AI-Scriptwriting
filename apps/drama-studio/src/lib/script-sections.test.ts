import { expect, test } from 'vitest'
import { projectFromResult, type Artifact } from './creative'
import { revisedLater, roundVersions, scriptSections } from './script-sections'

const episode = (number: number, lines = 12) => [`第${String(number).padStart(2, '0')}集`, `${number}-1场  长公主府前厅  日  内`, '人物：君婳、离渊',
  ...Array.from({ length: lines }, (_, index) => index % 2 ? `君婳：（冷笑）第${number}集第${index}句台词，字数足够长，用来撑起一集正文。` : `△离渊垂手立于一旁，第${number}集第${index}个动作描写。`)].join('\n')

test('同一轮后面的回复重写了哪些集，前面那段就标出这些集；跨轮接着写不算重写', () => {
  const draft = `正在创作第16—18集。\n\n${[16, 17, 18].map(number => episode(number)).join('\n\n')}`
  const trimmed = `正在对第18集定向精简。\n\n${episode(18)}`
  const nextTurn = episode(19)
  const revised = revisedLater([
    { id: 'draft', role: 'assistant', turnId: 'turn-1', text: draft },
    { id: 'saved', role: 'activity', turnId: 'turn-1' },
    { id: 'trimmed', role: 'assistant', turnId: 'turn-1', text: trimmed },
    { id: 'next', role: 'assistant', turnId: 'turn-2', text: nextTurn },
  ])
  expect(revised.get('draft')).toEqual([18])
  expect(revised.has('trimmed')).toBe(false)
  expect(revised.has('next')).toBe(false)
  // 开场白和正文分开：开场白照常显示，只有各集正文可以收起。
  expect(scriptSections(draft)).toMatchObject({ preamble: '正在创作第16—18集。', episodes: [16, 17, 18] })
})

test('只有同一轮里每份都带“_第N版”的同名稿件才算新旧版本；同名但无版本号的各自保留', () => {
  const artifact = (id: string, downloadName?: string): Artifact => ({ id, name: '第16—18集 剧本正文', kind: 'result', documentKind: 'script', downloadName })
  const versioned = roundVersions([artifact('v1', '第16—18集 剧本正文_第1版.docx'), artifact('v2', '第16—18集 剧本正文_第2版.docx')])
  expect(versioned.get('v1')).toEqual({ newerVersion: 2, versions: 2 })
  expect(versioned.get('v2')).toEqual({ newerVersion: undefined, versions: 2 })
  expect(roundVersions([artifact('a', '第16—18集 剧本正文.docx'), artifact('b', '第16—18集 剧本正文_第2版.docx')]).size).toBe(0)
})

test('交付回执里的按集字数与总数来自同一份统计，前端原样读取', () => {
  const project = projectFromResult({ project: {
    id: 'project', title: '测试项目', stage: 'M3',
    script_batches: [{ id: 'script-1', content: episode(16), status: 'draft' }],
    exports: [{ artifact_id: 'script-1', path: '/assets-data/abc/正文_第1版.docx', name: '正文_第1版.docx', format: 'docx', source_kind: 'script',
      text_statistics: { method: 'unicode_han_and_non_whitespace_v1', han_characters: 760, non_whitespace_characters: 905,
        episodes: [{ episode: '第16集', han_characters: 736, non_whitespace_characters: 880 }, { episode: '第17集', han_characters: -1, non_whitespace_characters: 3 }] } }],
  } })
  const statistics = project?.artifacts.find(row => row.id === 'script-1')?.textStatistics
  expect(statistics?.episodes).toEqual([{ episode: '第16集', hanCharacters: 736, nonWhitespaceCharacters: 880 }])
  expect(statistics?.episodes?.every(row => row.hanCharacters <= statistics.hanCharacters)).toBe(true)
})
