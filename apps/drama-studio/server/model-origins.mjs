import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 只记录模型服务来源，确保重启后仍可隐藏历史地址；不保存路径、查询或凭证。 */
export async function rememberModelOrigins(home, origins) {
  const directory = path.join(home, 'studio')
  const filename = path.join(directory, 'model-service-origins.json')
  let previous = []
  try { previous = JSON.parse(await readFile(filename, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!Array.isArray(previous) || previous.some(value => typeof value !== 'string' || new URL(value).origin !== value)) throw new Error('模型来源记录无效。')
  const merged = new Set([...previous, ...origins])
  if (merged.size !== previous.length) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = filename + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify([...merged]), { flag: 'wx', mode: 0o600 })
    await rename(temporary, filename)
  }
  return merged
}
