import type { Conversation } from './transcript'
import type { NextStepSuggestion } from './suggestions'
import { episodeNumber, parseEpisodes } from './revision-merge'
import { isScriptContent } from './episode-headings'

const NUMBER = '[0-9０-９〇零一二三四五六七八九十百千两]+'
const HISTORICAL = /历史|旧稿|原稿摘录|原文摘录|粘贴|引用|示例|此前|之前(?:的|发过|生成)/
const compact = (text: string) => text.replace(/[\s#*]+/g, '')
const EPISODE_END = new RegExp(`(?:^|\\n)[\\s#*【（(]*(?:第\\s*${NUMBER}\\s*集(?:完|终)|本集完|未完待续|全剧终|全剧完|全篇完|本剧终|本剧完结|大结局)[\\s*】）)。.!！]*$`)
const STORY_END = /(?:^|\n)[\s#*【（(]*(?:全剧终|全剧完|全篇完|本剧终|本剧完结|大结局)[\s*】）)。.!！]*$/

function userLimits(conversation: Conversation, prose: (text: string) => string) {
  let batch: number | undefined, total: number | undefined
  for (const entry of conversation.entries) {
    if (entry.role !== 'user') continue
    // 只从用户的直接要求取数，不把附带原稿中的“共 N 集”当成创作范围。
    const request = prose(entry.text).split(/\n\s*(?:#{1,6}\s*)?(?:第\s*[0-9０-９一二三四五六七八九十百]+\s*集|原稿|原文|附件)/, 1)[0]
    for (const match of request.matchAll(new RegExp(`(?:每批|每次|一次)(?:写|生成|输出|创作)?\\s*(${NUMBER})\\s*(?:[—–~～-]\\s*(${NUMBER}))?\\s*集`, 'g'))) {
      const value = episodeNumber(match[1])
      if (value && value <= 9999) batch = value
    }
    for (const match of request.matchAll(new RegExp(`(?:全剧|总共|总计|总集数|共计)(?:共|为|是|有|[:：])?\\s*(${NUMBER})\\s*集`, 'g'))) {
      const value = episodeNumber(match[1])
      if (value && value <= 9999) total = value
    }
  }
  return { batch, total }
}

/** 只从当前用户回合的实际剧本推导待点击动作，不以已保存或已验收作为前提。 */
export function scriptSuggestions(conversation: Conversation, prose: (text: string) => string): NextStepSuggestion[] {
  const userIndex = conversation.entries.findLastIndex(entry => entry.role === 'user')
  if (userIndex < 0) return []
  const request = prose(conversation.entries[userIndex].text)
  if (/(?:不要|不用|无需|停止|禁止)(?:再|继续)?(?:续写|写|创作|生成|改编)/.test(request)
    || /(?:分析|点评|评价|解释|总结|复述|展示|显示|阅读|朗读|回顾)/.test(request)
      && !/(?:续写|重写|改写|创作|编写|写出|生成|输出|修改|修订|调整|润色).{0,25}(?:剧本|正文|第.{1,8}集)/.test(request)) return []
  const current = conversation.entries.slice(userIndex + 1).filter(entry => entry.role === 'assistant')
  if (current.some(entry => entry.pending)) return []
  const original = compact(request)
  const episodes = new Map<number, string>()
  let latestNotes = ''
  for (const entry of current) {
    const parsed = parseEpisodes(prose(entry.text), true)
    if (!parsed.episodes.length || HISTORICAL.test(parsed.preamble)) continue
    // 助手复述用户粘贴的正文不构成本轮新进度。
    if (parsed.episodes.some(episode => original.includes(compact(episode.text)))) continue
    if (!parsed.episodes.some(episode => isScriptContent(episode.text))) continue
    for (const episode of parsed.episodes) episodes.set(episode.number, episode.text)
    latestNotes = parsed.notes
  }
  if (!episodes.size) return []
  const numbers = [...episodes.keys()].sort((a, b) => a - b)
  const first = numbers[0], last = numbers.at(-1)!
  const tail = episodes.get(last)!.trimEnd()
  const range = first === last ? `第${last}集` : `第${first}—${last}集`
  const { batch, total } = userLimits(conversation, prose)
  const adjustment: NextStepSuggestion = { label: `调整${range}`, prompt: `我想调整刚才的${range}剧本正文。请先列出可以调整的具体情节和人物表现，等我选择修改点后再改，不重写整批。` }
  const completeEnding = /[。！？.!?…][”」』）)】*\s]*$/.test(tail) || EPISODE_END.test(tail)
  const incomplete = !isScriptContent(tail) || !completeEnding
    || /(?:尚未写完|未完成|截断|中断)/.test(latestNotes)
  if (incomplete) return [
    { label: `补全第${last}集`, prompt: `请从刚才第${last}集未完成的位置接着写，先补全本集剧本正文。沿用本对话的人物、设定和要求，不要重写已有部分，也不要另起新集。`, recommended: true }, adjustment
  ]
  if (total !== undefined && last >= total || STORY_END.test(tail)) return [
    { label: '梳理全剧衔接', prompt: `请结合本对话已经写出的剧本，梳理到第${last}集为止的人物动机、情节衔接和伏笔收束，先列出具体修改建议，不新增集数或直接重写正文。`, recommended: true }, adjustment
  ]
  // 改稿轮只展示调整动作；实际连载进度由后端依据完整会话确认，不能从重写的较早集号倒退。
  if (/(?:修改|重写|改写|修订|润色|调整|优化|扩写|扩充).{0,25}(?:第.{1,8}集|前.{1,4}集|正文|剧本|结尾)/.test(request)
    && !/(?:续写|接着|下一批|后续未写)/.test(request)) return [adjustment]
  const end = Math.min(last + (batch ?? numbers.length), total ?? Infinity)
  const next = last + 1 === end ? `第${end}集` : `第${last + 1}—${end}集`
  return [
    { label: `写${next}正文`, prompt: `请接着刚才第${last}集的结尾，继续写${next}剧本正文，沿用本对话的人物、设定、格式和字数要求，不要重写已写内容；若本对话规划的总集数已到末尾，就停在大结局，不额外增加集数。`, recommended: true }, adjustment
  ]
}
