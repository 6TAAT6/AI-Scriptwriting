export function geminiImageRequest(baseUrl, body) {
  const target = new URL(baseUrl)
  target.pathname = target.pathname.replace(/\/v1\/?$/, '') + '/v1beta/models/' + encodeURIComponent(body.model) + ':generateContent'
  const aspect = { '1536x1024': '3:2', '1024x1536': '2:3', '1024x1024': '1:1' }[body.size] || '1:1'
  return { target, body: { contents: [{ role: 'user', parts: [{ text: body.prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } } } }
}

export function geminiImageData(data) {
  const parts = (data.candidates || []).flatMap(candidate => candidate.content?.parts || [])
  const image = parts.map(part => part.inlineData || part.inline_data).find(part => part && ['image/png', 'image/jpeg', 'image/webp'].includes(part.mimeType || part.mime_type) && typeof part.data === 'string')
  return { data: image ? [{ b64_json: image.data }] : [] }
}
