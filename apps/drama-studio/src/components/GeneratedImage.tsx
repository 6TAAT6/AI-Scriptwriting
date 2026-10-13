import { Download, ImageIcon, LoaderCircle } from 'lucide-react'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { gateway } from '../lib/gateway'
import { workspace } from '../store/workspace'

export function GeneratedImage({ path }: { path: string }) {
  const session = useStore(workspace.session)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true, objectUrl = ''
    setUrl(''); setError('')
    void gateway.file(path, session.storedId).then(response => response.blob()).then(blob => {
      if (!active) return
      if (!/^image\/(png|jpeg|webp)/.test(blob.type)) throw new Error('图片文件暂时无法预览。')
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(() => { if (active) setError('图片加载失败，请重新打开这段对话。') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [path, session.storedId])
  return <figure className="generated-image">
    {url ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label="查看生成图片"><img src={url} alt="生成的图片" onError={() => setError('图片文件无法显示。')} /></a> : <div className="generated-image-loading">{error ? <ImageIcon size={20} /> : <LoaderCircle size={20} className="spin" />}{error || '正在载入图片…'}</div>}
    <figcaption><span>生成图片</span>{url && <a href={url} download={path.split('/').pop() || '生成图片.png'}><Download size={14} />下载图片</a>}</figcaption>
  </figure>
}
