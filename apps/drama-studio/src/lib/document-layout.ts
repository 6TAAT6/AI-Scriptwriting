const NUMBER = '[0-9０-９一二三四五六七八九十百千万零〇两]+'
const CHAPTER = new RegExp(`^第\\s*${NUMBER}\\s*(?:[—－\\-~～至到]\\s*(?:第\\s*)?${NUMBER}\\s*)?[集章回幕卷部篇](?=$|[\\s:：·、\\-—（(【《])`)
const SCENE = new RegExp(`^(?:第\\s*${NUMBER}\\s*场(?=$|[\\s:：·、\\-—（(【《])|[0-9０-９]{1,3}[-－—.][0-9０-９]{1,3}(?:场)?(?=$|[\\s.·、日夜内外晨昏]))`)

function headingLevel(line: string): number | undefined {
  if (!line || line.length > 100 || /^[#>|`~]/.test(line) || /[。！？!?；;]/.test(line)) return undefined
  if (CHAPTER.test(line) || /^Episode\s+\d+(?:\s|[.:：-]|$)/i.test(line)) return 2
  if (SCENE.test(line)) return 3
  if (/^[一二三四五六七八九十]+[、．]\s*\S/.test(line) && line.length < 50) return 2
  return undefined
}

/** 只提升明确的章节行；正文、对白和下载原文都不改写。 */
export function prepareDocument(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let fence = ''
  return lines.map((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
      return line
    }
    if (fence || /^(?: {4}|\t)/.test(line) || /^\s*(?:=+|-+)\s*$/.test(lines[index + 1] ?? '')) return line
    const level = headingLevel(line.trim())
    return level ? `${'#'.repeat(level)} ${line.trim()}` : line
  }).join('\n')
}
