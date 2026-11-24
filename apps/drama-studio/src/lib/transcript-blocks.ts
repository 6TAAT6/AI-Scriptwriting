import type { Entry } from './transcript'
import type { Artifact } from './creative'
import { manuscriptText } from './chat-downloads'
import { splitSuggestions } from './suggestions'
import { episodeNumbers, mergeRevision } from './revision-merge'

/** 只隐藏旧宿主追加的固定尾注；保留正文、台词、用户引用和正常修改说明。 */
function withoutHostQualityNotice(text: string): string {
  return text.replace(/(?:^|\n)[ \t]*>[ \t]*【系统核验】(?:这份稿件还有以下地方没达到要求，可按以下问题继续调整：|这份稿件的要求核验尚未完成，结论出来后会更新到稿件上。)(?:[^\n]*)(?:\r?\n(?:[ \t]*>[^\n]*|[ \t]*))*\s*$/, '').trimEnd()
}

export interface TranscriptBlock {
  entry: Entry
  sourceIds: string[]
  parts: Entry[]
}

/**
 * 流式正文只会改变当前轮的尾部。保留最近一次变化前的完整用户轮次，
 * 让长历史不必在每个正文批次重新分组；如果历史对象整体替换，则退回完整重算。
 */
export function transcriptBlocksIncremental(entries: Entry[], previousEntries: Entry[], previousBlocks: TranscriptBlock[], artifacts: Artifact[] = []): TranscriptBlock[] {
  if (!previousEntries.length || !previousBlocks.length) return transcriptBlocks(entries, artifacts)
  let firstChanged = 0
  while (firstChanged < entries.length && firstChanged < previousEntries.length && entries[firstChanged] === previousEntries[firstChanged]) firstChanged++
  if (firstChanged === entries.length && entries.length === previousEntries.length) return previousBlocks
  if (firstChanged === 0) return transcriptBlocks(entries, artifacts)
  const boundary = entries.slice(0, firstChanged).findLastIndex(entry => entry.role === 'user')
  if (boundary < 0) return transcriptBlocks(entries, artifacts)
  const prefixEntries = entries.slice(0, boundary)
  const retainedIds = new Set(prefixEntries.map(entry => entry.id))
  const prefix = previousBlocks.filter(block => block.sourceIds.every(id => retainedIds.has(id)))
  return [...prefix, ...transcriptBlocks(entries.slice(boundary), artifacts)]
}

/**
 * 只合并展示，保留原消息身份；实时视图与刷新后的历史视图分组一致：
 * - 已结束的“已思考”只是两次模型调用之间的过渡标记（历史里本来没有），不留在对话里，正在思考时才显示；
 * - 本轮写出稿件之后的保存、核验、返修步骤留在正文下方，连续的合成一组；只展示实际操作；
 * - 有明确版本依据的修订稿按集号放回原稿位置。
 */
export function transcriptBlocks(entries: Entry[], artifacts: Artifact[] = []): TranscriptBlock[] {
  const documents = artifacts.filter(artifact => artifact.sourceMessageId)
  const blocks: TranscriptBlock[] = []
  for (const [index, source] of entries.entries()) {
    if (source.role === 'thinking' && !source.pending) continue
    const entry = source.role === 'assistant'
      ? { ...source, text: withoutHostQualityNotice(splitSuggestions(source.text, Boolean(source.pending)).text) }
      : source
    // 返修稿先按集号并回本轮前面的稿件，再考虑与上一段回复拼接，避免同一批正文显示两遍。
    if (entry.role === 'assistant' && mergeIntoDraft(blocks, entry, documents)) continue
    if (entry.role === 'thinking' && thinkingAfterManuscript(blocks, entry)) continue
    const previous = blocks.at(-1)
    if (entry.role === 'activity' && previous?.entry.role === 'activity') {
      // 中间只隔着已结束的思考标记的两组步骤合成一组。
      previous.entry = { ...previous.entry, calls: [...previous.entry.calls, ...entry.calls] }
      previous.parts = [previous.entry]
      previous.sourceIds.push(entry.id)
      continue
    }
    if (previous?.entry.role === 'assistant') {
      if (entry.role === 'thinking') {
        const next = entries.slice(index + 1).find(row => row.role !== 'thinking')
        if (next?.role === 'assistant' && next.turnId === previous.entry.turnId) {
          previous.parts.push(entry)
          previous.sourceIds.push(entry.id)
          continue
        }
      }
      if (entry.role === 'assistant' && entry.turnId === previous.entry.turnId) {
        const part = previous.parts.at(-1)!
        previous.entry = { ...previous.entry, text: `${previous.entry.text}\n\n${entry.text}`, pending: entry.pending }
        previous.sourceIds.push(entry.id)
        if (part.role === 'assistant') previous.parts[previous.parts.length - 1] = { ...part, text: `${part.text}\n\n${entry.text}`, pending: entry.pending }
        else previous.parts.push(entry)
        continue
      }
    }
    blocks.push({ entry, sourceIds: [entry.id], parts: [entry] })
  }
  return blocks
}

