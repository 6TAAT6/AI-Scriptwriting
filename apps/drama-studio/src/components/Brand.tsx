import './Brand.css'
import { version } from '../../package.json'

interface BrandProps {
  className?: string
  markOnly?: boolean
  subtitle?: string
  showVersion?: boolean
}

export function Brand({ className = '', markOnly = false, subtitle, showVersion = false }: BrandProps) {
  return <span className={`studio-brand ${markOnly ? 'studio-brand-mark-only' : ''} ${className}`}>
    <img className="studio-brand-mark" src="/jubao-mark.png" alt={markOnly ? '巨豹智能体' : ''} />
    {!markOnly && <span className="studio-brand-copy"><strong>巨豹智能体</strong>{showVersion && <small className="studio-brand-version">v{version}</small>}{subtitle && <small>{subtitle}</small>}</span>}
  </span>
}
