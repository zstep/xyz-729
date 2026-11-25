import { parseImageParameters, validateImageParameters, imageDiagnostic, IMAGE_BATCH_BYTES } from './image-contract.js'
import { createChatService, getModelServiceImage, getModelServiceConsumers, hasChatRegistration } from './private.js'
import { LIMITS, SUPPORTED, fail, safeError, safeImageGenerationError, record, identifier, optionsSignal,
  boundedJson, createLifetime, parseModels, freeze } from './common.js'

const REASONS = new Set(['available', 'disabled', 'forbidden', 'unauthenticated', 'unavailable', 'server-only', 'models-unavailable', 'revoked', 'not-connected'])
const unavailable = reason => ({ available: false, reason })
const emptyImage = () => ({ models: [], selection: 'server-only', defaultModel: null })
function imageCatalog(value) {
  if (!record(value) || !['request-local', 'server-only'].includes(value.selection)
    || (value.catalogStatus !== undefined && !['available', 'default-only'].includes(value.catalogStatus))) fail('INVALID_RESPONSE')
  const models = parseModels(value.models)
  const defaultModel = value.defaultModel == null ? null : parseModels([value.defaultModel])[0]
  let generationParameters
  try { generationParameters = parseImageParameters(value.generationParameters) }
  catch { /* Advanced capabilities fail closed without breaking legacy generation. */ }
  return { models: value.selection === 'request-local' ? models : [], selection: value.selection, defaultModel,
    ...(generationParameters ? { generationParameters } : {}),
    ...(value.catalogStatus === undefined ? {} : { catalogStatus: value.catalogStatus }) }
}
function publicFailure(error) {
  error = safeError(error)
  if (error.code === 'UNAUTHENTICATED') return unavailable('unauthenticated')
  if (error?.code === 'FORBIDDEN') return unavailable('forbidden')
  if (error.code === 'IMAGE_REVOKED') return unavailable('revoked')
  if (error?.code === 'INVALID_RESPONSE') throw error
  return unavailable('unavailable')
}
function validateChat(input) {
  const allowed = new Set(['model', 'messages', 'system', 'tools', 'temperature', 'maxTokens', 'stop', 'reasoningEffort'])
  if (!record(input) || Object.keys(input).some(key => !allowed.has(key))
    || (input.model !== undefined && !identifier(input.model)) || !Array.isArray(input.messages)
    || input.messages.length === 0 || input.messages.length > 256
    || (input.system !== undefined && typeof input.system !== 'string')
    || (input.reasoningEffort !== undefined && !identifier(input.reasoningEffort))
    || (input.temperature !== undefined && (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))
    || (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 131072))
    || (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 128))
    || (input.stop !== undefined && (!Array.isArray(input.stop) || input.stop.length > 16 || input.stop.some(value => typeof value !== 'string' || !value || value.length > 256)))) fail('INVALID_REQUEST')
  for (const message of input.messages) {
    if (!record(message) || !['user', 'assistant', 'system', 'developer', 'tool'].includes(message.role)
      || !Array.isArray(message.content) || message.content.length > 256) fail('INVALID_REQUEST')
  }
  for (const tool of input.tools ?? []) {
    if (!record(tool) || !identifier(tool.name) || typeof tool.description !== 'string' || !record(tool.parameters)) fail('INVALID_REQUEST')
  }
  return JSON.parse(boundedJson(input))
}
function chunkValue(chunk) {
  if (!record(chunk)) fail('INVALID_RESPONSE')
  const index = chunk.index
  if (['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type)
    && (!Number.isSafeInteger(index) || index < 0 || index > 4096)) fail('INVALID_RESPONSE')
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    if (typeof chunk.text !== 'string' || Buffer.byteLength(chunk.text) > LIMITS.responseBytes) fail('INVALID_RESPONSE')
    return { type: chunk.type, index, text: chunk.text }
  }
  if (chunk.type === 'block-start') {
    if (!['text', 'reasoning', 'tool-call'].includes(chunk.blockType)) return undefined
    return { type: chunk.type, index, blockType: chunk.blockType }
  }
  if (chunk.type === 'tool-call-delta') {
    if (!identifier(chunk.id) || (chunk.name !== undefined && !identifier(chunk.name)) || typeof chunk.argumentsDelta !== 'string'
      || Buffer.byteLength(chunk.argumentsDelta) > LIMITS.responseBytes) fail('INVALID_RESPONSE')
    return { type: chunk.type, index, id: chunk.id, ...(chunk.name === undefined ? {} : { name: chunk.name }), argumentsDelta: chunk.argumentsDelta }
  }
  if (chunk.type === 'usage') {
    if (!record(chunk.usage)) fail('INVALID_RESPONSE')
    const usage = {}
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (chunk.usage[key] === undefined && !['inputTokens', 'outputTokens'].includes(key)) continue
      if (!Number.isSafeInteger(chunk.usage[key]) || chunk.usage[key] < 0) fail('INVALID_RESPONSE')
      usage[key] = chunk.usage[key]
    }
    return { type: 'usage', usage }
  }
  if (chunk.type === 'finish') {
    const kind = chunk.reason?.kind
    if (kind === 'error') fail('FAILED')
    if (kind === 'aborted') fail('CANCELLED')
    if (!['stop', 'tool-calls', 'max-tokens'].includes(kind)) fail('INVALID_RESPONSE')
    return { type: 'finish', reason: { kind } }
  }
  // Block-end duplicates the deltas and can contain adapter-private replay data.
  if (chunk.type === 'block-end') return undefined
  fail('INVALID_RESPONSE')
}

