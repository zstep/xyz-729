import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { PENGBAO_PRODUCT } from './config'
import { type ModelServiceCapability } from '../../shared/model-service'
import { createImageGateway, IMAGE_GATEWAY_TIMEOUT_MS, type PengbaoImageLease, type PengbaoImageFailure } from './image-gateway'
import { createNativeVideoGateway, type NativeVideoLease, type VideoCatalogRow } from './native-video-gateway'
import { createPluginConfigurationGateway, type PluginConfigurationLease } from './plugin-configuration-gateway'
import { clientAccessConfigured, entryClientAccess, type ClientAccess, type ClientSurface } from './client-access'
export type { PluginConfigurationLease, PluginConfigurationPolicy } from './plugin-configuration-gateway'

const TOP_LEVEL = ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'response_format', 'reasoning_effort'] as const
const FORBIDDEN = new Set(['chat_id', 'id', 'session_id', 'parent_id', 'tool_ids', 'metadata', 'files', 'filter_ids', 'function_call', 'functions'])

export interface PengbaoGatewayFailure {
  requestId: string
  kind: 'upstream-http' | 'upstream-response' | 'transport' | 'timeout' | 'cancelled' | 'request-size'
  upstreamRoute?: 'config' | 'models' | 'image-metadata'
  upstreamStatus?: number
  elapsedMs: number
  phase: 'request' | 'headers' | 'body'
  bytesReceived: number
  upstreamHeadersMs?: number
  firstByteMs?: number
  lastByteMs?: number
  abortReason?: 'deadline' | 'downstream' | 'revoked'
  timeoutStage?: 'preflight' | 'upstream-idle' | 'chat-total' | 'downstream-blocked'
  requestBytes?: number
  maxBodyBytes?: number
  sizeSource?: 'declared' | 'received'
  transportCode?: 'UND_ERR_SOCKET' | 'UND_ERR_CONNECT_TIMEOUT' | 'UND_ERR_HEADERS_TIMEOUT' | 'UND_ERR_BODY_TIMEOUT' | 'ECONNRESET' | 'ECONNREFUSED' | 'EPIPE' | 'ENOTFOUND' | 'EAI_AGAIN'
}

/** A locally denied plugin model, reported with a fixed vocabulary and model IDs only. */
export interface PengbaoModelDenial {
  kind: 'model-denial'
  requestId: string
  route: 'chat' | 'models'
  model: string
  reason: 'not-granted' | 'not-in-catalog' | 'image-classified'
}

function transportCode(error: unknown): PengbaoGatewayFailure['transportCode'] {
  if (!error || typeof error !== 'object') return undefined
  const cause = 'cause' in error ? error.cause : undefined
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : 'code' in error ? error.code : undefined
  switch (code) {
    case 'UND_ERR_SOCKET': case 'UND_ERR_CONNECT_TIMEOUT': case 'UND_ERR_HEADERS_TIMEOUT': case 'UND_ERR_BODY_TIMEOUT':
    case 'ECONNRESET': case 'ECONNREFUSED': case 'EPIPE': case 'ENOTFOUND': case 'EAI_AGAIN': return code
    default: return undefined
  }
}

export interface PengbaoGatewayOptions {
  jwt: string
  fetch?: typeof fetch
  maxBodyBytes?: number
  /**
   * Chat inference bodies carry the whole conversation (tool output included), so
   * they outgrow the metadata cap by orders of magnitude on long sessions. Kept
   * separate so `/v1/models` and config reads stay tightly bounded.
   */
  maxChatBodyBytes?: number
  maxConcurrent?: number
  /** Request ingestion/preflight and metadata deadline; not a chat response deadline. */
  timeoutMs?: number
  chatIdleTimeoutMs?: number
  chatMaxDurationMs?: number
  imageTimeoutMs?: number
  imageMaxConcurrent?: number
  onFailure?: (failure: PengbaoGatewayFailure) => void
  onImageFailure?: (failure: PengbaoImageFailure) => void
  onModelDenial?: (denial: PengbaoModelDenial) => void
}

export interface PengbaoGateway {
  url: string
  port: number
  /** Legacy account-level chat credential; migrate consumers to runtime grants. */
  capabilityToken: string
  /** Issue a private capability limited to the requested model-service scopes. */
  createModelServiceGrant: (capabilities: readonly ModelServiceCapability[]) => PengbaoModelServiceGrant
  /** Issue a runtime-scoped image-generation lease. */
  createImageLease: () => PengbaoImageLease
  createVideoLease: (models: readonly string[]) => NativeVideoLease
  videoModels: (signal?: AbortSignal) => Promise<VideoCatalogRow[]>
  /** Bootstrap-only broker. Child tokens authorize only approved plugin routes/models. */
  createPluginConfigurationLease: () => PluginConfigurationLease
  /** Publish one already-authorized local HTML artifact through the account API. */
  publishHtml: (html: string) => Promise<{ url: string; expires_at: number | null }>
  stop: () => Promise<void>
}

