import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createPluginConfigurationBroker } from './private.js'
import { configurationSchemaDigest } from './plugin-config-analysis.js'
import { identifier } from './common.js'

const installed = new WeakMap()
const installing = new WeakMap()
const FILE = '.pengbao-plugin-configurations.json'
const SAFE_MODE_PROFILE = 'desktop-safe-mode'
const MAX_BYTES = 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const KEY = /^[a-zA-Z0-9_-]{1,128}$/
const ID = /^[A-Za-z0-9_@.-]{1,128}$/u
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const SEMVER = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const schemaDigest = schema => { try { return configurationSchemaDigest(schema) } catch { fail('BINDINGS_UNAVAILABLE') } }
const clone = value => structuredClone(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const marker = (id, field) => `pengbao-runtime:${id}:${field}`
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validFiles(files) {
  return Array.isArray(files) && files.length > 0 && files.length <= 12 && files.some(file => file?.path === 'package.json') && files.every(file => plain(file) &&
    Object.keys(file).sort().join(',') === 'digest,path' && typeof file.path === 'string' &&
    file.path.length > 0 && file.path.length <= 512 && !file.path.startsWith('/') && !file.path.includes('\\0') &&
    !file.path.includes('\\') && file.path.split('/').every(part => part && part !== '.' && part !== '..') &&
    !/(^|\/)(?:node_modules|\.git|\.env[^/]*|userdata|user-data|history|sessions?|secrets?|credentials?)(\/|$)/i.test(file.path) &&
    !file.path.endsWith('.map') && SHA256.test(file.digest))
}

function validateRecord(record) {
  if (!plain(record) || Object.keys(record).sort().join(',') !== 'configDigest,files,identity,policy') fail('INVALID_CONFIGURATION')
  const identity = record.identity
  if (!plain(identity) || Object.keys(identity).sort().join(',') !== 'bindingId,entryId,evidenceDigest,namespace,packageName,packageVersion,revision,schemaDigest' ||
    !KEY.test(identity.bindingId) || !ID.test(identity.entryId) || !ID.test(identity.namespace) ||
    !PACKAGE.test(identity.packageName) || !SEMVER.test(identity.packageVersion) ||
    !Number.isSafeInteger(identity.revision) || identity.revision < 0 || !SHA256.test(identity.schemaDigest) || !SHA256.test(identity.evidenceDigest)) fail('INVALID_CONFIGURATION')
  const policy = record.policy
  if (!plain(policy) || Object.keys(policy).sort().join(',') !== 'bindingId,capabilities,entryId,models,packageName,packageVersion' ||
    policy.bindingId !== identity.bindingId || policy.entryId !== identity.entryId || policy.packageName !== identity.packageName ||
    policy.packageVersion !== identity.packageVersion || !Array.isArray(policy.capabilities) || policy.capabilities.length === 0 ||
    policy.capabilities.length > 3 || policy.capabilities.some(scope => scope !== 'chat.completions' && scope !== 'image.generate' && scope !== 'video.generate') ||
    new Set(policy.capabilities).size !== policy.capabilities.length || !Array.isArray(policy.models) || policy.models.length === 0 ||
    policy.models.length > 256 || policy.models.some(model => typeof model !== 'string' ||
      (!/^pengbao-default-(?:chat|image)$/.test(model) && !identifier(model))) || new Set(policy.models).size !== policy.models.length) fail('INVALID_CONFIGURATION')
  if (!validFiles(record.files) || !SHA256.test(record.configDigest)) fail('INVALID_CONFIGURATION')
  return record
}

function containsRuntimeValue(value, lease) {
  let nodes = 0
  let bytes = 0
  const visiting = new Set()
  const visit = (current, depth) => {
    if (++nodes > 8192 || depth > 64) return { valid: false, found: false }
    if (current === null || typeof current === 'boolean') return { valid: true, found: false }
    if (typeof current === 'number') return { valid: Number.isFinite(current), found: false }
    if (typeof current === 'string') {
      bytes += Buffer.byteLength(current)
      return { valid: bytes <= MAX_BYTES, found: current === lease.apiKey || current.startsWith(lease.gatewayUrl) }
    }
    if (typeof current !== 'object' || visiting.has(current)) return { valid: false, found: false }
    const prototype = Object.getPrototypeOf(current)
    if (Array.isArray(current) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return { valid: false, found: false }
    visiting.add(current)
    let valid = true
    let found = false
    const names = Reflect.ownKeys(current)
    if (Array.isArray(current)) {
      if (names.length !== current.length + 1 || !Object.hasOwn(current, 'length')) valid = false
      for (let index = 0; valid && index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) { valid = false; break }
        const child = visit(descriptor.value, depth + 1)
        valid = child.valid; found ||= child.found
      }
    } else {
      if (names.length > 8192) valid = false
      for (const name of names) {
        if (!valid) break
        if (typeof name !== 'string') { valid = false; break }
        const descriptor = Object.getOwnPropertyDescriptor(current, name)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) { valid = false; break }
        bytes += Buffer.byteLength(name)
        if (bytes > MAX_BYTES) { valid = false; break }
        const child = visit(descriptor.value, depth + 1)
        valid = child.valid; found ||= child.found
      }
    }
    visiting.delete(current)
    return { valid, found }
  }
  const result = visit(value, 0)
  // An opaque candidate cannot safely be proven free of credentials.
  return !result.valid || result.found
}


