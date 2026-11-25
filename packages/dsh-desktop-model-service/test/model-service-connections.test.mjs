import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionAdapter, createModelServiceConnections, setupModelServiceConnections } from '../connections.js'

const NS = 'dsh-desktop-model-service'
const CHAT = 'chat.completions'
const IMAGE = 'image.generate'
const copy = value => structuredClone(value)
const consumer = (id, extra = {}) => ({ id, version: '0.1.0', status: 'declared', capabilities: [CHAT], ...extra })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const merge = (base, user) => {
  const result = copy(base)
  for (const [key, value] of Object.entries(user)) result[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? merge(result[key] && typeof result[key] === 'object' ? result[key] : {}, value) : copy(value)
  return result
}

function fixture(options = {}) {
  const rows = [{ ns: NS, revision: 7, base: { bindings: options.baseBindings ?? {} }, user: { bindings: options.bindings ?? {} } },
    { ns: 'agent-default-model', revision: 2, base: { provider: 'pengbao', model: 'chat-model' }, user: {} },
    { ns: 'dsh-imagegen', revision: 3, base: { desktopImageMode: 'inherit', desktopImageModelId: '' }, user: {} }]
  const writes = []
  const records = options.consumers ?? [consumer('first'), consumer('second', { capabilities: [IMAGE] })]
  const catalog = {
    models: [{ id: 'chat-model', capabilities: [CHAT] }, { id: 'image-model', capabilities: [IMAGE] }],
    availability: { chat: { available: true, reason: 'available' }, image: { available: true, reason: 'available' } },
    defaults: { [CHAT]: 'chat-model', [IMAGE]: 'image-model' }, imageSelection: 'request-local', imageCatalogStatus: 'available'
  }
  const settings = {
    writable: options.writable ?? true,
    describe(input) {
      assert.deepEqual(input, { redactSecrets: true })
      return rows.map(row => ({ ...copy(row), value: merge(row.base, row.user) }))
    },
    async mutate(ns, ops, revision) {
      const row = rows.find(item => item.ns === ns)
      assert.equal(revision, row.revision, 'all writes must carry the preview/receipt revision')
      writes.push({ ns, ops: copy(ops), revision })
      for (const op of ops) {
        let parent = row.user
        for (const key of op.path.slice(0, -1)) parent = parent[key] ??= {}
        if (op.op === 'unset') delete parent[op.path.at(-1)]
        else parent[op.path.at(-1)] = copy(op.value)
      }
      row.revision++
    }
  }
  const service = { consumers: () => copy(records), catalog: async () => copy(catalog) }
  const ctx = { settings }
  const controller = createModelServiceConnections(ctx, service, { videoModels: options.videoModels })
  return { controller, ctx, rows, writes, records, catalog, service }
}

test('overview exposes only bounded public video metadata without expanding facade model authority', async () => {
  const f = fixture({ videoModels: async () => [
    { id: 'doubao-seedance-2-5-260628', name: 'Seedance', provider: 'volcengine', protocol: 'ark', apiKey: 'must-not-expose', endpoint: 'https://private.invalid' },
    { id: 'sora-2', name: 'Sora', provider: 'openai', protocol: 'openai', default: true }
  ] })
  const result = await f.controller.overview()
  assert.deepEqual(result.video, { available: true, reason: 'available', models: [
    { id: 'doubao-seedance-2-5-260628', name: 'Seedance', provider: 'volcengine', protocol: 'ark' },
    { id: 'sora-2', name: 'Sora', provider: 'openai', protocol: 'openai', default: true }
  ], defaultModel: 'sora-2' })
  assert.equal(result.models.some(model => model.id.startsWith('doubao-')), false)
  assert.equal(JSON.stringify(result).includes('must-not-expose'), false)
  assert.equal(JSON.stringify(result).includes('private.invalid'), false)
})

test('unavailable or malformed video catalog leaves ordinary overview available', async () => {
  for (const videoModels of [async () => { throw new Error('fixture secret') }, async () => [{ id: 'sora-2', name: 'Sora', provider: 'unknown', protocol: 'openai' }]]) {
    const result = await fixture({ videoModels }).controller.overview()
    assert.deepEqual(result.video, { available: false, reason: 'unavailable', models: [], defaultModel: '' })
    assert.equal(result.availability.chat.available, true)
    assert.equal(result.availability.image.available, true)
  }
  assert.deepEqual((await fixture({ videoModels: async () => [] }).controller.overview()).video,
    { available: false, reason: 'no-models', models: [], defaultModel: '' })
})

test('connect-all previews only declared facade consumers, skips conflicts and preserves selections', async () => {
  const f = fixture({ bindings: {
    disabled: { enabled: false }, custom: { enabled: true, apiKey: 'not-a-binding-field' },
    connected: { enabled: true, chatModel: 'chat-model' }
  }, consumers: [consumer('first'), consumer('second', { capabilities: [IMAGE] }), consumer('disabled'), consumer('custom'),
    consumer('connected'), consumer('undeclared', { status: 'needs-adapter' }),
    consumer('llm', { adapter: 'llm-pi-ai', version: '0.2.2-alpha.2' }),
    consumer('imagegen', { adapter: 'desktop-imagegen' }), consumer('video', { capabilities: ['video.generate'] })] })
  const plan = await f.controller.plan({ action: 'connect-all' })
  assert.equal(plan.namespace, NS)
  assert.equal(plan.revision, 7)
  assert.equal(plan.state, 'ready')
  assert.deepEqual(plan.candidates, [
    { id: 'first', state: 'ready' }, { id: 'second', state: 'ready' },
    { id: 'disabled', state: 'conflict', reason: 'binding-conflict' },
    { id: 'custom', state: 'conflict', reason: 'binding-conflict' }, { id: 'connected', state: 'already-connected' }
  ])
  assert.deepEqual(plan.changes.map(item => item.path), [['bindings', 'first'], ['bindings', 'second']])
  assert.equal(f.writes.length, 0)
  assert.equal(JSON.stringify(plan).includes('not-a-binding-field'), false)
  const result = await f.controller.apply({ planId: plan.id })
  assert.equal(result.rollbackAvailable, true)
  assert.equal(result.revision, 8)
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.writes[0].ops, [
    { op: 'set', path: ['bindings', 'first'], value: { enabled: true } },
    { op: 'set', path: ['bindings', 'second'], value: { enabled: true } }
  ])
  assert.deepEqual(f.rows[0].user.bindings.connected, { enabled: true, chatModel: 'chat-model' })
  assert.deepEqual(f.rows[0].user.bindings.disabled, { enabled: false })
  assert.equal((await f.controller.overview()).video.reason, 'unavailable')
})

