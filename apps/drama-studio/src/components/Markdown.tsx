import { lazy, Suspense } from 'react'

const MarkdownBody = lazy(() => import('./MarkdownBody'))

export function Markdown({ text, streaming = false, onReadFile, chat = false }: { text: string; streaming?: boolean; onReadFile?: (file: { path: string; name: string }) => void; chat?: boolean }) {
  return <Suspense fallback={<div className="markdown" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>}><MarkdownBody text={text} streaming={streaming} onReadFile={onReadFile} chat={chat} /></Suspense>
}