/** The file contains approvals and references, never runtime credentials. */
export async function readPluginConfigurations(profileDir) {
  let handle
  try {
    const path = join(profileDir, FILE)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('BINDINGS_UNAVAILABLE')
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) fail('BINDINGS_UNAVAILABLE')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_BYTES) fail('BINDINGS_UNAVAILABLE')
    const data = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (data?.contractVersion !== 1 || !Array.isArray(data.bindings) || data.bindings.length > 512) fail('BINDINGS_UNAVAILABLE')
    const seen = new Set()
    for (const row of data.bindings) {
      // A previous DEV assistant persisted video model metadata alongside the
      // chat/image policy. This runtime has no video capability: accept only
      // this bounded legacy field and remove it from the in-memory policy,
      // never granting it or rewriting the user's approval file on startup.
      if (plain(row?.policy) && Object.hasOwn(row.policy, 'videoModels')) {
        const { videoModels, ...policy } = row.policy
        if (!Array.isArray(videoModels) || videoModels.length > 256 || videoModels.some(model => !identifier(model))
          || new Set(videoModels).size !== videoModels.length) fail('BINDINGS_UNAVAILABLE')
        row.policy = policy
      }
      validateRecord(row)
      if (seen.has(row.identity.bindingId)) fail('BINDINGS_UNAVAILABLE')
      seen.add(row.identity.bindingId)
    }
    return data.bindings
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    fail('BINDINGS_UNAVAILABLE')
  } finally { await handle?.close() }
}

export async function writePluginConfigurations(profileDir, bindings) {
  const body = JSON.stringify({ contractVersion: 1, bindings }, null, 2) + '\n'
  if (Buffer.byteLength(body) > MAX_BYTES) fail('BINDINGS_UNAVAILABLE')
  const path = join(profileDir, FILE)
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(body)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } finally {
    await handle?.close()
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

function replaceReferences(value, bindingId, lease, depth = 0) {
  if (depth > 64) fail('INVALID_CONFIGURATION')
  if (value === marker(bindingId, 'endpoint')) return `${lease.gatewayUrl}/v1`
  if (value === marker(bindingId, 'credential')) return lease.apiKey
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(child => replaceReferences(child, bindingId, lease, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceReferences(child, bindingId, lease, depth + 1)]))
}