test('skip, reinclude and skip-all plans replace previews without writing until apply', async () => {
  const { controller, writes } = fixture()
  const first = await controller.plan({ action: 'connect-all' })
  const skipped = await controller.plan({ action: 'connect-all', skipConsumerIds: ['first'] })
  assert.deepEqual(skipped.candidates, [{ id: 'first', state: 'skipped' }, { id: 'second', state: 'ready' }])
  assert.deepEqual(skipped.changes.map(item => item.path), [['bindings', 'second']])
  await assert.rejects(controller.apply({ planId: first.id }), { code: 'PLAN_EXPIRED' })
  const reincluded = await controller.plan({ action: 'connect-all', skipConsumerIds: [] })
  assert.equal(reincluded.changes.length, 2)
  await assert.rejects(controller.apply({ planId: skipped.id }), { code: 'PLAN_EXPIRED' })
  const none = await controller.plan({ action: 'connect-all', skipConsumerIds: ['first', 'second'] })
  assert.equal(none.state, 'already-connected')
  assert.deepEqual(none.changes, [])
  assert.deepEqual(await controller.apply({ planId: none.id }), { state: 'already-connected', rollbackAvailable: false })
  assert.equal(writes.length, 0)
})

test('invalid or failed replans invalidate the previously applicable preview', async () => {
  const f = fixture()
  let old = await f.controller.plan({ action: 'connect-all' })
  await assert.rejects(f.controller.plan({ action: 'connect-all', skipConsumerIds: ['first', 'first'] }), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.controller.apply({ planId: old.id }), { code: 'PLAN_EXPIRED' })
  old = await f.controller.plan({ action: 'connect-all' })
  f.service.catalog = async () => { throw new Error('catalog failed') }
  await assert.rejects(f.controller.plan({ action: 'connect-all', skipConsumerIds: ['first'] }), /catalog failed/)
  await assert.rejects(f.controller.apply({ planId: old.id }), { code: 'PLAN_EXPIRED' })
  assert.equal(f.writes.length, 0)
})

