import type { Artifact } from './creative'

/** 仅按稿件编号与已确认的前版关系归并；同名方案和分支各自保留。 */
export function latestDocumentVersions(artifacts: Artifact[]): Artifact[] {
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]))
  const ancestors = (artifact: Artifact): Set<string> => {
    const seen = new Set<string>([artifact.id])
    let current = artifact
    let previous = current.previousDocumentId
    while (previous && byId.has(previous) && !seen.has(previous)) {
      const prior = byId.get(previous)!
      if (!prior.contentSha256 || current.previousContentSha256 !== prior.contentSha256) break
      seen.add(previous)
      current = prior
      previous = current.previousDocumentId
    }
    // 损坏的循环关系不能隐藏任意稿件。
    return previous && seen.has(previous) ? new Set([artifact.id]) : seen
  }
  const superseded = new Set<string>()
  for (const artifact of byId.values()) for (const id of ancestors(artifact)) if (id !== artifact.id) superseded.add(id)
  return [...byId.values()].filter(artifact => !superseded.has(artifact.id))
    .map(artifact => ({ ...artifact, versions: Math.max(artifact.versions ?? 1, ancestors(artifact).size) }))
}