export interface PengbaoModelServiceGrant {
  contractVersion: 1
  gatewayUrl: string
  capabilityToken: string
  capabilities: readonly ModelServiceCapability[]
  revoke: () => void
}

class RequestFailure extends Error {
  constructor(readonly status: number, readonly upstreamStatus?: number) { super('Gateway request failed') }
}

class BodySizeFailure extends RequestFailure {
  constructor(readonly requestBytes: number, readonly sizeSource: 'declared' | 'received') { super(413) }
}

function displayText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
}

function modelEntryId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('id' in entry) || !displayText(entry.id)) return undefined
  return entry.id
}

function catalogModels(value: unknown): Map<string, { alias?: string; name?: string }> {
  if (!Array.isArray(value)) throw new RequestFailure(502)
  const models = new Map<string, { alias?: string; name?: string }>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !('id' in item) || !displayText(item.id)) continue
    const metadata: { alias?: string; name?: string } = {}
    if ('alias' in item && displayText(item.alias)) metadata.alias = item.alias
    if ('name' in item && displayText(item.name)) metadata.name = item.name
    models.set(item.id, metadata)
  }
  return models
}

function modelDisplayName(id: string, metadata: { alias?: string; name?: string } | undefined): string {
  return metadata?.alias ?? metadata?.name ?? id
}

function projectImageDefaultMetadata(
  value: Record<string, unknown>,
  rows: unknown[]
): unknown[] {
  const defaultModel = value.defaultModel
  if (!defaultModel || typeof defaultModel !== 'object' || Array.isArray(defaultModel)) return rows
  const defaultRecord = defaultModel as Record<string, unknown>
  if (typeof defaultRecord.id !== 'string' || !displayText(defaultRecord.id)) return rows
  const defaultId = defaultRecord.id
  const imageIds = new Set<string>()
  if (Array.isArray(value.models)) {
    for (const item of value.models) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>
        if (typeof record.id === 'string' && displayText(record.id)) imageIds.add(record.id)
      }
    }
  }
  if (!imageIds.has(defaultId)) return rows
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const model = row as Record<string, unknown>
    if (model.id !== defaultId) return row
    const info = model.info && typeof model.info === 'object' && !Array.isArray(model.info) ? model.info as Record<string, unknown> : {}
    const meta = info.meta && typeof info.meta === 'object' && !Array.isArray(info.meta) ? info.meta as Record<string, unknown> : {}
    if (typeof meta.imageModelId === 'string' && meta.imageModelId.trim()) return row
    return { ...model, info: { ...info, meta: { ...meta, imageModelId: defaultId } } }
  })
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason instanceof RequestFailure ? signal.reason : new RequestFailure(504))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

function fail(res: ServerResponse, status: number, upstreamStatus?: number): void {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close' })
  const message = upstreamStatus === 504 ? 'Pengbao model service timed out before responding. Try again later or select another model.' :
    upstreamStatus === 429 ? 'Pengbao model service is rate limited. Try again later.' :
      upstreamStatus === undefined ? 'Gateway request failed' : `Pengbao model service returned HTTP ${upstreamStatus}`
  res.end(JSON.stringify({ error: { message, type: upstreamStatus === undefined ? 'gateway_error' : 'upstream_error',
    ...(upstreamStatus === undefined ? {} : { upstream_status: upstreamStatus }) } }))
}

async function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      req.off('data', data)
      req.off('end', end)
      req.off('error', error)
      signal.removeEventListener('abort', abort)
    }
    const error = (reason: unknown) => { cleanup(); reject(reason) }
    const abort = () => error(signal.reason instanceof RequestFailure ? signal.reason : new RequestFailure(504))
    const data = (part: Buffer) => {
      size += part.length
      if (size > limit) { req.pause(); error(new BodySizeFailure(size, 'received')); return }
      chunks.push(part)
    }
    const end = () => {
      cleanup()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
      catch { reject(new RequestFailure(400)) }
    }
    req.on('data', data)
    req.once('end', end)
    req.once('error', error)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function chatBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestFailure(400)
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => FORBIDDEN.has(key))) throw new RequestFailure(400)
  if (typeof input.model !== 'string' || !input.model.trim() || !Array.isArray(input.messages)) throw new RequestFailure(400)
  if (input.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))) throw new RequestFailure(400)
  if ('tools' in input && !Array.isArray(input.tools)) throw new RequestFailure(400)
  const output: Record<string, unknown> = { tools: [] }
  // Only inference fields cross the boundary. Message-level tool IDs stay intact.
  for (const key of TOP_LEVEL) if (Object.hasOwn(input, key)) output[key] = input[key]
  // `features` is otherwise an open-webui control plane the gateway strips. The one
  // exception is memory: plugin chat always shares the user's Mem0 (injection + background
  // review), so the flag is pinned on and every other feature stays at its default off.
  // A malformed client-supplied `features` is still rejected for a loud, early failure.
  if (Object.hasOwn(input, 'features')) {
    const features = input.features
    if (features !== undefined && features !== null) {
      if (typeof features !== 'object' || Array.isArray(features)) throw new RequestFailure(400)
      const memory = (features as Record<string, unknown>).memory
      if (memory !== undefined && typeof memory !== 'boolean') throw new RequestFailure(400)
    }
  }
  output.features = { memory: true }
  return output
}