/** 本轮已写出稿件、正文下方紧接着是保存与核验步骤时，“正在思考”并入这组步骤：返修期间标题显示 AI 正在修复什么。 */
function thinkingAfterManuscript(blocks: TranscriptBlock[], entry: Entry): boolean {
  const last = blocks.at(-1)
  if (last?.entry.role !== 'activity') return false
  for (let index = blocks.length - 2; index >= 0; index--) {
    const block = blocks[index]
    if (block.entry.role === 'user') return false
    if (block.entry.role === 'assistant' && block.parts.some(part => part.role === 'assistant' && episodeNumbers(part.text).length)) {
      last.entry = { ...last.entry, thinking: true }
      last.parts = [last.entry]
      last.sourceIds.push(entry.id)
      return true
    }
  }
  return false
}

/**
 * 同一轮里，核验未通过后模型返修了前面写出的集（中间可能隔着保存步骤）：按集号把返修稿放回原稿位置，
 * 不再另起一段整批显示。只看本轮（遇到用户消息即停），写的是新集数（接着写下一批）时不合并。
 */
function mergeIntoDraft(blocks: TranscriptBlock[], entry: Entry, documents: Artifact[]): boolean {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.entry.role === 'user') return false
    // 实时事件里每次模型调用都有新的 turnId（历史记录按用户消息分轮），以遇到用户消息为本轮边界。
    if (block.entry.role !== 'assistant') continue
    const position = block.parts.findLastIndex(part => part.role === 'assistant')
    if (position < 0) continue
    const part = block.parts[position]
    const currentDocument = documents.find(document => document.sourceMessageId === entry.id
      && documents.some(previous => previous.id === document.previousDocumentId && block.sourceIds.includes(previous.sourceMessageId!)))
    const previousDocument = documents.find(document => document.id === currentDocument?.previousDocumentId && block.sourceIds.includes(document.sourceMessageId!))
    const lineage = currentDocument?.previousDocumentId && previousDocument?.contentSha256
      && currentDocument.previousContentSha256 === previousDocument.contentSha256
      ? { documentId: currentDocument.id, previousDocumentId: previousDocument.id, previousContentSha256: previousDocument.contentSha256 } : undefined
    const evidence = lineage ?? blocks.slice(index + 1).flatMap(block => block.entry.role === 'activity' ? block.entry.calls : [])
      .map(call => call.revisionEvidence).findLast(value => {
        if (value?.qualityStatus !== 'fail') return false
        const artifact = documents.find(document => document.id === value.documentId)
        const sourceId = value.sourceMessageId ?? artifact?.sourceMessageId
        if (sourceId && block.sourceIds.includes(sourceId)) return true
        const content = value.content ?? artifact?.content
        return Boolean(content) && [part.text, part.revision?.draft].some(text => text && manuscriptText(text) === manuscriptText(content!))
      })
    const merged = mergeRevision(part.text, entry.text, Boolean(entry.pending), evidence)
    if (merged === null) return false
    block.parts[position] = { ...part, text: merged, pending: entry.pending, revision: { draft: part.revision?.draft ?? part.text } }
    block.entry = { ...block.entry, text: block.parts.filter(row => row.role === 'assistant').map(row => row.text).join('\n\n'), pending: entry.pending }
    block.sourceIds.push(entry.id)
    return true
  }
  return false
}
