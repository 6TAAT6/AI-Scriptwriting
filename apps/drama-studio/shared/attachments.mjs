export const IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const IMAGE_MAX_COUNT = 4
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024
export const ATTACHMENT_ACCEPT = '.txt,.md,.docx,.xlsx,.csv,.pdf,.png,.jpg,.jpeg,.webp'
export const isImageFile = name => /\.(png|jpe?g|webp)$/i.test(name)
export const isSupportedFile = name => /\.(txt|md|docx|xlsx|csv|pdf|png|jpe?g|webp)$/i.test(name)
