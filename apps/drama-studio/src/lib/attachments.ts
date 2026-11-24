import { isDocumentFile, isImageFile } from '../../shared/attachments.mjs'

export function attachmentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.filter(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n')
}

/** 消息中的附件引用按路径去重：Hermes 展开附件时会在“Attached Context”里再提一次同一文件。 */
function referencedFiles(text: string, accept: (path: string) => boolean): { path: string; name: string }[] {
  const found = new Map<string, { path: string; name: string }>()
  for (const match of text.matchAll(/@file:(?:`([^`]+)`|"([^"]+)"|([^\s]+))/g)) {
    const path = match[1] || match[2] || match[3]
    if (path.startsWith('/') && accept(path) && !found.has(path)) found.set(path, { path, name: path.split('/').pop()! })
  }
  return [...found.values()]
}

export function attachedImages(text: string): { path: string; name: string }[] {
  return referencedFiles(text, isImageFile)
}

export function attachedFiles(text: string): { path: string; name: string }[] {
  return referencedFiles(text, isDocumentFile)
}

interface AttachmentAvailability {
  busy: boolean
  running: boolean
  loading: boolean
  preparing?: boolean
  connection: string
}

export function attachmentBlockReason({ busy, running, loading, preparing, connection }: AttachmentAvailability): string {
  if (busy) return '正在处理当前操作，请稍后添加附件。'
  if (loading) return '正在打开创作记录，请稍后添加附件。'
  if (preparing) return '创作服务正在准备，请稍后添加附件。'
  if (connection !== 'open') return '创作服务尚未连接，请连接后再添加附件。'
  if (running) return '请等待本轮创作结束，或先停止创作再添加附件。'
  return ''
}
