import { fail } from './accounts.mjs'
import { FILE_REFERENCE, isEmployee } from './file-handles.mjs'
import { IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, isImageFile } from '../shared/attachments.mjs'

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  fail(400, '图片格式无法识别，请重新上传 PNG、JPG 或 WebP 图片。')
}

export function validateImageUpload(dataUrl, name) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 100) fail(400, '单张图片请控制在 4 MB 以内。')
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match) fail(400, '图片内容无效，请重新复制截图或选择图片文件。')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES || bytes.toString('base64') !== match[2]) fail(400, '图片内容无效或超过 4 MB。')
  const mime = imageMime(bytes)
  const expected = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg'
  if (mime !== match[1] || mime !== expected) fail(400, '图片内容与文件格式不一致，请重新导出图片。')
}

async function readImage(backend, user, target) {
  // 由所属账号的文件服务读取，宿主边缘服务不直接打开可被工作进程替换的路径。
  const response = await backend.fetch('/api/fs/download', user, { path: target })
  if (!response.ok || !response.body) fail(400, '截图读取失败，请重新添加后再发送。')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > IMAGE_MAX_BYTES) fail(400, '单张图片请控制在 4 MB 以内。')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = Buffer.concat(chunks)
  return `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`
}

/** 一次提交文字和图片，避免原生待发送图片队列遗留到后续消息。 */
export async function imagePrompt(backend, user, text) {
  const prompt = isEmployee(user) ? await backend.files.incoming(user, text) : text
  const paths = [...new Set([...text.matchAll(FILE_REFERENCE)].map(match => match[1] || match[2] || match[3] || match[4]).filter(isImageFile))]
  if (!paths.length) return prompt
  if (paths.length > IMAGE_MAX_COUNT) fail(400, '每条消息最多添加 4 张图片。')
  const parts = [{ type: 'text', text: prompt }]
  for (const source of paths) {
    const target = isEmployee(user) ? await backend.files.resolve(user, source) : await backend.file(user, source)
    parts.push({ type: 'image_url', image_url: { url: await readImage(backend, user, target) } })
  }
  return parts
}
