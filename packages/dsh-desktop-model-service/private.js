import { LIMITS, SUPPORTED, ModelServiceError, fail, safeError, record, identifier, optionsSignal,
  boundedJson, createLifetime, readBounded, parseModels, clientVisibleRows, freeze } from './common.js'

let registration
let imageOperations
let consumers
let pluginConfiguration
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/
const ADAPTERS = new Set(['llm-pi-ai', 'desktop-imagegen', 'image-generation'])
const CONSUMER_CAPABILITIES = new Set(['chat.completions', 'image.generate'])
const semver = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value)

/** Bootstrap-only registration. Credentials never appear on a returned service. */
export function registerModelService(packet) {
  if (registration) fail('ALREADY_REGISTERED')
  if (!record(packet) || Object.keys(packet).sort().join(',') !== 'capabilities,capabilityToken,contractVersion,gatewayUrl'
    || packet.contractVersion !== 1 || typeof packet.gatewayUrl !== 'string'
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(packet.gatewayUrl)
    || typeof packet.capabilityToken !== 'string' || !TOKEN.test(packet.capabilityToken)
    || !Array.isArray(packet.capabilities) || packet.capabilities.length !== 1 || packet.capabilities[0] !== 'chat.completions') fail('INVALID_REGISTRATION')
  try { const url = new URL(packet.gatewayUrl); if (!url.port || Number(url.port) > 65535) fail('INVALID_REGISTRATION') }
  catch { fail('INVALID_REGISTRATION') }
  registration = freeze({ ...packet, capabilities: [...packet.capabilities] })
}

/** Bootstrap-only configuration broker registration. Tokens are never returned to plugin contexts. */
export function registerPrivatePluginConfiguration(packet) {
  if (pluginConfiguration) fail('ALREADY_REGISTERED')
  if (!record(packet) || Object.keys(packet).sort().join(',') !== 'capabilityToken,contractVersion,gatewayUrl' || packet.contractVersion !== 1 ||
    typeof packet.gatewayUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(packet.gatewayUrl) ||
    typeof packet.capabilityToken !== 'string' || !TOKEN.test(packet.capabilityToken)) fail('INVALID_REGISTRATION')
  try { const url = new URL(packet.gatewayUrl); if (!url.port || Number(url.port) > 65535) fail('INVALID_REGISTRATION') }
  catch { fail('INVALID_REGISTRATION') }
  pluginConfiguration = freeze({ ...packet })
}

