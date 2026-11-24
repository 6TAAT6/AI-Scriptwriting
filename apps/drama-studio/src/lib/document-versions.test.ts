import { expect, test } from 'vitest'
import { latestDocumentVersions } from './document-versions'
import type { Artifact } from './creative'

test('只按明确 previousDocumentId 归并版本，同名独立稿件保留', () => {
  const rows: Artifact[] = [
    { id: 'old', contentSha256: 'a'.repeat(64), name: '第2集正文', content: '旧', kind: 'result' },
    { id: 'new', name: '第2集正文', content: '新', kind: 'result', previousDocumentId: 'old', previousContentSha256: 'a'.repeat(64) },
    { id: 'alt', name: '第2集正文', content: '方案二', kind: 'result' }
  ]
  expect(latestDocumentVersions(rows).map(row => row.id)).toEqual(['new', 'alt'])
  expect(latestDocumentVersions(rows)[0].versions).toBe(2)
})
