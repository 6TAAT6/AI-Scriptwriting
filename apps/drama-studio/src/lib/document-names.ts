/** Word 下载名去掉扩展名与“_第N版”版本号，得到稿件名，用于把导出文件对应回稿件。 */
export function documentStem(name: string): string {
  return name.replace(/\.docx$/i, '').replace(/_第\d+版$/, '')
}

/** 从 Word 下载名读出版本号；没有版本号时返回 undefined。 */
export function documentVersion(name?: string): number | undefined {
  const match = /_第(\d+)版(?:\.docx)?$/i.exec(name ?? '')
  return match ? Number(match[1]) : undefined
}
