import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, writeFile, link, rm } from 'node:fs/promises'
import path from 'node:path'

// 公司后台账号由公司统一登录和应用授权把关，不再要求激活码；激活码只用于本地账号。
export const activationRequired = user => ['admin', 'employee'].includes(user?.role) && !user.activated_at && user.auth_source !== 'company'
const digest = value => createHash('sha256').update(value).digest('hex')

export function activationDigest(value) {
  if (typeof value !== 'string' || value.length > 100) return null
  const normalized = value.replace(/[\s-]/g, '').toUpperCase()
  return /^JB[A-F0-9]{32}$/.test(normalized) ? digest(normalized) : null
}

export async function loadActivationKey(directory, codes) {
  const file = path.join(directory, '.activation-code.key')
  let handle
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (codes.some(row => row.code_ciphertext)) throw new Error('激活码密钥缺失，请恢复账号密钥备份。')
    const temp = file + '.' + randomUUID() + '.tmp'
    await writeFile(temp, randomBytes(32), { mode: 0o600, flag: 'wx' })
    try { await link(temp, file) } catch (error) { if (error.code !== 'EEXIST') throw error }
    finally { await rm(temp, { force: true }) }
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  }
  try {
    const key = await handle.readFile()
    if (key.length !== 32) throw new Error('激活码密钥格式不正确。')
    await handle.chmod(0o600)
    return key
  } finally { await handle.close() }
}

export function encryptActivationCode(code, key, id) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(id))
  const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

function decryptActivationCode(record, key) {
  if (!record.code_ciphertext) return null
  const [version, iv, tag, encrypted] = record.code_ciphertext.split('.')
  if (version !== 'v1') throw new Error('激活码保存格式不支持。')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(record.id)); decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  const code = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
  if (activationDigest(code) !== record.code_hash) throw new Error('激活码保存记录不一致。')
  return code
}

export function newActivationCode(actor, key) {
  const value = randomBytes(16).toString('hex').toUpperCase()
  const code = 'JB-' + value.match(/.{8}/g).join('-')
  const id = randomUUID()
  return { code, record: { id, code_hash: activationDigest(code), code_ciphertext: encryptActivationCode(code, key, id), suffix: value.slice(-8),
    created_at: new Date().toISOString(), created_by: actor.id, used_at: null, used_by: null } }
}

export function publicActivationCode(record, users, key) {
  return { id: record.id, suffix: record.suffix, created_at: record.created_at, created_by: record.created_by,
    status: record.used_at ? 'used' : 'unused', used_at: record.used_at, used_by: record.used_by,
    used_by_name: users.find(user => user.id === record.used_by)?.username ?? null, code: decryptActivationCode(record, key) }
}
