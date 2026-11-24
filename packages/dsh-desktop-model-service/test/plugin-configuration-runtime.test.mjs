import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVolatile, isVolatile } from '@deepseek-ai/cosmokit'
import { registerPrivatePluginConfiguration } from '../private.js'
import { configurationDigest, installPluginConfigurationRuntime, pluginConfigurationReference } from '../plugin-configuration-runtime.js'

test('protects runtime references from Loader persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-runtime-'))
  const profileDir = join(root, 'profile')
  const gatewayUrl = 'http://127.0.0.1:43127'
  const hostToken = 'h'.repeat(32)
  const leaseToken = 'l'.repeat(32)
  const bindingId = 'binding-one'
  const raw = { endpoint: pluginConfigurationReference(bindingId, 'endpoint'), credential: pluginConfigurationReference(bindingId, 'credential'), model: 'chat-model' }
  const record = {
    identity: { bindingId, entryId: 'fixture-plugin', namespace: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', revision: 0, schemaDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64) },
    policy: { bindingId, entryId: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', capabilities: ['chat.completions', 'image.generate'], models: ['claude-opus-5-5', 'gpt-image-2.5-sunburst'] },
    files: [{ path: 'package.json', digest: 'c'.repeat(64) }],
    configDigest: configurationDigest(raw)
  }
  await mkdir(profileDir, { recursive: true })
  registerPrivatePluginConfiguration({ contractVersion: 1, gatewayUrl, capabilityToken: hostToken })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    if (request.leaseId) return new Response('{}', { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ contractVersion: 1, gatewayUrl, leaseId: 'lease-one', capabilityToken: leaseToken }), { headers: { 'content-type': 'application/json' } })
  }
  const listeners = new Map()
  const rootContext = {}
  const entry = { options: { id: 'fixture-plugin' } }
  const ctx = {
    root: rootContext,
    get(name) { assert.equal(name, 'profileContext'); return { dir: profileDir, name: 'web' } },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
    effect() {},
    logger: { warn() {} }
  }
  const fiber = { entry, parent: { fiber: { entry: {} } }, rawConfig: raw }
  let runtime
  try {
    runtime = await installPluginConfigurationRuntime(ctx)
    await runtime.activate(record, configurationDigest(raw))
    const configHook = listeners.get('internal/config')
    const updateHook = listeners.get('internal/update')
    assert.ok(configHook)
    assert.ok(updateHook)
    // Cordis global carriers may invoke these hooks with a null context.
    assert.equal(configHook.call(null, null, () => 'next'), 'next')
    assert.equal(updateHook.call(null, {}, false, () => 'next'), 'next')
    const resolved = configHook.call(fiber, fiber, () => raw)
    assert.deepEqual(resolved, { endpoint: `${gatewayUrl}/v1`, credential: leaseToken, model: 'chat-model' })
    let forwarded
    const patches = { path: 'profile/cordis.patch.yml', patches: [{ id: 'fixture-plugin', config: raw }] }
    updateHook.call(fiber, patches, false, (...args) => { forwarded = args; return 'ok' })
    assert.equal(forwarded[0], patches)
    assert.equal(forwarded[1], false)
    const live = { path: 'profile/cordis.patch.yml', patches: [{ id: 'fixture-plugin', config: { token: leaseToken } }] }
    assert.throws(() => updateHook.call(fiber, live, false, () => 'unreachable'), { code: 'PERSISTED_RUNTIME_CREDENTIAL' })
  } finally {
    await runtime?.dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves the approved raw configuration after the plugin schema normalizes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-runtime-'))
  const profileDir = join(root, 'profile')
  const gatewayUrl = 'http://127.0.0.1:43127'
  const hostToken = 'h'.repeat(32)
  const leaseToken = 'l'.repeat(32)
  const bindingId = 'binding-normalized'
  const approved = { endpoint: pluginConfigurationReference(bindingId, 'endpoint'), credential: pluginConfigurationReference(bindingId, 'credential'), model: 'chat-model' }
  const record = {
    identity: { bindingId, entryId: 'fixture-plugin', namespace: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', revision: 0, schemaDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64) },
    policy: { bindingId, entryId: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', capabilities: ['chat.completions', 'image.generate'], models: ['claude-opus-5-5', 'gpt-image-2.5-sunburst'] },
    files: [{ path: 'package.json', digest: 'c'.repeat(64) }],
    configDigest: configurationDigest(approved)
  }
  await mkdir(profileDir, { recursive: true })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    if (request.leaseId) return new Response('{}', { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ contractVersion: 1, gatewayUrl, leaseId: 'lease-normalized', capabilityToken: leaseToken }), { headers: { 'content-type': 'application/json' } })
  }
  const listeners = new Map()
  const rootContext = {}
  const entry = { options: { id: 'fixture-plugin', config: approved } }
  const ctx = {
    root: rootContext,
    get(name) { assert.equal(name, 'profileContext'); return { dir: profileDir, name: 'web' } },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
    effect() {},
    logger: { warn() {} }
  }
  const fiber = { entry, parent: { fiber: { entry: {} } } }
  let runtime
  try {
    runtime = await installPluginConfigurationRuntime(ctx)
    await runtime.activate(record, configurationDigest(approved))
    const configHook = listeners.get('internal/config')
    // Cordis validates the plugin's candidate against its Schemastery schema,
    // so `next()` returns a normalized object with defaults added. The approval
    // digest covers the authored entry configuration, not that normalized copy.
    const normalized = { ...approved, extraDefault: 'from-schema' }
    const resolved = configHook.call(fiber, fiber, () => normalized)
    assert.deepEqual(resolved, { ...normalized, endpoint: `${gatewayUrl}/v1`, credential: leaseToken })
  } finally {
    await runtime?.dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps Schemastery volatile references while substituting markers inside them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-runtime-'))
  const profileDir = join(root, 'profile')
  const gatewayUrl = 'http://127.0.0.1:43127'
  const hostToken = 'h'.repeat(32)
  const leaseToken = 'l'.repeat(32)
  const bindingId = 'binding-volatile'
  const approved = { channels: [{ id: 'channel-one', apiUrl: pluginConfigurationReference(bindingId, 'endpoint') }] }
  const record = {
    identity: { bindingId, entryId: 'fixture-plugin', namespace: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', revision: 0, schemaDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64) },
    policy: { bindingId, entryId: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', capabilities: ['chat.completions', 'image.generate'], models: ['claude-opus-5-5', 'gpt-image-2.5-sunburst'] },
    files: [{ path: 'package.json', digest: 'c'.repeat(64) }],
    configDigest: configurationDigest(approved)
  }
  await mkdir(profileDir, { recursive: true })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    if (request.leaseId) return new Response('{}', { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ contractVersion: 1, gatewayUrl, leaseId: 'lease-volatile', capabilityToken: leaseToken }), { headers: { 'content-type': 'application/json' } })
  }
  const listeners = new Map()
  const rootContext = {}
  const entry = { options: { id: 'fixture-plugin', config: approved } }
  const ctx = {
    root: rootContext,
    get(name) { assert.equal(name, 'profileContext'); return { dir: profileDir, name: 'web' } },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
    effect() {},
    logger: { warn() {} }
  }
  const fiber = { entry, parent: { fiber: { entry: {} } } }
  let runtime
  try {
    runtime = await installPluginConfigurationRuntime(ctx)
    await runtime.activate(record, configurationDigest(approved))
    const configHook = listeners.get('internal/config')
    // A volatile Config field resolves to a cosmokit reference, exactly like
    // Schemastery's `z.array(...).volatile()` output.
    const normalized = { channels: createVolatile([{ id: 'channel-one', apiUrl: pluginConfigurationReference(bindingId, 'endpoint') }]) }
    const resolved = configHook.call(fiber, fiber, () => normalized)
    assert.equal(isVolatile(resolved.channels), true)
    assert.deepEqual(resolved.channels.get(), [{ id: 'channel-one', apiUrl: `${gatewayUrl}/v1` }])
  } finally {
    await runtime?.dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('resolve tolerates plugins without a raw configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-runtime-'))
  const profileDir = join(root, 'profile')
  const gatewayUrl = 'http://127.0.0.1:43127'
  const hostToken = 'h'.repeat(32)
  const leaseToken = 'l'.repeat(32)
  const bindingId = 'binding-two'
  const raw = { endpoint: pluginConfigurationReference(bindingId, 'endpoint') }
  const record = {
    identity: { bindingId, entryId: 'fixture-plugin', namespace: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', revision: 0, schemaDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64) },
    policy: { bindingId, entryId: 'fixture-plugin', packageName: 'fixture-plugin', packageVersion: '1.0.0', capabilities: ['chat.completions', 'image.generate'], models: ['claude-opus-5-5', 'gpt-image-2.5-sunburst'] },
    files: [{ path: 'package.json', digest: 'c'.repeat(64) }],
    configDigest: configurationDigest(raw)
  }
  await mkdir(profileDir, { recursive: true })
  // The private registration is a process singleton; the first test registered it.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    if (request.leaseId) return new Response('{}', { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ contractVersion: 1, gatewayUrl, leaseId: 'lease-two', capabilityToken: leaseToken }), { headers: { 'content-type': 'application/json' } })
  }
  const listeners = new Map()
  const rootContext = {}
  const entry = { options: { id: 'fixture-plugin' } }
  const ctx = {
    root: rootContext,
    get(name) { assert.equal(name, 'profileContext'); return { dir: profileDir, name: 'web' } },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name) },
    effect() {},
    logger: { warn() {} }
  }
  const fiber = { entry, parent: { fiber: { entry: {} } }, rawConfig: raw }
  let runtime
  try {
    runtime = await installPluginConfigurationRuntime(ctx)
    await runtime.activate(record, configurationDigest(raw))
    const configHook = listeners.get('internal/config')
    assert.ok(configHook)
    // Plugins without a config file invoke the hook with raw === undefined.
    const otherFiber = { ...fiber, entry: { options: { id: 'other-plugin' } }, rawConfig: {} }
    const unrelated = configHook.call(otherFiber, otherFiber, () => 'default-resolved')
    assert.equal(unrelated, 'default-resolved')
    // A bound entry whose raw configuration disappeared falls back to defaults.
    const staleFiber = { ...fiber, rawConfig: undefined }
    const stale = configHook.call(staleFiber, staleFiber, () => 'default-resolved')
    assert.equal(stale, 'default-resolved')
  } finally {
    await runtime?.dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
