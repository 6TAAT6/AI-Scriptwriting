import { expect, test } from 'vitest'
import { attachedFiles, attachedImages } from './attachments'

test('同一次上传在消息正文与附件展开中各出现一次时只算一份', () => {
  const path = '/state/attachments/被赶出门的小福星_61集中英双语剧本(1).docx'
  const text = `完整改变\n\n@file:\`${path}\`\n\n--- Attached Context ---\n\n📎 @file:\`${path}\` (application/vnd.openxmlformats-officedocument.wordprocessingml.document, 149.1 KB)`
  expect(attachedFiles(text)).toEqual([{ path, name: '被赶出门的小福星_61集中英双语剧本(1).docx' }])
  const image = '/state/attachments/截图.png'
  expect(attachedImages(`@file:\`${image}\`\n📎 @file:\`${image}\``)).toHaveLength(1)
  // 真正上传的两份不同文件仍各自显示。
  expect(attachedFiles(`@file:\`/a/原稿.docx\` @file:\`/a/原稿-2.docx\``)).toHaveLength(2)
})
