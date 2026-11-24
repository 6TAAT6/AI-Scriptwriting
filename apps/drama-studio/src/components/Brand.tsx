import './Brand.css'
// 测试版静态边界不放行单独的图片文件，暗色标识以内联数据随脚本下发。
import markDark from '../assets/jubao-mark-dark.png?inline'
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
    {/* 暗色版标识：深蓝改浅色，只在曜夜暗色下显示（两张图同一时间只显示一张）。 */}
    <img className="studio-brand-mark studio-brand-mark-dark" src={markDark} alt={markOnly ? '巨豹智能体' : ''} />
    {!markOnly && <span className="studio-brand-copy"><strong>巨豹智能体</strong>{showVersion && <small className="studio-brand-version">v{version}</small>}{subtitle && <small>{subtitle}</small>}</span>}
  </span>
}