test('out-of-order replans and disposal cannot revive older in-flight previews', async () => {
  const f = fixture()
  const waiting = deferred()
  f.service.catalog = () => waiting.promise
  const old = f.controller.plan({ action: 'connect-all' })
  f.service.catalog = async () => copy(f.catalog)
  const latest = await f.controller.plan({ action: 'connect-all', skipConsumerIds: ['first'] })
  waiting.resolve(copy(f.catalog))
  await assert.rejects(old, { code: 'PLAN_EXPIRED' })
  await f.controller.apply({ planId: latest.id })
  assert.deepEqual(f.writes[0].ops.map(item => item.path), [['bindings', 'second']])
  const pending = deferred()
  f.service.catalog = () => pending.promise
  const disposed = f.controller.plan({ action: 'connect-all' })
  f.controller.dispose()
  pending.resolve(copy(f.catalog))
  await assert.rejects(disposed, { code: 'PLAN_EXPIRED' })
})

test('replanning while apply revalidates prevents the old write', async () => {
  const f = fixture()
  const plan = await f.controller.plan({ action: 'connect-all' })
  const waiting = deferred()
  const entered = deferred()
  f.service.catalog = () => { entered.resolve(); return waiting.promise }
  const applying = f.controller.apply({ planId: plan.id })
  await entered.promise
  await assert.rejects(f.controller.plan({ action: 'guess-config' }), { code: 'INVALID_REQUEST' })
  waiting.resolve(copy(f.catalog))
  await assert.rejects(applying, { code: 'PLAN_EXPIRED' })
  assert.equal(f.writes.length, 0)
})

test('apply revalidates settings revision and consumer eligibility, including skip candidates', async () => {
  for (const update of [
    f => { f.rows[0].revision++ },
    f => { f.records[0].status = 'needs-adapter' },
    f => { f.rows[0].user.bindings.second = { enabled: false } }
  ]) {
    const f = fixture()
    const plan = await f.controller.plan({ action: 'connect-all', skipConsumerIds: ['first'] })
    update(f)
    await assert.rejects(f.controller.apply({ planId: plan.id }), { code: 'CONFLICT' })
    assert.equal(f.writes.length, 0)
  }
})

test('rollback restores inherited/unset fields and never overwrites a later revision', async () => {
  const f = fixture({ baseBindings: { inherited: { enabled: true, chatModel: 'chat-model' } }, bindings: { existing: { enabled: true, chatModel: 'chat-model' } },
    consumers: [consumer('first'), consumer('inherited'), consumer('existing')] })
  const before = copy(f.rows[0].user)
  const plan = await f.controller.plan({ action: 'connect-all' })
  const result = await f.controller.apply({ planId: plan.id })
  assert.equal((await f.controller.overview()).receiptId, result.receiptId)
  await assert.rejects(f.controller.apply({ planId: plan.id }), { code: 'PLAN_EXPIRED' })
  assert.deepEqual(await f.controller.rollback({ receiptId: result.receiptId }), { state: 'rolled-back' })
  assert.deepEqual(f.rows[0].user, before)
  assert.equal((await f.controller.overview()).rollbackAvailable, undefined)
  await assert.rejects(f.controller.rollback({ receiptId: result.receiptId }), { code: 'PLAN_EXPIRED' })
  const newer = await f.controller.plan({ action: 'connect-all' })
  const applied = await f.controller.apply({ planId: newer.id })
  f.rows[0].revision++
  await assert.rejects(f.controller.rollback({ receiptId: applied.receiptId }), { code: 'CONFLICT' })
  assert.equal(f.writes.length, 3)
})

test('explicit per-consumer selections are validated and rollback restores their original user layer', async () => {
  const f = fixture({ bindings: { first: { enabled: true, chatModel: 'chat-model' } } })
  await assert.rejects(f.controller.plan({ action: 'connect', consumerId: 'first', imageModel: 'image-model' }), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.controller.plan({ action: 'connect', consumerId: 'first', chatModel: 'missing' }), { code: 'MODEL_UNAVAILABLE' })
  const plan = await f.controller.plan({ action: 'connect', consumerId: 'first', chatModel: '' })
  const result = await f.controller.apply({ planId: plan.id })
  assert.deepEqual(f.rows[0].user.bindings.first, { enabled: true })
  await f.controller.rollback({ receiptId: result.receiptId })
  assert.deepEqual(f.rows[0].user.bindings.first, { enabled: true, chatModel: 'chat-model' })
})

