import { parseImageParameters } from './image-contract.js'
import { getPluginConfigurationRuntime } from './plugin-configuration-runtime.js'
import { randomUUID } from 'node:crypto'
import { imageSettingsConflict as imageConflict } from './image-settings.js'

const PREFIX = '/api/model-service.'
const SERVICE_NS = 'dsh-desktop-model-service'
const CHAT = 'chat.completions'
const IMAGE = 'image.generate'
const CAPABILITIES = [CHAT, IMAGE]
const TTL = 10 * 60_000
const MAX_RECORDS = 100
const dangerous = new Set(['__proto__', 'prototype', 'constructor'])
const own = (value, key) => value != null && Object.hasOwn(value, key)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) && !/https?:\/\//i.test(value)
const versioned = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const at = (value, path) => path.reduce((node, key) => own(node, key) ? node[key] : undefined, value)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function fail(code, status = 409) {
  throw Object.assign(new Error(code), { code, status })
}

// Discovery verifies the wrapper's dependency and resolved package version before
// adding adapter. Neither package names alone nor version ranges authorize edits.
export function connectionAdapter(consumer) {
  if (!consumer || consumer.status !== 'declared' || !versioned(consumer.version)) return 'needs-adapter'
  if (consumer.adapter === 'desktop-imagegen') return consumer.version === '0.1.0' ? 'desktop-imagegen' : 'needs-adapter'
  if (consumer.adapter === 'llm-pi-ai') return consumer.version === '0.2.2-alpha.2' ? 'already-connected' : 'needs-adapter'
  if (consumer.adapter === 'image-generation') return consumer.version === '0.1.0' ? 'already-connected' : 'needs-adapter'
  if (consumer.adapter !== undefined) return 'needs-adapter'
  return identifier(consumer.id) && !dangerous.has(consumer.id) && Array.isArray(consumer.capabilities) &&
    consumer.capabilities.length > 0 && consumer.capabilities.every(value => CAPABILITIES.includes(value)) ? 'facade' : 'needs-adapter'
}

function safeConsumer(value) {
  if (!identifier(value?.id)) return null
  return { id: value.id, version: versioned(value.version) ? value.version : null,
    status: ['declared', 'needs-adapter', 'invalid-declaration'].includes(value.status) ? value.status : 'needs-adapter',
    capabilities: CAPABILITIES.filter(capability => value.capabilities?.includes(capability)),
    adapter: connectionAdapter(value) }
}

function catalogView(raw) {
  const models = Array.isArray(raw?.models) ? raw.models.filter(model => identifier(model?.id)).slice(0, 512).map(model => ({
    id: model.id, name: identifier(model.alias) ? model.alias : identifier(model.name) ? model.name : model.id,
    capabilities: CAPABILITIES.filter(capability => model.capabilities?.includes(capability)),
  })) : []
  const availability = {}
  for (const [key, capability] of [['chat', CHAT], ['image', IMAGE]]) {
    const value = raw?.availability?.[capability] ?? raw?.availability?.[key]
    availability[key] = { available: value?.available === true,
      reason: ['available', 'disabled', 'forbidden', 'unauthenticated', 'unavailable', 'revoked', 'server-only', 'models-unavailable', 'not-connected', 'not-declared'].includes(value?.reason) ? value.reason : value?.available === true ? 'available' : 'unavailable' }
  }
  const chat = raw?.defaults?.[CHAT]
  const image = raw?.defaults?.[IMAGE]
  const modelById = new Map(models.map(model => [model.id, model]))
  const chatModel = identifier(chat) && models.some(model => model.id === chat && model.capabilities.includes(CHAT)) ? modelById.get(chat) : null
  const serverImage = raw?.imageDefaultModel
  const imageModel = identifier(image) && models.some(model => model.id === image && model.capabilities.includes(IMAGE)) ? modelById.get(image)
    : raw?.imageSelection === 'server-only' && identifier(serverImage?.id) ? { id: serverImage.id, name: identifier(serverImage.alias) ? serverImage.alias : identifier(serverImage.name) ? serverImage.name : serverImage.id } : null
  return { models, availability, ...(raw?.imageParameters ? { imageParameters: parseImageParameters(raw.imageParameters) } : {}), imageSelection: raw?.imageSelection === 'request-local' ? 'request-local' : 'server-only',
    imageCatalogStatus: ['available', 'default-only', 'models-unavailable'].includes(raw?.imageCatalogStatus) ? raw.imageCatalogStatus : 'default-only',
    defaults: { chat: chatModel ? { provider: 'pengbao', model: chatModel.id, name: chatModel.name } : null,
      image: imageModel ? { id: imageModel.id, name: imageModel.name } : null },
    video: { available: false, reason: 'unverified' } }
}

