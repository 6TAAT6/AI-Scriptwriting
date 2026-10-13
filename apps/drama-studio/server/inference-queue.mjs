const queueError = (status, code) => Object.assign(new Error(code), { status, code })

/** 每账号共享的先进先出执行名额，等待不会增加供应商并发。 */
export class InferenceQueue {
  constructor(limit = 10, capacity = 40, waitMs = 120_000) {
    this.limit = limit; this.capacity = capacity; this.waitMs = waitMs
    this.active = 0; this.waiters = []
  }
  async acquire(signal) {
    if (signal.aborted) throw queueError(409, 'request_cancelled')
    if (this.active < this.limit && !this.waiters.length) return this.reserve()
    if (this.waiters.length >= this.capacity) throw queueError(429, 'queue_full')
    return new Promise((resolve, reject) => {
      const waiter = { signal, grant: () => { cleanup(); resolve(this.reserve()) } }
      const cancel = error => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return
        this.waiters.splice(index, 1); cleanup(); reject(error)
      }
      const aborted = () => cancel(queueError(409, 'request_cancelled'))
      const timer = setTimeout(() => cancel(queueError(503, 'queue_timeout')), this.waitMs)
      timer.unref()
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted) }
      signal.addEventListener('abort', aborted, { once: true })
      this.waiters.push(waiter)
    })
  }
  reserve() {
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true; this.active--
      while (this.active < this.limit && this.waiters.length) this.waiters.shift().grant()
    }
  }
}
