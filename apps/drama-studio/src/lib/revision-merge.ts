// 核验未通过时模型会在同一轮返修：可能整批重写，也可能只重写其中几集。界面上把返修稿按集号放回初稿原来的位置，
// 用户始终只看到一份正文，集的先后顺序不变；返修稿的开场白不显示，结尾说明放在正文之后。
// 集标题的识别与后端（requirement_checks._episodes）一致：独立成行、不超过 40 字、不以句末标点结尾。

const HEADING = /^[\t ]*(?:(?:[-+*]|\d+[.)、])\s+)?[\t #*]*(?:《[^》\n]+》[\t ]*)?第[\t ]*([0-9０-９]{1,4}|[〇零一二三四五六七八九十百千两]{1,8})[\t ]*集(?:[\t ]*[*#]+)?(?=[\t :：·—\-（(《【*]|$)/
const GLUED = /^((?:正在|好的|下面|以下|现在|已)[^\n]{0,120}?[。：:！!])\s*(?=#{1,6}\s|\*{0,2}第\s*[0-9一二三四五六七八九十百零〇两]+\s*集|《)/
// 最后一集之后的说明：分隔线、Markdown 标题（场次标题除外）、引用、核验说明，或以“本轮/修订/返修/已按…”开头的段落。
const NOTES = /^\s*(?:-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$|#{1,6}\s+(?!\d+\s*[-—.])|>|【系统核验】|(?:[-*]\s+)?(?:\*\*)?(?:本轮|本次|修订|返修|核验|交付说明|说明[:：]|已按|已根据|已完成|下一步|接下来))/
const DIGITS: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

export function episodeNumber(text: string): number | null {
  const ascii = text.replace(/[０-９]/g, char => String(char.charCodeAt(0) - 0xff10))
  if (/^\d+$/.test(ascii)) return Number(ascii)
  let total = 0, digit = 0
  for (const char of text) {
    if (char in DIGITS) digit = DIGITS[char]
    else if (char === '十' || char === '百' || char === '千') { total += (digit || 1) * { 十: 10, 百: 100, 千: 1000 }[char]; digit = 0 }
    else return null
  }
  return total + digit
}

function headingNumber(line: string): number | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 40 || /[。！？，；]$/.test(trimmed) || /\d+\s*(?:字|个汉字)/.test(trimmed)) return null
  const match = trimmed.match(HEADING)
  return match ? episodeNumber(match[1]) : null
}

interface Parsed { preamble: string; episodes: { number: number; text: string }[]; notes: string }

export function parseEpisodes(text: string, streaming = false): Parsed {
  const lines = text.replace(GLUED, '$1\n\n').split('\n')
  const starts = lines.flatMap((line, index) => {
    const number = headingNumber(line)
    return number === null ? [] : [{ index, number }]
  })
  // 一集至少有几行正文；正在流式写出的最后一集刚出现标题时也算，返修稿一开始就能放回原位。
  const episodes: { number: number; start: number; end: number }[] = []
  starts.forEach((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].index : lines.length
    const body = lines.slice(start.index + 1, end).filter(line => line.trim())
    const last = position + 1 === starts.length
    if (body.length >= 2 || (last && streaming)) episodes.push({ number: start.number, start: start.index, end })
  })
  if (!episodes.length) return { preamble: text.trim(), episodes: [], notes: '' }
  for (let index = 0; index + 1 < episodes.length; index++) episodes[index].end = episodes[index + 1].start
  const last = episodes[episodes.length - 1]
  let notesAt = lines.length
  for (let index = last.start + 3; index < lines.length; index++) {
    if (NOTES.test(lines[index])) { notesAt = index; break }
  }
  last.end = Math.min(last.end, notesAt)
  const slice = (from: number, to: number) => lines.slice(from, to).join('\n').trim()
  return {
    preamble: slice(0, episodes[0].start),
    episodes: episodes.map(episode => ({ number: episode.number, text: slice(episode.start, episode.end) })),
    notes: slice(notesAt, lines.length)
  }
}

export function episodeNumbers(text: string): number[] {
  return parseEpisodes(text).episodes.map(episode => episode.number)
}

/**
 * 把同一轮后写出的返修稿合并进前面的稿件：同集号的替换、初稿缺的集按集号插入，其余集原样保留。
 * 返修稿与前稿没有共同的集（例如接着写第4—6集）时不是返修，返回 null。
 */
export interface RevisionEvidence {
  documentId: string
  qualityStatus?: 'fail' | 'pass'
  previousDocumentId?: string
  previousContentSha256?: string
  sourceMessageId?: string
  content?: string
}

export function mergeRevision(base: string, revised: string, streaming = false, evidence?: RevisionEvidence): string | null {
  // 同集正文可能是另一个方案；只有具备文档身份的失败核验才允许自动替换。
  if (!evidence?.documentId || !((evidence.previousDocumentId && evidence.previousContentSha256)
    || evidence.qualityStatus === 'fail' && (evidence.sourceMessageId || evidence.content))) return null
  const before = parseEpisodes(base)
  const after = parseEpisodes(revised, streaming)
  if (!before.episodes.length || !after.episodes.length) return null
  const previous = new Set(before.episodes.map(episode => episode.number))
  if (!after.episodes.some(episode => previous.has(episode.number))) return null
  const merged = new Map(before.episodes.map(episode => [episode.number, episode.text]))
  for (const episode of after.episodes) merged.set(episode.number, episode.text)
  const body = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text)
  return [before.preamble, ...body, after.notes || before.notes].filter(Boolean).join('\n\n')
}
