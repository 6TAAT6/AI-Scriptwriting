// 剧本正文中“第N集 标题”是普通一行，紧凑行距下各集会连成一片；显示时把集标题行升为小标题，集与集之间留出间隔。
// 只改显示，不改稿件、复制内容或 Word；统计说明（如“第1集：893字”）和代码块不受影响。
const EPISODE_HEADING = /^(?:\*\*)?(第\s*[0-9０-９一二三四五六七八九十百千两]+\s*集(?:[\s：:·—\-《【（(][^\n]{0,24}?)?)(?:\*\*)?$/

const SCENE_HEADING = /^(?:\*\*)?\d{1,3}\s*[-—]\s*\d{1,3}\s*场?[\s.．、]+\S.{0,40}?[日夜晨昏][^。！？]{0,12}(?:\*\*)?$/

// 剧本行：△动作、“人物：”与“角色：（情绪）台词”。模型有时只用单个换行分隔，渲染时会挤在同一段里；
// 显示时相邻剧本行之间补一个空行，每行成为独立段落，行与行之间有统一的小间隔（不改稿件、复制内容或 Word）。
const SCRIPT_LINE = /^(?:△|▲|【|[^\s#>|*\-：:]{1,12}(?:[（(][^）)]{0,16}[）)])?[：:])/

/** 集号本身也常见于分析和大纲；推进正文需要同时有场次与实际剧本行。 */
export function isScriptContent(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim().replace(/^#{1,6}\s+/, '').replace(/^\*\*|\*\*$/g, ''))
  return lines.some(line => SCENE_HEADING.test(line)) && lines.filter(line => SCRIPT_LINE.test(line)).length >= 2
}

function spaceScriptLines(text: string): string {
  const lines = text.split('\n')
  let fenced = false
  return lines.flatMap((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const next = lines[index + 1]
    const script = (value: string) => SCRIPT_LINE.test(value.trim()) || SCENE_HEADING.test(value.trim())
    return !fenced && next !== undefined && line.trim() && next.trim() && script(line) && script(next) ? [line, ''] : [line]
  }).join('\n')
}

// 对话中每集标题后附上本集汉字数（“### 第04集 ⟨967⟩”），由标题组件显示成字数标记；只用于显示。
function episodeCounts(lines: string[]): Map<number, number> {
  const counts = new Map<number, number>()
  let current = -1
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.length <= 32 && EPISODE_HEADING.test(trimmed) && !/\d+\s*(?:字|个|分钟)/.test(trimmed)) { current = index; counts.set(index, 0); return }
    if (current >= 0) counts.set(current, counts.get(current)! + (line.match(/[\u4e00-\u9fff]/g)?.length ?? 0))
  })
  return counts
}

export function emphasizeEpisodeHeadings(text: string, chat = false): string {
  let fenced = false
  const lines = (chat ? spaceScriptLines(text) : text).split('\n')
  const counts = chat ? episodeCounts(lines) : new Map<number, number>()
  return lines.map((line, index) => {
    const trimmed = line.trim()
    if (/^(```|~~~)/.test(trimmed)) { fenced = !fenced; return line }
    if (fenced || !trimmed || /^[#>|*-]\s/.test(trimmed) || trimmed.length > 32) return line
    if (/\d+\s*(?:字|个|分钟)/.test(trimmed) || /[。！？，]$/.test(trimmed)) return line
    const match = trimmed.match(EPISODE_HEADING)
    if (match) return `### ${match[1].trim()}${(counts.get(index) ?? 0) >= 100 ? ` ⟨${counts.get(index)}⟩` : ''}`
    // 对话中的场次标题（“9-1场  冰峰堡垒中央祭典广场  夜  外”“1-2 书房 日 内”）升为四级小标题：加粗，与上一场留出间隔。
    // 稿件阅读面板另有按集场生成的目录与分行规则，不在那里改写。
    return chat && SCENE_HEADING.test(trimmed) ? `#### ${trimmed.replace(/^\*\*|\*\*$/g, '')}` : line
  }).join('\n')
}