/** Installed by bootstrap before any target plugin mounts; no target injection is required. */
export async function installPluginConfigurationRuntime(ctx) {
  const root = ctx.root ?? ctx
  if (installed.has(root)) return installed.get(root)
  const profile = ctx.get('profileContext')
  if (!profile?.dir || profile.name === SAFE_MODE_PROFILE) return undefined
  const broker = createPluginConfigurationBroker()
  const active = new Map()
  let disposed = false
  const controller = Object.freeze({
    async videoModels(options) { return broker.videoModels(options) },
    async activate(record, configDigest = record.configDigest) {
      if (disposed) fail('UNAVAILABLE')
      const recordInput = validateRecord(record)
      const id = recordInput.identity.bindingId
      if (typeof configDigest !== 'string' || !SHA256.test(configDigest)) fail('INVALID_CONFIGURATION')
      const previous = active.get(id)
      const lease = await broker.issue(recordInput.policy)
      if (disposed) { await lease.release(); fail('UNAVAILABLE') }
      if (previous) {
        try { await previous.lease.release() }
        catch (error) { await lease.release().catch(() => {}); throw error }
      }
      active.set(id, { record: clone(recordInput), configDigest, lease })
    },
    async deactivate(id) {
      const item = active.get(id)
      if (!item) return
      await item.lease.release()
      if (active.get(id) === item) active.delete(id)
    },
    resolve(entryId, raw, resolved) {
      const matches = [...active.values()].filter(item => item.record.identity.entryId === entryId)
      // Plugins without a configuration file resolve with raw === undefined.
      const serialized = JSON.stringify(raw)
      const markersPresent = typeof serialized === 'string' && serialized.includes('pengbao-runtime:')
      if (matches.length !== 1) {
        if (markersPresent) fail('BINDING_UNAVAILABLE')
        return resolved
      }
      const binding = matches[0]
      if (typeof serialized !== 'string' || digest(raw) !== binding.configDigest) {
        if (markersPresent) fail('BINDING_STALE')
        return resolved
      }
      return replaceReferences(resolved, binding.record.identity.bindingId, binding.lease)
    },
    guardUpdate(entryId, config, noSave) {
      if (disposed || noSave) return config
      const bindings = [...active.values()].filter(item => item.record.identity.entryId === entryId)
      if (!bindings.length) return config
      // Loader persists the inert config, not an interpolated runtime Config.
      // Reject any already-materialized lease value while preserving markers.
      if (bindings.some(item => containsRuntimeValue(config, item.lease))) fail('PERSISTED_RUNTIME_CREDENTIAL')
      return config
    },
    async dispose() {
      if (disposed) return
      disposed = true
      unhook(); unhookUpdate()
      installed.delete(root)
      const leases = [...active.values()].map(item => item.lease)
      active.clear()
      const results = await Promise.allSettled(leases.map(lease => lease.release()))
      await broker.dispose()
      if (results.some(result => result.status === 'rejected')) fail('FAILED')
    }
  })
  // Loader interpolation is inside this hook. Markers are inert strings; only an
  // exact approved raw configuration is eligible for secret substitution.
  // The loader's own carrier entries (cordis:include/cordis:group) hold the raw
  // patch tree, which legitimately embeds marker-bearing target configs. They
  // are not plugins and must never be treated as a binding target; otherwise a
  // reconcile would reject the whole patch document as BINDING_UNAVAILABLE.
  const carrier = entry => entry?.options?.name === 'cordis:include' || entry?.options?.name === 'cordis:group'
  let unhook = () => {}
  let unhookUpdate = () => {}
  unhook = ctx.on('internal/config', function (fiber, next) {
    // V0.14 Cordis passes the resolving fiber as the first argument. Global
    // carrier entries may still arrive with no context; they never own bindings.
    const entry = fiber?.entry
    if (!entry || carrier(entry) || fiber?.parent?.fiber?.entry === entry) return next()
    const resolved = next()
    return controller.resolve(entry.options.id, fiber.rawConfig ?? resolved, resolved)
  }, { global: true, prepend: true })
  unhookUpdate = ctx.on('internal/update', function (config, noSave, next) {
    const entry = this?.entry
    if (!entry || carrier(entry) || this?.parent?.fiber?.entry === entry) return next()
    const guarded = controller.guardUpdate(entry.options.id, config, noSave)
    return next(guarded, noSave)
  }, { global: true, prepend: true })
  try {
    for (const record of await readPluginConfigurations(profile.dir)) {
      try { validateRecord(record); await controller.activate(record) }
      catch { ctx.logger.warn('Pengbao plugin binding requires configuration review') }
    }
    installed.set(root, controller)
    ctx.effect(() => async () => { unhook(); unhookUpdate(); await controller.dispose() }, 'private plugin configuration runtime')
    return controller
  } catch (error) { unhook(); unhookUpdate(); await controller.dispose(); throw error }
}

export function getPluginConfigurationRuntime(ctx) { return installed.get(ctx.root ?? ctx) }
export function pluginConfigurationReference(bindingId, field) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(bindingId) || !['endpoint', 'credential'].includes(field)) fail('INVALID_CONFIGURATION')
  return marker(bindingId, field)
}
export const configurationDigest = digest
