import type { Entry } from '../lib/transcript'
import { AttachmentLabel } from './AttachmentLabel'
import { FileDownloadLink } from './FileDownloadLink'
import { SourceImage } from './SourceImage'
import { CapabilityTag } from './CapabilityTag'
import { splitCapabilityDraft } from '../lib/capabilities'

export function UserMessageContent({ entry }: { entry: Entry }) {
  const legacy = splitCapabilityDraft(entry.text)
  const selected = (entry.capabilityCommands ?? legacy.commands).filter(row => row.action !== '停用').map(row => row.capability)
  return <>
    {selected.length > 0 && <div className="message-capabilities" role="group" aria-label="本条消息使用的创作能力">{selected.map(capability =>
      <CapabilityTag key={capability.id} capability={capability} />)}</div>}
    {legacy.body && <div className="user-message-text">{legacy.body}</div>}
    {Boolean(entry.attachments?.length) && <div className="message-attachments" role="group" aria-label="消息附件">
      {entry.attachments!.map((file, index) => <FileDownloadLink key={`${file.path}-${index}`} path={file.path} title={`下载附件 ${file.name}`}>
        <AttachmentLabel name={file.name} />
      </FileDownloadLink>)}
    </div>}
    {Boolean(entry.images?.length) && <div className="user-images">{entry.images!.map(image => <SourceImage key={image.path} {...image} />)}</div>}
  </>
}
