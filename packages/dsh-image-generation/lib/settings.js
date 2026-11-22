import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { DEFAULTS, MODEL_CATALOG, ImageError, listModels, profile, safeError, validateConnection } from './provider.js'

import { getDesktopImageBridge } from './desktop-bridge.js'
import { managedStatus, requireManagedAvailable } from './managed-provider.js'

const KEY = credentialKey('dsh-image-generation', 'configuration')
const EMPTY = () => ({ revision: 0, profiles: {} })

function described(state, writable) {
  return {
    revision: state.revision, provider: state.provider, writable, catalogs: MODEL_CATALOG,
    profiles: Object.fromEntries(Object.entries(DEFAULTS).map(([provider, defaults]) => {
      const stored = state.profiles[provider]
      return [provider, { ...defaults, ...(stored ? profile(provider, stored) : {}), configured: Boolean(stored?.key), validation: stored?.validation ?? null }]
    })),
  }
}

/** Keep each validated endpoint/model/key together in one atomic host credential record. */
export function createSettings(ctx, validate = validateConnection, desktopBridge = getDesktopImageBridge()) {
  const selectedProvider = state => state.provider || (desktopBridge ? 'pengbao' : 'bytedance')
  let lastStatus
  let statusCheckedAt = 0
  let pendingStatus
  async function refreshStatus(signal) {
    const status = await managedStatus(desktopBridge, signal)
    lastStatus = status
    statusCheckedAt = Date.now()
    return status
  }
  async function read() {
    let record
    try {
      record = await ctx.credentials.readRecord(KEY)
    } catch (error) {
      if (error instanceof ImageError) throw error
      throw new ImageError('LOAD_FAILED', 'The saved image configuration could not be read.', 503)
    }
    if (!record) return EMPTY()
    if (record.kind !== 'grant' || !Number.isSafeInteger(record.payload?.revision) || record.payload.revision < 0
      || !record.payload?.profiles || typeof record.payload.profiles !== 'object' || Array.isArray(record.payload.profiles)
      || (record.payload.provider && !['pengbao', ...Object.keys(DEFAULTS)].includes(record.payload.provider))) {
      throw new ImageError('CONFIGURATION', 'The stored image configuration needs to be saved again.', 500)
    }
    return record.payload
  }
  async function describeWritable() {
    try { return (await ctx.credentials.describeRecord(KEY)).writable } catch { return true }
  }
  async function describe(signal) {
    try {
      const state = await read()
      const provider = selectedProvider(state)
      return { ...described({ ...state, provider }, await describeWritable()),
        ...(desktopBridge || provider === 'pengbao' ? { managed: { supported: Boolean(desktopBridge), ...await refreshStatus(signal) } } : {}) }
    } catch (error) {
      const safe = safeError(error)
      ctx.logger.info('image-generation: settings describe failed; code=%s', safe.code)
      throw safe
    }
  }
  async function isConfigured({ background = false } = {}) {
    const state = await read()
    const provider = selectedProvider(state)
    if (provider === 'pengbao') {
      // Prompt assembly is on the text-chat path. Refresh in the background,
      // while settings and actual generation still await a current status.
      if (!background) return (await refreshStatus()).available
      if ((!lastStatus || Date.now() - statusCheckedAt > 15_000) && !pendingStatus) {
        pendingStatus = refreshStatus().finally(() => { pendingStatus = undefined })
      }
      return lastStatus?.available ?? Boolean(desktopBridge)
    }
    return Boolean(state.profiles[provider]?.key)
  }
  async function active(signal) {
    const state = await read()
    const provider = selectedProvider(state)
    if (provider === 'pengbao') {
      requireManagedAvailable(await refreshStatus(signal))
      return { provider, generate: desktopBridge.generate, edit: desktopBridge.edit, model_selection: 'server-managed' }
    }
    const spec = state.profiles[provider]
    if (!spec?.key) throw new ImageError('NOT_CONFIGURED', 'Configure the image tool in Settings > Plugins before generating an image.')
    return { provider, ...profile(provider, spec), key: spec.key }
  }
  async function checked(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ImageError('CONFIGURATION', 'Enter a valid image configuration.')
    const before = await read()
    if (!Number.isSafeInteger(input.revision) || input.revision !== before.revision) throw new ImageError('CONFLICT', 'The settings changed in another window. Reopen this card before saving.', 409)
    return before
  }
  async function prepared(input, before) {
    before ??= await checked(input)
    const spec = profile(input.provider, input)
    const previous = before.profiles[input.provider]
    const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    if (!key && previous && new URL(previous.baseUrl).origin !== new URL(spec.baseUrl).origin) {
      throw new ImageError('KEY_REQUIRED', 'Enter the API key again for the new API origin.')
    }
    const effectiveKey = key || previous?.key
    if (!effectiveKey || effectiveKey.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(effectiveKey)) throw new ImageError('KEY_REQUIRED', 'Enter a valid API key.')
    return { before, spec, effectiveKey }
  }
  async function models(input, signal) {
    const { spec, effectiveKey } = await prepared(input)
    return listModels(input.provider, spec, effectiveKey, { signal })
  }
  async function save(input, signal) {
    const before = await checked(input)
    if (!(await describeWritable())) throw new ImageError('READ_ONLY', 'The host credential store is read-only.', 403)
    if (input.provider === 'pengbao') {
      signal?.throwIfAborted()
      await ctx.credentials.modifyRecord(KEY, async record => {
        signal?.throwIfAborted()
        const latest = record?.kind === 'grant' ? record.payload : EMPTY()
        if (latest.revision !== before.revision) throw new ImageError('CONFLICT', 'The settings changed in another window. Reopen this card before saving.', 409)
        return { kind: 'grant', payload: { ...before, revision: before.revision + 1, provider: 'pengbao', profiles: before.profiles } }
      })
      return describe(signal)
    }
    const { spec, effectiveKey } = await prepared(input, before)
    try {
      const validation = await validate(input.provider, spec, effectiveKey, { signal })
      signal?.throwIfAborted()
      await ctx.credentials.modifyRecord(KEY, async record => {
        const latest = record?.kind === 'grant' ? record.payload : EMPTY()
        if (latest.revision !== before.revision) throw new ImageError('CONFLICT', 'The settings changed in another window. Reopen this card before saving.', 409)
        return { kind: 'grant', payload: {
          revision: before.revision + 1, provider: input.provider,
          profiles: { ...before.profiles, [input.provider]: { ...spec, key: effectiveKey, validation } },
        } }
      })
      ctx.logger.info('image-generation: configuration saved; provider=%s validation=%s', input.provider, validation)
      return await describe()
    } catch (error) {
      const safe = safeError(error)
      ctx.logger.info('image-generation: configuration save failed; provider=%s code=%s', input.provider, safe.code)
      throw safe
    }
  }
  return { describe, isConfigured, active, save, models }
}
