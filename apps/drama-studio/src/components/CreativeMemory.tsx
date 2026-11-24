import { useStore } from '@nanostores/react'
import { BookOpen, Check, ChevronDown, Globe, History, ListChecks, LoaderCircle, Pencil, Pin, PinOff, Plus, RefreshCw, RotateCcw, Undo2, X } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { $creativeMemory, REQUIREMENT_LABELS, SOURCE_LABELS, editCreativeMemory, loadCreativeMemory, type BibleEntry, type BibleVersion, type RequirementItem } from '../lib/creative-memory'
import { SelectMenu } from './SelectMenu'
import './CreativeMemory.css'

function useAction(sessionId: string) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('')
    try { await action(); return true }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作暂未完成，请稍后重试。'); return false }
    finally { setBusy('') }
  }
  return { busy, error, run, sessionId }
}

function SectionTitle({ title, count, sessionId, loading }: { title: string; count: number; sessionId: string; loading: boolean }) {
  return <div className="file-section-title">{title}<span>{count}</span>
    <span className="inspector-action-tooltip" data-tooltip={loading ? '正在刷新…' : '刷新'}><button className="icon-button" disabled={!sessionId || loading} aria-label={`刷新${title}`} aria-busy={loading} onClick={() => void loadCreativeMemory(sessionId)}><RefreshCw size={13} className={loading ? 'spin' : undefined} /></button></span>
  </div>
}

function EmptyState({ icon, title, lines }: { icon: ReactNode; title: string; lines: string[] }) {
  return <div className="files-empty"><span className="empty-file-icon">{icon}</span><h3>{title}</h3><p>{lines.map((line, index) => <span key={index}>{line}<br /></span>)}</p></div>
}

function NoSession({ icon, title }: { icon: ReactNode; title: string }) {
  return <EmptyState icon={icon} title={title} lines={['发送第一条消息后，', '这里会随创作逐步整理。']} />
}

// ---------------- 要求清单 ----------------