test('overview exposes display names for current server defaults without changing their IDs or settings', async () => {
  const f = fixture()
  const before = copy(f.rows)
  for (const mode of ['alias', 'name', 'id']) {
    f.catalog.models = [
      { id: 'chat-model', capabilities: [CHAT], ...(mode !== 'id' ? { name: 'Chat name' } : {}), ...(mode === 'alias' ? { alias: 'Chat alias' } : {}) },
      { id: 'image-model', capabilities: [IMAGE], ...(mode !== 'id' ? { name: 'Image name' } : {}), ...(mode === 'alias' ? { alias: 'Image alias' } : {}) }
    ]
    const view = await f.controller.overview()
    assert.deepEqual(view.defaults, {
      chat: { provider: 'pengbao', model: 'chat-model', name: mode === 'id' ? 'chat-model' : `Chat ${mode}` },
      image: { id: 'image-model', name: mode === 'id' ? 'image-model' : `Image ${mode}` }
    })
    assert.deepEqual(view.editable, { chat: false, image: false })
    assert.equal(view.models.some(model => Object.hasOwn(model, 'alias')), false, 'aliases normalize into display names, not selection IDs')
  }
  assert.deepEqual(f.rows, before)
  assert.deepEqual(f.writes, [])
})

test('server-only image defaults retain their alias, name or ID as display-only metadata', async () => {
  const f = fixture()
  f.catalog.imageSelection = 'server-only'
  delete f.catalog.defaults[IMAGE]
  f.catalog.models = f.catalog.models.filter(model => model.capabilities.includes(CHAT))
  for (const [metadata, name] of [
    [{ alias: 'Server alias', name: 'Underlying name' }, 'Server alias'],
    [{ alias: '', name: 'Server name' }, 'Server name'],
    [{ alias: '\nunsafe', name: 'Server name' }, 'Server name'],
    [{ name: 'https://invalid.test/private' }, 'server-image'],
    [{}, 'server-image']
  ]) {
    f.catalog.imageDefaultModel = { id: 'server-image', ...metadata }
    const view = await f.controller.overview()
    assert.deepEqual(view.defaults.image, { id: 'server-image', name })
    assert.equal(view.models.some(model => model.id === 'server-image'), false)
    assert.equal(view.imageSelection, 'server-only')
    assert.equal(view.editable.image, false)
  }
  assert.deepEqual(f.writes, [])
})

test('missing or capability-mismatched defaults never borrow the first catalog model for display', async () => {
  const f = fixture()
  for (const defaults of [{}, { [CHAT]: 'missing-chat', [IMAGE]: 'missing-image' }, { [CHAT]: 'image-model', [IMAGE]: 'chat-model' }]) {
    f.catalog.defaults = defaults
    assert.deepEqual((await f.controller.overview()).defaults, { chat: null, image: null })
  }
  assert.deepEqual(f.writes, [])
})

test('default edits are rejected because foundation defaults are server-owned', async () => {
  const f = fixture()
  await assert.rejects(f.controller.plan({ action: 'default-chat', modelId: 'chat-model' }), { code: 'READ_ONLY' })
  await assert.rejects(f.controller.plan({ action: 'default-image', modelId: 'image-model' }), { code: 'READ_ONLY' })
})


test('expired plans/receipts and plans that expire during revalidation cannot write', async t => {
  const now = Date.now()
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  const f = fixture()
  const expired = await f.controller.plan({ action: 'connect-all' })
  clock += 10 * 60_000 + 1
  await assert.rejects(f.controller.apply({ planId: expired.id }), { code: 'PLAN_EXPIRED' })
  const fresh = await f.controller.plan({ action: 'connect-all' })
  const result = await f.controller.apply({ planId: fresh.id })
  clock += 10 * 60_000 + 1
  await assert.rejects(f.controller.rollback({ receiptId: result.receiptId }), { code: 'PLAN_EXPIRED' })
  assert.equal((await f.controller.overview()).rollbackAvailable, undefined)
  const waiting = deferred()
  const entered = deferred()
  const noChanges = await f.controller.plan({ action: 'connect-all' })
  f.service.catalog = () => { entered.resolve(); return waiting.promise }
  const applying = f.controller.apply({ planId: noChanges.id })
  await entered.promise
  clock += 10 * 60_000 + 1
  waiting.resolve(copy(f.catalog))
  await assert.rejects(applying, { code: 'PLAN_EXPIRED' })
  assert.equal(f.writes.length, 1)
})

