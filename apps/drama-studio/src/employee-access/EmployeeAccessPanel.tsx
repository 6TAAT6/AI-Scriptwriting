import { ChevronDown, ChevronRight, Eye, LoaderCircle, Plus, Trash2, UserRound } from 'lucide-react'
import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'
import { listUsers, type StudioUser } from '../accounts/api'
import { FormNotice } from '../accounts/Fields'
import { groupByRegion } from '../accounts/regions'
import { $employeeGroups, addEmployeeConversationAccess, loadEmployeeConversations, removeEmployeeConversationAccess, type EmployeeConversationGroup } from './api'

export function EmployeeAccessPanel() {
  const [users, setUsers] = useState<StudioUser[]>([])
  const groups = useStore($employeeGroups)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [expandedRegions, setExpandedRegions] = useState({ chongqing: true, hangzhou: true })
  useEffect(() => {
    let mounted = true
    void Promise.all([listUsers(), loadEmployeeConversations()]).then(([all]) => { if (mounted) setUsers(all) })
      .catch(reason => { if (mounted) setError(reason instanceof Error ? reason.message : '员工查看授权读取失败。') })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])
  const employees = useMemo(() => users.filter(user => user.role === 'employee' && user.enabled && !groups.some(group => group.employeeId === user.id)), [users, groups])
  const employeeRegions = groupByRegion(employees, user => user)
  const accessRegions = groupByRegion(groups, group => group.employee)
  async function add() {
    if (!selected || busy) return
    setBusy(true); setError(''); setNotice('')
    try { await addEmployeeConversationAccess(selected); setSelected(''); setNotice('已添加员工对话查看授权。') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '添加失败，请重试。') }
    finally { setBusy(false) }
  }
  async function remove(group: EmployeeConversationGroup) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await removeEmployeeConversationAccess(group.id); setNotice(`已移除对 ${group.employee.display_name} 的查看授权。`) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '移除失败，请重试。') }
    finally { setBusy(false) }
  }
  return <section className="account-users">
    <div className="account-page-heading"><div><h2>员工对话查看</h2><p>添加员工后，可在侧栏按员工查看其全部创作对话。员工不会收到你的查看操作，也不会影响其创作权限。</p></div><Eye size={24} color="var(--purple)" /></div>
    <FormNotice error={error} message={notice} />
    <div className="account-list-toolbar">
      <label className="account-search"><UserRound size={16} /><select aria-label="选择员工" value={selected} onChange={event => setSelected(event.target.value)} disabled={loading || busy}><option value="">选择要查看的员工</option>{employeeRegions.filter(region => region.members.length > 0).map(region => <optgroup key={region.id} label={region.label}>{region.members.map(user => <option key={user.id} value={user.id}>{user.display_name}（{user.username}）</option>)}</optgroup>)}</select></label>
      <button type="button" className="primary-button" onClick={() => void add()} disabled={!selected || busy}>{busy ? <LoaderCircle size={15} className="account-spin" /> : <Plus size={15} />}添加查看</button>
    </div>
    <div className="account-table-wrap" aria-busy={loading}>
      <table className="account-table"><thead><tr><th>员工</th><th>当前对话</th><th>授权时间</th><th>操作</th></tr></thead>
        {loading && <tbody><tr><td colSpan={4}><div className="account-table-empty" role="status"><LoaderCircle size={22} className="account-spin" />正在加载授权…</div></td></tr></tbody>}
        {!loading && accessRegions.map(region => <tbody key={region.id} className="account-region-group" data-region={region.id} aria-label={`${region.label}分组`}>
          <tr className="account-region-row"><td colSpan={4}><button type="button" className="account-region-toggle" aria-expanded={expandedRegions[region.id]} onClick={() => setExpandedRegions(current => ({ ...current, [region.id]: !current[region.id] }))}>
            {expandedRegions[region.id] ? <ChevronDown size={17} /> : <ChevronRight size={17} />}<span>{region.label}分组</span><span className="account-region-count">{region.members.length} 人</span>
          </button></td></tr>
          {expandedRegions[region.id] && region.members.map(group => <tr key={group.id}><td><strong>{group.employee.display_name}</strong><small className="account-cell-subtitle">{group.employee.username}</small></td><td>{group.sync_error ? <span className="account-cell-subtitle">同步中，稍后自动重试</span> : `${group.sessions.length} 个对话`}</td><td><time>{new Date(group.createdAt).toLocaleString('zh-CN')}</time></td><td><button type="button" className="account-row-action-danger" disabled={busy} onClick={() => void remove(group)}><Trash2 size={13} />移除查看</button></td></tr>)}
        </tbody>)}
        {!loading && !groups.length && <tbody><tr><td colSpan={4}><div className="account-table-empty"><Eye size={26} /><strong>还没有添加员工</strong><p>从上方选择员工后即可在侧栏查看对话。</p></div></td></tr></tbody>}
      </table>
    </div>
  </section>
}
