import { Copy, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { deleteActivationCode, generateActivationCode, listActivationCodes, type ActivationCode } from './api'
import { FormNotice } from './Fields'
import './ActivationCodesPanel.css'

const formatTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

export function ActivationCodesPanel() {
  const [codes, setCodes] = useState<ActivationCode[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<ActivationCode | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const codeInputs = useRef(new Map<string, HTMLInputElement>())
  useEffect(() => {
    let active = true
    void listActivationCodes().then(rows => { if (active) setCodes(rows) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '激活码列表读取失败。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  async function refresh() {
    setLoading(true); setError('')
    try { setCodes(await listActivationCodes()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '激活码列表读取失败。') }
    finally { setLoading(false) }
  }
  async function generate() {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await generateActivationCode()
      setCodes(rows => [result.activation_code, ...rows]); setNotice('激活码已生成，可随时在列表中查看和复制。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '激活码生成失败，请重试。') }
    finally { setBusy(false) }
  }
  async function copy(code: ActivationCode) {
    if (!code.code) return
    setNotice(''); setError('')
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code.code)
      else { codeInputs.current.get(code.id)?.select(); if (!document.execCommand('copy')) throw new Error('无法复制') }
      setNotice(`尾号 ${code.suffix} 的激活码已复制。`)
    } catch { codeInputs.current.get(code.id)?.select(); setError('自动复制失败，已选中激活码，请手动复制。') }
  }
  async function remove() {
    if (!deleting || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await deleteActivationCode(deleting.id)
      setCodes(rows => rows.filter(row => row.id !== deleting.id)); setDeleting(null)
      setNotice('激活码已删除，已激活的员工账号仍可正常登录。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败，请重试。') }
    finally { setBusy(false) }
  }
  return <section className="account-users activation-codes">
    <div className="account-page-heading"><div><h2>激活码管理</h2><p>每个码仅能激活一个员工账号，可随时查看、复制和删除。</p></div><button className="primary-button" disabled={busy || loading} onClick={() => void generate()}>{busy ? <LoaderCircle size={16} className="account-spin" /> : <Plus size={16} />}生成激活码</button></div>
    <FormNotice error={error} message={notice} />
    {deleting && <div className="activation-delete-confirm" role="alert"><div><strong>删除尾号 {deleting.suffix} 的激活码？</strong><p>删除后此码不能再用于激活，已激活的员工账号不受影响。</p></div><button className="secondary-button" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="primary-button" disabled={busy} onClick={() => void remove()}>确认删除</button></div>}
    <div className="account-list-toolbar"><span>生成及使用记录</span><button className="secondary-button" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'account-spin' : ''} />刷新</button></div>
    <div className="account-table-wrap" aria-busy={loading}><table className="account-table"><thead><tr><th>激活码</th><th>状态</th><th>生成时间</th><th>激活账号</th><th>激活时间</th><th>操作</th></tr></thead><tbody>
      {codes.map(code => <tr key={code.id}><td className="activation-code-cell">{code.code ? <input readOnly value={code.code} aria-label={`激活码 ${code.suffix}`} ref={node => { if (node) codeInputs.current.set(code.id, node); else codeInputs.current.delete(code.id) }} onClick={event => event.currentTarget.select()} /> : <><code>旧激活码 · 尾号 {code.suffix}</code><small>旧版未保存完整码，可删除后重新生成。</small></>}</td><td>{code.status === 'used' ? '已使用' : '未使用'}</td><td>{formatTime(code.created_at)}</td><td>{code.used_by_name || '—'}</td><td>{formatTime(code.used_at)}</td><td><div className="account-row-actions activation-code-actions"><button disabled={!code.code || busy} aria-label={`复制激活码 ${code.suffix}`} onClick={() => void copy(code)}><Copy size={13} />复制</button><button className="is-danger" disabled={busy} aria-label={`删除激活码 ${code.suffix}`} onClick={() => { setDeleting(code); setError(''); setNotice('') }}><Trash2 size={13} />删除</button></div></td></tr>)}
      {!codes.length && <tr><td colSpan={6}><div className="account-table-empty" role="status">{loading ? '正在读取激活码…' : '暂无激活码，点击上方按钮生成。'}</div></td></tr>}
    </tbody></table></div>
  </section>
}
