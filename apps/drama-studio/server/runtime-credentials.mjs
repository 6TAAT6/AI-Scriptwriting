import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open } from 'node:fs/promises'
import path from 'node:path'

export async function runtimeToken(dataDir, { create = false } = {}) {
  const file = path.join(dataDir, 'runtime-token')
  let handle
  try {
    if (create) await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const directory = await lstat(dataDir)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077) throw new Error('目录权限')
    if (create) {
      try {
        handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        const value = randomBytes(32).toString('base64url')
        await handle.writeFile(value)
        await handle.sync()
        return value
      } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.mode & 0o077 || process.getuid && metadata.uid !== process.getuid()) throw new Error('文件权限')
    const value = (await handle.readFile('utf8')).trim()
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error('凭证格式')
    return value
  } catch (error) {
    if (!create && error.code === 'ENOENT') return ''
    throw new Error('服务凭证不可用；请检查私有目录及文件权限。')
  } finally { await handle?.close() }
}