test('public previews cannot mutate private planned values or rollback paths', async () => {
  const f = fixture()
  const plan = await f.controller.plan({ action: 'connect-all' })
  plan.changes[0].path[0] = 'credentials'
  plan.changes[0].after.enabled = false
  await f.controller.apply({ planId: plan.id })
  assert.deepEqual(f.writes[0].ops[0], { op: 'set', path: ['bindings', 'first'], value: { enabled: true } })
})

test('read-only, malformed bindings, dangerous identifiers and unreviewed adapters are rejected', async () => {
  const readOnly = fixture({ writable: false })
  await assert.rejects(readOnly.controller.plan({ action: 'connect-all' }), { code: 'READ_ONLY' })
  const malformed = fixture({ bindings: [] })
  await assert.rejects(malformed.controller.plan({ action: 'connect-all' }), { code: 'CONFLICT' })
  for (const skipConsumerIds of [['__proto__'], ['constructor'], [' first'], [null], 'first']) {
    await assert.rejects(fixture().controller.plan({ action: 'connect-all', skipConsumerIds }), { code: 'INVALID_REQUEST' })
  }
  assert.equal(connectionAdapter(consumer('imagegen', { adapter: 'desktop-imagegen', version: '0.2.0' })), 'needs-adapter')
  assert.equal(connectionAdapter(consumer('llm', { adapter: 'llm-pi-ai', version: '0.2.1' })), 'needs-adapter')
  assert.equal(connectionAdapter(consumer('video', { capabilities: ['video.generate'] })), 'needs-adapter')
  assert.equal(connectionAdapter(consumer('guessed', { adapter: 'guessed-config' })), 'needs-adapter')
})

test('redacted settings are not writable by default actions', async () => {
  const f = fixture({ consumers: [consumer('imagegen', { adapter: 'desktop-imagegen', capabilities: [IMAGE] })] })
  assert.equal((await f.controller.overview()).editable.image, false)
  await assert.rejects(f.controller.plan({ action: 'default-image', modelId: 'image-model' }), { code: 'READ_ONLY' })
})

test('normalized carrier URL accepts only the listener-owned browser origin, never forwarded authority', async () => {
  const f = fixture()
  const routes = new Map()
  setupModelServiceConnections({ ...f.ctx, webServer: { getOrigin: () => 'http://127.0.0.1:31999' },
    connection: { fetch: { register: route => routes.set(route.path, route) } } }, f.service)
  for (const [origin, status] of [['http://127.0.0.1:31999', 200], ['http://dsh.internal', 403], ['http://attacker.invalid', 403]]) {
    const response = await routes.get('/api/model-service.plan').fetch(new Request('http://dsh.internal/api/model-service.plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Host: 'attacker.invalid', 'X-Forwarded-Host': 'attacker.invalid' },
      body: JSON.stringify({ action: 'connect-all' })
    }))
    assert.equal(response.status, status)
  }
})

test('HTTP routes enforce same-origin JSON, whitelist errors, redact unexpected failures and disable caching', async () => {
  const f = fixture()
  const routes = new Map()
  setupModelServiceConnections({ ...f.ctx, connection: { fetch: { register: route => routes.set(route.path, route) } } }, f.service)
  const request = (endpoint, body, headers = {}) => new Request(`http://desktop.local/api/model-service.${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  })
  const planRoute = routes.get('/api/model-service.plan')
  assert.deepEqual(planRoute.methods, ['POST'])
  let response = await planRoute.fetch(request('plan', { action: 'connect-all' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const plan = await response.json()
  response = await planRoute.fetch(request('plan', { action: 'connect-all' }, { 'Content-Type': 'text/plain' }))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { code: 'INVALID_REQUEST' })
  response = await planRoute.fetch(request('plan', { action: 'connect-all', skipConsumerIds: ['x'.repeat(4096)] }))
  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { code: 'INVALID_REQUEST' })
  response = await planRoute.fetch(request('plan', { action: 'connect-all' }, { Origin: 'http://other.local' }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { code: 'FORBIDDEN' })
  f.ctx.settings.mutate = async () => { throw Object.assign(new Error('private detail'), { code: 'SETTINGS_CONFLICT' }) }
  response = await routes.get('/api/model-service.apply').fetch(request('apply', { planId: plan.id }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { code: 'CONFLICT' })
  f.service.catalog = async () => { throw new Error('private detail') }
  response = await planRoute.fetch(request('plan', { action: 'connect-all' }))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await response.json(), { code: 'UNAVAILABLE' })
})
