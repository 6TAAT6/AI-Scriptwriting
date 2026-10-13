import { ArrowUpRight, PencilLine } from 'lucide-react'
import { useId } from 'react'
import type { NextStepSuggestion } from '../lib/suggestions'
import './NextStepSuggestions.css'

interface NextStepSuggestionsProps {
  suggestions: NextStepSuggestion[]
  disabled?: boolean
  hasDraft?: boolean
  onSend: (suggestion: NextStepSuggestion) => void
  onEdit: (suggestion: NextStepSuggestion) => void
}

export function NextStepSuggestions({ suggestions, disabled = false, hasDraft = false, onSend, onEdit }: NextStepSuggestionsProps) {
  const headingId = useId()
  const draftHintId = useId()
  if (!suggestions.length) return null

  return <section className="next-step-suggestions" aria-labelledby={headingId}>
    <h3 id={headingId}>接下来，你可以</h3>
    {hasDraft && <p id={draftHintId} className="next-step-draft-hint" role="status">输入框里已有草稿，可先填入编辑，整理后再发送。</p>}
    <ul className={`next-step-list next-step-columns-${Math.min(3, suggestions.length)}`}>
      {suggestions.map(suggestion => <li className="next-step-card" key={`${suggestion.label}:${suggestion.prompt}`}>
        <strong className="next-step-label">{suggestion.label}{suggestion.recommended && <span className="next-step-recommended">推荐</span>}</strong>
        <p className="next-step-prompt" title={suggestion.prompt}>{suggestion.prompt}</p>
        <div className="next-step-actions">
          <button className="next-step-send" type="button" disabled={disabled || hasDraft}
            aria-label={`直接发送：${suggestion.label}`} aria-describedby={hasDraft ? draftHintId : undefined}
            onClick={() => onSend(suggestion)}>
            直接发送<ArrowUpRight size={13} aria-hidden="true" />
          </button>
          <button className="next-step-edit" type="button" disabled={disabled} aria-label={`填入编辑：${suggestion.label}`}
            onClick={() => onEdit(suggestion)}>
            <PencilLine size={12} aria-hidden="true" />填入编辑
          </button>
        </div>
      </li>)}
    </ul>
  </section>
}
