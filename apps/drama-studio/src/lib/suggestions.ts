import type { Conversation } from './transcript'
import { CAPABILITIES, conversationSelection } from './capabilities'
import { scriptSuggestions } from './script-suggestions'

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

/** 引用和代码只作为正文展示，不从中推导待发送的选择。 */
function suggestionProse(text: string): string {
  const lines: string[] = []
  let fence = ''
  let historicalLevel = 0
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''
      continue
    }
    if (marker) { fence = marker[1]; continue }
    const heading = /^\s*(#{1,6})\s+(.+)$/.exec(line)
    if (historicalLevel && heading && heading[1].length <= historicalLevel) historicalLevel = 0
    if (heading && /^(?:历史|回顾|此前|之前|旧方案|旧方向|示例|引用)/.test(heading[2])) historicalLevel = heading[1].length
    if (historicalLevel) continue
    if (/^\s*>/.test(line) || /^\s*(?:#{1,6}\s*)?(?:此前|之前|当时|曾经|历史|上次|引用|示例)/.test(line)) continue
    lines.push(line)
  }
  return lines.join('\n').replace(/\*\*/g, '')
}

function offeredPlans(text: string): NextStepSuggestion[] {
  const prose = suggestionProse(text)
  const questions = prose.split(/[。！？\n]/).filter(line =>
    (/(?:请选择|请(?:直接)?(?:选择|确认是否采用)|可以(?:直接)?选择|或选择|停在方案选择|等待.{0,12}选择|可直接指示切换)/.test(line)
      || /(?:请|可以)(?:直接)?回复/.test(line) && /(?:方向|方案)\s*[一二三四五1-5A-E]|\b[A-E]\b/.test(line))
    && !/^\s*[“「"]/.test(line)
    && !/(?:此前|之前|当时|曾经|历史|上次).{0,20}(?:说|回复|要求|选择)/.test(line))
  if (!questions.length) return []
  interface Plan { selector: string; display: string; label: string; order: number; recommended: boolean }
  const numbers = '一二三四五'
  const identity = (kind: string, code: string) => {
    const normalized = numbers[Number(code) - 1] || code
    const letter = /^[A-E]$/.test(normalized)
    return { key: kind + normalized, selector: kind + (letter ? ' ' : '') + normalized,
      display: kind === '方案' && letter ? ` ${normalized}` : kind + normalized,
      order: letter ? normalized.charCodeAt(0) - 65 : numbers.indexOf(normalized) }
  }
  const references = (value: string) => [...value.matchAll(/(方向|方案)\s*([一二三四五1-5A-E])/g)]
    .map(match => identity(match[1], match[2]))
  const resolved = new Set(prose.split(/[。；;，\n]/).flatMap(line =>
    /(?:已(?:经)?(?:选择|选定|采用|拒绝|取消|放弃)|不再采用)/.test(line) ? references(line).map(row => row.key) : []))
  const titles = new Map<string, Plan>()
  const addTitle = (kind: string, code: string, raw: string) => {
    const selected = identity(kind, code)
    if (resolved.has(selected.key) || titles.has(selected.key)) return
    const cleaned = raw.replace(/[【（(](?:重点)?(?:推荐|优先)[】）)]/g, '').trim()
    const label = /^【([^】]+)】/.exec(cleaned)?.[1] ?? cleaned
    if (label) titles.set(selected.key, { ...selected, label, recommended: /推荐|优先/.test(raw) })
  }
  for (const line of prose.split(/\r?\n/)) {
    const heading = line.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+|[1-5][.、)）]\s+)?/, '')
    const before = /^(方向|方案)\s*([一二三四五1-5A-E])[．.、:：)）｜|]\s*(.{1,80})$/.exec(heading)
    const after = /^(.{1,80}?)[（(](方向|方案)\s*([一二三四五1-5A-E])[）)](?:[【（(]推荐[】）)])?$/.exec(heading)
    const letter = /^([A-E])[．.、:：)）｜|]\s*(.{1,80})$/.exec(heading)
    if (before) addTitle(before[1], before[2], before[3])
    else if (after) addTitle(after[2], after[3], after[1])
    else if (letter) addTitle('方案', letter[1], letter[2])
  }
  // 仅从明确待选的当前句补充短标题；完整正文中的正式标题优先。
  for (const line of questions) {
    for (const match of line.matchAll(/[【「](方向|方案)\s*([一二三四五1-5A-E])[：:]\s*([^】」\n]{1,80})[】」]/g)) {
      addTitle(match[1], match[2], match[3])
    }
    for (const match of line.matchAll(/([^，。；;：:、【】（）()\n]{1,40})[（(](方向|方案)\s*([一二三四五1-5A-E])[）)]/g)) {
      const title = match[1].trim().replace(/^(?:(?:若|如果)?更?倾向于?|或(?:者)?(?:选择|采用)?|还是)\s*/, '')
      addTitle(match[2], match[3], title)
    }
  }
  for (const match of prose.matchAll(/(?:推荐|优先)(?:采用|选择)?[【（(\s]*(方向|方案)\s*([一二三四五1-5A-E])/g)) {
    const title = titles.get(identity(match[1], match[2]).key)
    if (title) title.recommended = true
  }
  const requested = new Map(questions.flatMap(line => references(line)).map(row => [row.key, row]))
  for (const line of questions) for (const match of line.matchAll(/\b([A-E])\b/g)) {
    const selected = identity('方案', match[1])
    if (!titles.has(selected.key)) titles.set(selected.key, { ...selected, label: '', recommended: false })
    requested.set(selected.key, selected)
  }
  const offered = [...titles.entries()].filter(([key]) => !resolved.has(key) && (requested.size < 2 || requested.has(key)))
    .map(([, title]) => title).sort((a, b) => a.order - b.order)
  if (offered.length < 2 || offered.length > 5) return []
  return uniqueSuggestions(offered.map(title => ({
    label: `选择${title.display}${title.label ? ` · ${title.label}` : ''}`.slice(0, 30),
    prompt: `我选择你刚才提供的${title.selector}${title.label ? `（${title.label}）` : ''}。`,
    ...(title.recommended ? { recommended: true } : {})
  })))
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

/** 部分中转会删掉代码围栏，只保留独占一行的协议名。 */
function trailingInlineSuggestions(text: string, streaming: boolean): SuggestionMessage | null {
  let fence = ''
  let offset = 0
  for (const line of text.split('\n')) {
    const boundary = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (boundary && boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) fence = ''
    } else if (boundary) {
      fence = boundary[1]
    } else {
      const opening = /^[ \t]*studio-suggestions[ \t]*[:：][ \t]*/i.exec(line)
      const tail = text.slice(offset).trim().toLowerCase()
      const partial = streaming && tail.startsWith('studio-') && MARKER.startsWith(tail)
      if (opening || partial) {
        const prose = text.slice(0, offset).trimEnd()
        if (/(?:示例|代码|JSON|数据结构|格式示范)/i.test(prose.slice(-1200))) return null
        if (partial) return { text: prose, suggestions: [] }
        const source = text.slice(offset + opening![0].length)
        const suggestions = parseSuggestions(source)
        if (suggestions.length || streaming && /^[\s]*[\[{]/.test(source) || streaming && !source.trim()) {
          return { text: prose, suggestions: streaming ? [] : suggestions }
        }
      }
    }
    offset += line.length + 1
  }
  return null
}

function trailingJsonSuggestions(text: string): SuggestionMessage | null {
  const blocks = [...text.matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/gi)]
  const last = blocks.at(-1)
  if (!last || text.slice(last.index! + last[0].length).trim() || last[2].length > 10000) return null
  const prose = text.slice(0, last.index).trimEnd()
  const preceding = prose.slice(-1200)
  // 中转可能省略引导问句；以末尾的严格字段结构识别，技术示例和纯 JSON 交付不转换。
  if (!prose || /(?:示例|代码|JSON|数据结构|数组|键值|接口|字段|格式示范)/i.test(preceding)) return null
  let values: unknown
  try { values = JSON.parse(last[2]) } catch { return null }
  if (!Array.isArray(values) || !values.length || values.length > 5 || values.some(item =>
    !item || typeof item !== 'object' || Array.isArray(item)
    || Object.keys(item).some(key => !['label', 'prompt', 'recommended'].includes(key))
    || 'recommended' in item && typeof item.recommended !== 'boolean')) return null
  const suggestions = uniqueSuggestions(values)
  return suggestions.length === values.length ? { text: prose, suggestions } : null
}

/** 展示层兼容明确的末尾操作选项；普通 JSON 和原始记录保持原样。 */
export function splitSuggestions(text: string, streaming = false): SuggestionMessage {
  const inline = trailingInlineSuggestions(text, streaming)
  if (inline) {
    const preceding = splitSuggestions(inline.text, streaming)
    return { text: preceding.text, suggestions: uniqueSuggestions([...preceding.suggestions, ...inline.suggestions]) }
  }
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
  if (!cursor) {
    const compatible = trailingJsonSuggestions(visible)
    if (compatible) return { text: compatible.text, suggestions: streaming ? [] : compatible.suggestions }
  }
  return { text: partial ? visible.slice(0, lineStart).trimEnd() : cursor ? visible.trimEnd() : visible, suggestions: uniqueSuggestions(choices) }
}

function proseSuggestions(text: string): NextStepSuggestion[] {
  const prose = suggestionProse(text)
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

/** 模型漏写卡片协议时，只为当前明确请求的原作分析提供待点击的阶段动作。 */
function analysisSuggestions(conversation: Conversation, text: string): NextStepSuggestion[] {
  if (!conversationSelection(conversation.entries).agent) return []
  const request = conversation.entries.findLast(row => row.role === 'user')?.text.trim() ?? ''
  if (!/^(?:[?？]+|(?:请|帮我)?(?:完整改编|分析原作|原作分析|原作理解)[。！!\s]*)$/.test(request)) return []
  const prose = suggestionProse(text)
  const heading = /^#{1,3}\s+《([^》\n]{1,80})》[^\n]*(?:原作理解|原作分析|原作.{0,8}资产分析)[^\n]*$/m.exec(prose)
  if (!heading) return []
  const title = `《${heading[1]}》`
  const headings = [...prose.matchAll(/^(#{2,4})\s+([^\n]+)\n/gm)]
  const sections = headings.filter((match, index) => {
    const next = headings.slice(index + 1).find(row => row[1].length <= match[1].length)
    const body = prose.slice(match.index + match[0].length, next?.index)
    return body.replace(/^#{1,6}\s+[^\n]+$/gm, '').trim().length > 0
  }).map(match => match[2])
  const hasPeople = sections.some(label => /人物|角色/.test(label))
  const hasEvents = sections.some(label => /逐集|分集|戏剧资产/.test(label))
  const hasMechanisms = sections.some(label => /机制|期待兑现/.test(label))
  if (!hasPeople || !hasEvents || !hasMechanisms || !/[。！？.!?][”」』）)*\s]*$/.test(prose.trimEnd())) {
    return [{ label: '补全当前原作分析', prompt: `请继续补全${title}当前尚未完成的原作分析，从上次未完成的位置接着写，不要重写已有部分，不进入改编方向或剧本正文。`, recommended: true }]
  }
  return [
    { label: '生成改编方向', prompt: `请基于本对话中${title}的原稿与已有原作分析，提出三套不同的改编方向，沿用当前创作设置和我的要求；如还有必要的分析缺项，先补齐缺项，不重复已有内容。此步只提供方向供我选择，不直接写剧本正文。`, recommended: true },
    { label: '调整原作分析', prompt: `我想调整${title}的原作分析。请先列出故事梗概、人物关系、逐集事件和改编机制这几个可调整部分，供我选择具体修改点，不直接重写全文。` }
  ]
}

const plainLine = (line: string) => line.replace(/\*\*/g, '').replace(/^[-*+]\s+/, '').trim()

const CIRCLED = '①②③④⑤⑥⑦⑧⑨'
const NUMERALS = '一二三四五六七八九'
// 选择卡与状态行之间的作答提示（有无括号都有）：“回一个数字、一句话都行；只回‘确认’，我就当你选①。”
const CHOICE_HINT = /回一个数字|回编号|回数字|只回|都行|都算数/
const circled = (line: string) => line !== '' && CIRCLED.includes(line[0])
const numeral = (value: string) => /\d/.test(value) ? Number(value) : NUMERALS.indexOf(value) + 1

/** 选择卡里“方案 N”“N 号名”要员工补编号：从选择卡之前的正文读出候选编号和 Vee 主推的那一个。 */
function candidateNumbers(body: string, kind: 'plan' | 'name'): { numbers: number[]; preferred?: number } {
  const pattern = kind === 'plan' ? /方案\s*([1-9一二三四五六七八九])/g : /^(?:#{1,4}\s*)?(?:No\.?\s*)?([1-9])\s*(?:[.、．)）]|号)/gm
  const numbers = [...new Set([...body.matchAll(pattern)].map(match => numeral(match[1])))].filter(value => value > 0).sort((a, b) => a - b)
  const preferred = kind === 'plan'
    ? /(?:我推|推荐|主推)\s*(?:的是)?\s*方案\s*([1-9一二三四五六七八九])/.exec(body)
    : /主推\s*(?:第\s*)?([1-9一二三四五六七八九])/.exec(body)
  return { numbers, ...(preferred ? { preferred: numeral(preferred[1]) } : {}) }
}

/** 自带协议的 Agent（Vee）每区交付末尾是“状态行 + 停顿句”，按区给可点按钮：
 * 选择卡（①②③…，正文里的块标号不算）→“选择 N：…”，方案/片名要补编号的按正文候选逐个展开；
 * Zone C 卡点集“EP07 / EP08 / EP09（请选一个）”→ 逐个 EP；其余区交付完待确认 →“确认，进入下一区”。
 * 提问轮等员工作答不给按钮；没有停顿句视为交付不完整，按协议不能推进，也不给按钮。 */
function protocolSuggestions(text: string): NextStepSuggestion[] {
  const lines = text.split(/\r?\n/).map(plainLine)
  while (lines.length && !lines.at(-1)) lines.pop()
  const pause = lines.findLastIndex(line => line.startsWith('⏸'))
  if (pause < 0 || pause !== lines.length - 1) return []
  const status = lines.slice(0, pause).findLast(line => /^当前位置[：:]/.test(line)) ?? ''
  const next = /下一区[：:]\s*([^｜|·]+?)\s*(?:[｜|·]|$)/.exec(status)?.[1]
  const results: NextStepSuggestion[] = []
  const add = (label: string, prompt: string, recommended = false) => {
    if (results.length >= 8 || results.some(row => row.prompt === prompt || row.label === label.slice(0, 30))) return
    results.push({ label: label.slice(0, 30), prompt, ...(recommended && !results.some(row => row.recommended) ? { recommended: true } : {}) })
  }
  let cursor = pause - 1, confirmIsFirst = false
  while (cursor >= 0 && !circled(lines[cursor])
    && (!lines[cursor] || /^当前位置[：:]/.test(lines[cursor]) || CHOICE_HINT.test(lines[cursor]) && lines[cursor].length <= 80)) {
    confirmIsFirst ||= /确认.{0,12}选\s*[①1]/.test(lines[cursor])
    cursor--
  }
  const block: string[] = []
  for (; cursor >= 0 && (!lines[cursor] || circled(lines[cursor])); cursor--) if (lines[cursor]) block.unshift(lines[cursor])
  if (block.length >= 2) {
    const before = lines.slice(0, cursor + 1).join('\n')
    const marked = block.some(line => /[（(]推荐[）)]/.test(line))
    for (const line of block) {
      const number = CIRCLED.indexOf(line[0]) + 1
      const body = line.slice(1).trim()
      const head = body.split(/——|—|：|:/)[0].trim()
      const label = head.replace(/[（(]推荐[）)]/g, '').replace(/[（(].*$/, '').trim()
      const kind = /方案\s*N\b/.test(body) ? 'plan' : /\bN\s*号/.test(body) ? 'name' : undefined
      if (kind) {
        const { numbers, preferred } = candidateNumbers(before, kind)
        const ordered = preferred && numbers.includes(preferred) ? [preferred, ...numbers.filter(value => value !== preferred)] : numbers
        if (ordered.length >= 2) {
          for (const value of ordered) {
            const choice = `选择 ${number}：${label.replace(/\bN\b/, String(value))}`
            add(choice, choice, value === preferred || !preferred && kind === 'name' && value === 1)
          }
        } else if (number === 1 && confirmIsFirst) add('选择 1：按推荐的来', '确认', !marked)
        continue
      }
      if (!label) continue
      add(`选择 ${number}：${label}`, `选择 ${number}：${label}`, /[（(]推荐[）)]/.test(head) || !marked && confirmIsFirst && number === 1)
    }
    return results
  }
  const pick = lines.slice(Math.max(0, pause - 8), pause).find(line => /请选|选一个|挑一个|你挑/.test(line) && (line.match(/EP\d{2,3}/g) ?? []).length >= 2)
  if (pick) {
    for (const episode of new Set(pick.match(/EP\d{2,3}/g))) add(`选择 ${episode}`, `卡点集选 ${episode}`)
    return results
  }
  // 提问轮（“答完我出整理稿”、编号或圆点问题）要员工作答，“确认”不能代替回答。
  const asked = lines.slice(0, pause)
  const questionRound = /答完|回答完|先回答/.test(asked.slice(-6).join('\n')) || asked.filter(line => /[？?]$/.test(line)).length >= 2
  if (/待确认/.test(status) && !questionRound) add(next ? `确认，进入 ${next}` : '确认', '确认', true)
  return results
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
  const agent = conversationSelection(conversation.entries).agent
  if (CAPABILITIES.some(row => row.id === agent && row.own_protocol)) {
    // 自带协议的 Agent 不套用宿主的方案/阶段推测，只认它自己的选择卡与停顿门禁。
    const protocol = protocolSuggestions(parsed.text)
    return protocol.length ? { entryId: entry.id, suggestions: protocol } : null
  }
  const plans = offeredPlans(parsed.text)
  const prose = plans.length ? plans : proseSuggestions(parsed.text)
  const analysis = prose.length ? prose : analysisSuggestions(conversation, parsed.text)
  const suggestions = analysis.length ? analysis : scriptSuggestions(conversation, suggestionProse)
  // 所有推导选项仍由用户点击，不补已确认/已保存前提，也不自动推进阶段。
  return suggestions.length ? { entryId: entry.id, suggestions } : null
}

/** 数字仅引用当前回复明确提供的卡片，不猜测历史或推导建议的编号。 */
export function selectedSuggestion(conversation: Conversation, reply: string): NextStepSuggestion | null {
  const number = /^(?:选(?:择)?\s*|第\s*)?([1-5])(?:\s*[项个])?[。.!！]?$/.exec(reply.trim())
  if (!number) return null
  const available = availableSuggestions(conversation)
  if (!available) return null
  const entry = conversation.entries.find(row => row.id === available.entryId)!
  return splitSuggestions(entry.text).suggestions[Number(number[1]) - 1] ?? null
}
