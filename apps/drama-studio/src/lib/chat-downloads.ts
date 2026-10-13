import type { Entry, ToolDownload } from './transcript'
import type { Artifact } from './creative'
import { splitSuggestions } from './suggestions'

function linkedPaths(text: string): Set<string> {
  const paths = new Set<string>()
  for (const match of text.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) {
    try { paths.add(decodeURIComponent(match[1] || match[2])) } catch { /* 无效链接不占用正式交付入口。 */ }
  }
  return paths
}

function manuscriptText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim())
    .filter(line => line && !/^(?:-{3,}|\*{3,}|_{3,})$/.test(line))
    .map(line => line.replace(/^#{1,6}\s+(.+?)(?:\s+#+)?$/, '$1').replace(/^\*\*(.+)\*\*$/, '$1'))
    .join('\n')
}

/** 正式文件回执归属本次用户回合，不依赖模型是否重复写出下载链接。 */
export function downloadsByEntry(entries: Entry[], artifacts: Artifact[] = [], includeLinked = false): Map<string, ToolDownload[]> {
  const result = new Map<string, ToolDownload[]>()
  const assistants = entries.filter(entry => entry.role === 'assistant' && !entry.pending)
  const assistantById = new Map(assistants.map(entry => [entry.id, entry]))
  const liveAssistants = assistants.filter(entry => entry.id.startsWith('message-'))
    .map(entry => ({ entry, text: manuscriptText(splitSuggestions(entry.text).text) }))
  const documents = new Map<string, ToolDownload[]>()
  for (const artifact of artifacts) {
    if (!artifact.sourceMessageId || !artifact.downloadPath) continue
    let owner = assistantById.get(artifact.sourceMessageId)
    if (!owner && artifact.content) {
      // 兜底保存会去除排版标记；只忽略这些标记，不改写文句，也不猜测重复正文的归属。
      const content = manuscriptText(artifact.content)
      const matching = content ? liveAssistants.filter(item => item.text.includes(content)) : []
      if (matching.length === 1) owner = matching[0].entry
    }
    if (!owner) continue
    const files = documents.get(owner.id) ?? []
    files.push({ path: artifact.downloadPath, name: artifact.downloadName || artifact.name,
      format: artifact.downloadFormat || 'docx', status: artifact.downloadStatus })
    documents.set(owner.id, files)
  }
  let downloads = new Map<string, ToolDownload>(), linked = new Set<string>(), target: Entry | undefined
  const finish = () => {
    if (!target) return
    const missing = [...downloads.values()].filter(file => includeLinked || !linked.has(file.path))
    if (missing.length) result.set(target.id, missing)
  }
  for (const entry of entries) {
    if (entry.role === 'user') {
      finish(); downloads = new Map(); linked = new Set(); target = undefined
      continue
    }
    if (entry.role === 'assistant') {
      target = entry
      for (const path of linkedPaths(splitSuggestions(entry.text, Boolean(entry.pending)).text)) linked.add(path)
      for (const file of documents.get(entry.id) ?? []) downloads.set(file.path, file)
    }
    for (const call of entry.calls) for (const file of call.downloads ?? []) {
      downloads.set(file.path, file)
      target ??= entry
    }
  }
  finish()
  return result
}
