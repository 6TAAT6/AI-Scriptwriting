import { unzipSync } from 'fflate'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const STRICT_S = 'http://purl.oclc.org/ooxml/spreadsheetml/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const STRICT_R = 'http://purl.oclc.org/ooxml/officeDocument/relationships'
const P = 'http://schemas.openxmlformats.org/package/2006/relationships'
const MAX_BYTES = 20 * 1024 * 1024
const elements = (node: Document | Element, ns: string, tag: string) => Array.from(node.getElementsByTagNameNS(ns, tag))

/** 只解析已鉴权下载的正文 XML；图片、宏和外部关系均不执行。 */
export function readOfficeText(data: Uint8Array, extension: 'docx' | 'xlsx'): string {
  if (data.length > MAX_BYTES) throw new Error('文档过大，请下载查看。')
  let unpacked = 0, count = 0
  const names = new Set<string>()
  const files = unzipSync(data, { filter: file => {
    unpacked += file.originalSize
    if (unpacked > 60 * 1024 * 1024 || ++count > 10000) throw new Error('解压后的文档过大，请下载查看。')
    if (names.has(file.name) || file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').includes('..')) throw new Error('文档包含无效的文件路径。')
    names.add(file.name)
    return /\.(xml|rels)$/.test(file.name)
  } })
  const xml = (name: string) => {
    if (!files[name]) throw new Error('文档缺少必要内容。')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(files[name])
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('不支持包含实体声明的 XML 文档。')
    const document = new DOMParser().parseFromString(text, 'application/xml')
    if (document.getElementsByTagName('parsererror').length) throw new Error('文档 XML 无法解析。')
    return document
  }
  let text: string
  if (extension === 'docx') {
    const body = elements(xml('word/document.xml'), W, 'body')[0]
    if (!body) throw new Error('文档缺少剧本正文。')
    text = elements(body, W, 'p').map(paragraph => elements(paragraph, W, '*').map(node => {
      if (node.localName === 't') return node.textContent || ''
      if (node.localName === 'tab') return '\t'
      return ['br', 'cr'].includes(node.localName) ? '\n' : ''
    }).join('')).join('\n\n')
  } else {
    const workbook = xml('xl/workbook.xml')
    const namespace = workbook.documentElement.namespaceURI
    if (namespace !== S && namespace !== STRICT_S) throw new Error('工作簿 XML 格式无法识别。')
    const spreadsheetElements = (node: Document | Element, tag: string) => elements(node, namespace, tag)
    const relations = new Map(elements(xml('xl/_rels/workbook.xml.rels'), P, 'Relationship').map(node => [node.getAttribute('Id'), node]))
    const shared = files['xl/sharedStrings.xml'] ? spreadsheetElements(xml('xl/sharedStrings.xml'), 'si').map(node => spreadsheetElements(node, 't').map(part => part.textContent || '').join('')) : []
    text = spreadsheetElements(workbook, 'sheet').filter(sheet => !sheet.getAttribute('state') || sheet.getAttribute('state') === 'visible').map(sheet => {
      const relation = relations.get(sheet.getAttributeNS(namespace === S ? R : STRICT_R, 'id'))
      const target = relation?.getAttribute('Target') || ''
      if (!target || relation?.getAttribute('TargetMode') === 'External' || target.includes('\\') || target.split('/').includes('..')) throw new Error('工作表关系无效。')
      const member = target.startsWith('/') ? target.slice(1) : `xl/${target}`
      if (!member.startsWith('xl/')) throw new Error('工作表关系超出文档范围。')
      const labels = new Map<string, string>()
      const rows = spreadsheetElements(xml(member), 'row').map((row, index) => {
        const cells = spreadsheetElements(row, 'c').map((cell, position) => {
          const column = cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0] || String(position + 1)
          const kind = cell.getAttribute('t')
          const cached = spreadsheetElements(cell, 'v')[0]
          const formula = spreadsheetElements(cell, 'f')[0]
          let value = cached?.textContent || ''
          if (formula && (!cached || !value && kind !== 'str')) value = `[公式未计算${formula.textContent ? `：=${formula.textContent}` : ''}]`
          else if (kind === 'inlineStr') value = spreadsheetElements(cell, 't').map(node => node.textContent || '').join('')
          else if (kind === 's') {
            if (!/^\d+$/.test(value) || shared[Number(value)] === undefined) throw new Error('工作表文字索引无效。')
            value = shared[Number(value)]
          }
          if (index === 0 && value && value.length <= 40 && !value.includes('\n')) labels.set(column, value)
          return value ? `${index > 0 ? labels.get(column) || `${column}列` : `${column}列`}：${value}` : ''
        }).filter(Boolean)
        return cells.length ? `### 第${row.getAttribute('r') || index + 1}行\n\n${cells.join('\n\n')}` : ''
      }).filter(Boolean)
      return `## ${sheet.getAttribute('name') || '工作表'}\n\n${rows.join('\n\n')}`
    }).join('\n\n')
  }
  if (!text.trim()) throw new Error('文档没有可读取的正文。')
  if (text.length > 1500000) throw new Error('正文过长，请下载查看全文。')
  return text.replace(/\r\n?/g, '\n')
}

export async function readOfficeResponse(response: Response, extension: 'docx' | 'xlsx'): Promise<string> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('文档过大或无法读取。')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('文档过大，请下载查看。')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return readOfficeText(bytes, extension)
}
