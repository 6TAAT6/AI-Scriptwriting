import { once } from 'node:events'

/** 直接消费 Web 流，避免中转 Readable 在取消后留下无人消费的 error 事件。 */
export async function forwardBody(body, response) {
  const reader = body.getReader(), controller = new AbortController()
  const cancel = () => {
    controller.abort()
    void reader.cancel().catch(() => {})
  }
  response.once('close', cancel)
  response.once('error', cancel)
  try {
    while (!response.destroyed) {
      const { done, value } = await reader.read()
      if (done) { if (!response.destroyed) response.end(); return }
      if (!response.write(value)) await once(response, 'drain', { signal: controller.signal })
    }
  } finally {
    response.off('close', cancel)
    response.off('error', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
