import { FileSpreadsheet, FileText } from 'lucide-react'
import { isSpreadsheetFile } from '../../shared/attachments.mjs'
import './AttachmentLabel.css'

const FILE_KINDS: Record<string, string> = { docx: 'word', pdf: 'pdf' }

export function AttachmentLabel({ name }: { name: string }) {
  const kind = isSpreadsheetFile(name) ? 'spreadsheet' : FILE_KINDS[name.split('.').pop()?.toLowerCase() || ''] || 'text'
  const Icon = kind === 'spreadsheet' ? FileSpreadsheet : FileText
  return <span className={`attachment-label file-${kind}`} title={name}>
    <Icon size={15} aria-hidden="true" /><span>{name}</span>
  </span>
}