function RequirementRow({ item, sessionId, onEdit }: { item: RequirementItem; sessionId: string; onEdit: (item: RequirementItem) => void }) {
  const { busy, error, run } = useAction(sessionId)
  const active = item.status === 'active'
  const act = (action: string) => run(action, () => editCreativeMemory(sessionId, 'requirement', action, { id: item.id }))
  return <div className={`memory-row ${active ? '' : 'inactive'}`}>
    <div className="memory-row-head">
      <span className="memory-chip">{REQUIREMENT_LABELS[item.category] || '其他'}</span>
      {item.lasting && <span className="memory-chip lasting"><Globe size={9} />长期·所有作品</span>}
      {item.pinned && <span className="memory-chip pinned"><Pin size={9} />置顶</span>}
      {item.lifetime === 'turn' && <span className="memory-chip muted">仅本轮</span>}
      {item.origin === 'migration' && <span className="memory-chip muted">旧会话整理，待确认</span>}
      {!active && <span className="memory-chip muted">{item.status === 'expired' ? '已失效' : item.status === 'superseded' ? '已被替换' : '已取消'}</span>}
      <span className="memory-row-actions">
        {active ? <>
          <button className="icon-button" aria-label={item.pinned ? '取消置顶' : '置顶'} disabled={Boolean(busy)} onClick={() => void act(item.pinned ? 'unpin' : 'pin')}>{item.pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
          <button className="icon-button" aria-label={item.lasting ? '改为仅本作品' : '设为长期要求（所有作品适用）'} title={item.lasting ? '改为仅本作品' : '设为长期要求（所有作品适用）'} disabled={Boolean(busy) || item.lifetime === 'turn'} onClick={() => void act(item.lasting ? 'local' : 'lasting')}><Globe size={13} /></button>
          <button className="icon-button" aria-label="编辑要求" disabled={Boolean(busy)} onClick={() => onEdit(item)}><Pencil size={13} /></button>
          <button className="icon-button" aria-label="取消这条要求" disabled={Boolean(busy)} onClick={() => void act('cancel')}><X size={13} /></button>
        </> : item.status === 'cancelled' && <button className="icon-button" aria-label="恢复这条要求" disabled={Boolean(busy)} onClick={() => void act('restore')}><Undo2 size={13} /></button>}
      </span>
    </div>
    <p className="memory-text">{item.text}</p>
    {item.detail && <p className="memory-detail">执行细则：{item.detail}</p>}
    {item.quote && item.quote !== item.text && <p className="memory-quote">原话：{item.quote}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>
}

function RequirementEditor({ sessionId, item, categories, onDone }: { sessionId: string; item: RequirementItem | null; categories: string[]; onDone: () => void }) {
  const [text, setText] = useState(item?.text || '')
  const [category, setCategory] = useState(item?.category || 'other')
  const [lasting, setLasting] = useState(false)
  const { busy, error, run } = useAction(sessionId)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim()) return
    const ok = await run('save', () => item
      ? editCreativeMemory(sessionId, 'requirement', 'update', { id: item.id, text: text.trim() })
      : editCreativeMemory(sessionId, 'requirement', 'add', { text: text.trim(), category, lasting }))
    if (ok) onDone()
  }
  return <form className="memory-editor" onSubmit={event => void submit(event)}>
    {!item && <SelectMenu label="要求类别" value={category} onChange={setCategory} options={categories.map(value => ({ value, label: REQUIREMENT_LABELS[value] || value }))} />}
    <textarea value={text} maxLength={600} rows={3} autoFocus placeholder="例如：每集结尾留一个悬念；女主不会武功。" onChange={event => setText(event.target.value)} />
    {!item && <label className="memory-check"><input type="checkbox" checked={lasting} onChange={event => setLasting(event.target.checked)} />以后所有作品都适用（如固定格式、文风）</label>}
    {item && <p className="memory-hint">修改后按文字要求核验，原来的字数等精确指标不再自动计算。</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="memory-editor-actions"><button type="button" className="text-button" onClick={onDone}>取消</button><button type="submit" className="primary-button" disabled={Boolean(busy) || !text.trim()}>{busy ? '正在保存…' : '保存'}</button></div>
  </form>
}

export function RequirementsPanel({ sessionId }: { sessionId: string }) {
  const state = useStore($creativeMemory)
  const [editing, setEditing] = useState<RequirementItem | null | 'new'>(null)
  const [showInactive, setShowInactive] = useState(false)
  if (!sessionId) return <NoSession icon={<ListChecks size={25} />} title="你提的每条要求，都会记在这里" />
  const data = state.sessionId === sessionId ? state.data : null
  const items = data?.requirements ?? []
  const active = items.filter(item => item.status === 'active')
  const inactive = items.filter(item => item.status !== 'active').slice(-30).reverse()
  return <>
    <SectionTitle title="要求清单" count={active.length} sessionId={sessionId} loading={state.loading} />
    <p className="memory-intro">智能体每一轮都会对照这份清单创作和核验。清单只记录你说过的要求，可直接修改；标为“长期”的要求在你以后的新对话里同样生效。</p>
    {state.error && <p className="inline-error" role="alert">{state.error}</p>}
    {data?.pending_extraction && <p className="memory-pending" role="status"><LoaderCircle size={12} className="spin" />正在整理本轮消息中的要求…</p>}
    {editing ? <RequirementEditor sessionId={sessionId} item={editing === 'new' ? null : editing} categories={data?.requirement_categories ?? Object.keys(REQUIREMENT_LABELS)} onDone={() => setEditing(null)} />
      : <button className="memory-add" onClick={() => setEditing('new')} disabled={!data}><Plus size={13} />添加要求</button>}
    {active.length ? active.map(item => <RequirementRow key={item.id} item={item} sessionId={sessionId} onEdit={setEditing} />)
      : !state.loading && !editing && <EmptyState icon={<ListChecks size={25} />} title="还没有记录的要求" lines={['在对话里提出的要求，', '会在下一轮开始前整理到这里。']} />}
    {inactive.length > 0 && <details className="memory-inactive" open={showInactive} onToggle={event => setShowInactive((event.target as HTMLDetailsElement).open)}>
      <summary><ChevronDown size={12} />已取消或失效 {inactive.length}</summary>
      {inactive.map(item => <RequirementRow key={item.id} item={item} sessionId={sessionId} onEdit={setEditing} />)}
    </details>}
  </>
}

// ---------------- 设定库 ----------------

function BibleEditor({ sessionId, entry, categories, onDone }: { sessionId: string; entry: BibleEntry | null; categories: [string, string][]; onDone: () => void }) {
  const [category, setCategory] = useState(entry?.category || categories[0]?.[0] || 'character')
  const [name, setName] = useState(entry?.name || '')
  const [aliases, setAliases] = useState(entry?.aliases.join('、') || '')
  const [content, setContent] = useState(entry?.content || '')
  const { busy, error, run } = useAction(sessionId)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const payload = { category, name: name.trim(), content: content.trim(), aliases: aliases.split(/[、,，\s]+/).map(value => value.trim()).filter(Boolean) }
    if (!payload.name || !payload.content) return
    const ok = await run('save', () => editCreativeMemory(sessionId, 'bible', entry ? 'update' : 'add', entry ? { ...payload, id: entry.id } : payload))
    if (ok) onDone()
  }
  return <form className="memory-editor" onSubmit={event => void submit(event)}>
    <SelectMenu label="设定类别" value={category} onChange={setCategory} options={categories.map(([value, label]) => ({ value, label }))} />
    <input value={name} maxLength={60} placeholder="名称，例如人物姓名、物件名" onChange={event => setName(event.target.value)} autoFocus />
    <input value={aliases} placeholder="别名或称呼，用顿号分隔（可选）" onChange={event => setAliases(event.target.value)} />
    <textarea value={content} maxLength={4000} rows={5} placeholder="设定内容：身份、能力、关系、限制、当前状态等" onChange={event => setContent(event.target.value)} />
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="memory-editor-actions"><button type="button" className="text-button" onClick={onDone}>取消</button><button type="submit" className="primary-button" disabled={Boolean(busy) || !name.trim() || !content.trim()}>{busy ? '正在保存…' : '保存'}</button></div>
  </form>
}

