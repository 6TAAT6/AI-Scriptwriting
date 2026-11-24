import { BookOpenText, Layers, Sparkles, X } from 'lucide-react'
import type { Capability } from '../lib/capabilities'

interface CapabilityTagProps {
  capability: Capability
  title?: string
  disabled?: boolean
  expanded?: boolean
  removeLabel?: string
  onChoose?: () => void
  onRemove?: () => void
}

const icons = { humanize: Sparkles, 'outline-script': BookOpenText }

export function CapabilityTag({ capability, title, disabled, expanded, removeLabel, onChoose, onRemove }: CapabilityTagProps) {
  const Icon = icons[capability.id as keyof typeof icons] ?? Layers
  const label = <><Icon size={14} aria-hidden="true" /><span>{capability.label}</span>{capability.environment_badge && <small className="capability-environment-badge">{capability.environment_badge}</small>}</>
  return <span className={`capability-token agent-${capability.id}`} title={title || capability.display_name}>
    {onChoose ? <button type="button" className="capability-token-name" disabled={disabled} aria-haspopup="listbox" aria-expanded={expanded}
      aria-label={capability.kind === 'agent' ? `切换剧本 Agent：${capability.display_name}` : `选择技能：${capability.display_name}`} aria-description={capability.environment_badge} onClick={onChoose}>{label}</button>
      : <span className="capability-token-name">{label}</span>}
    {onRemove && <button type="button" className="capability-token-remove" disabled={disabled} aria-label={removeLabel || `停用${capability.display_name}`} onClick={onRemove}><X size={12} /></button>}
  </span>
}
