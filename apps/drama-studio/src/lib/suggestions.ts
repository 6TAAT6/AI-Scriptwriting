import type { Conversation } from './transcript'

export interface NextStepSuggestion { label: string; prompt: string; recommended?: boolean }
export interface SuggestionMessage { text: string; suggestions: NextStepSuggestion[] }
export interface AvailableSuggestions { entryId: string; suggestions: NextStepSuggestion[] }

const MARKER = 'studio-suggestions'

function uniqueSuggestions(values: unknown[]): NextStepSuggestion[] {
  const result: NextStepSuggestion[] = []
  for (const item of values) {
    if (!item || typeof item !== 'object' || !('label' in item) || !('prompt' in item)
      || typeof item.label !== 'string' || typeof item.prompt !== 'string') continue
    const label = item.label.trim(), prompt = item.prompt.trim()
    if (!label || label.length > 40 || /[\r\n]/.test(label) || !prompt || prompt.length > 1200) continue
    if (result.some(row => row.prompt === prompt || row.label === label)) continue
    result.push({ label, prompt, ...('recommended' in item && item.recommended === true && !result.some(row => row.recommended) ? { recommended: true } : {}) })
    if (result.length === 5) break
  }
  return result
}

function offeredPlans(text: string): NextStepSuggestion[] {
  const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, '').replace(/\*\*/g, '')
  const questions = prose.split(/[。！？\n]/).filter(line => /(?:请选择|请(?:直接)?回复|可以(?:直接)?(?:回复|选择)|或选择|停在方案选择|等待.{0,12}选择)/.test(line))
  if (!questions.length) return []
  const titles = new Map<string, { label: string; recommended: boolean }>()
  for (const match of prose.matchAll(/^(?:#{1,6}\s*)?([A-E])[．.、:：)）｜|]\s*([^\n]{1,80})/gm)) {
    const raw = match[2].trim()
    titles.set(match[1], { label: raw.replace(/[【（(]推荐[】）)]/g, '').trim(), recommended: /推荐|优先/.test(raw) })
  }
  const codes = [...new Set(questions.flatMap(line => [...line.matchAll(/\b([A-E])\b/g)].map(match => match[1])))]
  const offered = codes.length >= 2 ? codes : [...titles.keys()]
  if (offered.length < 2 || offered.length > 5) return []
  return uniqueSuggestions(offered.sort().map(code => {
    const title = titles.get(code)
    return { label: `选择 ${code}${title?.label ? ` · ${title.label}` : ''}`.slice(0, 30),
      prompt: `我选择你刚才提供的方案 ${code}${title?.label ? `（${title.label}）` : ''}。请按已有流程完成这一方案的正式确认，再继续本次任务。`,
      ...(title?.recommended ? { recommended: true } : {}) }
  }))
}

function parseSuggestions(source: string): NextStepSuggestion[] {
  if (source.length > 10000) return []
  let values: unknown
  const normalized = source.trim().replace(/^json[ \t]*\r?\n/i, '')
    .replace(/("(?:\\.|[^"\\])*")|,\s*([}\]])/g, (_match, quoted: string | undefined, closing: string) => quoted ?? closing)
  try { values = JSON.parse(normalized) } catch { return [] }
  if (values && typeof values === 'object') {
    for (const key of ['suggestions', 'options', 'items']) {
      if (key in values) { values = values[key as keyof typeof values]; break }
    }
  }
  return Array.isArray(values) ? uniqueSuggestions(values) : []
}

/** 只解析约定的展示片段，正文和原始记录不回写；普通代码块保持原样。 */
export function splitSuggestions(text: string, streaming = false): SuggestionMessage {
  const opening = /(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*studio-suggestions[ \t]*(?:\r?\n|$)/gi
  const fragments: string[] = []
  const choices: NextStepSuggestion[] = []
  let cursor = 0
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    fragments.push(text.slice(cursor, match.index))
    const contentStart = match.index + match[0].length
    const content = text.slice(contentStart)
    const closing = new RegExp('\\r?\\n[ \\t]*' + match[1][0] + '{' + match[1].length + ',}[ \\t]*(?=\\r?\\n|$)').exec(content)
    if (!closing) return { text: fragments.join('').trimEnd(), suggestions: streaming ? [] : uniqueSuggestions(choices) }
    if (!streaming) choices.push(...parseSuggestions(content.slice(0, closing.index)))
    cursor = contentStart + closing.index + closing[0].length
    opening.lastIndex = cursor
  }
  fragments.push(text.slice(cursor))
  const visible = fragments.join('')
  const lineStart = visible.lastIndexOf('\n') + 1
  const tail = visible.slice(lineStart).trim().toLowerCase()
  const fenced = /^(?:`{3,}|~{3,})[ \t]*(.*)$/.exec(tail)
  const partial = fenced && MARKER.startsWith(fenced[1]) && (streaming || fenced[1].startsWith('studio-'))
  return { text: partial ? visible.slice(0, lineStart).trimEnd() : cursor ? visible.trimEnd() : visible, suggestions: uniqueSuggestions(choices) }
}

function proseSuggestions(text: string): NextStepSuggestion[] {
  const prose = text.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, '')
  const quoted = [...prose.matchAll(/(?:可以(?:直接)?(?:回复|发送|输入|说)|请(?:直接)?(?:回复|发送))[：:\s]*[“「"]([^”」"\n]{2,1200})[”」"]/g)]
    .map(match => ({ label: match[1].slice(0, 30), prompt: match[1] }))
  if (quoted.length) return uniqueSuggestions(quoted)
  const heading = /(?:^|\n)(?:#{1,6}[ \t]*)?(?:接下来[，,]?你可以|下一步(?:建议|可以)?|推荐(?:提示词|操作)|你可以(?:选择)?)[：:]?[ \t]*\r?\n/.exec(prose)
  if (!heading) return []
  const choices: NextStepSuggestion[] = []
  for (const line of prose.slice(heading.index + heading[0].length).split(/\r?\n/)) {
    if (!line.trim()) continue
    const item = /^[ \t]*(?:[-*+]|[1-5][.、）)])[ \t]+(.+)$/.exec(line)
    if (!item) break
    const value = item[1].replace(/\*\*/g, '').trim()
    const named = /^([^：:]{1,40})[：:]\s*(.+)$/.exec(value)
    const prompt = (named?.[2] ?? value).replace(/^[“「"]|[”」"]$/g, '')
    choices.push({ label: (named?.[1] ?? prompt).slice(0, 30), prompt })
  }
  return uniqueSuggestions(choices)
}

function fallbackSuggestions(text: string, userText: string): NextStepSuggestion[] {
  if (/请选择|请.{0,20}(?:提供|补充|确认)|[?？]/.test(text)) return [{
    label: '帮我明确需要补充的信息',
    prompt: '请结合当前对话，说明你刚才需要我补充或确认的关键信息，并给出便于我回答的问题；不要代替我做决定，也不要编造我的要求。'
  }]
  if (/写|作文|剧本|大纲|润色|改写|故事|文案/.test(userText)) return [{
    label: '检查刚才的内容',
    prompt: '请依据当前对话已经明确的要求，检查你刚才的内容，列出具体问题和可改进之处，保留已经确认的设定与限制。'
  }, {
    label: '帮我明确修改重点',
    prompt: '我想修改刚才的内容。请结合当前对话列出值得调整的重点，等我补充具体意见后再修改。'
  }]
  return [{
    label: '展开关键细节',
    prompt: '请结合当前对话，进一步解释你刚才回复中的关键细节，沿用我已经明确的要求；信息不足时先向我确认。'
  }, {
    label: '给一个具体例子',
    prompt: '请围绕当前对话刚才讨论的内容，给出一个便于理解的具体例子；明确区分举例与已核实事实，并保留我已经提出的限制。'
  }]
}

export function availableSuggestions(conversation: Conversation): AvailableSuggestions | null {
  if (conversation.running || conversation.error || (conversation.asyncPending ?? 0) > 0
    || conversation.turn && conversation.turn.state !== 'complete') return null
  const index = conversation.entries.findLastIndex(row => row.role === 'assistant')
  const userIndex = conversation.entries.findLastIndex(row => row.role === 'user')
  if (index < 0 || userIndex > index) return null
  const entry = conversation.entries[index]
  if (entry.pending) return null
  const parsed = splitSuggestions(entry.text)
  if (parsed.suggestions.length) return { entryId: entry.id, suggestions: parsed.suggestions }
  if (!parsed.text.trim()) return null
  const plans = offeredPlans(parsed.text)
  const prose = plans.length ? plans : proseSuggestions(parsed.text)
  return { entryId: entry.id, suggestions: prose.length ? prose : fallbackSuggestions(parsed.text, conversation.entries[userIndex]?.text ?? '') }
}