export function createPluginConfigurationBroker({ fetch: fetchImpl = globalThis.fetch } = {}) {
  const packet = pluginConfiguration
  if (!packet) fail('UNAVAILABLE')
  const leases = new Set()
  const lifetime = createLifetime()
  let disposed = false
  async function post(route, body, signal) {
    if (disposed && route === '/v1/plugin-configuration/issue') fail('UNAVAILABLE')
    const operation = lifetime.operation(5_000, signal)
    try {
      const response = await operation.wait(fetchImpl(`${packet.gatewayUrl}${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: operation.signal,
        headers: { Authorization: `Bearer ${packet.capabilityToken}`, 'Content-Type': 'application/json', Accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      if (!response.ok) {
        const status = response.status
        let detail
        if (status === 403) {
          // The host attaches a fixed-vocabulary reason to a denied approval. Read a
          // small body for diagnostics; any malformed or absent reason is discarded.
          try {
            if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json') {
              const bytes = await readBounded(response, 1024, operation)
              const body = JSON.parse(bytes.toString('utf8'))
              const candidate = record(body?.error) ? body.error.reason : body?.reason
              if (typeof candidate === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(candidate)) detail = candidate
            }
          } catch { /* The HTTP status remains authoritative. */ }
        }
        if (detail === undefined) void response.body?.cancel().catch(() => {})
        throw httpError(status, detail)
      }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('INVALID_RESPONSE')
      const bytes = await readBounded(response, 32768, operation)
      try { return JSON.parse(bytes.toString('utf8')) } catch { fail('INVALID_RESPONSE') }
    } catch (error) { throw safeError(error, operation.signal) }
    finally { operation.finish() }
  }
  return Object.freeze({
    async videoModels({ signal } = {}) {
      const result = await post('/v1/plugin-configuration/video-models', undefined, signal)
      if (!record(result) || !Array.isArray(result.data) || result.data.length > 256) fail('INVALID_RESPONSE')
      return freeze(result.data.map(row => {
        if (!record(row) || !identifier(row.id) || !identifier(row.name) || !['volcengine', 'alibaba', 'openai'].includes(row.provider) || !['ark', 'dashscope', 'openai', 'newapi'].includes(row.protocol)
          || (row.default !== undefined && row.default !== true)) fail('INVALID_RESPONSE')
        return { id: row.id, name: row.name, provider: row.provider, protocol: row.protocol, ...(row.default === true ? { default: true } : {}) }
      }))
    },
    async issue(policy, { signal } = {}) {
      if (disposed) fail('UNAVAILABLE')
      if (!record(policy) || Object.keys(policy).sort().join(',') !== 'bindingId,capabilities,entryId,models,packageName,packageVersion' ||
        !identifier(policy.bindingId) || !identifier(policy.entryId) || !identifier(policy.packageName) || !semver(policy.packageVersion) ||
        !Array.isArray(policy.capabilities) || policy.capabilities.length === 0 || policy.capabilities.length > 3 ||
        policy.capabilities.some(item => !['chat.completions', 'image.generate', 'video.generate'].includes(item)) || new Set(policy.capabilities).size !== policy.capabilities.length ||
        !Array.isArray(policy.models) || policy.models.length === 0 || policy.models.length > 256 ||
        policy.models.some(item => typeof item !== 'string' || !/^(?:pengbao-default-chat|pengbao-default-image)$/.test(item) && !identifier(item)) || new Set(policy.models).size !== policy.models.length) fail('INVALID_REQUEST')
      const result = await post('/v1/plugin-configuration/issue', policy, signal)
      if (disposed) {
        if (record(result) && identifier(result.leaseId)) await post('/v1/plugin-configuration/revoke', { leaseId: result.leaseId }, undefined)
        fail('UNAVAILABLE')
      }
      if (!record(result) || result.gatewayUrl !== packet.gatewayUrl || result.contractVersion !== 1 || !identifier(result.leaseId) || typeof result.gatewayUrl !== 'string' ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(result.gatewayUrl) || typeof result.capabilityToken !== 'string' || !TOKEN.test(result.capabilityToken)) fail('INVALID_RESPONSE')
      const child = { gatewayUrl: result.gatewayUrl, apiKey: result.capabilityToken, capabilities: freeze([...policy.capabilities]), models: freeze([...policy.models]),
        release: async () => {
          if (!leases.delete(child)) return
          try { await post('/v1/plugin-configuration/revoke', { leaseId: result.leaseId }, undefined) }
          catch (error) { if (!disposed) throw error }
        } }
      leases.add(child)
      return Object.freeze(child)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        const results = await Promise.allSettled([...leases].map(child => child.release()))
        if (results.some(result => result.status === 'rejected')) fail('FAILED')
      } finally { leases.clear(); lifetime.dispose() }
    }
  })
}

/** Accept operations already bound by bootstrap, never import a consumer package. */
export function registerModelServiceImage(operations) {
  if (imageOperations) fail('ALREADY_REGISTERED')
  if (!record(operations) || ['status', 'models', 'generate'].some(key => typeof operations[key] !== 'function')) fail('INVALID_REGISTRATION')
  imageOperations = Object.freeze({ status: operations.status.bind(operations), models: operations.models.bind(operations),
    generate: operations.generate.bind(operations),
    ...(typeof operations.generateMany === 'function' ? { generateMany: operations.generateMany.bind(operations) } : {}) })
}

/** Detached, immutable discovery records. Scopes are conventions, not a sandbox. */
export function registerModelServiceConsumers(records) {
  if (consumers) fail('ALREADY_REGISTERED')
  if (!Array.isArray(records) || records.length > LIMITS.consumers) fail('INVALID_REGISTRATION')
  const seen = new Set()
  consumers = freeze(records.map(item => {
    if (!record(item) || !identifier(item.id) || (item.version !== undefined && !semver(item.version)) || seen.has(item.id)
      || !['declared', 'needs-adapter', 'invalid-declaration'].includes(item.status)
      || !Array.isArray(item.capabilities) || item.capabilities.length > 16
      || item.capabilities.some(capability => !identifier(capability) || !CONSUMER_CAPABILITIES.has(capability))
      || new Set(item.capabilities).size !== item.capabilities.length
      || (item.adapter !== undefined && !ADAPTERS.has(item.adapter))) fail('INVALID_REGISTRATION')
    seen.add(item.id)
    return { id: item.id, ...(item.version === undefined ? {} : { version: item.version }), status: item.status, capabilities: [...item.capabilities],
      ...(item.adapter === undefined ? {} : { adapter: item.adapter }) }
  }))
}

export function getModelServiceConsumers() { return consumers ?? Object.freeze([]) }
export function getModelServiceImage() { return imageOperations }
export function hasChatRegistration() { return registration !== undefined }

function httpError(status, detail) {
  const error = new ModelServiceError(status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 429 ? 'BUSY' : 'FAILED')
  if (detail !== undefined) error.detail = detail
  return error
}
function validateCompletion(input) {
  const allowed = new Set(['model', 'messages', 'stream', 'temperature', 'max_tokens', 'stop', 'tools', 'tool_choice', 'stream_options'])
  if (!record(input) || Object.keys(input).some(key => !allowed.has(key)) || !identifier(input.model)
    || !Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 256
    || (input.stream !== undefined && typeof input.stream !== 'boolean')) fail('INVALID_REQUEST')
  return boundedJson(input)
}

/** Fixed-route compatibility transport; public plugin chat uses ctx.llm instead. */
export function createChatService({ signal, fetch: fetchImpl = globalThis.fetch } = {}) {
  const packet = registration
  const lifetime = createLifetime(signal)
  async function request(route, input, options, timeout) {
    if (!packet) fail('UNAVAILABLE')
    const op = lifetime.operation(timeout, optionsSignal(options))
    try {
      const response = await op.wait(Promise.resolve().then(() => {
        if (op.signal.aborted) throw safeError(undefined, op.signal)
        return fetchImpl(`${packet.gatewayUrl}${route}`, {
          method: input === undefined ? 'GET' : 'POST', redirect: 'error', signal: op.signal,
          headers: { Authorization: `Bearer ${packet.capabilityToken}`, Accept: input?.stream ? 'text/event-stream' : 'application/json',
            ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(input === undefined ? {} : { body: validateCompletion(input) })
        })
      }))
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw httpError(response.status) }
      return { response, op }
    } catch (error) { op.finish(); throw safeError(error, op.signal) }
  }
  async function json(route, input, options, limit, timeout) {
    const { response, op } = await request(route, input, options, timeout)
    try {
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('INVALID_RESPONSE')
      const bytes = await readBounded(response, limit, op)
      try { return JSON.parse(bytes.toString('utf8')) } catch { fail('INVALID_RESPONSE') }
    } catch (error) { throw safeError(error, op.signal) }
    finally { op.finish() }
  }
  return Object.freeze({
    contractVersion: 1,
    capabilities: Object.freeze(packet ? ['chat.completions'] : []),
    async defaults(options = {}) {
      const value = await json('/v1/model-service/defaults', undefined, options, LIMITS.metadataBytes, LIMITS.metadataMs)
      if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'defaultModels') || !Array.isArray(value.defaultModels) || value.defaultModels.length > 256 || value.defaultModels.some(item => !identifier(item))) fail('INVALID_RESPONSE')
      return freeze({ defaultModels: [...new Set(value.defaultModels)] })
    },
    async models(options = {}) {
      const value = await json('/v1/models', undefined, options, LIMITS.metadataBytes, LIMITS.metadataMs)
      return freeze(parseModels(clientVisibleRows(value?.data, 'text')).map(model => ({ ...model, capabilities: ['chat.completions'] })))
    },
    async complete(input, options = {}) {
      // Snapshot before I/O so caller mutation cannot alter a pending request.
      input = JSON.parse(validateCompletion(input))
      if (!input.stream) return json('/v1/chat/completions', input, options, LIMITS.responseBytes, LIMITS.chatMs)
      const { response, op } = await request('/v1/chat/completions', input, options, LIMITS.chatMs)
      let reader
      try {
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream' || !response.body) fail('INVALID_RESPONSE')
        reader = response.body.getReader()
      } catch (error) { void response.body?.cancel().catch(() => {}); op.finish(); throw safeError(error, op.signal) }
      let bytes = 0
      let ended = false
      const finish = () => {
        if (ended) return
        ended = true
        void reader.cancel().catch(() => {})
        op.signal.removeEventListener('abort', onAbort)
        op.finish()
      }
      let streamController
      const onAbort = () => { streamController?.error(safeError(undefined, op.signal)); finish() }
      return new ReadableStream({
        start(controller) { streamController = controller; op.signal.addEventListener('abort', onAbort, { once: true }); if (op.signal.aborted) onAbort() },
        async pull(controller) {
          try {
            const chunk = await op.wait(reader.read())
            if (ended) return
            if (chunk.done) { controller.close(); finish(); return }
            bytes += chunk.value.byteLength
            if (bytes > LIMITS.responseBytes) fail('TOO_LARGE')
            controller.enqueue(chunk.value)
          } catch (error) { if (!ended) controller.error(safeError(error, op.signal)); finish() }
        },
        cancel() { op.abort('CANCELLED'); finish() }
      })
    },
    dispose: lifetime.dispose
  })
}

export { SUPPORTED }
