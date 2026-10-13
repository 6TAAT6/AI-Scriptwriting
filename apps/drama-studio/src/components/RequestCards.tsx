import { useStore } from '@nanostores/react'
import { Check, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { ServerRequest } from '../../../shared/src/json-rpc-channel'
import type { ApprovalRequestParams, ClarifyRequestParams } from '../../../shared/src/gateway-contract.generated'
import { workspace } from '../store/workspace'
import { Markdown } from './Markdown'

function ApprovalCard({ request }: { request: ServerRequest }) {
  const params = request.params as unknown as ApprovalRequestParams
  const canConfirm = !params.choices?.length || params.choices.includes('once')
  return <section className="request-card" aria-label="创作确认">
    <div className="request-heading"><ShieldCheck size={18} /><strong>这一步需要你的确认</strong></div>
    <div className="request-description" tabIndex={0} aria-label="完整确认内容"><Markdown text={params.description || '确认本次操作后，AI 将继续推进创作。'} /></div>
    {canConfirm && <p className="request-manual-confirm">请仔细阅读以上内容，确认后才会继续执行。</p>}
    <div className="request-actions"><button className="secondary-button" onClick={() => workspace.answer(request, { choice: 'deny' })}>暂不执行</button>
      <button className="primary-button" disabled={!canConfirm} onClick={() => workspace.answer(request, { choice: 'once' })}><Check size={14} />确认本次操作</button></div>
  </section>
}

function ClarifyCard({ request }: { request: ServerRequest }) {
  const params = request.params as unknown as ClarifyRequestParams
  const [answers, setAnswers] = useState<Record<string, string | null>>({})
  const selectedChoices = (qid: string) => {
    const raw = answers[qid]
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
    } catch { return [] }
  }
  const setAnswer = (qid: string, value: string | null) => setAnswers(current => ({ ...current, [qid]: value }))
  const toggleChoice = (qid: string, choice: string, multi: boolean) => {
    if (!multi) { setAnswer(qid, choice); return }
    const selected = selectedChoices(qid)
    const next = selected.includes(choice) ? selected.filter(value => value !== choice) : [...selected, choice]
    setAnswers(current => {
      const result = { ...current }
      if (next.length) result[qid] = JSON.stringify(next)
      else delete result[qid]
      return result
    })
  }
  const answered = (qid: string) => Object.prototype.hasOwnProperty.call(answers, qid) && (answers[qid] === null || Boolean(answers[qid]?.trim()))
  return <form className="request-card" aria-label="创作问题" onSubmit={event => { event.preventDefault(); workspace.answer(request, { answers }) }}>
    <div className="request-heading"><ShieldCheck size={18} /><strong>确认你的创作方向</strong></div>
    {params.questions.map(question => <fieldset key={question.qid}><legend>{question.question}</legend>
      <div className="choice-list">{question.choices?.map(choice => {
        const selected = question.multi_select ? selectedChoices(question.qid).includes(choice) : answers[question.qid] === choice
        return <button type="button" key={choice} className={selected ? 'choice selected' : 'choice'} aria-pressed={selected} aria-selected={selected}
          onClick={() => toggleChoice(question.qid, choice, Boolean(question.multi_select))}>{choice}</button>
      })}</div>
      <input aria-label={question.question} placeholder={question.multi_select ? '也可以填写自己的想法，或选择多个选项' : '也可以填写自己的想法'}
        value={question.multi_select && answers[question.qid]?.startsWith('[') ? '' : answers[question.qid] ?? ''}
        onChange={event => setAnswer(question.qid, event.target.value)} />
      <button type="button" className="text-button clarify-skip" aria-pressed={answers[question.qid] === null} onClick={() => setAnswer(question.qid, null)}>跳过本题</button>
    </fieldset>)}
    <div className="request-actions"><button type="button" className="secondary-button" onClick={() => workspace.answer(request, {})}>取消本次确认</button>
      <button type="submit" className="primary-button" disabled={params.questions.some(question => !answered(question.qid))}>确认并继续</button></div>
  </form>
}

export function RequestCards() {
  const requests = useStore(workspace.requests)
  const session = useStore(workspace.session)
  return <div className="request-list">{requests.filter(request => request.params.session_id === session.runtimeId).map(request =>
    request.method === 'approval' ? <ApprovalCard key={request.id} request={request} /> : <ClarifyCard key={request.id} request={request} />)}</div>
}