export async function startPengbaoGateway(options: PengbaoGatewayOptions): Promise<PengbaoGateway> {
  let jwt = options.jwt
  if (!jwt || /[\r\n]/.test(jwt)) throw new Error('Invalid gateway credential')
  const maxBody = options.maxBodyBytes ?? 1_048_576
  const maxChatBody = options.maxChatBodyBytes ?? 33_554_432
  const maxConcurrent = options.maxConcurrent ?? 4
  const timeout = options.timeoutMs ?? 120_000
  const chatIdleTimeout = options.chatIdleTimeoutMs ?? 300_000
  const chatMaxDuration = options.chatMaxDurationMs ?? 3_600_000
  const imageTimeout = options.imageTimeoutMs ?? IMAGE_GATEWAY_TIMEOUT_MS
  const imageMaxConcurrent = options.imageMaxConcurrent ?? 2
  for (const limit of [timeout, chatIdleTimeout, chatMaxDuration, imageTimeout]) {
    // Node clamps overflowing timer delays to 1ms; reject rather than silently cut streams.
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_147_483_647) throw new Error('Invalid gateway limit')
  }
  for (const limit of [maxBody, maxChatBody, maxConcurrent, imageMaxConcurrent]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid gateway limit')
  }
  const upstreamFetch = options.fetch ?? fetch
  const capabilityToken = randomBytes(32).toString('base64url')
  let credential = Buffer.from(`Bearer ${capabilityToken}`)
  type ModelGrant = { credential: Buffer; capabilities: ReadonlySet<ModelServiceCapability | 'video.generate'>; models?: ReadonlySet<string>; active: Set<() => void>; revoked: boolean }
  const modelGrants = new Set<ModelGrant>()
  const defaultChatGrant: ModelGrant = {
    credential,
    capabilities: new Set(['chat.completions']),
    active: new Set(),
    revoked: false
  }
  modelGrants.add(defaultChatGrant)
  const active = new Set<AbortController>()
  const activeChatSockets = new Map<IncomingMessage['socket'], number>()
  let stopping = false
  let authority = ''
  let stopPromise: Promise<void> | undefined

  const images = createImageGateway({ getJwt: () => jwt, fetch: upstreamFetch, maxBodyBytes: maxBody,
    timeoutMs: Math.min(imageTimeout, IMAGE_GATEWAY_TIMEOUT_MS), maxConcurrent: imageMaxConcurrent, onFailure: options.onImageFailure })
  const videos = createNativeVideoGateway({ getJwt: () => jwt, fetch: upstreamFetch })
  const pluginConfiguration = createPluginConfigurationGateway({ videoModels: signal => videos.models(signal), getGatewayUrl: () => `http://${authority}`, issue: policy => {
    if (stopping) throw new Error('Gateway is stopped')
    const token = randomBytes(32).toString('base64url')
    const grant: ModelGrant = { credential: Buffer.from(`Bearer ${token}`), capabilities: new Set(policy.capabilities), models: new Set(policy.models), active: new Set(), revoked: false }
    modelGrants.add(grant)
    const image = policy.capabilities.includes('image.generate') ? images.createLease({ capabilityToken: token, models: policy.models,
      capabilities: policy.capabilities.filter((capability): capability is 'image.generate' => capability === 'image.generate'), compatibilityOnly: true }) : undefined
    const video = policy.capabilities.includes('video.generate') ? videos.createLease({ capabilityToken: token, models: policy.models }) : undefined
    return { capabilityToken: token, revoke: () => {
      video?.revoke()
      image?.revoke()
      if (grant.capabilities.has('chat.completions')) revokeModelGrant(grant)
      else { grant.revoked = true; grant.credential.fill(0); modelGrants.delete(grant); for (const abortOperation of grant.active) abortOperation() }
    } }
  } })
  const serverTimeout = Math.max(timeout, Math.min(imageTimeout, IMAGE_GATEWAY_TIMEOUT_MS))
  const server = createServer((req, res) => { void handle(req, res) })
  server.headersTimeout = 10_000
  server.requestTimeout = serverTimeout
  server.maxHeadersCount = 32
  server.on('connection', socket => { socket.setTimeout(serverTimeout, () => socket.destroy()) })
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.on('connect', (_req, socket) => socket.destroy())

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (stopping) return fail(res, 503)
    const hostCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]?.toLowerCase() === 'host').length
    // Node's fetch sends Sec-Fetch-Mode: cors without Origin or Sec-Fetch-Site.
    // Browser-initiated requests carry a site or origin; never accept those.
    const fetchMode = req.headers['sec-fetch-mode']
    if (hostCount !== 1 || req.headers.host !== authority || 'origin' in req.headers ||
      'sec-fetch-site' in req.headers || (fetchMode !== undefined && fetchMode !== 'cors')) return fail(res, 403)
    // Image routes authenticate against runtime-scoped image leases, never chat-only credentials.
    if (req.url?.startsWith('/v1/image-generation/') || req.url?.startsWith('/v1/images/')) {
      const supplied = Buffer.from(req.headers.authorization ?? '')
      const modelGrant = [...modelGrants].find(item => supplied.length === item.credential.length && timingSafeEqual(supplied, item.credential))
      if (modelGrant?.models !== undefined && !modelGrant.revoked && !modelGrant.capabilities.has('image.generate')) return fail(res, 404)
      return images.handle(req, res)
    }
    if (req.url?.startsWith('/v1/videos') || req.url?.startsWith('/v1/contents/generations/tasks')) return videos.handle(req, res)
    if (req.url?.startsWith('/v1/plugin-configuration/')) return pluginConfiguration.handle(req, res)
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const grant = [...modelGrants].find(item => supplied.length === item.credential.length && timingSafeEqual(supplied, item.credential))
    if (!grant || grant.revoked) return fail(res, 401)
    const modelUrl = req.method === 'GET' && typeof req.url === 'string' && req.url.startsWith('/v1/models?')
      ? new URL(req.url, 'http://gateway.local') : undefined
    const imageModelsOnly = modelUrl?.pathname === '/v1/models' && modelUrl.searchParams.get('kind') === 'image'
    const isModels = req.method === 'GET' && req.url === '/v1/models' && grant.models === undefined
    const isPluginModels = req.method === 'GET' && grant.models !== undefined &&
      ((req.url === '/v1/models' && grant.capabilities.has('chat.completions')) ||
       (imageModelsOnly && grant.capabilities.has('image.generate')))
    const isPluginChat = req.method === 'POST' && req.url === '/v1/chat/completions' && grant.models !== undefined && grant.capabilities.has('chat.completions')
    const isChat = req.method === 'POST' && req.url === '/v1/chat/completions' && grant.capabilities.has('chat.completions')
    const isDefaults = req.method === 'GET' && req.url === '/v1/model-service/defaults' && grant.capabilities.has('chat.completions') && grant.models === undefined
    if (!isModels && !isPluginModels && !isPluginChat && !isChat && !isDefaults) return fail(res, 404)
    if (!grant.capabilities.has('chat.completions') && !isDefaults) return fail(res, 401)
    const bodyLimit = isChat || isPluginChat ? maxChatBody : maxBody
    if (active.size >= maxConcurrent) return fail(res, 429)
    const started = Date.now()
    // One ID per network attempt, independent of user/session IDs and caller headers.
    const requestId = `pb-${randomBytes(16).toString('hex')}`
    let forwarded = false
    let failureReported = false
    let upstreamStatus: number | undefined
    let upstreamHeadersMs: number | undefined
    let firstByteMs: number | undefined
    let lastByteMs: number | undefined
    let bytesReceived = 0
    let abortReason: PengbaoGatewayFailure['abortReason']
    let timeoutStage: PengbaoGatewayFailure['timeoutStage']
    const controller = new AbortController()
    const abort = (reason: NonNullable<PengbaoGatewayFailure['abortReason']>) => {
      if (controller.signal.aborted) return
      abortReason = reason
      controller.abort(reason === 'revoked' ? new RequestFailure(401) : undefined)
    }
    active.add(controller)
    const abortGrantOperation = () => abort('revoked')
    grant.active.add(abortGrantOperation)
    if (grant.revoked) abortGrantOperation()
    const deadline = (stage: NonNullable<PengbaoGatewayFailure['timeoutStage']>) => {
      if (controller.signal.aborted) return
      timeoutStage = stage
      abort('deadline')
    }
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => deadline('preflight'), timeout)
    const totalTimer = isChat ? setTimeout(() => deadline('chat-total'), chatMaxDuration) : undefined
    const armChatTimer = (stage: 'upstream-idle' | 'downstream-blocked') => {
      clearTimeout(timer)
      if (!controller.signal.aborted) timer = setTimeout(() => deadline(stage), chatIdleTimeout)
    }
    // Only admitted inference uses the chat timers. Restore the socket for subsequent
    // keep-alive requests; metadata, upload and image policies remain unchanged.
    let chatSocket = false
    const registerChatSocket = () => {
      if (!isChat || chatSocket) return
      activeChatSockets.set(req.socket, (activeChatSockets.get(req.socket) ?? 0) + 1)
      req.socket.setTimeout(0)
      chatSocket = true
    }
    const unregisterChatSocket = () => {
      if (!chatSocket) return
      const count = activeChatSockets.get(req.socket) ?? 0
      if (count <= 1) activeChatSockets.delete(req.socket)
      else activeChatSockets.set(req.socket, count - 1)
      if (!req.socket.destroyed && !activeChatSockets.has(req.socket)) req.socket.setTimeout(serverTimeout)
      chatSocket = false
    }
    const close = () => { if (!res.writableFinished) abort('downstream') }
    req.once('aborted', close)
    res.once('close', close)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancel = () => { void reader?.cancel().catch(() => { /* Transport may already be closed. */ }) }
    controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      const metadata = async (path: '/api/config' | '/api/v1/models' | '/api/v1/images/metadata'): Promise<Record<string, unknown>> => {
        const metadataStarted = Date.now()
        let response: Response | undefined
        let metadataReader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let phase: PengbaoGatewayFailure['phase'] = 'request'
        let size = 0
        let invalidResponse = false
        const cancelMetadata = () => { void metadataReader?.cancel().catch(() => { /* Metadata body may already be closed. */ }) }
        controller.signal.addEventListener('abort', cancelMetadata, { once: true })
        try {
          const operation = upstreamFetch(`${PENGBAO_PRODUCT.serverUrl}${path}`, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
            headers: { Authorization: `Bearer ${jwt}`, 'X-Pengbao-Request-Id': requestId } })
          void operation.then(late => {
            if (controller.signal.aborted) void late.body?.cancel().catch(() => { /* Late metadata must not keep its socket open. */ })
          }, () => { /* The awaited operation reports failures. */ })
          response = await abortable(operation, controller.signal)
          phase = 'headers'
          metadataReader = response.body?.getReader()
          if (!response.ok) throw new RequestFailure(502)
          invalidResponse = response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !metadataReader
          if (invalidResponse || !metadataReader) throw new RequestFailure(502)
          const chunks: Buffer[] = []
          while (true) {
            const part = await abortable(metadataReader.read(), controller.signal)
            if (part.done) break
            phase = 'body'
            size += part.value.byteLength
            if (size > maxBody) { invalidResponse = true; throw new RequestFailure(502) }
            chunks.push(Buffer.from(part.value))
          }
          invalidResponse = true
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestFailure(502)
          return value as Record<string, unknown>
        } catch (error) {
          if (!stopping) {
            failureReported = true
            try {
              const code = transportCode(error)
              options.onFailure?.({ requestId, upstreamRoute: path === '/api/config' ? 'config' : path === '/api/v1/models' ? 'models' : 'image-metadata',
                kind: abortReason === 'deadline' ? 'timeout' : abortReason ? 'cancelled' : response && !response.ok ? 'upstream-http' : invalidResponse ? 'upstream-response' : 'transport',
                ...(response ? { upstreamStatus: response.status } : {}), elapsedMs: Date.now() - metadataStarted, phase, bytesReceived: size,
                ...(abortReason ? { abortReason } : {}), ...(timeoutStage ? { timeoutStage } : {}), ...(code && !abortReason ? { transportCode: code } : {}) })
            } catch { /* Diagnostics must not change request handling. */ }
          }
          throw error
        } finally { controller.signal.removeEventListener('abort', cancelMetadata); cancelMetadata() }
      }
      const defaults = async (): Promise<string[]> => {
        const value = await metadata('/api/config')
        if (value.default_models !== undefined && value.default_models !== null && typeof value.default_models !== 'string') throw new RequestFailure(502)
        const ids = typeof value.default_models === 'string' ? value.default_models.split(',').map(id => id.trim()).filter(Boolean) : []
        if (ids.length > 256 || ids.some(id => id.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(id) || /https?:\/\//i.test(id)) || new Set(ids).size !== ids.length) throw new RequestFailure(502)
        return [...new Set(ids)]
      }
      type ClientIndex = { configured: boolean; models: Map<string, ClientAccess>; catalog: Record<string, unknown> }
      let clientIndexPromise: Promise<ClientIndex> | undefined
      const clientIndex = (): Promise<ClientIndex> => clientIndexPromise ??= (async () => {
        const catalog = await metadata('/api/v1/models')
        const rows = Array.isArray(catalog.data) ? catalog.data : []
        const models = new Map<string, ClientAccess>()
        for (const entry of rows) {
          const id = modelEntryId(entry)
          const access = entryClientAccess(entry)
          if (id && access) models.set(id, access)
        }
        return { configured: clientAccessConfigured(rows), models, catalog }
      })()
      const visibleFor = (index: ClientIndex, model: string, surface: ClientSurface): boolean =>
        !index.configured || (index.models.get(model)?.enabled === true && index.models.get(model)?.types.includes(surface) === true)
      const taggedImageIds = async (): Promise<Set<string>> => {
        const index = await clientIndex()
        return index.configured
          ? new Set([...index.models].filter(([, access]) => access.enabled && access.types.includes('image')).map(([id]) => id))
          : new Set()
      }
      const imageCatalogIds = async (): Promise<Set<string>> => {
        const index = await clientIndex()
        if (index.configured) {
          return new Set([...index.models].filter(([, access]) => access.enabled && access.types.includes('image')).map(([id]) => id))
        }
        // Before the first tag the server's own image catalog is authoritative.
        // This is not a client-side type guess; it is the endpoint the server
        // publishes for image surfaces.
        const value = await metadata('/api/v1/images/metadata')
        const record = value as Record<string, unknown>
        // The image endpoint's `.models` list is the server's own answer for
        // "which models can this deployment generate images with". No name or
        // capability heuristics are applied: a model is offered only when the
        // operator listed it here and the plugin was configured with it.
        const ids = new Set<string>()
        if (Array.isArray(record.models)) {
          for (const item of record.models) {
            if (item && typeof item === 'object' && 'id' in item && typeof (item as Record<string, unknown>).id === 'string') {
              ids.add((item as Record<string, unknown>).id as string)
            }
          }
        }
        const defaultModel = record.defaultModel
        if (defaultModel && typeof defaultModel === 'object' && 'id' in defaultModel && typeof (defaultModel as Record<string, unknown>).id === 'string') ids.add((defaultModel as Record<string, unknown>).id as string)
        return ids
      }
      const diagnose = (reason: PengbaoModelDenial['reason'], route: PengbaoModelDenial['route'], model: string): void => {
        // Rejected request values are untrusted, not catalog metadata. Never persist URLs,
        // control characters, or unbounded payloads in diagnostic logs.
        const safeModel = model.length <= 256 && /^[\p{L}\p{N}_.:/-]+$/u.test(model) && !model.includes('://') ? model : '[invalid-model]'
        try { options.onModelDenial?.({ kind: 'model-denial', requestId, route, model: safeModel, reason }) } catch { /* Diagnostics must not change request handling. */ }
      }
      const denyLocal = (reason: PengbaoModelDenial['reason'], route: PengbaoModelDenial['route'], model: string): never => {
        diagnose(reason, route, model)
        throw new RequestFailure(403)
      }
      if (isDefaults) {
        const defaultModels = await defaults()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ defaultModels }))
        return
      }
      if (req.headers['content-encoding']) throw new RequestFailure(415)
      const declaredBytes = Number(req.headers['content-length'] ?? 0)
      if (declaredBytes > bodyLimit) throw new BodySizeFailure(declaredBytes, 'declared')
      const body = isChat || isPluginChat ? chatBody(await readBody(req, bodyLimit, controller.signal)) : undefined
      if (body && grant.models !== undefined) {
        if (!grant.models.has(body.model as string)) denyLocal('not-granted', 'chat', body.model as string)
        // Compatibility chat currently supports text/tool inference only, never arbitrary media URLs.
        if ((body.messages as Record<string, unknown>[]).some(message => {
          const content = message.content
          return content !== null && content !== undefined && typeof content !== 'string' &&
            (!Array.isArray(content) || content.some(part => !part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string' || Object.keys(part).some(key => key !== 'type' && key !== 'text')))
        })) throw new RequestFailure(400)
        const index = await clientIndex()
        const catalog = index.catalog
        if (!Array.isArray(catalog.data)) throw new RequestFailure(502)
        const catalogIds = new Set(catalog.data.flatMap((item: unknown) => item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' ? [item.id] : []))
        const explicitAllowed = grant.models === undefined || grant.models.has(body.model as string)
        const isDefaultAlias = body.model === 'pengbao-default-chat' && grant.models?.has('pengbao-default-chat')
        if (isDefaultAlias) {
          const current = (await defaults()).find(id => catalogIds.has(id) && visibleFor(index, id, 'text'))
          if (!current) denyLocal('not-in-catalog', 'chat', body.model as string)
          body.model = current
        } else {
          if (!explicitAllowed) denyLocal('not-granted', 'chat', body.model as string)
          if (!catalogIds.has(body.model as string)) denyLocal('not-in-catalog', 'chat', body.model as string)
          if (grant.models !== undefined && (await taggedImageIds()).has(body.model as string)) denyLocal('image-classified', 'chat', body.model as string)
        }
        if (!visibleFor(index, body.model as string, 'text')) denyLocal('not-in-catalog', 'chat', body.model as string)
      }
      if (isPluginModels) {
        const allowed = [...(grant.models ?? [])]
        if (imageModelsOnly) {
          // Image plugins ask for their own catalog; returning chat or video
          // models here pollutes the image-model picker.
          const imageIds = await imageCatalogIds()
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ object: 'list', data: allowed.filter(model => imageIds.has(model)).map(id => ({ id, object: 'model', name: id })) }))
          return
        }
        const index = await clientIndex()
        const catalog = catalogModels(index.catalog.data)
        const imageIds = await taggedImageIds()
        const chatVisible = (model: string) => visibleFor(index, model, 'text')
        const defaultsForChat = allowed.includes('pengbao-default-chat') ? await defaults() : []
        const resolved = [...new Set([
          ...allowed.filter(model => {
            if (model === 'pengbao-default-chat' || model === 'pengbao-default-image') return false
            if (!catalog.has(model)) { diagnose('not-in-catalog', 'models', model); return false }
            if (!chatVisible(model)) { diagnose('not-in-catalog', 'models', model); return false }
            if (imageIds.has(model)) { diagnose('image-classified', 'models', model); return false }
            return true
          }),
          ...defaultsForChat.filter(model => {
            if (!catalog.has(model)) { diagnose('not-in-catalog', 'models', model); return false }
            if (!chatVisible(model)) { diagnose('not-in-catalog', 'models', model); return false }
            if (imageIds.has(model)) { diagnose('image-classified', 'models', model); return false }
            return true
          })
        ])]
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ object: 'list', data: resolved.map(id => ({ id, object: 'model', name: modelDisplayName(id, catalog.get(id)) })) }))
        return
      }
      controller.signal.throwIfAborted()
      if (isChat) {
        registerChatSocket()
        armChatTimer('upstream-idle')
      }
      forwarded = true
      const upstreamOperation = upstreamFetch(`${PENGBAO_PRODUCT.serverUrl}/api/v1${isModels ? '/models' : '/chat/completions'}`, {
        method: isModels ? 'GET' : 'POST',
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${jwt}`, 'X-Pengbao-Request-Id': requestId, ...(isModels ? {} : { 'Content-Type': 'application/json' }) },
        body: body ? JSON.stringify(body) : undefined
      })
      // A transport that completes after cancellation must not leave its body open.
      void upstreamOperation.then(response => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => { /* Already closed. */ })
      }, () => { /* The awaited operation reports transport failures. */ })
      const upstream = await abortable(upstreamOperation, controller.signal)
      upstreamStatus = upstream.status
      upstreamHeadersMs = Date.now() - started
      reader = upstream.body?.getReader()
      controller.signal.throwIfAborted()
      // Preserve inference failures without reflecting bodies, cookies, redirects, or internal headers.
      if (upstream.redirected || upstream.type === 'opaqueredirect' || (upstream.status < 400 && !upstream.ok)) {
        throw new RequestFailure(502, upstream.status)
      }
      if (!upstream.ok) throw new RequestFailure(upstream.status, upstream.status)
      const sse = upstream.headers.get('content-type')?.split(';')[0]?.trim() === 'text/event-stream'
      if (isModels && !sse && reader && upstream.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json') {
        const chunks: Buffer[] = []
        let size = 0
        while (true) {
          const { done, value } = await abortable(reader.read(), controller.signal)
          if (done) break
          size += value.byteLength
          if (size > maxBody) throw new RequestFailure(502)
          chunks.push(Buffer.from(value))
        }
        let catalog: Record<string, unknown>
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid catalog')
          catalog = parsed as Record<string, unknown>
        } catch { throw new RequestFailure(502) }
        let projected = Array.isArray(catalog.data) ? catalog.data : []
        if (projected.length > 0) {
          try { projected = projectImageDefaultMetadata(await metadata('/api/v1/images/metadata'), projected) }
          catch { /* Image metadata is optional for the ordinary model list. */ }
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(JSON.stringify({ ...catalog, data: projected }))
        return
      }
      res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.flushHeaders()
      while (reader) {
        const { done, value } = await abortable(reader.read(), controller.signal)
        controller.signal.throwIfAborted()
        if (done) break
        if (value.byteLength) {
          bytesReceived += value.byteLength
          lastByteMs = Date.now() - started
          firstByteMs ??= lastByteMs
          if (isChat) armChatTimer('upstream-idle')
        }
        // Forward bytes, including sources/error events, without buffering SSE.
        if (!res.write(value)) {
          // We deliberately stop reading upstream under backpressure. Bound the
          // downstream stall instead of falsely diagnosing upstream inactivity.
          if (isChat) armChatTimer('downstream-blocked')
          await once(res, 'drain', { signal: controller.signal })
          if (isChat) armChatTimer('upstream-idle')
        }
      }
      res.end()
    } catch (error) {
      if (!stopping && !failureReported && (forwarded || abortReason === 'deadline' || error instanceof BodySizeFailure)) {
        try {
          const code = transportCode(error)
          options.onFailure?.({ requestId, kind: error instanceof BodySizeFailure ? 'request-size' : abortReason === 'downstream' ? 'cancelled' : abortReason === 'deadline' ? 'timeout' : abortReason === 'revoked' ? 'cancelled' : error instanceof RequestFailure ? 'upstream-http' : 'transport',
            ...(upstreamStatus === undefined ? {} : { upstreamStatus }), elapsedMs: Date.now() - started,
            phase: firstByteMs !== undefined ? 'body' : upstreamHeadersMs !== undefined ? 'headers' : 'request', bytesReceived,
            ...(upstreamHeadersMs === undefined ? {} : { upstreamHeadersMs }),
            ...(firstByteMs === undefined ? {} : { firstByteMs, lastByteMs }),
            ...(abortReason === undefined ? {} : { abortReason }),
            ...(timeoutStage === undefined ? {} : { timeoutStage }),
            ...(error instanceof BodySizeFailure ? { requestBytes: error.requestBytes, maxBodyBytes: bodyLimit, sizeSource: error.sizeSource } : {}),
            ...(code === undefined || abortReason !== undefined ? {} : { transportCode: code }) })
        } catch { /* Diagnostics must not change request handling. */ }
      }
      // Discard an unread request body before responding so the client can read
      // the error instead of losing the connection mid-upload (which surfaces as
      // a transport error and a pointless retry loop). Bounded: a client that
      // keeps uploading forever must not pin the slot.
      if (error instanceof BodySizeFailure && !req.destroyed && !req.complete) {
        req.resume()
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); req.off('end', finish); req.off('close', finish); req.off('error', finish); resolve() }
          const timer = setTimeout(finish, 5_000)
          timer.unref()
          req.once('end', finish)
          req.once('close', finish)
          req.once('error', finish)
        })
      }
      fail(res, error instanceof RequestFailure ? error.status : controller.signal.aborted ? 504 : 502,
        error instanceof RequestFailure ? error.upstreamStatus : undefined)
    } finally {
      cancel()
      clearTimeout(timer)
      clearTimeout(totalTimer)
      unregisterChatSocket()
      req.off('aborted', close)
      res.off('close', close)
      controller.signal.removeEventListener('abort', cancel)
      active.delete(controller)
      grant.active.delete(abortGrantOperation)
    }
  }

  function revokeModelGrant(grant: ModelGrant): void {
    if (grant.revoked) return
    grant.revoked = true
    grant.credential.fill(0)
    modelGrants.delete(grant)
    for (const abortOperation of grant.active) abortOperation()
  }

  function createModelServiceGrant(capabilities: readonly ModelServiceCapability[]): PengbaoModelServiceGrant {
    const unique = new Set(capabilities)
    if (stopping || capabilities.length !== 1 || unique.size !== capabilities.length ||
      capabilities.some(capability => capability !== 'chat.completions')) {
      throw new Error('Unsupported model service grant')
    }
    const token = randomBytes(32).toString('base64url')
    const grant: ModelGrant = {
      credential: Buffer.from(`Bearer ${token}`),
      capabilities: new Set(capabilities),
      active: new Set(),
      revoked: false
    }
    modelGrants.add(grant)
    return {
      contractVersion: 1,
      gatewayUrl: `http://${authority}`,
      capabilityToken: token,
      capabilities: [...capabilities],
      revoke: () => revokeModelGrant(grant)
    }
  }

  async function publishHtml(html: string): Promise<{ url: string; expires_at: number | null }> {
    if (typeof html !== 'string' || html.length === 0 || Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) throw new Error('Invalid HTML artifact')
    const response = await upstreamFetch(`${PENGBAO_PRODUCT.serverUrl}/api/v1/published`, {
      method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ html })
    })
    if (!response.ok) throw new Error('Could not publish HTML artifact')
    const value = await response.json() as unknown
    if (!value || typeof value !== 'object' || typeof (value as { url?: unknown }).url !== 'string') throw new Error('Invalid publish response')
    const expiresAt = (value as { expires_at?: unknown }).expires_at
    return { url: (value as { url: string }).url, expires_at: typeof expiresAt === 'number' ? expiresAt : null }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Gateway did not bind')
  authority = `127.0.0.1:${address.port}`
  return {
    port: address.port,
    url: `http://${authority}`,
    capabilityToken,
    createModelServiceGrant,
    createImageLease: () => images.createLease(),
    createVideoLease: models => videos.createLease({ models }),
    videoModels: signal => videos.models(signal ?? AbortSignal.timeout(10000)),
    createPluginConfigurationLease: pluginConfiguration.createLease,
    publishHtml,
    stop: () => {
      if (stopPromise) return stopPromise
      stopping = true
      pluginConfiguration.stop()
      images.stop()
      videos.stop()
      for (const grant of modelGrants) revokeModelGrant(grant)
      credential = Buffer.alloc(0)
      jwt = ''
      for (const controller of active) controller.abort()
      stopPromise = new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      return stopPromise
    }
  }
}

export const createPengbaoGateway = startPengbaoGateway
