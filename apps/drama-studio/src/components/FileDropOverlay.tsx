import { useStore } from '@nanostores/react'
import { FileUp, Info } from 'lucide-react'
import { useEffect, useEffectEvent, useState } from 'react'
import { attachmentBlockReason } from '../lib/attachments'
import { workspace } from '../store/workspace'
import './FileDropOverlay.css'

interface FileDropOverlayProps { disabled?: boolean }

function containsFiles(event: DragEvent) {
  return event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')
}

export function FileDropOverlay({ disabled = false }: FileDropOverlayProps) {
  const draft = useStore(workspace.composer)
  const conversation = useStore(workspace.conversation)
  const navigation = useStore(workspace.navigation)
  const connection = useStore(workspace.connection)
  const preparing = useStore(workspace.preparing)
  const [dragging, setDragging] = useState(false)
  const blocked = disabled ? '请先关闭设置，再添加原稿。' : attachmentBlockReason({
    busy: draft.busy, running: conversation.running, loading: navigation.loading, preparing, connection
  })
  const dragOver = useEffectEvent((event: DragEvent) => {
    if (!containsFiles(event)) return
    event.preventDefault()
    event.dataTransfer!.dropEffect = blocked ? 'none' : 'copy'
    setDragging(true)
  })
  const drop = useEffectEvent((event: DragEvent) => {
    if (!containsFiles(event)) return
    event.preventDefault()
    if (blocked) return
    const transfer = event.dataTransfer!
    const directory = Array.from(transfer.items).some(item => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)
    const files = Array.from(transfer.files)
    if (directory || !files.length) {
      workspace.conversation.set({ ...workspace.conversation.get(), error: directory
        ? '暂不支持拖入文件夹，请选择其中的原稿文件。'
        : '没有读取到文件，请尝试点击上传原稿。' })
      return
    }
    void workspace.attach(files)
  })

  useEffect(() => {
    let depth = 0
    const reset = () => { depth = 0; setDragging(false) }
    const enter = (event: DragEvent) => {
      if (!containsFiles(event)) return
      event.preventDefault()
      depth++
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (!containsFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (event: DragEvent) => dragOver(event)
    const released = (event: DragEvent) => { reset(); drop(event) }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', released)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', released)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])

  if (!dragging) return null
  return <div className={`file-drop-overlay ${blocked ? 'is-blocked' : ''}`} data-file-drop="active" role="status">
    <div className="file-drop-card">
      <span className="file-drop-icon">{blocked ? <Info size={28} /> : <FileUp size={30} />}</span>
      <strong>{blocked || '松开鼠标，添加文档或图片'}</strong>
      {!blocked && <><span>文档每个不超过 20 MB；图片每张不超过 4 MB，每条消息最多 4 张</span><small>TXT · MD · DOCX · XLSX · CSV · PDF · PNG · JPG · WebP</small><span>添加为附件后，点击发送再开始处理</span></>}
    </div>
  </div>
}