function BibleHistory({ sessionId, entry, onClose }: { sessionId: string; entry: BibleEntry; onClose: () => void }) {
  const [versions, setVersions] = useState<BibleVersion[] | null>(null)
  const { busy, error, run } = useAction(sessionId)
  useEffect(() => {
    let cancelled = false
    void run('load', async () => {
      const result = await editCreativeMemory<{ history: BibleVersion[] }>(sessionId, 'bible', 'history', { id: entry.id })
      if (!cancelled) setVersions(result.history)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, entry.id, entry.version])
  return <div className="memory-history">
    <div className="memory-history-head"><strong>{entry.name} · 历史版本</strong><button className="icon-button" aria-label="关闭历史" onClick={onClose}><X size={13} /></button></div>
    {busy === 'load' && <p className="memory-pending"><LoaderCircle size={12} className="spin" />正在读取…</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {versions?.map(row => <div key={row.version} className="memory-version">
      <div className="memory-row-head"><span className="memory-chip">第 {row.version} 版</span><span className="memory-chip muted">{SOURCE_LABELS[row.actor] || row.actor}</span>
        {row.version !== entry.version && <span className="memory-row-actions visible"><button className="text-button" disabled={Boolean(busy)} onClick={() => void run('revert', async () => { await editCreativeMemory(sessionId, 'bible', 'revert', { id: entry.id, version: row.version }); onClose() })}><RotateCcw size={12} />恢复此版</button></span>}
      </div>
      <p className="memory-text">{row.snapshot.status === 'retired' ? '（已停用）' : row.snapshot.content}</p>
      {row.reason && <p className="memory-quote">理由：{row.reason}</p>}
    </div>)}
  </div>
}

function BibleRow({ entry, sessionId, onEdit, onHistory }: { entry: BibleEntry; sessionId: string; onEdit: (entry: BibleEntry) => void; onHistory: (entry: BibleEntry) => void }) {
  const [expanded, setExpanded] = useState(false)
  const { busy, error, run } = useAction(sessionId)
  const retired = entry.status !== 'active'
  return <div className={`memory-row ${retired ? 'inactive' : ''}`}>
    <div className="memory-row-head">
      <strong className="memory-name">{entry.name}</strong>
      {entry.aliases.length > 0 && <span className="memory-alias">{entry.aliases.join('、')}</span>}
      <span className="memory-row-actions">
        <button className="icon-button" aria-label="查看历史版本" onClick={() => onHistory(entry)}><History size={13} /></button>
        {!retired && <><button className="icon-button" aria-label="编辑设定" onClick={() => onEdit(entry)}><Pencil size={13} /></button>
          <button className="icon-button" aria-label="停用这条设定" disabled={Boolean(busy)} onClick={() => void run('retire', () => editCreativeMemory(sessionId, 'bible', 'retire', { id: entry.id }))}><X size={13} /></button></>}
      </span>
    </div>
    <button className={`memory-content ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{entry.content}</button>
    <p className="memory-meta">第 {entry.version} 版 · {SOURCE_LABELS[entry.source] || entry.source}{retired ? ' · 已停用' : ''}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>
}

function ProposedEntry({ entry, sessionId }: { entry: BibleEntry; sessionId: string }) {
  const { busy, error, run } = useAction(sessionId)
  const decide = (action: 'confirm' | 'reject') => run(action, () => editCreativeMemory(sessionId, 'bible', action, { id: entry.id }))
  return <div className="memory-row proposed">
    <div className="memory-row-head">
      <span className="memory-chip core">{entry.category_label}</span><strong className="memory-name">{entry.name}</strong>
      <span className="memory-row-actions visible">
        <button className="text-button" disabled={Boolean(busy)} onClick={() => void decide('reject')}><X size={12} />不采用</button>
        <button className="text-button confirm" disabled={Boolean(busy)} onClick={() => void decide('confirm')}><Check size={12} />确认</button>
      </span>
    </div>
    <p className="memory-text">{entry.content}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>
}

function ProposedGroup({ entries, sessionId }: { entries: BibleEntry[]; sessionId: string }) {
  const { busy, error, run } = useAction(sessionId)
  const confirmAll = () => run('all', async () => { for (const entry of entries) await editCreativeMemory(sessionId, 'bible', 'confirm', { id: entry.id }) })
  return <section className="memory-group memory-proposed" aria-label="待你确认的核心设定">
    <h4>待你确认<span className="count">{entries.length}</span>
      <button className="text-button confirm-all" disabled={Boolean(busy)} onClick={() => void confirmAll()}>{busy ? '正在确认…' : '全部确认'}</button></h4>
    <p className="memory-hint">系统依据你的要求和已交付的稿件整理。确认后成为正式设定；不采用的条目不再作为创作依据。</p>
    {entries.map(entry => <ProposedEntry key={entry.id} entry={entry} sessionId={sessionId} />)}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>
}

export function BiblePanel({ sessionId }: { sessionId: string }) {
  const state = useStore($creativeMemory)
  const [editing, setEditing] = useState<BibleEntry | null | 'new'>(null)
  const [history, setHistory] = useState<BibleEntry | null>(null)
  if (!sessionId) return <NoSession icon={<BookOpen size={25} />} title="人物与世界观，都会整理在这里" />
  const data = state.sessionId === sessionId ? state.data : null
  const entries = data?.bible ?? []
  const active = entries.filter(entry => entry.status === 'active')
  const proposed = entries.filter(entry => entry.status === 'proposed')
  const retired = entries.filter(entry => entry.status !== 'active' && entry.status !== 'proposed')
  const categories: [string, string][] = data ? [...Object.entries(data.categories.core), ...Object.entries(data.categories.notes)] : []
  const groups = categories.map(([key, label]) => ({ key, label, core: Boolean(data?.categories.core[key]), rows: active.filter(entry => entry.category === key) })).filter(group => group.rows.length)
  return <>
    <SectionTitle title="设定库" count={active.length} sessionId={sessionId} loading={state.loading} />
    <p className="memory-intro">本作品的权威设定。智能体只能按这里的设定创作；新增或修改核心设定会先请你确认。</p>
    {state.error && <p className="inline-error" role="alert">{state.error}</p>}
    {history ? <BibleHistory sessionId={sessionId} entry={history} onClose={() => setHistory(null)} />
      : editing ? <BibleEditor sessionId={sessionId} entry={editing === 'new' ? null : editing} categories={categories} onDone={() => setEditing(null)} />
      : <button className="memory-add" onClick={() => setEditing('new')} disabled={!data}><Plus size={13} />添加设定</button>}
    {proposed.length > 0 && !editing && !history && <ProposedGroup entries={proposed} sessionId={sessionId} />}
    {groups.length ? groups.map(group => <section key={group.key} className="memory-group">
      <h4>{group.label}{group.core && <span className="memory-chip core">核心</span>}<span className="count">{group.rows.length}</span></h4>
      {group.rows.map(entry => <BibleRow key={entry.id} entry={entry} sessionId={sessionId} onEdit={setEditing} onHistory={setHistory} />)}
    </section>) : !state.loading && !editing && !history && !proposed.length && <EmptyState icon={<BookOpen size={25} />} title="设定库还是空的" lines={['开始创作后，智能体会整理人物和世界观，', '核心设定经你确认后写入。']} />}
    {retired.length > 0 && <details className="memory-inactive"><summary><ChevronDown size={12} />已停用或未采用 {retired.length}</summary>
      {retired.map(entry => <BibleRow key={entry.id} entry={entry} sessionId={sessionId} onEdit={setEditing} onHistory={setHistory} />)}
    </details>}
  </>
}
