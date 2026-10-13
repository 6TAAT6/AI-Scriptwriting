import { LoaderCircle, PencilLine } from 'lucide-react'
import { useEffect, useState } from 'react'
import { listModelDisplayNames, saveModelDisplayNames, type ModelDisplayName, type ModelTarget } from './api'
import { FormNotice } from './Fields'
import { SelectMenu } from '../components/SelectMenu'

export function ModelNamesPanel() {
  const [models, setModels] = useState<ModelDisplayName[]>([])
  const [targets, setTargets] = useState<ModelTarget[]>([])
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const dirty = JSON.stringify(models) !== saved
  useEffect(() => {
    let active = true
    void listModelDisplayNames().then(result => {
      if (active) { setModels(result.models); setTargets(result.targets); setSaved(JSON.stringify(result.models)) }
    }).catch(reason => { if (active) setError(reason.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  function update(id: string, value: Partial<ModelDisplayName>) {
    setModels(rows => rows.map(row => row.id === id ? { ...row, ...value } : row))
    setError(''); setMessage('')
  }
  async function save() {
    if (busy || !dirty) return
    if (models.some(row => !row.display_name.trim())) { setError('请为每个品牌入口填写前端名称。'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await saveModelDisplayNames(models.map(row => ({ ...row, display_name: row.display_name.trim() })))
      setModels(result.models); setTargets(result.targets); setSaved(JSON.stringify(result.models))
      setMessage('品牌入口已保存。新会话使用新的后台模型，已有会话保留原模型。')
      window.dispatchEvent(new Event('studio:models-changed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '品牌入口未能保存，请重试。') }
    finally { setBusy(false) }
  }
  return <form className="model-names-panel" onSubmit={event => { event.preventDefault(); void save() }}>
    <header className="model-names-heading"><PencilLine size={17} aria-hidden="true" /><div><h3>品牌入口与后台模型</h3><p>前端名称固定展示给管理员和员工。更换后台模型时，名称保持不变。</p></div><span className="model-names-root">仅 root 可管理</span></header>
    <FormNotice error={error} message={message} />
    {loading ? <p role="status" className="models-empty">正在读取品牌入口…</p> : <>
      {(['text', 'image'] as const).map(kind => <fieldset key={kind} className="model-names-group" disabled={busy}>
        <legend>{kind === 'text' ? '文字模型' : '生图模型'}</legend>
        {models.filter(row => row.kind === kind).map(row => {
          const options = targets.flatMap(target => (kind === 'text' ? target.models : target.image_models).map(model => ({ value: JSON.stringify([target.provider, model]), label: `${target.provider_name} · ${model}` })))
          const value = JSON.stringify([row.provider, row.model])
          const available = options.some(option => option.value === value)
          return <div key={row.id} className={`model-name-row${row.visible ? '' : ' is-hidden'}`}>
            <div className="account-field"><label htmlFor={`display-${row.id}`}>前端名称</label><input id={`display-${row.id}`} aria-label={`${row.id} 的前端名称`} value={row.display_name} required maxLength={80} onChange={event => update(row.id, { display_name: event.target.value })} /></div>
            <div className="account-field"><span>后台调用模型</span><SelectMenu label={`${row.display_name}的后台模型`} value={value} placeholder={row.model ? `${row.model}（尚未接入）` : '选择已接入的模型'} options={options} disabled={busy || !options.length} searchLabel="搜索后台模型" onChange={selected => { const [provider, model] = JSON.parse(selected) as [string, string]; update(row.id, { provider, model }) }} />{!available && <small>先在上方接入该模型，再绑定到此入口。</small>}</div>
          </div>
        })}
      </fieldset>)}
      <footer className="model-names-footer"><small>更换后台模型后，新会话生效；已有会话保留原模型。<br />只有你修改左侧名称，成员看到的名称才会变化。</small><button type="submit" className="primary-button" disabled={busy || !dirty || !models.length}>{busy && <LoaderCircle size={14} className="account-spin" />}保存品牌入口</button></footer>
    </>}
  </form>
}
