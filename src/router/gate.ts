// per-identity cap on upstream hops. a saturated uplink fails every in-flight
// upload at once, and each failure retries — uncapped, the retries are the load.
export const LIMIT = 2
export const QUEUE = 4
export const WAIT = 15_000

export interface Gate {
  acquire: (id: string, signal: AbortSignal) => Promise<(() => void) | null>
}

interface Waiter {
  grant: () => void
}

export const create = ({ limit = LIMIT, queue = QUEUE, wait = WAIT }: { limit?: number; queue?: number; wait?: number } = {}): Gate => {
  const inflight = new Map<string, number>()
  const waiting = new Map<string, Waiter[]>()

  const release = (id: string): void => {
    const q = waiting.get(id)
    const next = q?.shift()
    if (q && !q.length) waiting.delete(id)
    if (next) {
      next.grant() // slot transfers; the count stays at the cap
      return
    }
    const n = (inflight.get(id) ?? 1) - 1
    if (n <= 0) inflight.delete(id)
    else inflight.set(id, n)
  }

  const acquire = (id: string, signal: AbortSignal): Promise<(() => void) | null> => {
    if (signal.aborted) return Promise.resolve(null)
    const n = inflight.get(id) ?? 0
    if (n < limit) {
      inflight.set(id, n + 1)
      return Promise.resolve(() => release(id))
    }
    const q = waiting.get(id) ?? []
    if (q.length >= queue) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      const finish = (fn: (() => void) | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(fn)
      }
      const waiter: Waiter = { grant: () => finish(() => release(id)) }
      const drop = (): void => {
        const i = q.indexOf(waiter)
        if (i >= 0) q.splice(i, 1)
        if (!q.length) waiting.delete(id)
        finish(null)
      }
      const onAbort = (): void => drop()
      const timer = setTimeout(drop, wait)
      q.push(waiter)
      waiting.set(id, q)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return { acquire }
}
