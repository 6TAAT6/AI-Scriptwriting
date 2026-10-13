import { isImageFile } from '../../shared/attachments.mjs'

export function attachmentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.filter(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n')
}

export function attachedImages(text: string): { path: string; name: string }[] {
  return [...text.matchAll(/@file:(?:`([^`]+)`|"([^"]+)"|([^\s]+))/g)].flatMap(match => {
    const path = match[1] || match[2] || match[3]
    return path.startsWith('/') && isImageFile(path) ? [{ path, name: path.split('/').pop()! }] : []
  })
}

export function attachedFiles(text: string): { path: string; name: string }[] {
  return [...text.matchAll(/@file:(?:`([^`]+)`|"([^"]+)"|([^\s]+))/g)].flatMap(match => {
    const path = match[1] || match[2] || match[3]
    return path.startsWith('/') && /\.(?:txt|md|docx|xlsx|csv|pdf)$/i.test(path) ? [{ path, name: path.split('/').pop()! }] : []
  })
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
