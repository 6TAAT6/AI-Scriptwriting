import { expect, test } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readOfficeText } from './office-preview'

test('真实 Office 字节保留剧本段落与大纲单元格换行', () => {
  const docx = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第03集</w:t></w:r></w:p><w:p><w:r><w:t>3-1场  接待室  日  内</w:t></w:r></w:p><w:p><w:r><w:t>人物：人物甲、人物乙</w:t><w:br/><w:t>△人物甲坐下。</w:t></w:r></w:p></w:body></w:document>') })
  expect(readOfficeText(docx, 'docx')).toBe('第03集\n\n3-1场  接待室  日  内\n\n人物：人物甲、人物乙\n△人物甲坐下。')
  const xlsx = zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="分集大纲" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="inlineStr"><is><t>集数</t></is></c><c r="B1" t="inlineStr"><is><t>新纲</t></is></c></row><row><c r="A2"><v>3</v></c><c r="B2" t="inlineStr"><is><t>发现线索\n主动追查</t></is></c></row></sheetData></worksheet>')
  })
  expect(readOfficeText(xlsx, 'xlsx')).toContain('新纲：发现线索\n主动追查')
})

test('不展开超量压缩包或 XML 实体，也不将损坏文件冒充可读全文', () => {
  expect(() => readOfficeText(new Uint8Array([1, 2, 3]), 'docx')).toThrow()
  const xml = '<!DOCTYPE x [<!ENTITY hidden SYSTEM "file:///private">]><x>&hidden;</x>'
  expect(() => readOfficeText(zipSync({'word/document.xml': strToU8(xml)}), 'docx')).toThrow(/XML/)
  const oversized = zipSync({'word/document.xml': new Uint8Array(61 * 1024 * 1024)}, {level: 1})
  expect(() => readOfficeText(oversized, 'docx')).toThrow(/过大/)
})
