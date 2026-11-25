import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PENGBAO_PRODUCT } from './config'

export interface NativeVideoLease { capabilityToken: string; revoke(): void }
export interface NativeVideoScope { capabilityToken?: string; models: readonly string[] }
export type VideoCatalogRow = { id: string; name: string; provider: string; protocol: string; default?: boolean }
const MAX_BODY = 16 * 1024 * 1024
const MAX_JSON = 256 * 1024
const MAX_VIDEO = 512 * 1024 * 1024
const MODEL = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]|:\/\//.test(id)
const forbidden = new Set(['endpoint', 'url', 'base_url', 'baseUrl', 'apiUrl', 'apiKey', 'api_key', 'headers', 'authorization', 'provider'])

class VideoFailure extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}
function respond(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function read(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader()
  if (!reader) throw new VideoFailure(502, 'VIDEO_RESPONSE')
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const part = await abortable(reader.read(), signal)
      signal.throwIfAborted()
      if (part.done) break
      total += part.value.byteLength
      if (total > limit) throw new VideoFailure(413, 'VIDEO_TOO_LARGE')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function createNativeVideoGateway(options: { getJwt(): string; fetch: typeof fetch; maxConcurrent?: number }) {
  type Lease = { credential: Buffer; models: Set<string>; active: Set<AbortController>; revoked: boolean }
  const leases = new Set<Lease>()
  let stopped = false
  let count = 0
  const revoke = (lease: Lease) => {
    lease.revoked = true; lease.credential.fill(0); leases.delete(lease)
    for (const controller of lease.active) controller.abort(new VideoFailure(401, 'VIDEO_REVOKED'))
  }
  const upstream = async (path: string, signal: AbortSignal, body?: unknown) => {
    const operation = options.fetch(PENGBAO_PRODUCT.serverUrl + path, { method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', signal, credentials: 'omit', headers: { Authorization: `Bearer ${options.getJwt()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    void operation.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}) }, () => {})
    const response = await abortable(operation, signal)
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {})
      throw new VideoFailure(response.status === 401 ? 401 : response.status === 403 ? 403 : response.status === 429 ? 429 : response.status === 404 ? 503 : 502,
        response.status === 404 ? 'VIDEO_ROUTE_UNAVAILABLE' : 'VIDEO_UPSTREAM_FAILED')
    }
    return response
  }
  const json = async (path: string, signal: AbortSignal, body?: unknown): Promise<any> => {
    const response = await upstream(path, signal, body)
    if (!response.headers.get('content-type')?.includes('application/json')) throw new VideoFailure(502, 'VIDEO_RESPONSE')
    return JSON.parse((await read(response, MAX_JSON, signal)).toString('utf8'))
  }
  const models = async (signal: AbortSignal): Promise<VideoCatalogRow[]> => {
    const payload = await json('/api/v1/videos/proxy/models', signal)
    if (!Array.isArray(payload?.data) || payload.data.length > 512) throw new VideoFailure(502, 'VIDEO_RESPONSE')
    const rows: VideoCatalogRow[] = payload.data.map((row: any) => {
      if (!MODEL(row?.id) || !MODEL(row?.name) || !['volcengine', 'alibaba', 'openai'].includes(row?.provider) || !['ark', 'dashscope', 'openai', 'newapi'].includes(row?.protocol)) throw new VideoFailure(502, 'VIDEO_RESPONSE')
      return { id: row.id as string, name: row.name as string, provider: row.provider as string, protocol: row.protocol as string }
    })
    const selected = MODEL(payload.default_model) && rows.some(row => row.id === payload.default_model) ? payload.default_model : ''
    return rows.map((row: VideoCatalogRow) => selected !== '' && row.id === selected ? { ...row, default: true } : row)
  }
  return {
    createLease(scope: NativeVideoScope): NativeVideoLease {
      if (stopped || scope.models.length > 256 || scope.models.some(id => !MODEL(id))) throw new Error('Invalid video scope')
      const token = scope.capabilityToken ?? randomBytes(32).toString('base64url')
      const lease: Lease = { credential: Buffer.from(`Bearer ${token}`), models: new Set(scope.models), active: new Set(), revoked: false }
      leases.add(lease)
      return { capabilityToken: token, revoke: () => revoke(lease) }
    },
    models,
    async handle(req: IncomingMessage, res: ServerResponse) {
      const token = Buffer.from(req.headers.authorization ?? '')
      const lease = [...leases].find(lease => token.length === lease.credential.length && timingSafeEqual(token, lease.credential))
      if (!lease || stopped) return respond(res, 401, { error: { code: 'VIDEO_AUTH', message: 'Video access is not granted.' } })
      if (count >= (options.maxConcurrent ?? 2)) return respond(res, 429, { error: { code: 'VIDEO_BUSY' } })
      let path = req.url ?? ''
      const ark = path.startsWith('/v1/contents/generations/tasks')
      const isSubmit = req.method === 'POST' && ['/v1/videos', '/v1/contents/generations/tasks'].includes(path)
      const match = /^\/v1\/(?:videos|contents\/generations\/tasks)\/([a-f0-9]{32})(?:\/(content|cancel))?$/.exec(path)
      const id = match?.[1], action = match?.[2]
      const isStatus = req.method === 'GET' && !!id && !action
      const isContent = req.method === 'GET' && !!id && action === 'content'
      const isCancel = (req.method === 'POST' && action === 'cancel') || (req.method === 'DELETE' && !!id && !action)
      if (!isSubmit && !isStatus && !isContent && !isCancel) return respond(res, 404, { error: { code: 'VIDEO_INVALID_REQUEST' } })
      const controller = new AbortController()
      const signal = controller.signal
      lease.active.add(controller); count++
      const timer = setTimeout(() => controller.abort(new VideoFailure(504, 'VIDEO_TIMEOUT')), isContent ? 300000 : 30000)
      const close = () => { if (!res.writableFinished) controller.abort() }
      req.once('aborted', close); res.once('close', close)
      try {
        if (isSubmit) {
          if (req.headers['content-encoding'] || !req.headers['content-type']?.startsWith('application/json')) throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
          const input = new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = []
            let size = 0
            const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); signal.removeEventListener('abort', abort) }
            const error = (cause: Error) => { cleanup(); reject(cause) }
            const abort = () => { cleanup(); req.pause(); reject(signal.reason) }
            const data = (part: Buffer) => {
              size += part.length
              if (size > MAX_BODY) { req.pause(); error(new VideoFailure(413, 'VIDEO_TOO_LARGE')); return }
              chunks.push(part)
            }
            const end = () => { cleanup(); resolve(Buffer.concat(chunks)) }
            req.on('data', data); req.once('end', end); req.once('error', error); signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
          const body = JSON.parse((await input).toString('utf8'))
          if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => forbidden.has(key))) throw new VideoFailure(400, 'VIDEO_INVALID_REQUEST')
          if (!lease.models.has(body.model)) throw new VideoFailure(403, 'VIDEO_MODEL_UNAVAILABLE')
          if (!(await models(signal)).some(row => row.id === body.model)) throw new VideoFailure(403, 'VIDEO_MODEL_UNAVAILABLE')
          const value = await json(`/api/v1/videos/proxy/submit/${ark ? 'ark' : 'openai'}`, signal, body)
          if (typeof value?.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id)) throw new VideoFailure(502, 'VIDEO_RESPONSE')
          return respond(res, 200, { id: value.id, task_id: value.id, status: 'queued' })
        }
        const task = await json(`/api/v1/videos/proxy/tasks/${id}`, signal)
        if (!lease.models.has(task?.model)) throw new VideoFailure(403, 'VIDEO_MODEL_UNAVAILABLE')
        if (isCancel) {
          const value = await json(`/api/v1/videos/proxy/tasks/${id}/cancel`, signal, {})
          return respond(res, 200, { id, task_id: id, status: 'cancelled', upstream_may_continue: value?.upstream_may_continue !== false })
        }
        if (isStatus) {
          const value = task
          const statuses = ['queued', 'in_progress', 'completed', 'failed', 'cancelled', 'expired']
          if (!statuses.includes(value?.status)) throw new VideoFailure(502, 'VIDEO_RESPONSE')
          return respond(res, 200, { id, task_id: id, status: value.status,
            ...(value.status === 'completed' ? { url: `/v1/${ark ? 'contents/generations/tasks' : 'videos'}/${id}/content` } : {}),
            ...(value.status === 'failed' ? { error: { message: 'Video generation failed.' } } : {}) })
        }
        const response = await upstream(`/api/v1/videos/proxy/tasks/${id}/content`, signal)
        if (!response.headers.get('content-type')?.startsWith('video/')) throw new VideoFailure(502, 'VIDEO_RESPONSE')
        const reader = response.body?.getReader()
        if (!reader) throw new VideoFailure(502, 'VIDEO_RESPONSE')
        res.writeHead(200, { 'content-type': response.headers.get('content-type')!, 'cache-control': 'no-store' })
        let size = 0
        try {
          while (true) {
            const chunk = await abortable(reader.read(), signal); signal.throwIfAborted()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > MAX_VIDEO) throw new VideoFailure(413, 'VIDEO_TOO_LARGE')
            if (!res.write(chunk.value)) await new Promise<void>((resolve, reject) => {
              const abort = () => { cleanup(); reject(new Error('cancelled')) }
              const drain = () => { cleanup(); resolve() }
              const cleanup = () => { res.off('drain', drain); signal.removeEventListener('abort', abort) }
              res.once('drain', drain); signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
            })
          }
          res.end()
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      } catch (error) {
        if (signal.aborted) error = signal.reason
        if (res.headersSent) res.destroy()
        else respond(res, error instanceof VideoFailure ? error.status : 502,
          { error: { code: error instanceof VideoFailure ? error.code : 'VIDEO_RESPONSE',
            message: error instanceof VideoFailure && error.code === 'VIDEO_ROUTE_UNAVAILABLE' ? 'Pengbao video service route is unavailable.' : 'Video request failed; the provider may still complete and charge for the task. No generation is retried automatically.' } })
      } finally {
        clearTimeout(timer); req.off('aborted', close); res.off('close', close); lease.active.delete(controller); count--
      }
    },
    stop() { stopped = true; for (const lease of leases) revoke(lease) }
  }
}
