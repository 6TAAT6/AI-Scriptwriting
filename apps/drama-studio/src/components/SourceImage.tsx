import { useStore } from '@nanostores/react'
import { ImageIcon, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { gateway } from '../lib/gateway'
import { workspace } from '../store/workspace'
import './SourceImage.css'

interface SourceImageProps { path: string; name: string; compact?: boolean }

export function SourceImage({ path, name, compact = false }: SourceImageProps) {
  const session = useStore(workspace.session)
  const [url, setUrl] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true, objectUrl = ''
    setUrl(''); setError(false)
    void gateway.file(path, session.storedId).then(response => response.blob()).then(blob => {
      if (!active) return
      if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) throw new Error('图片格式无法预览')
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [path, session.storedId])
  return <span className={`source-image ${compact ? 'is-compact' : ''}`}>
    {url && !error ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看图片 ${name}`}><img src={url} alt={name} onError={() => setError(true)} /></a> :
      <span role="status" title={error ? '图片预览失败，请重新添加。' : '正在载入图片'}>{error ? <ImageIcon size={18} /> : <LoaderCircle size={18} className="spin" />}{!compact && (error ? '图片预览失败，请重新添加。' : '正在载入图片…')}</span>}
  </span>
}