/** Host-owned orchestration; no tokens, URLs, arbitrary fetch or provider routes. */
export function createModelService({ llm, getBindings = () => ({}), signal, transport } = {}) {
  const lifetime = createLifetime(signal)
  const chatTransport = transport ?? createChatService({ signal: lifetime.signal })
  const records = getModelServiceConsumers()
  const scopes = new Set()
  async function chatMetadata(signal) {
    const models = parseModels(await chatTransport.models({ signal }))
    // Missing metadata must not turn a user's selection or catalog order into a
    // foundation default. Explicit per-consumer/request models remain usable.
    let defaults
    try { defaults = typeof chatTransport.defaults === 'function' ? await chatTransport.defaults({ signal }) : undefined }
    catch (error) {
      if (signal.aborted || error?.code === 'INVALID_RESPONSE') throw error
      return { models }
    }
    if (defaults === undefined) return { models }
    if (!record(defaults) || !Array.isArray(defaults.defaultModels) || defaults.defaultModels.length > 256
      || defaults.defaultModels.some(id => !identifier(id))) fail('INVALID_RESPONSE')
    // Server defaults may name the display alias while the catalog id is versioned;
    // expose the matched catalog id so a selection stays routable.
    const defaultMatch = defaults.defaultModels.map(id => models.find(model => model.id === id || model.name === id)).find(Boolean)
    return { models, ...(defaultMatch === undefined ? {} : { defaultModel: defaultMatch.id }) }
  }
  /** Server-declared chat defaults as validated IDs. Never a catalog-order fallback. */
  async function chatDefaults(options = {}) {
    return bounded(lifetime, LIMITS.metadataMs, options, async signal => {
      if (!hasChatRegistration() || typeof chatTransport.defaults !== 'function') return freeze({ defaultModels: [] })
      let defaults
      try { defaults = await chatTransport.defaults({ signal }) }
      catch (error) {
        if (signal.aborted || error?.code === 'INVALID_RESPONSE') throw error
        return freeze({ defaultModels: [] })
      }
      if (!record(defaults) || !Array.isArray(defaults.defaultModels) || defaults.defaultModels.length > LIMITS.models
        || defaults.defaultModels.some(id => !identifier(id))) fail('INVALID_RESPONSE')
      return freeze({ defaultModels: [...new Set(defaults.defaultModels)] })
    })
  }
  async function bounded(life, timeout, options, task) {
    const op = life.operation(timeout, optionsSignal(options))
    try { return await op.wait(Promise.resolve().then(() => {
      if (op.signal.aborted) throw safeError(undefined, op.signal)
      return task(op.signal)
    })) }
    catch (error) { throw safeError(error, op.signal) }
    finally { op.finish() }
  }
  async function catalog(options = {}) {
    return bounded(lifetime, LIMITS.metadataMs, options, async signal => {
      const image = getModelServiceImage()
      const [chat, picture] = await Promise.all([
        (async () => {
          if (!hasChatRegistration() || typeof llm?.stream !== 'function') return { models: [], status: unavailable('unavailable') }
          try { return { ...await chatMetadata(signal), status: { available: true, reason: 'available' } } }
          catch (error) {
            if (signal.aborted) throw error
            if (error?.code === 'INVALID_RESPONSE') throw error
            return { models: [], status: publicFailure(error) }
          }
        })(),
        (async () => {
          if (!image) return { ...emptyImage(), status: unavailable('unavailable') }
          try {
            const status = await image.status({ signal })
            if (!record(status) || !REASONS.has(status.reason) || status.available !== (status.reason === 'available')) fail('INVALID_RESPONSE')
            if (!status.available) return { ...emptyImage(), status: { available: false, reason: status.reason } }
            try { return { ...imageCatalog(await image.models({ signal })), status: { available: true, reason: 'available' } } }
            catch (error) {
              error = safeError(error, signal)
              if (signal.aborted || error.code === 'INVALID_RESPONSE') throw error
              if (['UNAUTHENTICATED', 'FORBIDDEN', 'IMAGE_REVOKED'].includes(error.code)) return { ...emptyImage(), status: publicFailure(error) }
              // Generation remains usable with the server default, but no local
              // selection is safe until metadata can be read again.
              return { ...emptyImage(), catalogStatus: 'models-unavailable', status: { available: true, reason: 'available' } }
            }
          } catch (error) {
            if (signal.aborted || error?.code === 'INVALID_RESPONSE') throw error
            return { ...emptyImage(), status: publicFailure(error) }
          }
        })()
      ])
      const merged = new Map()
      for (const [models, capability] of [[chat.models, 'chat.completions'], [picture.models, 'image.generate']]) {
        for (const model of models) {
          const entry = merged.get(model.id)
          if (entry) entry.capabilities.push(capability)
          else merged.set(model.id, { ...model, capabilities: [capability] })
        }
      }
      const defaults = {}
      if (chat.defaultModel !== undefined) defaults['chat.completions'] = chat.defaultModel
      const preferredImage = picture.defaultModel?.id
      const imageDefaultModel = picture.defaultModel && (picture.selection === 'server-only' || picture.models.some(model => model.id === preferredImage)) ? picture.defaultModel : null
      if (picture.selection === 'request-local' && imageDefaultModel) defaults['image.generate'] = imageDefaultModel.id
      return freeze({ contractVersion: 1, models: [...merged.values()],
        defaults, imageDefaultModel,
        imageSelection: picture.selection, ...(picture.generationParameters ? { imageParameters: picture.generationParameters } : {}), imageCatalogStatus: picture.catalogStatus ?? (picture.models.length ? 'available' : 'default-only'),
        availability: { chat: chat.status, image: picture.status } })
    })
  }
  async function status(options = {}) {
    const result = await catalog(options)
    return freeze({ contractVersion: 1, availability: result.availability,
      capabilities: SUPPORTED.filter(capability => result.availability[capability === 'chat.completions' ? 'chat' : 'image'].available) })
  }
  function forConsumer(id) {
    if (lifetime.signal.aborted) fail('DISPOSED')
    if (!identifier(id)) fail('INVALID_REQUEST')
    const consumer = records.find(item => item.id === id)
    if (!consumer || consumer.status !== 'declared') fail('CONSUMER_UNAVAILABLE')
    const capabilities = Object.freeze(consumer.capabilities.filter(capability => SUPPORTED.includes(capability)))
    const life = createLifetime(lifetime.signal)
    let closed = false
    function binding() {
      let value
      try { const all = getBindings(); value = record(all) && Object.hasOwn(all, id) ? all[id] : undefined }
      catch { fail('FORBIDDEN') }
      if (value === undefined) return consumer.adapter === 'llm-pi-ai' || consumer.adapter === 'desktop-imagegen' || consumer.adapter === 'image-generation' ? { enabled: true } : { enabled: false }
      if (!record(value) || typeof value.enabled !== 'boolean'
        || (value.chatModel !== undefined && !identifier(value.chatModel)) || (value.imageModel !== undefined && !identifier(value.imageModel))) fail('FORBIDDEN')
      return value
    }
    function authorize(capability) {
      if (life.signal.aborted) fail('DISPOSED')
      if (!capabilities.includes(capability)) fail('FORBIDDEN')
      const selected = binding()
      if (!selected.enabled) fail('FORBIDDEN')
      return selected
    }
    async function scopedCatalog(options = {}) {
      return bounded(life, LIMITS.metadataMs, options, async signal => {
        const result = await catalog({ signal })
        const selected = binding()
        const enabled = selected.enabled
        const chat = enabled && capabilities.includes('chat.completions')
        const image = enabled && capabilities.includes('image.generate')
        const defaults = {}
        const imageDefault = selected.imageModel ?? result.defaults['image.generate']
        for (const [allowed, capability, model] of [
          [chat, 'chat.completions', selected.chatModel ?? result.defaults['chat.completions']],
          [image && result.availability.image.available, 'image.generate', imageDefault]
        ]) {
          // An unavailable explicit binding must not silently become the host default.
          if (allowed && result.models.some(item => item.id === model && item.capabilities.includes(capability))) defaults[capability] = model
        }
        return freeze({ ...result,
          models: enabled ? result.models.map(model => ({ ...model, capabilities: model.capabilities.filter(capability => capabilities.includes(capability)) })).filter(model => model.capabilities.length) : [],
          defaults,
          availability: { chat: chat ? result.availability.chat : unavailable(enabled ? 'not-declared' : 'not-connected'),
            image: image ? result.availability.image : unavailable(enabled ? 'not-declared' : 'not-connected') } })
      })
    }
    function stream(input, options = {}) {
      const selectedBinding = authorize('chat.completions')
      input = validateChat(input)
      const op = life.operation(LIMITS.chatMs, optionsSignal(options))
      let iterator
      let ended = false
      let pending = false
      let bytes = 0
      let events = 0
      let finished = false
      let initialized
      const cleanup = () => {
        if (ended) return
        ended = true
        op.signal.removeEventListener('abort', onAbort)
        try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* Never surface provider cleanup errors. */ }
        op.finish()
      }
      const onAbort = () => cleanup()
      op.signal.addEventListener('abort', onAbort, { once: true })
      async function init() {
        const explicitModel = input.model ?? selectedBinding.chatModel
        const metadata = explicitModel === undefined ? await op.wait(chatMetadata(op.signal))
          : { models: parseModels(await op.wait(chatTransport.models({ signal: op.signal }))) }
        const model = explicitModel ?? metadata.defaultModel
        if (!identifier(model) || typeof llm?.stream !== 'function' || !hasChatRegistration()) fail('UNAVAILABLE')
        if (!metadata.models.some(entry => entry.id === model)) fail('MODEL_UNAVAILABLE')
        const reasoningEffort = input.reasoningEffort
        if (op.signal.aborted) throw safeError(undefined, op.signal)
        const { model: _untrustedModel, reasoningEffort: _untrustedEffort, ...request } = input
        const source = llm.stream({ ...request, provider: 'pengbao', model, signal: op.signal,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
        if (!source || typeof source[Symbol.asyncIterator] !== 'function') fail('INVALID_RESPONSE')
        iterator = source[Symbol.asyncIterator]()
      }
      const result = {
        [Symbol.asyncIterator]() { return this },
        async next() {
          if (op.signal.aborted) throw safeError(undefined, op.signal)
          if (ended) return { done: true, value: undefined }
          if (pending) fail('INVALID_REQUEST')
          pending = true
          try {
            initialized ??= init()
            await op.wait(initialized)
            while (true) {
              const next = await op.wait(iterator.next())
              if (next.done) { if (!finished) fail('INVALID_RESPONSE'); cleanup(); return { done: true, value: undefined } }
              if (++events > 100_000) fail('TOO_LARGE')
              const value = chunkValue(next.value)
              if (!value) continue
              bytes += Buffer.byteLength(boundedJson(value, LIMITS.responseBytes))
              if (bytes > LIMITS.responseBytes) fail('TOO_LARGE')
              if (value.type === 'finish') { finished = true; cleanup() }
              return { done: false, value: freeze(value) }
            }
          } catch (error) { const failure = safeError(error, op.signal); cleanup(); throw failure }
          finally { pending = false }
        },
        async return() { op.abort('CANCELLED'); cleanup(); return { done: true, value: undefined } },
        async throw(error) { op.abort('CANCELLED'); cleanup(); throw safeError(error, op.signal) },
        cancel() { op.abort('CANCELLED'); cleanup() }
      }
      return Object.freeze(result)
    }
    const scope = {
      id, contractVersion: 1, capabilities, catalog: scopedCatalog,
      async status(options = {}) {
        const result = await scopedCatalog(options)
        return freeze({ contractVersion: 1, availability: result.availability,
          capabilities: capabilities.filter(capability => result.availability[capability === 'chat.completions' ? 'chat' : 'image'].available) })
      },
      ...(capabilities.includes('chat.completions') ? { chat: Object.freeze({ stream }) } : {}),
      ...(capabilities.includes('image.generate') ? { image: Object.freeze({
        async status(options = {}) {
          authorize('image.generate')
          return bounded(life, LIMITS.metadataMs, options, async signal => {
            const image = getModelServiceImage()
            if (!image) return unavailable('unavailable')
            const current = await image.status({ signal })
            if (!record(current) || !REASONS.has(current.reason) || current.available !== (current.reason === 'available')) fail('INVALID_RESPONSE')
            return { available: current.available, reason: current.reason }
          })
        },
        async models(options = {}) {
          authorize('image.generate')
          return bounded(life, LIMITS.metadataMs, options, async signal => {
            const image = getModelServiceImage()
            if (!image) fail('UNAVAILABLE')
            return freeze(imageCatalog(await image.models({ signal })))
          })
        },
        async generateMany(prompt, options = {}) {
          const selected = authorize('image.generate')
          if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || !record(options) ||
            Object.keys(options).some(key => !['model', 'size', 'signal', 'n', 'quality', 'detail', 'parameterContractVersion', 'parameterRevision'].includes(key)) ||
            (options.model !== undefined && !identifier(options.model)) || !Number.isSafeInteger(options.n) || options.n < 1 || options.n > 4) fail('INVALID_REQUEST')
          if (options.size !== undefined) {
            if (typeof options.size !== 'string' || options.size.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(options.size)) fail('INVALID_REQUEST')
            if (/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(options.size)) {
              const [width, height] = options.size.split('x').map(Number)
              if (width > 8192 || height > 8192 || width * height > 64_000_000) fail('INVALID_REQUEST')
            }
          }
          if (options.quality !== undefined && (typeof options.quality !== 'string' || options.quality.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(options.quality))) fail('INVALID_REQUEST')
          if (options.detail !== undefined && (typeof options.detail !== 'string' || options.detail.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(options.detail))) fail('INVALID_REQUEST')
          const { signal: callerSignal, ...parameters } = options
          const model = options.model ?? selected.imageModel
          // The configured OpenWebUI image API is authoritative for newer
          // generation parameters; metadata is used for model routing only.
          return bounded(life, LIMITS.imageMs, { signal: callerSignal }, async signal => {
            const image = getModelServiceImage()
            if (!image || typeof image.generateMany !== 'function') fail('UNSUPPORTED')
            const info = imageCatalog(await bounded(life, LIMITS.metadataMs, { signal }, child => image.models({ signal: child })))
            if (model !== undefined && info.selection !== 'request-local') fail('UNSUPPORTED')
            if (model !== undefined && !info.models.some(item => item.id === model)) fail('MODEL_UNAVAILABLE')
            // New OpenWebUI parameters are forwarded by the configured image API.
            // The desktop metadata contract is not a generation allowlist.
            const result = await image.generateMany(prompt, { ...parameters, ...(model === undefined ? {} : { model }), signal })
            if (!record(result) || result.requested !== parameters.n || !Array.isArray(result.images) || !Array.isArray(result.failures) ||
              result.images.length + result.failures.length !== parameters.n || result.complete !== (result.failures.length === 0)) fail('INVALID_RESPONSE')
            let total = 0
            const seen = new Set()
            const index = value => { if (!Number.isSafeInteger(value) || value < 0 || value >= parameters.n || seen.has(value)) fail('INVALID_RESPONSE'); seen.add(value); return value }
            const images = result.images.map(item => {
              if (!record(item) || !(item.data instanceof Uint8Array) || !['image/png', 'image/jpeg', 'image/webp'].includes(item.mime)) fail('INVALID_RESPONSE')
              index(item.index); total += item.data.byteLength
              if (!item.data.byteLength || item.data.byteLength > LIMITS.imageBytes || total > IMAGE_BATCH_BYTES) fail('TOO_LARGE')
              return { index: item.index, data: Buffer.from(item.data), mime: item.mime }
            })
            const failures = result.failures.map(item => {
              if (!record(item) || !['IMAGE_RESPONSE', 'IMAGE_NETWORK', 'IMAGE_TOO_LARGE', 'IMAGE_TIMEOUT', 'IMAGE_UPSTREAM_TIMEOUT', 'IMAGE_TIMEOUT_UNKNOWN', 'IMAGE_AUTH', 'IMAGE_FORBIDDEN', 'IMAGE_REVOKED', 'IMAGE_BUSY', 'IMAGE_PROVIDER_AUTH', 'IMAGE_PROVIDER_REJECTED', 'IMAGE_FETCH', 'IMAGE_STORE'].includes(item.code)) fail('INVALID_RESPONSE')
              const diagnostic = imageDiagnostic(item.diagnostic)
              return { index: index(item.index), code: item.code, ...(diagnostic?.code === item.code ? { diagnostic } : {}) }
            })
            return { requested: parameters.n, images, failures, complete: result.complete }
          }).catch(error => { throw safeImageGenerationError(error) })
        },
        async generate(prompt, options = {}) {
          const selected = authorize('image.generate')
          if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || !record(options)
            || Object.keys(options).some(key => !['model', 'size', 'n', 'quality', 'detail', 'signal'].includes(key))
            || (options.model !== undefined && !identifier(options.model))) fail('INVALID_REQUEST')
          if (options.size !== undefined) {
            if (typeof options.size !== 'string' || options.size.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(options.size)) fail('INVALID_REQUEST')
            if (/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(options.size)) {
              const [width, height] = options.size.split('x').map(Number)
              if (width > 8192 || height > 8192 || width * height > 64_000_000) fail('INVALID_REQUEST')
            }
          }
          const model = options.model ?? selected.imageModel
          const size = options.size
          return bounded(life, LIMITS.imageMs, { signal: options.signal }, async signal => {
            const image = getModelServiceImage()
            if (!image) fail('UNAVAILABLE')
            if (model !== undefined) {
              const info = await bounded(life, LIMITS.metadataMs, { signal }, child => image.models({ signal: child }))
              const catalog = imageCatalog(info)
              if (catalog.selection !== 'request-local') fail('UNSUPPORTED')
              if (!catalog.models.some(item => item.id === model)) fail('MODEL_UNAVAILABLE')
            }
            const bytes = await image.generate(prompt, { signal, ...(model === undefined ? {} : { model }), ...(size === undefined ? {} : { size }), ...(options.n === undefined ? {} : { n: options.n }), ...(options.quality === undefined ? {} : { quality: options.quality }), ...(options.detail === undefined ? {} : { detail: options.detail }) })
            if (!(bytes instanceof Uint8Array)) fail('INVALID_RESPONSE')
            if (!bytes.byteLength || bytes.byteLength > LIMITS.imageBytes) fail('TOO_LARGE')
            return Buffer.from(bytes)
          }).catch(error => { throw safeImageGenerationError(error) })
        }
      }) } : {}),
      dispose() { if (closed) return; closed = true; life.dispose(); scopes.delete(scope) }
    }
    scopes.add(scope)
    return Object.freeze(scope)
  }
  async function serviceImageStatus(options = {}) {
    return bounded(lifetime, LIMITS.metadataMs, options, async signal => {
      const image = getModelServiceImage()
      if (!image) return unavailable('unavailable')
      const current = await image.status({ signal })
      if (!record(current) || !REASONS.has(current.reason) || current.available !== (current.reason === 'available')) fail('INVALID_RESPONSE')
      return { available: current.available, reason: current.reason }
    })
  }
  return Object.freeze({ contractVersion: 1, catalog, status, imageStatus: serviceImageStatus, chatDefaults, forConsumer, consumers: () => records,
    dispose() { lifetime.dispose(); for (const scope of scopes) scope.dispose(); chatTransport.dispose?.() } })
}
