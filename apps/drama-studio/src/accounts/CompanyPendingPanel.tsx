import { LoaderCircle, UserPlus } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { assignCompanyEmployee, listCompanyEmployees, type CompanyEmployee, type StudioUser } from './api'
import { ORGANIZATIONS } from '../../shared/organizations.mjs'

type CompanyOrganization = 'hangzhou' | 'chongqing'
interface CompanyPendingPanelProps { onSynced: () => void; onAssigned: (user: StudioUser, message: string) => void }

/** 公司后台新增、但自动同步定不了归属（部门横店重庆混合或新部门）的员工，由管理员选公司后建号。 */
export function CompanyPendingPanel({ onSynced, onAssigned }: CompanyPendingPanelProps) {
  const headingId = useId()
  const [employees, setEmployees] = useState<CompanyEmployee[]>([])
  const [choices, setChoices] = useState<Record<string, CompanyOrganization>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    void listCompanyEmployees().then(result => {
      if (!mounted) return
      setEmployees(result.employees)
      if (result.changed) onSynced()
    }).catch(reason => { if (mounted) setError(reason instanceof Error ? reason.message : '公司员工目录读取失败。') })
    return () => { mounted = false }
    // 只在打开人员管理时同步一次；父组件回调变化不应重复读取公司目录。
  }, [])
  async function assign(employee: CompanyEmployee) {
    const organization = choices[employee.employee_id]
    if (!organization || busy) return
    setBusy(employee.employee_id); setError('')
    try {
      const user = await assignCompanyEmployee(employee.employee_id, organization)
      setEmployees(previous => previous.filter(row => row.employee_id !== employee.employee_id))
      onAssigned(user, `已为 ${user.display_name} 创建${ORGANIZATIONS[organization]}账号，员工现在可以用公司账号直接登录。`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '创建账号失败，请重试。') }
    finally { setBusy('') }
  }
  if (!employees.length && !error) return null
  return <section className="account-company-pending" aria-labelledby={headingId}>
    <header><h3 id={headingId}>待分配的公司员工{employees.length ? `（${employees.length}）` : ''}</h3>
      <p>公司后台新增的员工会自动建号；以下员工所在部门横店、重庆都有人，或是新部门，需要选择所属公司后创建账号。</p></header>
    {error && <p className="account-notice is-error" role="alert">{error}</p>}
    {employees.length > 0 && <ul>{employees.map(employee => <li key={employee.employee_id}>
      <div className="account-company-pending-person"><strong>{employee.name}</strong>
        <small>{[employee.account, employee.department_name, employee.position_name].filter(Boolean).join(' · ')}</small>
        {employee.department_organizations.length > 0 && <small>同部门已有：{employee.department_organizations.map(value => ORGANIZATIONS[value]).join('、')}</small>}
      </div>
      {employee.username_conflict ? <span className="account-protected">已有同名本地账号，需超级管理员处理</span> : <div className="account-company-pending-actions">
        <select aria-label={`${employee.name}的所属公司`} value={choices[employee.employee_id] ?? ''} disabled={Boolean(busy)}
          onChange={event => setChoices(previous => ({ ...previous, [employee.employee_id]: event.target.value as CompanyOrganization }))}>
          <option value="" disabled>选择所属公司</option><option value="hangzhou">横店</option><option value="chongqing">重庆</option>
        </select>
        <button type="button" className="primary-button" aria-label={`为${employee.name}创建账号`} disabled={!choices[employee.employee_id] || Boolean(busy)} aria-busy={busy === employee.employee_id} onClick={() => void assign(employee)}>
          {busy === employee.employee_id ? <LoaderCircle size={14} className="account-spin" /> : <UserPlus size={14} />}创建账号
        </button>
      </div>}
    </li>)}</ul>}
  </section>
}
