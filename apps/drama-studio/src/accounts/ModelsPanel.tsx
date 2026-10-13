import { ModelNamesPanel } from './ModelNamesPanel'
import { KeyRound, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { listModelEndpoints, saveModelEndpoint, validateModelEndpoint, type ModelEndpoint, type ModelEndpointInput } from './api'
import { FormNotice } from './Fields'
import './ModelsPanel.css'
import { SelectMenu } from '../components/SelectMenu'

const emptyForm: ModelEndpointInput = { name: '', base_url: '', model: '', models: [], api_mode: 'chat_completions' }

export function ModelsPanel() {
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([])
  const [form, setForm] = useState<ModelEndpointInput | null>(null)
  const [models, setModels] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    void listModelEndpoints().then(rows => { if (active) setEndpoints(rows) }).catch(reason => { if (active) setError(reason.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  function edit(endpoint?: ModelEndpoint) {
    setError(''); setMessage(''); setApiKey('')
    setModels(endpoint?.models.join('\n') || '')
    setForm(endpoint ? { id: endpoint.id, name: endpoint.name, base_url: endpoint.base_url, model: endpoint.model, models: endpoint.models, api_mode: endpoint.api_mode, image_model: endpoint.image_model, image_models: endpoint.image_models } : { ...emptyForm })
  }
  async function refresh() {
    setLoading(true); setError('')
    try { setEndpoints(await listModelEndpoints()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法读取模型接入。') }
    finally { setLoading(false) }
  }
  async function submit(action: 'save' | 'test') {
    if (!form || busy) return
    setBusy(action); setError(''); setMessage('')
    const input = { ...form, models: [...new Set(models.split(/[\n,，]/).map(value => value.trim()).filter(Boolean))], ...(apiKey ? { api_key: apiKey } : {}) }
    try {
      if (action === 'test') {
        const result = await validateModelEndpoint(input)
        if (!result.ok) setError(result.message)
        else { setMessage(result.message); if (!models.trim()) setModels(result.models.join('\n')) }
      } else {
        const result = await saveModelEndpoint(input)
        setEndpoints(result.endpoints); setMessage(result.message); setForm(null); setApiKey('')
        window.dispatchEvent(new Event('studio:models-changed'))
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '模型接入操作未完成。') }
    finally { setBusy(null) }
  }
  return <section className="models-panel">
    <header className="account-page-heading"><div><h2>模型接入</h2><p>由超级管理员统一配置。成员可在新建对话时选择已接入的模型。</p></div><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => edit()}><Plus size={15} />新增接入</button></header>
    {!form && <div className="models-toolbar"><span>已配置 {endpoints.length} 个接入</span><button type="button" className="secondary-button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button></div>}
    <FormNotice error={error} message={message} />
    {form ? <form className="account-form models-form" onSubmit={event => { event.preventDefault(); void submit('save') }}>
      <h3>{form.id ? '编辑接入' : '新增接入'}</h3>
      <div className="account-field"><label htmlFor="model-name">接入名称</label><input id="model-name" value={form.name} maxLength={80} required disabled={Boolean(busy)} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：团队写作模型" /></div>
      <div className="account-field"><label htmlFor="model-url">服务地址</label><input id="model-url" type="url" value={form.base_url} required disabled={Boolean(busy)} onChange={event => setForm({ ...form, base_url: event.target.value })} placeholder="https://api.example.com/v1" autoComplete="off" /></div>
      <div className="account-field"><span>接口协议</span><SelectMenu label="接口协议" value={form.api_mode} disabled={Boolean(busy)} onChange={value => setForm({ ...form, api_mode: value as ModelEndpointInput['api_mode'] })} options={[{ value: 'chat_completions', label: 'OpenAI Chat Completions' }, { value: 'codex_responses', label: 'OpenAI Responses' }]} /></div>
      <div className="account-field"><label htmlFor="model-default">默认模型</label><input id="model-default" value={form.model} required disabled={Boolean(busy)} onChange={event => setForm({ ...form, model: event.target.value })} placeholder="服务提供的模型名称" /></div>
      <div className="account-field"><label htmlFor="model-list">模型列表</label><textarea id="model-list" value={models} rows={4} required disabled={Boolean(busy)} onChange={event => setModels(event.target.value)} placeholder="每行一个模型名称，包含上方默认模型" /></div>
      <div className="account-field"><label htmlFor="model-key">API Key</label><input id="model-key" type="password" value={apiKey} required={!form.id} disabled={Boolean(busy)} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" spellCheck={false} placeholder={form.id ? '留空保留已保存的密钥' : '输入服务提供的 API Key'} /><small>密钥仅保存在服务端，保存后不再显示。检查连接只读取模型目录。</small></div>
      <div className="account-field"><label htmlFor="image-model">生图模型</label><input id="image-model" value={form.image_model || ''} disabled={Boolean(busy)} onChange={event => setForm({ ...form, image_model: event.target.value.trim(), image_models: event.target.value.trim() ? [event.target.value.trim()] : [] })} placeholder="例如：gpt-image-2；留空关闭生图" /><small>使用这个接入的服务地址和密钥，通过图片接口生成。图片模型不进入聊天模型列表。</small></div>
      <div className="models-actions"><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => { setForm(null); setApiKey(''); setError(''); setMessage('') }}>取消</button><button type="button" className="secondary-button" disabled={Boolean(busy) || !apiKey} onClick={() => void submit('test')}>{busy === 'test' && <LoaderCircle size={14} className="account-spin" />}检查连接</button><button type="submit" className="primary-button" disabled={Boolean(busy)}>{busy === 'save' && <LoaderCircle size={14} className="account-spin" />}保存接入</button></div>
    </form> : loading ? <p className="models-empty" role="status">正在读取模型接入…</p> : <div className="models-list">{endpoints.length ? endpoints.map(endpoint => <article key={endpoint.id} className="models-card"><div className="models-card-top"><span className="models-icon"><KeyRound size={17} /></span><div><h3>{endpoint.name}</h3><p>{endpoint.api_mode === 'codex_responses' ? 'Responses' : 'Chat Completions'} · {endpoint.models.length} 个模型</p></div><button type="button" className="secondary-button" aria-label={`编辑${endpoint.name}`} onClick={() => edit(endpoint)}>编辑</button></div><p className="models-address">{endpoint.base_url}</p><div className="models-card-footer"><span>{endpoint.model}</span><span className={endpoint.has_api_key ? 'models-configured' : ''}>{endpoint.has_api_key ? '密钥已配置' : '未配置密钥'}</span></div></article>) : <p className="models-empty">还没有接入模型，点击“新增接入”开始配置。</p>}</div>}
    {!form && <ModelNamesPanel key={endpoints.map(row => `${row.id}:${row.models.join()}:${row.image_models?.join()}`).join(";")} />}
  </section>
}
