import type { Artifact } from './creative'
import { documentVersion } from './document-names'
import { isScriptContent } from './episode-headings'
import { parseEpisodes } from './revision-merge'

// 只改对话里的显示：开场白和结尾说明照常显示，各集正文可以收起；复制、稿件和 Word 不受影响。
const COLLAPSIBLE_CHARACTERS = 600

export interface ScriptSections { preamble: string; body: string; notes: string; episodes: number[] }

function parseScript(text: string) {
  if (!isScriptContent(text)) return null
  const parsed = parseEpisodes(text)
  return parsed.episodes.length ? parsed : null
}

/** 足够长的剧本正文才收起；短的一两场照常显示。 */
export function scriptSections(text: string): ScriptSections | null {
  const parsed = parseScript(text)
  if (!parsed) return null
  const body = parsed.episodes.map(episode => episode.text).join('\n\n')
  if (body.replace(/\s/g, '').length < COLLAPSIBLE_CHARACTERS) return null
  return { preamble: parsed.preamble, body, notes: parsed.notes, episodes: parsed.episodes.map(episode => episode.number) }
}

export function episodeRange(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  const pad = (value: number) => String(value).padStart(2, '0')
  if (sorted.length <= 1) return sorted.length ? `第${pad(sorted[0])}集` : ''
  const consecutive = sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1)
  return consecutive ? `第${pad(sorted[0])}—${pad(sorted.at(-1)!)}集` : `第${sorted.map(pad).join('、')}集`
}

interface ScriptMessage { id: string; role: string; turnId?: string; text?: string }

/** 同一轮里后面的回复又写了同一集，前面那段就是被重写的稿子；返回每段被重写的集号。 */
export function revisedLater(messages: ScriptMessage[]): Map<string, number[]> {
  const revised = new Map<string, number[]>()
  const earlier: { id: string; turnId: string; episodes: number[] }[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.turnId || !message.text) continue
    const episodes = parseScript(message.text)?.episodes.map(episode => episode.number)
    if (!episodes) continue
    for (const previous of earlier) {
      if (previous.turnId !== message.turnId) continue
      const overlap = previous.episodes.filter(number => episodes.includes(number))
      if (overlap.length) revised.set(previous.id, [...new Set([...(revised.get(previous.id) ?? []), ...overlap])])
    }
    earlier.push({ id: message.id, turnId: message.turnId, episodes })
  }
  return revised
}

/**
 * 同一轮里后端按同名同类另存的稿件（Word 名带“_第N版”）。只有每一份都带版本号时才视为同一稿件的不同版本，
 * 同名但没有版本号的方案、分支各自保留。
 */
export function roundVersions(artifacts: Artifact[]): Map<string, { newerVersion?: number; versions: number }> {
  const groups = new Map<string, Artifact[]>()
  for (const artifact of artifacts) {
    const key = `${artifact.documentKind ?? ''}\u0000${artifact.name}`
    groups.set(key, [...(groups.get(key) ?? []), artifact])
  }
  const result = new Map<string, { newerVersion?: number; versions: number }>()
  for (const group of groups.values()) {
    const versions = group.map(artifact => documentVersion(artifact.downloadName))
    if (group.length < 2 || versions.some(version => version === undefined)) continue
    const latest = Math.max(...versions as number[])
    group.forEach((artifact, index) => result.set(artifact.id, { newerVersion: versions[index]! < latest ? latest : undefined, versions: group.length }))
  }
  return result
}