function validBinding(value) {
  return object(value) && Object.keys(value).every(key => ['enabled', 'chatModel', 'imageModel'].includes(key)) &&
    typeof value.enabled === 'boolean' && ['chatModel', 'imageModel'].every(key => value[key] === undefined || identifier(value[key]))
}

function imageDescriptor(all, consumers) {
  const candidates = new Set(['dsh-imagegen', 'imagegen', 'dsh-desktop-imagegen'])
  const adapter = consumers.find(item => item.adapter === 'desktop-imagegen' && item.status === 'declared')
  if (adapter) candidates.add(adapter.id)
  const matches = all.filter(item => candidates.has(item.ns))
  if (matches.length > 1) fail('CONFLICT')
  return matches[0]
}

function strictInput(input) {
  if (!object(input)) fail('INVALID_REQUEST', 400)
  if (input.action === 'default-chat' || input.action === 'default-image') fail('READ_ONLY', 403)
  const allowed = input.action === 'connect' ? ['action', 'consumerId', 'chatModel', 'imageModel']
    : ['action', 'skipConsumerIds']
  if (!['connect', 'connect-all'].includes(input.action) || Object.keys(input).some(key => !allowed.includes(key))) fail('INVALID_REQUEST', 400)
  if (input.action === 'connect' && (!identifier(input.consumerId) || dangerous.has(input.consumerId))) fail('INVALID_REQUEST', 400)
  if (input.action === 'connect-all' && input.skipConsumerIds !== undefined && (!Array.isArray(input.skipConsumerIds) || input.skipConsumerIds.length > MAX_RECORDS ||
    input.skipConsumerIds.some(id => !identifier(id) || dangerous.has(id)) || new Set(input.skipConsumerIds).size !== input.skipConsumerIds.length)) fail('INVALID_REQUEST', 400)
  for (const key of ['chatModel', 'imageModel']) if (input[key] !== undefined && input[key] !== '' && !identifier(input[key])) fail('INVALID_REQUEST', 400)
  return clone(input)
}

/**
 * Single-namespace transactions avoid claiming cross-plugin atomicity. Plans and
 * rollback receipts are process-local, short-lived and contain only whitelisted
 * nonsecret fields; profile credentials are never read, copied or rewritten.
 */
