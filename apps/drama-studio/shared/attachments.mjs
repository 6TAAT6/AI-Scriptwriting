export const IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const IMAGE_MAX_COUNT = 4
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024
const spreadsheetExtensions = ['.xlsx', '.xls', '.xlsm', '.csv']
const documentExtensions = ['.txt', '.md', '.docx', ...spreadsheetExtensions, '.pdf']
const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp']
const hasExtension = (name, extensions) => typeof name === 'string' && extensions.some(extension => name.toLowerCase().endsWith(extension))
export const ATTACHMENT_ACCEPT = [...documentExtensions, ...imageExtensions].join(',')
export const isImageFile = name => hasExtension(name, imageExtensions)
export const isSpreadsheetFile = name => hasExtension(name, spreadsheetExtensions)
export const isDocumentFile = name => hasExtension(name, documentExtensions)
export const isSupportedFile = name => isDocumentFile(name) || isImageFile(name)
