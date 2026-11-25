import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelService } from '../service.js'
import { clientVisibleRows, parseModels } from '../common.js'
import { registerModelService, registerModelServiceConsumers, registerModelServiceImage, hasChatRegistration } from '../private.js'

const records = [
  { id: 'chat-consumer', version: '0.1.0', status: 'declared', capabilities: ['chat.completions'] },
  { id: 'disabled-consumer', version: '0.1.0', status: 'declared', capabilities: ['chat.completions'] },
  { id: 'catalog-consumer', version: '0.1.0', status: 'declared', capabilities: ['chat.completions'] },
  { id: 'invalid-consumer', status: 'needs-adapter', capabilities: ['chat.completions'] }
]
registerModelServiceConsumers(records)
registerModelService({ contractVersion: 1, gatewayUrl: 'http://127.0.0.1:12345',
  capabilityToken: 'a'.repeat(32), capabilities: ['chat.completions'] })
registerModelServiceImage({
  status: async () => ({ available: true, reason: 'available' }),
  models: async () => ({ selection: 'server-only', models: [], defaultModel: { id: 'server-image', name: 'Image' } }),
  generate: async () => Buffer.from([137, 80, 78, 71])
})

const create = (options = {}) => createModelService({
  llm: options.noLlm ? undefined : { stream: options.stream ?? (() => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()) },
  transport: { models: async () => [{ id: 'chat-model', name: 'Chat', capabilities: ['chat.completions'] }], defaults: async () => ({ defaultModels: ['chat-model'] }) },
  getBindings: options.bindings ?? (() => ({ 'chat-consumer': { enabled: true }, 'catalog-consumer': { enabled: true } }))
})

test('model metadata normalizes aliases ahead of names while preserving validated selection IDs', () => {
  const models = [
    { id: 'aliased', alias: '<Alias & display>', name: 'Underlying name' },
    { id: 'named', name: 'Display name' },
    { id: 'empty-alias', alias: '', name: 'Name fallback' },
    { id: 'id-only' }
  ]
  assert.deepEqual(parseModels(models), [
    { id: 'aliased', name: '<Alias & display>' }, { id: 'named', name: 'Display name' },
    { id: 'empty-alias', name: 'Name fallback' }, { id: 'id-only', name: 'id-only' }
  ])
  assert.equal(models[0].name, 'Underlying name', 'normalization must not mutate transport metadata')
  for (const alias of ['\nunsafe', ' leading-space', 'https://invalid.test/private', 'x'.repeat(257), 42, null]) {
    assert.throws(() => parseModels([{ id: 'valid-id', name: 'Valid name', alias }]), { code: 'INVALID_RESPONSE' })
  }
  assert.throws(() => parseModels([{ id: 'same', alias: 'First' }, { id: 'same', alias: 'Second' }]), { code: 'INVALID_RESPONSE' })
})

test('client tags narrow chat metadata and keep the legacy catalog before configuration', () => {
  const rows = [
    { id: 'text-on', info: { meta: { client: { enabled: true, types: ['text'] } } } },
    { id: 'image-on', info: { meta: { client: { enabled: true, types: ['image'] } } } },
    { id: 'off', info: { meta: { client: { enabled: false, types: ['text'] } } } },
    { id: 'legacy' },
    { id: 'null-client', info: { meta: { client: null } } }
  ]
  assert.deepEqual(clientVisibleRows(rows, 'text').map(row => row.id), ['text-on'])
  assert.deepEqual(clientVisibleRows([{ id: 'a' }, { id: 'b' }], 'text').map(row => row.id), ['a', 'b'])
})

test('service remains published without a usable chat provider', async () => {
  const service = create({ noLlm: true })
  const state = await service.status()
  assert.equal(state.contractVersion, 1)
  assert.equal(state.availability.chat.available, false)
  assert.throws(() => service.forConsumer('unknown-consumer'), { code: 'CONSUMER_UNAVAILABLE' })
  assert.throws(() => service.forConsumer('invalid-consumer'), { code: 'CONSUMER_UNAVAILABLE' })
  service.dispose()
})

test('consumer chat is fixed to Pengbao and strips adapter-only chunks', async () => {
  assert.equal(hasChatRegistration(), true)
  const service = create()
  const scope = service.forConsumer('chat-consumer')
  const iterator = scope.chat.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  const output = []
  for await (const chunk of iterator) output.push(chunk)
  assert.equal(output.at(-1).type, 'finish')
  assert.equal(output.some(chunk => Object.hasOwn(chunk, 'replayState')), false)
  assert.equal(scope.image, undefined)
  scope.dispose()
  service.dispose()
})

test('explicit disabled binding does not silently opt a consumer in', () => {
  const service = create({ bindings: () => ({ 'disabled-consumer': { enabled: false } }) })
  const scope = service.forConsumer('disabled-consumer')
  assert.throws(() => scope.chat.stream({ messages: [{ role: 'user', content: [] }] }), { code: 'FORBIDDEN' })
  scope.dispose()
  service.dispose()
})

test('server-only image default is metadata, not an image model selection', async () => {
  const service = create()
  const catalog = await service.catalog()
  assert.equal(catalog.models.some(item => item.capabilities.includes('image.generate')), false)
  assert.equal(catalog.defaults['image.generate'], undefined)
  assert.equal(service.forConsumer('catalog-consumer').image, undefined)
  service.dispose()
})

test('server chat defaults are exposed as validated IDs for boot-time selection', async () => {
  const service = create()
  assert.deepEqual(await service.chatDefaults(), { defaultModels: ['chat-model'] })
  service.dispose()
})

test('resolves a server chat default that names the display alias', async () => {
  const service = createModelService({
    llm: { stream: () => (async function* () {})() },
    transport: {
      models: async () => [{ id: 'chat-model-1017', name: 'chat-model', capabilities: ['chat.completions'] }],
      defaults: async () => ({ defaultModels: ['chat-model'] })
    }, getBindings: () => ({}) })
  const catalog = await service.catalog()
  assert.equal(catalog.defaults['chat.completions'], 'chat-model-1017')
  service.dispose()
})

test('chat defaults degrade to an empty list instead of failing startup', async () => {
  const offline = createModelService({ transport: {
    models: async () => [], defaults: async () => { throw new Error('offline') }
  }, getBindings: () => ({}) })
  assert.deepEqual(await offline.chatDefaults(), { defaultModels: [] })
  offline.dispose()
  const malformed = createModelService({ transport: {
    models: async () => [], defaults: async () => ({ defaultModels: ['bad id', 'https://leak.test'] })
  }, getBindings: () => ({}) })
  await assert.rejects(() => malformed.chatDefaults(), { code: 'INVALID_RESPONSE' })
  malformed.dispose()
})

test('malformed chat message is rejected before dispatch', () => {
  let dispatched = false
  const service = create({ stream: () => { dispatched = true; return (async function* () {})() } })
  const scope = service.forConsumer('chat-consumer')
  assert.throws(() => scope.chat.stream({ messages: [{ role: 'user', content: 'not-blocks' }] }), { code: 'INVALID_REQUEST' })
  assert.equal(dispatched, false)
  scope.dispose()
  service.dispose()
})