export function createModelServiceConnections(ctx, service, { videoModels = options => {
  const runtime = getPluginConfigurationRuntime(ctx)
  if (!runtime) fail('UNAVAILABLE')
  return runtime.videoModels(options)
} } = {}) {
  const plans = new Map()
  const receipts = new Map()
  let latestReceiptId = null
  let planRevision = 0
  let queue = Promise.resolve()
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next }
  const describe = () => {
    if (!ctx.settings?.describe) return []
    const result = ctx.settings.describe({ redactSecrets: true })
    if (!Array.isArray(result)) fail('READ_ONLY')
    return result
  }
  const writable = () => ctx.settings?.writable === true && typeof ctx.settings.mutate === 'function'
  const descriptor = (all, ns) => all.find(item => item.ns === ns)
  const requireDescriptor = (all, ns) => {
    const found = descriptor(all, ns)
    if (!found || !Number.isSafeInteger(found.revision) || !object(found.value) || !object(found.user) || !object(found.base)) fail('READ_ONLY')
    return found
  }
  const consumers = () => service.consumers?.() ?? []
  const catalog = async () => {
    const raw = await service.catalog()
    let image = raw?.availability?.image ?? raw?.availability?.[IMAGE]
    if (image?.available === true && typeof service.imageStatus === 'function') {
      image = await service.imageStatus()
    }
    return catalogView({ ...raw, availability: {
      chat: raw?.availability?.chat ?? raw?.availability?.[CHAT], image
    } })
  }
  const videoCatalog = async () => {
    const signal = AbortSignal.timeout(6_000)
    let onAbort
    try {
      const rows = await Promise.race([Promise.resolve().then(() => videoModels({ signal })), new Promise((_, reject) => {
        onAbort = () => reject(new Error('Video catalog unavailable'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })])
      if (!Array.isArray(rows) || rows.length > 256 || rows.some(row => !object(row) || !identifier(row.id) || !identifier(row.name) ||
        !['volcengine', 'alibaba', 'openai'].includes(row.provider) || !['ark', 'dashscope', 'openai', 'newapi'].includes(row.protocol)) ||
        new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Invalid video catalog')
      const models = rows.map(({ id, name, provider, protocol, default: selected }) => ({ id, name, provider, protocol, ...(selected === true ? { default: true } : {}) }))
      // Mirror the server's own resolution: its configured default, else the first model.
      const defaultModel = models.find(model => model.default === true)?.id ?? models[0]?.id ?? ''
      return { available: rows.length > 0, reason: rows.length ? 'available' : 'no-models', models, defaultModel }
    } catch { return { available: false, reason: 'unavailable', models: [], defaultModel: '' } }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
  }
  const remember = (map, record) => {
    for (const [id, item] of map) if (item.expires <= Date.now()) map.delete(id)
    while (map.size >= MAX_RECORDS) map.delete(map.keys().next().value)
    const id = randomUUID()
    map.set(id, { ...record, expires: Date.now() + TTL })
    return id
  }
  const get = (map, id) => {
    if (typeof id !== 'string') fail('INVALID_REQUEST', 400)
    const record = map.get(id)
    if (!record || record.expires <= Date.now()) { map.delete(id); fail('PLAN_EXPIRED') }
    return record
  }
  const selected = (view, capability, id) => {
    if (!view.availability[capability === CHAT ? 'chat' : 'image'].available) fail('UNAVAILABLE')
    if (capability === IMAGE && view.imageSelection !== 'request-local') fail('SERVER_ONLY')
    if (!view.models.some(model => model.id === id && model.capabilities.includes(capability))) fail('MODEL_UNAVAILABLE')
  }
  const change = (desc, path, value) => {
    // All callers below supply fixed paths and validated primitive/binding values.
    const before = at(desc.value, path)
    const user = at(desc.user, path)
    if (equal(before, value)) return null
    const bindingObject = path[0] === 'bindings' && path.length === 2
    if (before !== undefined && typeof before === 'object' && !(bindingObject && validBinding(before))) fail('CONFLICT')
    if (user !== undefined && typeof user === 'object' && !(bindingObject && validBinding(user))) fail('CONFLICT')
    return { path, before: clone(before), value: clone(value), undo: user === undefined ? { op: 'unset', path } : { op: 'set', path, value: clone(user) } }
  }
  async function build(input) {
    const all = describe()
    const view = await catalog()
    if (input.action === 'connect-all') {
      const skipped = new Set(input.skipConsumerIds ?? [])
      const candidates = consumers().filter(consumer => connectionAdapter(consumer) === 'facade')
      const namespace = requireDescriptor(all, SERVICE_NS)
      const bindingConfig = at(namespace.value, ['bindings']) ?? {}
      if (!object(bindingConfig)) fail('CONFLICT')
      const changes = []
      const planned = []
      for (const consumer of candidates) {
        if (skipped.has(consumer.id)) {
          planned.push({ id: consumer.id, state: 'skipped' })
          continue
        }
        const before = at(bindingConfig, [consumer.id])
        if (before !== undefined && (!validBinding(before) || before.enabled === false)) {
          planned.push({ id: consumer.id, state: 'conflict', reason: 'binding-conflict' })
          continue
        }
        const next = { ...(before ?? {}), enabled: true }
        const changeItem = change(namespace, ['bindings', consumer.id], next)
        planned.push({ id: consumer.id, state: changeItem ? 'ready' : 'already-connected' })
        if (changeItem) changes.push(changeItem)
      }
      const requestedChanges = changes.map(({ path, value }) => ({ op: 'set', path, value }))
      if (requestedChanges.length && !writable()) fail('READ_ONLY')
      return { input, target: 'connect-all', adapter: 'facade-batch', namespace: namespace.ns,
        revision: namespace.revision, state: requestedChanges.length ? 'ready' : 'already-connected',
        changes, candidates: planned }
    }
    let desc, adapter, target, requested = []
    if (input.action === 'connect') {
      const consumer = consumers().find(item => item.id === input.consumerId)
      adapter = connectionAdapter(consumer)
      target = input.consumerId
      if (adapter === 'needs-adapter') fail('NEEDS_ADAPTER')
      if (adapter === 'already-connected') {
        if (input.chatModel !== undefined || input.imageModel !== undefined) fail('USE_DEFAULT_SELECTION', 400)
        return { input, target, adapter, state: 'already-connected', changes: [] }
      }
      if (adapter === 'desktop-imagegen') {
        if (input.chatModel !== undefined || input.imageModel !== undefined) fail('USE_DEFAULT_SELECTION', 400)
        desc = imageDescriptor(all, consumers())
        if (!desc) fail('READ_ONLY')
        if (imageConflict(desc)) fail('CONFLICT')
        if (!view.availability.image.available) fail('UNAVAILABLE')
        return { input, target, adapter, state: 'already-connected', namespace: desc.ns, revision: desc.revision, changes: [] }
      }
      desc = requireDescriptor(all, SERVICE_NS)
      const binding = at(desc.value, ['bindings', input.consumerId])
      if (binding !== undefined && (!validBinding(binding) || binding.enabled === false)) fail('CONFLICT')
      const next = { ...(binding ?? {}), enabled: true }
      for (const [key, capability] of [['chatModel', CHAT], ['imageModel', IMAGE]]) {
        if (input[key] === undefined) continue
        if (!consumer.capabilities.includes(capability)) fail('INVALID_REQUEST', 400)
        if (input[key] === '') delete next[key]
        else { selected(view, capability, input[key]); next[key] = input[key] }
      }
      requested = [[['bindings', input.consumerId], next]]
    }
    const changes = requested.map(([path, value]) => change(desc, path, value)).filter(Boolean)
    if (changes.length && !writable()) fail('READ_ONLY')
    return { input, target, adapter, namespace: desc.ns, revision: desc.revision,
      changes: changes.map(item => ({ ...item, afterRevision: undefined })),
      state: changes.length ? 'ready' : 'already-connected' }
  }
  const publicPlan = (id, plan) => ({ id, target: plan.target, adapter: plan.adapter, state: plan.state,
        ...(plan.candidates ? { candidates: plan.candidates.map(item => ({ ...item })) } : {}),
    ...(plan.namespace ? { namespace: plan.namespace, revision: plan.revision } : {}),
    changes: plan.changes.map(item => ({ path: [...item.path], before: clone(item.before ?? null), after: clone(item.value) })),
    expiresAt: plan.expires })

  return {
    async overview() {
      const all = describe()
      const [view, video] = await Promise.all([catalog(), videoCatalog()])
      const bindingConfig = descriptor(all, SERVICE_NS)?.value?.bindings
      const image = imageDescriptor(all, consumers())
      const records = consumers().map(item => {
        const record = safeConsumer(item)
        if (!record) return null
        const binding = at(bindingConfig, [item.id])
        const adapter = record.adapter
        let state = adapter === 'needs-adapter' ? 'needs-adapter' : adapter === 'already-connected' ? 'already-connected' : 'not-connected'
        if (adapter === 'desktop-imagegen') state = !image ? 'read-only' : 'already-connected'
        if (adapter === 'facade') state = binding === undefined ? 'not-connected' : !validBinding(binding) || binding.enabled === false ? 'conflict' : 'connected'
        return { ...record, state, ...(validBinding(binding) ? { selection: { ...(binding.chatModel ? { chatModel: binding.chatModel } : {}), ...(binding.imageModel ? { imageModel: binding.imageModel } : {}) } } : {}) }
      }).filter(Boolean)
      return { ...view, video, writable: writable(), consumers: records,
        editable: { chat: false, image: false },
        ...(latestReceiptId && receipts.get(latestReceiptId)?.expires > Date.now() ? { rollbackAvailable: true, receiptId: latestReceiptId } : {}) }
    },
    async plan(input) {
      // A replacement preview supersedes old previews even when validation or
      // discovery fails. An older in-flight request must not revive one either.
      const revision = ++planRevision
      plans.clear()
      const plan = await build(strictInput(input))
      if (revision !== planRevision) fail('PLAN_EXPIRED')
      const id = remember(plans, plan)
      return publicPlan(id, plans.get(id))
    },
    apply(input) {
      return serial(async () => {
        if (!object(input) || Object.keys(input).length !== 1 || !own(input, 'planId')) fail('INVALID_REQUEST', 400)
        const plan = get(plans, input.planId)
        const current = await build(plan.input)
        if (get(plans, input.planId) !== plan) fail('PLAN_EXPIRED')
        if (!equal(current, { ...plan, expires: undefined })) fail('CONFLICT')
        if (!plan.changes.length) { plans.delete(input.planId); return { state: 'already-connected', rollbackAvailable: false } }
        if (!writable()) fail('READ_ONLY')
        await ctx.settings.mutate(plan.namespace, plan.changes.map(item => ({ op: 'set', path: item.path, value: item.value })), plan.revision)
        plans.delete(input.planId)
        const after = descriptor(describe(), plan.namespace)
        // A mutation without an authoritative redacted readback is not success.
        // Do not create a rollback receipt for a write whose persisted value is unknown.
        if (!after || !Number.isSafeInteger(after.revision) || plan.changes.some(item => !equal(at(after.value, item.path), item.value))) {
          return { state: 'verification-failed', rollbackAvailable: false }
        }
        const receiptId = remember(receipts, { namespace: plan.namespace, revision: after.revision, changes: plan.changes })
        latestReceiptId = receiptId
        return { state: 'applied', rollbackAvailable: true, receiptId, revision: after.revision }
      })
    },
    rollback(input) {
      return serial(async () => {
        if (!object(input) || Object.keys(input).length !== 1 || !own(input, 'receiptId')) fail('INVALID_REQUEST', 400)
        const receipt = get(receipts, input.receiptId)
        if (!writable()) fail('READ_ONLY')
        const current = descriptor(describe(), receipt.namespace)
        if (!current || current.revision !== receipt.revision || receipt.changes.some(item => !equal(at(current.value, item.path), item.value))) fail('CONFLICT')
        await ctx.settings.mutate(receipt.namespace, receipt.changes.map(item => item.undo), receipt.revision)
        const after = descriptor(describe(), receipt.namespace)
        if (!after || receipt.changes.some(item => !equal(at(after.value, item.undo.path), item.undo.op === 'unset' ? undefined : item.undo.value))) {
          return { state: 'verification-failed' }
        }
        receipts.delete(input.receiptId)
        if (latestReceiptId === input.receiptId) latestReceiptId = null
        return { state: 'rolled-back' }
      })
    },
    dispose() { planRevision++; plans.clear(); receipts.clear(); latestReceiptId = null },
  }
}

async function readInput(request, expectedOrigin) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('INVALID_REQUEST', 400)
  const origin = request.headers.get('origin')
  if (origin && origin !== (expectedOrigin ?? new URL(request.url).origin)) fail('FORBIDDEN', 403)
  if (!request.body) fail('INVALID_REQUEST', 400)
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 4096) fail('INVALID_REQUEST', 413)
      chunks.push(part.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('INVALID_REQUEST', 400) }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function setupModelServiceConnections(ctx, service) {
  const controller = createModelServiceConnections(ctx, service)
  for (const endpoint of ['overview', 'plan', 'apply', 'rollback']) {
    ctx.connection.fetch.register({ path: `${PREFIX}${endpoint}`, methods: [endpoint === 'overview' ? 'GET' : 'POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          // The connection carrier uses http://dsh.internal internally; the
          // listener-owned origin, never Host/Forwarded headers, is authoritative.
          const expectedOrigin = ctx.webServer?.getOrigin?.()
          const result = await controller[endpoint](endpoint === 'overview' ? undefined : await readInput(request, expectedOrigin))
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
        } catch (error) {
          const codes = ['INVALID_REQUEST', 'FORBIDDEN', 'READ_ONLY', 'CONFLICT', 'NEEDS_ADAPTER', 'USE_DEFAULT_SELECTION', 'UNAVAILABLE', 'SERVER_ONLY', 'MODEL_UNAVAILABLE', 'PLAN_EXPIRED']
          const code = error?.code === 'SETTINGS_CONFLICT' ? 'CONFLICT' : codes.includes(error?.code) ? error.code : 'UNAVAILABLE'
          return Response.json({ code }, { status: codes.includes(error?.code) ? error.status : code === 'CONFLICT' ? 409 : 503, headers: { 'Cache-Control': 'no-store' } })
        }
      } })
  }
  ctx.effect?.(() => () => controller.dispose(), 'model-service connection plans')
  return controller
}
