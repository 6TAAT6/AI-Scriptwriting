import { LoaderCircle, PencilLine, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { listModelDisplayNames, saveModelDisplayNames, type ModelBranding, type ModelDisplayName, type ModelTarget } from './api'
import { FormNotice } from './Fields'
import { SelectMenu } from '../components/SelectMenu'

export function ModelNamesPanel() {
  const [models, setModels] = useState<ModelDisplayName[]>([])
  const [targets, setTargets] = useState<ModelTarget[]>([])
  const [pausedTargets, setPausedTargets] = useState<NonNullable<ModelBranding['disabled_targets']>>([])
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const dirty = JSON.stringify(models) !== saved
  const available = (row: ModelDisplayName) => targets.some(target => target.provider === row.provider && (row.kind === 'text' ? target.models : target.image_models).includes(row.model))
  const availableTextCount = models.filter(row => row.visible && row.kind === 'text' && available(row)).length
  const deleted = models.filter(row => !row.visible)
  useEffect(() => {
    let active = true
    void listModelDisplayNames().then(result => {
      if (active) { setModels(result.models); setTargets(result.targets); setPausedTargets(result.disabled_targets ?? []); setSaved(JSON.stringify(result.models)) }
    }).catch(reason => { if (active) setError(reason.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  function update(id: string, value: Partial<ModelDisplayName>) {
    setModels(rows => rows.map(row => row.id === id ? { ...row, ...value } : row))
    setError(''); setMessage('')
  }
  function add(kind: ModelDisplayName['kind']) {
    const target = targets.find(row => (kind === 'text' ? row.models : row.image_models).length)
    if (!target) return
    const model = (kind === 'text' ? target.models : target.image_models)[0]
    setModels(rows => [...rows, { id: `brand-${kind}-${crypto.randomUUID()}`, kind, provider: target.provider, model, display_name: '', visible: true }])
    setError(''); setMessage('')
  }
  function remove(row: ModelDisplayName) {
    if (row.kind === 'text' && available(row) && availableTextCount <= 1) return
    const persisted = (JSON.parse(saved) as ModelDisplayName[]).some(value => value.id === row.id)
    if (persisted) update(row.id, { visible: false })
    else { setModels(rows => rows.filter(value => value.id !== row.id)); setError(''); setMessage('') }
  }
  async function save() {
    if (busy || !dirty) return
    if (models.some(row => !row.display_name.trim())) { setError('请为每个品牌入口填写前端名称。'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await saveModelDisplayNames(models.map(row => ({ ...row, display_name: row.display_name.trim() })))
      setModels(result.models); setTargets(result.targets); setPausedTargets(result.disabled_targets ?? []); setSaved(JSON.stringify(result.models))
      setMessage('品牌入口已保存。所有成员的可选列表会同步更新，已有会话和正在运行的任务保留原模型。')
      window.dispatchEvent(new Event('studio:models-changed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '品牌入口未能保存，请重试。') }
    finally { setBusy(false) }
  }
  return <form className="model-names-panel" onSubmit={event => { event.preventDefault(); void save() }}>
    <header className="model-names-heading"><PencilLine size={17} aria-hidden="true" /><div><h3>品牌入口与后台模型</h3><p>前端名称固定展示给管理员和员工。更换后台模型时，名称保持不变。</p></div><span className="model-names-root">仅 root 可管理</span></header>
    <FormNotice error={error} message={message} />
    {loading ? <p role="status" className="models-empty">正在读取品牌入口…</p> : <>
      {(['text', 'image'] as const).map(kind => <fieldset key={kind} className="model-names-group" disabled={busy}>
        <legend><span>{kind === 'text' ? '文字模型' : '生图模型'}</span><button type="button" className="model-name-add" disabled={!targets.some(target => (kind === 'text' ? target.models : target.image_models).length)} onClick={() => add(kind)}><Plus size={14} aria-hidden="true" />新增{kind === 'text' ? '文字' : '生图'}入口</button></legend>
        {models.filter(row => row.kind === kind && row.visible).map(row => {
          const options = targets.flatMap(target => (kind === 'text' ? target.models : target.image_models).map(model => ({ value: JSON.stringify([target.provider, model]), label: `${target.provider_name} · ${model}` })))
          const value = JSON.stringify([row.provider, row.model])
          const connected = options.some(option => option.value === value)
          const lastText = row.kind === 'text' && connected && availableTextCount <= 1
          const paused = connected || !row.provider ? undefined : pausedTargets.find(target => target.provider === row.provider)
          return <div key={row.id} className="model-name-row">
            <div className="account-field"><label htmlFor={`display-${row.id}`}>前端名称</label><input id={`display-${row.id}`} aria-label={`${row.id} 的前端名称`} value={row.display_name} required maxLength={80} onChange={event => update(row.id, { display_name: event.target.value })} /></div>
            <div className="account-field"><span>后台调用模型</span><SelectMenu label={`${row.display_name || '新入口'}的后台模型`} value={value} placeholder={paused ? `${row.model}（接入已停用）` : row.model ? `${row.model}（尚未接入）` : '选择已接入的模型'} options={options} disabled={busy || !options.length} searchLabel="搜索后台模型" onChange={selected => { const [provider, model] = JSON.parse(selected) as [string, string]; update(row.id, { provider, model }) }} />{!connected && <small>{paused ? `接入「${paused.provider_name}」已停用，员工看不到这个入口。请改选已启用的接入，或删除该入口。` : '先在上方接入该模型，再绑定到此入口。'}</small>}</div>
            <button type="button" className="model-name-delete" aria-label={`删除${row.display_name || '未命名入口'}`} disabled={lastText} title={lastText ? '至少保留一个已接入的文字入口。' : '保存后从所有成员的可选列表移除，保留已有会话。'} onClick={() => remove(row)}><Trash2 size={15} aria-hidden="true" /><span>删除</span></button>
          </div>
        })}
      </fieldset>)}
      {deleted.length > 0 && <details className="model-names-deleted"><summary>已删除入口（{deleted.length}）</summary><p>删除记录用于保留历史会话，可恢复后重新保存。</p>{deleted.map(row => <div key={row.id} className="model-name-deleted-row"><span>{row.display_name}<small>{row.kind === 'text' ? '文字模型' : '生图模型'}</small></span><button type="button" disabled={busy} aria-label={`恢复${row.display_name}`} onClick={() => update(row.id, { visible: true })}><RotateCcw size={14} aria-hidden="true" />恢复</button></div>)}</details>}
      <footer className="model-names-footer"><small>新增、删除与恢复须点击保存后生效，并同步所有成员的可选列表。<br />已有会话和正在运行的任务保留原模型；至少保留一个已接入的文字入口。</small><button type="submit" className="primary-button" disabled={busy || !dirty || !models.length}>{busy && <LoaderCircle size={14} className="account-spin" />}保存品牌入口</button></footer>
    </>}
  </form>
}
