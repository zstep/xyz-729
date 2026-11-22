import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm, symlink, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import sharp from 'sharp'
import { apply, CONFIGURED_IMAGE_PROMPT, IMAGE_PROMPT_SECTION, imageEditTool, imageTool, UNCONFIGURED_IMAGE_PROMPT } from '../packages/dsh-image-generation/index.js'
import { createSettings } from '../packages/dsh-image-generation/lib/settings.js'
import { DEFAULTS, MODEL_CATALOG, generate, generationBody, ImageError, profile, readBounded, validateConnection } from '../packages/dsh-image-generation/lib/provider.js'
import { normalizeImage } from '../packages/dsh-image-generation/lib/assets.js'
import { materialize } from '../packages/dsh-image-generation/lib/storage.js'
import { previewImage, imageResult } from '../packages/dsh-image-generation/lib/preview.js'
import { managedPrompt } from '../packages/dsh-image-generation/lib/managed-provider.js'
import { writerEnvironment } from '../packages/dsh-image-generation/lib/commit.js'

async function executeTool(ctx, input) {
  const { callId, name, arguments: args, ...context } = input
  const batch = await ctx.tools.execute({
    ...context, calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }]
  })
  return batch.results[0].result
}

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
async function temp() { const p = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-image-test-'))); cleanups.push(() => rm(p, { recursive: true, force: true })); return p }
async function server() {
  const calls = []
  const png = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#11223380' } }).png().toBuffer()
  let status = 200; let malformed = false; let delay = 0; let redirect
  let metadataStatus = 200; let modelList
  const http = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: body && JSON.parse(body) })
    if (redirect) { res.writeHead(307, { Location: redirect }); res.end(); return }
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    if (status === 200 && /\/models\//.test(req.url) && metadataStatus !== 200) {
      res.writeHead(metadataStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'secret-echo-key' } }))
      return
    }
    if (status === 200 && req.url.endsWith('/models') && modelList !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(modelList))
      return
    }
    const probe = status === 200 && !malformed && req.url.endsWith('/images/generations') && body && !Object.hasOwn(JSON.parse(body), 'prompt')
    const input = body && JSON.parse(body)
    // Provider-documented canvas ranges, independent of the production catalog.
    // Treat an opaque endpoint as 5.0 Pro too: its ID conveys no capabilities.
    const canvas = {
      'doubao-seedream-5-0-pro-260628': [921600, 4624220],
      'doubao-seedream-5-0-260128': [3686400, 16777216],
      'doubao-seedream-5-0-lite-260128': [3686400, 16777216],
      'doubao-seedream-4-5-251128': [3686400, 16777216],
      'doubao-seedream-4-0-250828': [921600, 16777216],
      'ep-custom': [921600, 4624220],
    }[input?.model]
    if (status === 200 && input?.prompt && canvas) {
      const singleOnly = ['doubao-seedream-5-0-pro-260628', 'ep-custom'].includes(input.model)
      const parameter = singleOnly && (['sequential_image_generation', 'sequential_image_generation_options'].find(field => Object.hasOwn(input, field)) || (input.stream === true ? 'stream' : undefined))
      const [width, height] = input.size.split('x').map(Number)
      const invalidSize = !(width * height >= canvas[0] && width * height <= canvas[1] && width / height >= 1 / 16 && width / height <= 16)
      if (parameter || invalidSize) {
        res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'seedream-contract-request' })
        res.end(JSON.stringify({ error: { code: 'InvalidParameter', param: parameter || 'size', message: parameter ? `The parameter ${parameter} is not supported by this model.` : 'The size is outside the supported range.' } }))
        return
      }
    }
    res.writeHead(probe ? 400 : status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(probe ? { error: { code: 'MissingParameter', message: 'The request is missing a required parameter: prompt.' } } : status !== 200 ? { error: { message: 'secret-echo-key' } } : malformed ? {} : req.url.endsWith('/images/generations')
      ? { data: [{ b64_json: png.toString('base64') }] }
      : req.url.endsWith('/models') ? { data: [{ id: 'gpt-image-2.5-flare' }, { id: DEFAULTS.openai.model }, { id: 'gpt-image-2.5-flare' }, { id: 'gpt-5' }, { id: 'dall-e-3' }, { id: 'gpt-image-1', shutdown_date: '2020-01-01' }] } : { id: DEFAULTS.openai.model }))
  })
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)) })
  return { calls, png, baseUrl: `http://127.0.0.1:${http.address().port}/v1`, setStatus: value => { status = value }, setMetadataStatus: value => { metadataStatus = value }, setModels: value => { modelList = value }, malformed: () => { malformed = true }, delay: value => { delay = value }, redirect: value => { redirect = value } }
}
async function fixture() {
  const home = await temp(); const workspace = await temp()
  const ctx = new Context()
  for (const [plugin, config] of [[SystemPrompt, {}], [ToolRuntime, {}], [nativeExecutor, {}], [SkillRegistry, {}], [LocalSandboxProvider, {}], [LocalSubprocessRuntime, {}], [LocalCredentialProvider, { dshHome: home, watch: false }]]) {
    const fork = ctx.plugin(plugin, config); await fork; cleanups.push(() => fork.dispose())
  }
  const log = vi.fn(); let mode = 'workspace-write'
  const services = { credentials: ctx.credentials, sandbox: ctx.sandbox, subprocess: ctx.subprocess, logger: { info: log }, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: workspace }) } }
  const settings = createSettings(services)
  const id = SessionId(randomUUID())
  const agent = { session: Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false, cwd: workspace }) }
  return { ctx, home, workspace, services, settings, log, agent, setMode: value => { mode = value } }
}
const saveInput = (provider, baseUrl, revision = 0) => ({ provider, baseUrl, model: DEFAULTS[provider].model, apiKey: 'test-image-key', revision })

describe('Pengbao managed image settings and tool', () => {
  const status = reason => ({ available: reason === 'available', reason, serviceUrl: 'https://pengbao.ecombus.net', modelSelection: 'server-managed' })
  it('defaults only with a private bridge, without persisting a provider or secret', async () => {
    const f = await fixture()
    const bridge = { status: vi.fn(async () => status('available')), generate: vi.fn() }
    const settings = createSettings(f.services, vi.fn(), bridge)
    expect(await settings.describe()).toMatchObject({ revision: 0, provider: 'pengbao', managed: status('available') })
    expect(await settings.isConfigured()).toBe(true)
    expect(await readdir(f.home)).not.toContain('.credentials.yaml')
    expect((await f.settings.describe()).provider).toBe('bytedance')
    expect((await settings.active()).model_selection).toBe('server-managed')
  })
  it('does not wait on image networking in the text prompt path', async () => {
    const f = await fixture()
    let resolveStatus
    const settings = createSettings(f.services, vi.fn(), { status: () => new Promise(resolve => { resolveStatus = resolve }) })
    expect(await settings.isConfigured({ background: true })).toBe(true)
    resolveStatus(status('disabled'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await settings.isConfigured({ background: true })).toBe(false)
  })
  it('retains direct choices and profiles, saves managed before key/model validation, and switches back', async () => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput('openai', s.baseUrl))
    const validate = vi.fn(async () => 'model')
    const settings = createSettings(f.services, validate, { status: async () => status('available'), generate: vi.fn() })
    expect((await settings.describe()).provider).toBe('openai')
    const before = await readFile(path.join(f.home, '.credentials.yaml'), 'utf8')
    expect(before).toContain('test-image-key')
    const result = await settings.save({ revision: 1, provider: 'pengbao', model: '', baseUrl: 'invalid', apiKey: '' })
    expect(result).toMatchObject({ revision: 2, provider: 'pengbao', profiles: { openai: { configured: true, validation: 'model' } } })
    expect(validate).not.toHaveBeenCalled()
    expect(s.calls).toHaveLength(1)
    expect(await readFile(path.join(f.home, '.credentials.yaml'), 'utf8')).toContain('test-image-key')
    await settings.save({ ...saveInput('openai', s.baseUrl, 2), apiKey: '' })
    expect((await settings.active()).key).toBe('test-image-key')
    expect(validate).toHaveBeenCalledTimes(1)
    await settings.save({ provider: 'pengbao', revision: 3 })
    const detached = createSettings(f.services, validate, null)
    expect(await detached.describe()).toMatchObject({ provider: 'pengbao', managed: { available: false, reason: 'unavailable' } })
    await expect(detached.active()).rejects.toMatchObject({ code: 'IMAGE_NETWORK' })
  })
  it('uses atomic revisions and does not overwrite read-only, cancelled or unreadable settings', async () => {
    const f = await fixture()
    const settings = createSettings(f.services, vi.fn(), { status: async () => status('available') })
    const results = await Promise.allSettled([settings.save({ provider: 'pengbao', revision: 0 }), settings.save({ provider: 'pengbao', revision: 0 })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected').reason.code).toBe('CONFLICT')
    const controller = new AbortController(); controller.abort()
    await expect(settings.save({ provider: 'pengbao', revision: 1 }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    vi.spyOn(f.services.credentials, 'describeRecord').mockResolvedValue({ writable: false })
    await expect(settings.save({ provider: 'pengbao', revision: 1 })).rejects.toMatchObject({ code: 'READ_ONLY' })
    vi.spyOn(f.services.credentials, 'readRecord').mockRejectedValue(new Error('private-error'))
    await expect(settings.save({ provider: 'pengbao', revision: 1 })).rejects.toMatchObject({ code: 'LOAD_FAILED' })
  })
  it.each(['disabled', 'forbidden', 'unauthenticated', 'unavailable'])('refreshes %s without falling back or blocking chat', async reason => {
    const f = await fixture(); let current = reason
    const settings = createSettings(f.services, vi.fn(), { status: async () => status(current), generate: vi.fn() })
    expect(await settings.describe()).toMatchObject({ provider: 'pengbao', managed: { reason } })
    expect(await settings.isConfigured()).toBe(false)
    await expect(settings.active()).rejects.toBeInstanceOf(ImageError)
    current = 'available'
    expect(await settings.isConfigured()).toBe(true)
    expect((await settings.describe()).managed.available).toBe(true)
  })
  it('normalizes binary output, omits a fabricated model and reuses policy and preview contracts', async () => {
    const f = await fixture(); const s = await server()
    const bridge = { status: async () => status('available'), generate: vi.fn(async () => s.png) }
    const settings = createSettings(f.services, vi.fn(), bridge)
    f.ctx.tools.register(imageTool(f.services, settings))
    const result = await executeTool(f.ctx, { callId: 'managed', name: 'image_generate', arguments: { prompt: 'A flower', style_context: 'Blue', purpose: 'presentation', aspect_ratio: '16:9' }, agent: f.agent, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result)).toBeFalsy()
    const value = JSON.parse(result.content[0].text)
    expect(value).toMatchObject({ provider: 'pengbao', model_selection: 'server-managed', media_type: 'image/png', width: 32, height: 24 })
    expect(value).not.toHaveProperty('model')
    expect(imageResult(result.content)).toEqual(value)
    expect(await sharp(await readFile(path.join(f.workspace, value.workspace_path))).metadata()).toMatchObject({ format: 'png' })
    expect(bridge.generate.mock.calls[0][0]).toBe(managedPrompt({ prompt: 'A flower', style_context: 'Blue', purpose: 'presentation', aspect_ratio: '16:9' }))
    expect(JSON.stringify(f.log.mock.calls)).toContain('model_selection=server-managed')
    f.setMode('read-only')
    await expect(imageTool(f.services, settings).execute({ prompt: 'Flower' }, { agent: f.agent })).rejects.toMatchObject({ code: 'POLICY' })
    expect(bridge.generate).toHaveBeenCalledTimes(1)
  })
  it('edits a generated image through the managed bridge and preserves the source', async () => {
    const f = await fixture(); const s = await server()
    const editedPng = await sharp({ create: { width: 40, height: 30, channels: 4, background: '#3366aa' } }).png().toBuffer()
    const bridge = { status: async () => status('available'), generate: vi.fn(async () => s.png), edit: vi.fn(async () => editedPng) }
    const settings = createSettings(f.services, vi.fn(), bridge)
    f.ctx.tools.register(imageTool(f.services, settings))
    f.ctx.tools.register(imageEditTool(f.services, settings))
    const first = await executeTool(f.ctx, { callId: 'managed-edit-source', name: 'image_generate', arguments: { prompt: 'A flower' }, agent: f.agent, signal: new AbortController().signal })
    expect(first.isError, JSON.stringify(first)).toBeFalsy()
    const source = JSON.parse(first.content[0].text)
    const sourcePath = path.join(f.workspace, source.workspace_path)
    const sourceBytes = await readFile(sourcePath)
    const edit = await executeTool(f.ctx, { callId: 'managed-edit', name: 'image_edit', arguments: {
      source: { kind: 'generated', sha256: source.sha256 }, prompt: 'Make the flower blue'
    }, agent: f.agent, signal: new AbortController().signal })
    expect(edit.isError, JSON.stringify(edit)).toBeFalsy()
    const result = JSON.parse(edit.content[0].text)
    expect(result.sha256).not.toBe(source.sha256)
    expect(result).toMatchObject({ provider: 'pengbao', model_selection: 'server-managed', media_type: 'image/png' })
    expect(bridge.edit).toHaveBeenCalledOnce()
    expect(bridge.edit.mock.calls[0][0]).toBe('Make the flower blue')
    expect(bridge.edit.mock.calls[0][1].image).toEqual(sourceBytes)
    expect(await readFile(sourcePath)).toEqual(sourceBytes)
    expect(JSON.stringify(f.log.mock.calls)).toContain('edit saved')
  })
  it('rechecks live workspace permissions and rejects malformed images before committing', async () => {
    const f = await fixture(); const s = await server()
    const bridge = { status: async () => status('available'), generate: vi.fn(async () => { f.setMode('read-only'); return s.png }) }
    const settings = createSettings(f.services, vi.fn(), bridge)
    await expect(imageTool(f.services, settings).execute({ prompt: 'Flower' }, { agent: f.agent })).rejects.toMatchObject({ code: 'POLICY' })
    f.setMode('workspace-write'); bridge.generate.mockResolvedValue(Buffer.from('broken'))
    await expect(imageTool(f.services, settings).execute({ prompt: 'Flower' }, { agent: f.agent })).rejects.toMatchObject({ code: 'IMAGE' })
    expect(await readdir(f.workspace)).toEqual([])
  })
})

describe('image settings save and provider requests', () => {
  it.each(['openai', 'bytedance'])('saves %s with exactly one non-generating request and redacts credentials', async provider => {
    const f = await fixture(); const s = await server()
    const result = await f.settings.save(saveInput(provider, s.baseUrl))
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({ method: provider === 'openai' ? 'GET' : 'POST', auth: 'Bearer test-image-key' })
    if (provider === 'openai') expect(s.calls[0].url).toContain('/models')
    else expect(s.calls[0].body).toEqual({ model: DEFAULTS.bytedance.model })
    expect(result.profiles[provider]).toMatchObject({ configured: true, validation: provider === 'openai' ? 'model' : 'connection' })
    expect(JSON.stringify(result)).not.toContain('test-image-key')
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('test-image-key')
    expect((await f.settings.active()).provider).toBe(provider)
    if (process.platform !== 'win32') expect((await stat(path.join(f.home, '.credentials.yaml'))).mode & 0o777).toBe(0o600)
    expect(await readdir(f.workspace)).toEqual([])
  })
  it.each([404, 405])('saves through model-list validation when single-model metadata returns HTTP %s', async status => {
    const f = await fixture(); const s = await server()
    s.setMetadataStatus(status)
    const result = await f.settings.save(saveInput('openai', s.baseUrl))
    expect(result.profiles.openai).toMatchObject({ configured: true, validation: 'model' })
    expect((await f.settings.active()).model).toBe(DEFAULTS.openai.model)
    expect(s.calls.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: `/v1/models/${DEFAULTS.openai.model}` },
      { method: 'GET', url: '/v1/models' },
    ])
    expect(s.calls.every(call => call.auth === 'Bearer test-image-key' && !call.body)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('test-image-key')
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret-echo-key')
  })
  it.each([
    { data: [] },
    { data: [{ id: DEFAULTS.openai.model, shutdown_date: '2020-01-01' }] },
    { data: [{ id: `${DEFAULTS.openai.model}-other` }] },
  ])('does not save a model absent from the fallback visible list (%#)', async models => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput('openai', s.baseUrl))
    s.setMetadataStatus(404); s.setModels(models)
    await expect(f.settings.save({ ...saveInput('openai', s.baseUrl, 1), apiKey: 'replacement-key' })).rejects.toMatchObject({ code: 'MODEL' })
    expect((await f.settings.describe()).revision).toBe(1)
    expect((await f.settings.active()).key).toBe('test-image-key')
    expect(await readFile(path.join(f.home, '.credentials.yaml'), 'utf8')).not.toContain('replacement-key')
  })
  it.each([null, {}, { data: 'not-a-list' }])('rejects malformed fallback model lists (%#)', async models => {
    const f = await fixture(); const s = await server()
    s.setMetadataStatus(404); s.setModels(models)
    await expect(f.settings.save(saveInput('openai', s.baseUrl))).rejects.toMatchObject({ code: 'RESPONSE' })
    expect((await f.settings.describe()).revision).toBe(0)
  })
  it.each([400, 401, 403, 429, 500])('does not fall back or save after metadata HTTP %s', async status => {
    const f = await fixture(); const s = await server()
    s.setMetadataStatus(status)
    await expect(f.settings.save(saveInput('openai', s.baseUrl))).rejects.toMatchObject({ providerStatus: status })
    expect(s.calls).toHaveLength(1)
    expect((await f.settings.describe()).revision).toBe(0)
  })
  it('preserves authentication failure on the fallback list and does not follow its redirect', async () => {
    const s = await server(); const target = await server()
    s.setMetadataStatus(404)
    const fetchImpl = async (url, options) => {
      if (String(url).endsWith('/models')) return Response.json({ error: { message: 'secret-echo-key' } }, { status: 401 })
      return fetch(url, options)
    }
    await expect(validateConnection('openai', { ...profile('openai'), baseUrl: s.baseUrl }, 'secret-echo-key', { fetchImpl })).rejects.toMatchObject({ code: 'AUTH', providerStatus: 401 })
    const redirectFetch = (url, options) => {
      if (String(url).endsWith('/models')) { s.setMetadataStatus(200); s.redirect(target.baseUrl) }
      return fetch(url, options)
    }
    await expect(validateConnection('openai', { ...profile('openai'), baseUrl: s.baseUrl }, 'key', { fetchImpl: redirectFetch })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(target.calls).toHaveLength(0)
  })
  it('validates an exact custom model ID in the fallback list without limiting it to the built-in catalog', async () => {
    const s = await server()
    s.setMetadataStatus(404); s.setModels({ data: [{ id: 'company/image-model' }] })
    expect(await validateConnection('openai', { baseUrl: s.baseUrl, model: 'company/image-model' }, 'key')).toBe('model')
    expect(s.calls[0].url).toBe('/v1/models/company%2Fimage-model')
    expect(s.calls[1].url).toBe('/v1/models')
  })
  it('preserves the whole saved profile after validation fails and keeps provider credentials separate', async () => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput('openai', s.baseUrl))
    s.setStatus(401)
    await expect(f.settings.save({ ...saveInput('bytedance', s.baseUrl, 1), apiKey: 'secret-echo-key' })).rejects.toMatchObject({ code: 'AUTH' })
    expect(await f.settings.active()).toMatchObject({ provider: 'openai', key: 'test-image-key' })
    expect(await readFile(path.join(f.home, '.credentials.yaml'), 'utf8')).not.toContain('secret-echo-key')
    s.setStatus(200)
    await f.settings.save({ ...saveInput('bytedance', s.baseUrl, 1), apiKey: 'byte-key' })
    await f.settings.save({ ...saveInput('openai', s.baseUrl, 2), apiKey: '' })
    expect(s.calls.at(-1).auth).toBe('Bearer test-image-key')
  })
  it('prevents lost updates across two validated saves', async () => {
    const f = await fixture(); const s = await server()
    const result = await Promise.allSettled([f.settings.save(saveInput('openai', s.baseUrl)), f.settings.save(saveInput('bytedance', s.baseUrl))])
    expect(result.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(result.find(result => result.status === 'rejected').reason.code).toBe('CONFLICT')
    expect((await f.settings.describe()).revision).toBe(1)
  })
  it('reuses the saved key when only the image model changes', async () => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput('bytedance', s.baseUrl))
    const result = await f.settings.save({
      provider: 'bytedance', baseUrl: s.baseUrl, model: 'doubao-seedream-4-0-250828', apiKey: '', revision: 1,
    })
    expect(result.profiles.bytedance).toMatchObject({ configured: true, model: 'doubao-seedream-4-0-250828' })
    expect((await f.settings.active()).key).toBe('test-image-key')
    expect(s.calls.at(-1).auth).toBe('Bearer test-image-key')
    expect(s.calls).toHaveLength(2)
  })
  it('keeps a saved profile when only describeRecord fails', async () => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput('bytedance', s.baseUrl))
    vi.spyOn(f.services.credentials, 'describeRecord').mockRejectedValue(new Error('secret-echo-key'))
    const result = await f.settings.describe()
    expect(result.profiles.bytedance.configured).toBe(true)
    expect(result.writable).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-echo-key')
  })
  it('requires a re-entered key for a different origin and rejects stale revisions before requests', async () => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput('openai', s.baseUrl))
    await expect(f.settings.save(saveInput('openai', s.baseUrl))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.settings.save({ ...saveInput('openai', 'https://example.com/v1', 1), apiKey: '' })).rejects.toMatchObject({ code: 'KEY_REQUIRED' })
    expect(s.calls).toHaveLength(1)
  })
  it('handles malformed metadata, cancellation, and custom Ark endpoint validation honestly', async () => {
    const s = await server()
    expect(await validateConnection('bytedance', { baseUrl: s.baseUrl, model: 'ep-custom' }, 'key')).toBe('connection')
    s.malformed()
    await expect(validateConnection('bytedance', { baseUrl: s.baseUrl, model: 'ep-custom' }, 'key')).rejects.toMatchObject({ code: 'RESPONSE' })
    const cancelled = new AbortController(); cancelled.abort()
    await expect(validateConnection('openai', { baseUrl: s.baseUrl, model: DEFAULTS.openai.model }, 'key', { signal: cancelled.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('rejects redirects without forwarding a key to the redirect target', async () => {
    const source = await server(); const target = await server()
    source.redirect(target.baseUrl)
    await expect(validateConnection('openai', { ...profile('openai'), baseUrl: source.baseUrl }, 'key')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(source.calls).toHaveLength(1); expect(target.calls).toHaveLength(0)
  })
  it('accepts only the specific Ark missing-prompt response and rejects unrelated 400 errors', async () => {
    const s = await server(); s.setStatus(400)
    await expect(validateConnection('bytedance', { ...profile('bytedance'), baseUrl: s.baseUrl }, 'key')).rejects.toMatchObject({ code: 'PARAMETERS' })
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].body).toEqual({ model: DEFAULTS.bytedance.model })
  })
  it('leaves credentials untouched when an in-flight validation is cancelled', async () => {
    const f = await fixture(); const s = await server(); s.delay(50)
    const controller = new AbortController()
    const pending = f.settings.save(saveInput('openai', s.baseUrl), controller.signal)
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect((await f.settings.describe()).revision).toBe(0)
  })
  it('describes empty defaults when no image configuration is stored', async () => {
    const f = await fixture()
    const result = await f.settings.describe()
    expect(result).toMatchObject({ revision: 0, provider: 'bytedance', writable: true })
    expect(result.profiles.bytedance.configured).toBe(false)
    expect(result.profiles.openai.configured).toBe(false)
  })
  it('rejects settings reads and saves when the credential store cannot be read', async () => {
    const f = await fixture()
    vi.spyOn(f.services.credentials, 'readRecord').mockRejectedValue(new Error('secret-echo-key'))
    await expect(f.settings.describe()).rejects.toMatchObject({ code: 'LOAD_FAILED', status: 503 })
    await expect(f.settings.save(saveInput('bytedance', 'https://ark.cn-beijing.volces.com/api/v3'))).rejects.toMatchObject({ code: 'LOAD_FAILED', status: 503 })
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret-echo-key')
  })
  it.each(['https://user:key@example.com/v1', 'http://example.com/v1', 'https://example.com/v1?key=x'])('rejects unsafe endpoint %s', baseUrl => {
    expect(() => profile('openai', { baseUrl })).toThrow(ImageError)
  })
  it('accepts the console REST endpoint and requests generation with exactly one path suffix', async () => {
    const s = await server()
    const spec = profile('bytedance', { baseUrl: `${s.baseUrl}/images/generations/`, model: 'doubao-seedream-5-0-pro-260628' })
    expect(spec.baseUrl).toBe(s.baseUrl)
    await generate('bytedance', spec, 'test-image-key', { prompt: 'A flower' })
    expect(s.calls[0].url).toBe('/v1/images/generations')
  })
  it('fetches only supported visible image models with one request and keeps stored configuration unchanged', async () => {
    const f = await fixture(); const s = await server()
    const before = await f.settings.describe()
    const result = await f.settings.models(saveInput('openai', s.baseUrl))
    expect(result).toEqual({ source: 'provider', canFetch: true, models: ['gpt-image-2.5-flare', DEFAULTS.openai.model] })
    expect(s.calls).toHaveLength(1); expect(s.calls[0]).toMatchObject({ method: 'GET', url: '/v1/models' })
    expect(await f.settings.describe()).toEqual(before)
    expect(JSON.stringify(result)).not.toContain('test-image-key')
    await f.settings.save(saveInput('openai', s.baseUrl))
    await f.settings.models({ ...saveInput('openai', s.baseUrl, 1), apiKey: '' })
    expect(s.calls.at(-1).auth).toBe('Bearer test-image-key')
    await expect(f.settings.models({ ...saveInput('openai', 'https://other.example/v1', 1), apiKey: '' })).rejects.toMatchObject({ code: 'KEY_REQUIRED' })
    await expect(f.settings.models(saveInput('bytedance', s.baseUrl, 1))).rejects.toMatchObject({ code: 'MODEL_DISCOVERY' })
    expect(s.calls).toHaveLength(3)
  })
  it('maps provider canvas parameters independently and bounds streamed responses', async () => {
    const args = { prompt: 'A mountain', aspect_ratio: '16:9' }
    expect(generationBody('openai', profile('openai'), args)).toMatchObject({ size: '1536x1024', output_format: 'png' })
    expect(generationBody('openai', profile('openai'), args)).not.toHaveProperty('response_format')
    expect(generationBody('bytedance', profile('bytedance'), args)).toMatchObject({ size: '2560x1440', response_format: 'b64_json' })
    expect(generationBody('bytedance', profile('bytedance'), args)).not.toHaveProperty('quality')
    await expect(readBounded(new Response('too much'), 2)).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })
  it.each([...MODEL_CATALOG.bytedance.models, 'ep-custom'])('generates every supported aspect ratio with the single-image contract for %s', async model => {
    const s = await server()
    for (const aspect_ratio of ['1:1', '16:9', '9:16', '4:3', '3:4']) {
      expect(await generate('bytedance', { baseUrl: s.baseUrl, model }, 'test-image-key', { prompt: 'A flower', aspect_ratio })).toEqual(s.png)
    }
    expect(s.calls).toHaveLength(5)
  })
  it('reports the rejected parameter and request ID through ToolRuntime while keeping provider echoes private', async () => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput('bytedance', s.baseUrl))
    const original = globalThis.fetch
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => String(url).endsWith('/images/generations')
      ? Promise.resolve(Response.json({ error: { code: 'InvalidParameter', message: 'The parameter `sequential_image_generation` is not supported. Bearer test-image-key. PRIVATE-PROMPT' } }, { status: 400, headers: { 'x-request-id': 'req-123' } }))
      : original(url, options))
    f.ctx.tools.register(imageTool(f.services, f.settings))
    const result = await executeTool(f.ctx, { callId: 'provider-error', name: 'image_generate', arguments: { prompt: 'PRIVATE-PROMPT' }, agent: f.agent, signal: new AbortController().signal })
    const text = JSON.stringify(result)
    expect(result.isError).toBe(true)
    for (const value of ['sequential_image_generation', 'unsupported', 'InvalidParameter', 'req-123', 'HTTP 400']) expect(text).toContain(value)
    for (const value of ['test-image-key', 'PRIVATE-PROMPT', 'Bearer']) {
      expect(text).not.toContain(value)
      expect(JSON.stringify(f.log.mock.calls)).not.toContain(value)
    }
    expect(JSON.stringify(f.log.mock.calls)).toContain('req-123')
    expect(stub).toHaveBeenCalledTimes(1)
  })
  it.each([401, 403, 404, 429, 500])('preserves HTTP %s classification with private or malformed error bodies', async status => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { code: 'private-key', param: 'private-key', message: 'private-key' }, request_id: 'private-key' }, { status }))
    try {
      await generate('openai', profile('openai'), 'private-key', { prompt: 'Flower' }, { fetchImpl })
      expect.unreachable()
    } catch (error) {
      expect(error.code).toBe(({ 401: 'AUTH', 403: 'PERMISSION', 404: 'MODEL', 429: 'QUOTA', 500: 'PROVIDER_ERROR' })[status])
      expect(error.message).toContain(`HTTP ${status}`)
      expect(error.message).not.toContain('private-key')
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each(['<html>Gateway error</html>', 'x'.repeat(65537)])('preserves provider status when the error response is invalid or oversized (%#)', async body => {
    await expect(generate('bytedance', profile('bytedance'), 'key', { prompt: 'Flower' }, { fetchImpl: async () => new Response(body, { status: 400 }) }))
      .rejects.toMatchObject({ code: 'PARAMETERS', providerStatus: 400 })
  })
})

describe('image tool and durable Office assets', () => {
  it('starts an Electron Host child in Node mode while keeping credentials and Node options outside the writer', () => {
    const env = { ELECTRON_RUN_AS_NODE: '0', NODE_OPTIONS: '--require secret.js', API_KEY: 'private-key', PATH: '/host/bin' }
    expect(writerEnvironment({ env, platform: 'darwin', versions: { electron: '43.4.0' } })).toEqual({
      ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined, API_KEY: undefined, PATH: undefined,
    })
    expect(writerEnvironment({ env, platform: 'darwin', versions: { node: '24.9.0' } }).ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
  it.each(['openai', 'bytedance'])('executes %s through ToolRuntime and writes a verifiable PNG', async provider => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput(provider, s.baseUrl))
    f.ctx.tools.register(imageTool(f.services, f.settings))
    const result = await executeTool(f.ctx, { callId: 'test-call', name: 'image_generate', arguments: { prompt: 'A calm forest', purpose: 'presentation', aspect_ratio: '16:9' }, agent: f.agent, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result)).toBeFalsy()
    const value = JSON.parse(result.content[0].text)
    const data = await readFile(path.join(f.workspace, value.workspace_path))
    expect(createHash('sha256').update(data).digest('hex')).toBe(value.sha256)
    expect(await sharp(data).metadata()).toMatchObject({ format: 'png', width: value.width, height: value.height, hasAlpha: true })
    expect(s.calls.filter(call => call.body?.prompt)).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('test-image-key')
  })
  it('blocks a read-only workspace and symlink escape before the paid request', async () => {
    const f = await fixture(); const s = await server()
    await f.settings.save(saveInput('openai', s.baseUrl))
    const tool = imageTool(f.services, f.settings)
    f.setMode('read-only')
    await expect(tool.execute({ prompt: 'Forest' }, { agent: f.agent })).rejects.toMatchObject({ code: 'POLICY' })
    f.setMode('workspace-write')
    const outside = await temp(); await symlink(outside, path.join(f.workspace, '.workbuddy'))
    await expect(tool.execute({ prompt: 'Forest' }, { agent: f.agent })).rejects.toMatchObject({ code: 'ASSET_PATH' })
    expect(s.calls).toHaveLength(1); expect(await readdir(outside)).toEqual([])
  })
  it('commits identical assets concurrently, rejects target symlinks, and rejects damaged images', async () => {
    const workspace = await temp(); const s = await server(); const image = await normalizeImage(s.png)
    const values = await Promise.all([materialize(workspace, image.data), materialize(workspace, image.data)])
    expect(values[0]).toEqual(values[1])
    expect(await readdir(path.dirname(path.join(workspace, values[0].workspace_path)))).toHaveLength(1)
    const target = path.join(workspace, values[0].workspace_path)
    await rm(target); await symlink(path.join(workspace, 'absent'), target)
    await expect(materialize(workspace, image.data)).rejects.toThrow()
    await expect(normalizeImage(Buffer.from('not a PNG'))).rejects.toMatchObject({ code: 'IMAGE' })
  })
  async function mountPlugin(fixture, routes = []) {
    const plugin = fixture.ctx.plugin({ inject: ['skills', 'systemPrompt', 'tools'], apply: ctx => apply({
      ...fixture.services, skills: ctx.skills, systemPrompt: ctx.systemPrompt, tools: ctx.tools,
      on: ctx.on.bind(ctx), connection: { fetch: { register: route => routes.push(route) } },
    }) })
    await plugin
    cleanups.push(() => plugin.dispose())
    return plugin
  }
  it('registers standard routes and executes with saved configuration while honoring deployment guards', async () => {
    const f = await fixture(); const routes = []
    await mountPlugin(f, routes)
    expect(routes.map(({ path, methods, requestBody }) => ({ path, methods, requestBody }))).toEqual([
      { path: '/api/image-generation.settings', methods: ['GET'], requestBody: 'buffered' },
      { path: '/api/image-generation.save', methods: ['POST'], requestBody: 'buffered' },
      { path: '/api/image-generation.models', methods: ['POST'], requestBody: 'buffered' },
      { path: '/api/image-generation.preview', methods: ['GET'], requestBody: 'buffered' },
    ])
    const response = await routes[0].fetch(new Request('http://localhost/api/image-generation.settings'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()).profiles.openai.configured).toBe(false)
    const provider = await server()
    await f.settings.save(saveInput('bytedance', provider.baseUrl))
    const result = await executeTool(f.ctx, { callId: 'direct', name: 'image_generate', arguments: { prompt: 'Forest' }, agent: f.agent, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result)).toBeFalsy()
    expect(provider.calls).toHaveLength(2)
    const dispose = f.ctx.tools.guard(exec => exec.name === 'image_generate' ? 'Deployment blocks image generation' : undefined)
    const denied = await executeTool(f.ctx, { callId: 'denied', name: 'image_generate', arguments: { prompt: 'Forest' }, agent: f.agent, signal: new AbortController().signal })
    dispose()
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('Deployment blocks image generation')
    expect(provider.calls).toHaveLength(2)
  })
  it('returns LOAD_FAILED from the settings route when credentials cannot be read', async () => {
    const f = await fixture(); const routes = []
    await mountPlugin(f, routes)
    vi.spyOn(f.services.credentials, 'readRecord').mockRejectedValue(new Error('secret-echo-key'))
    const response = await routes[0].fetch(new Request('http://localhost/api/image-generation.settings'))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'LOAD_FAILED' })
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret-echo-key')
  })
  it('assembles an unconfigured prompt, a configured parallel prompt, and fails closed without leaking secrets', async () => {
    const f = await fixture()
    await mountPlugin(f)
    const unset = await f.ctx.systemPrompt.assemble()
    expect(unset.sections.find(section => section.name === IMAGE_PROMPT_SECTION)?.text).toBe(UNCONFIGURED_IMAGE_PROMPT)
    const s = await server()
    await f.settings.save(saveInput('openai', s.baseUrl))
    const ready = await f.ctx.systemPrompt.assemble()
    expect(ready.sections.find(section => section.name === IMAGE_PROMPT_SECTION)?.text).toBe(CONFIGURED_IMAGE_PROMPT)
    expect(JSON.stringify(ready)).not.toContain('test-image-key')
    vi.spyOn(f.services.credentials, 'readRecord').mockRejectedValue(new Error('secret-echo-key'))
    const closed = await f.ctx.systemPrompt.assemble()
    expect(closed.sections.find(section => section.name === IMAGE_PROMPT_SECTION)?.text).toBe(UNCONFIGURED_IMAGE_PROMPT)
    expect(JSON.stringify(closed)).not.toContain('secret-echo-key')
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret-echo-key')
    expect(JSON.stringify(f.log.mock.calls)).toContain('LOAD_FAILED')
  })
})


describe('session-authorized generated image previews', () => {
  async function previewFixture(id = `session-${randomUUID()}`) {
    const workspace = await temp()
    const png = await sharp({ create: { width: 16, height: 9, channels: 4, background: '#112233' } }).png().toBuffer()
    const asset = await materialize(workspace, png)
    const image = { ...asset, asset_id: `sha256:${asset.sha256}`, media_type: 'image/png', width: 16, height: 9, bytes: png.length, provider: 'bytedance', model: DEFAULTS.bytedance.model }
    const content = [{ type: 'text', text: JSON.stringify(image) }]
    const events = [{ type: 'tool/call', data: { callId: 'image-call', name: 'image_generate' } },
      { type: 'tool/result', surfaceOp: 'append', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'image-call' }, content, isError: false } } }]
    const log = vi.fn()
    const dispose = vi.fn()
    const ctx = { sessionQuery: { observeSession: vi.fn(async session => ({ header: { id: session, cwd: workspace }, cursor: events.length - 1, events: session === id ? events : [], [Symbol.dispose]: dispose })) }, logger: { info: log } }
    const request = (session = id, sha = image.sha256) => new Request(`http://localhost/api/image-generation.preview?${new URLSearchParams({ session, asset: sha })}`)
    return { workspace, png, image, id, content, events, ctx, dispose, request, target: path.join(workspace, image.workspace_path) }
  }
  it('serves historical successful PNGs with integrity, cache, content-type and audit checks', async () => {
    const f = await previewFixture()
    const result = await previewImage(f.ctx, f.request())
    expect(result.status).toBe(200)
    expect(Buffer.from(await result.arrayBuffer())).toEqual(f.png)
    expect(result.headers.get('content-type')).toBe('image/png')
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(f.ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('preview allowed'), f.id, f.image.sha256)
  })
  it.each([randomUUID(), 'session-1', 'imported:landscape'])('resolves the opaque Harness session ID %s', async id => {
    const f = await previewFixture(id)
    const result = await previewImage(f.ctx, f.request())
    expect(result.status).toBe(200)
    expect(Buffer.from(await result.arrayBuffer())).toEqual(f.png)
    expect(f.ctx.sessionQuery.observeSession).toHaveBeenCalledWith(id, expect.objectContaining({ signal: expect.any(AbortSignal), projectionMode: 'none' }))
  })
  it('requires a successful image tool result in the requested session', async () => {
    const f = await previewFixture()
    expect((await previewImage(f.ctx, f.request(randomUUID()))).status).toBe(404)
    expect((await previewImage(f.ctx, f.request(f.id, 'a'.repeat(64)))).status).toBe(404)
    f.events[0].data.name = 'other_tool'
    expect((await previewImage(f.ctx, f.request())).status).toBe(404)
    f.events[0].data.name = 'image_generate'
    f.events[1].data.message.isError = true
    expect((await previewImage(f.ctx, f.request())).status).toBe(404)
    for (const type of ['tool/ptc-dispatch', 'tool/code-dispatch']) {
      f.events.splice(0, f.events.length, { type, data: { name: 'image_generate', subCallId: 'ptc', content: f.content, isError: false } })
      expect((await previewImage(f.ctx, f.request())).status).toBe(200)
      f.events[0].data.isError = true
      expect((await previewImage(f.ctx, f.request())).status).toBe(404)
    }
  })
  it('validates query bounds and resolves session identity through the Host', async () => {
    const f = await previewFixture()
    for (const id of ['', 'a'.repeat(1025), 'session-\u0000']) {
      expect((await previewImage(f.ctx, f.request(id))).status).toBe(400)
    }
    expect((await previewImage(f.ctx, f.request(f.id, '../secret'))).status).toBe(400)
    expect(f.ctx.sessionQuery.observeSession).not.toHaveBeenCalled()
    expect((await previewImage(f.ctx, f.request('../outside'))).status).toBe(404)
    expect(f.ctx.sessionQuery.observeSession).toHaveBeenCalledWith('../outside', expect.objectContaining({ signal: expect.any(AbortSignal), projectionMode: 'none' }))
    expect(imageResult([null, { type: 'text', text: 'broken' }])).toBeUndefined()
    for (const change of [{ bytes: -1 }, { bytes: 1000000000 }, { workspace_path: '/etc/passwd' }, { media_type: 'text/html' }, { asset_id: 'wrong' }]) {
      expect(imageResult([{ type: 'text', text: JSON.stringify({ ...f.image, ...change }) }])).toBeUndefined()
    }
  })
  it('releases observations on success and integrity failure', async () => {
    const f = await previewFixture()
    expect((await previewImage(f.ctx, f.request())).status).toBe(200)
    expect(f.dispose).toHaveBeenCalledTimes(1)
    await writeFile(f.target, Buffer.alloc(f.png.length))
    expect((await previewImage(f.ctx, f.request())).status).toBe(404)
    expect(f.dispose).toHaveBeenCalledTimes(2)
  })
  it('refuses excessive history before reading its lazy event snapshot', async () => {
    const f = await previewFixture()
    const events = vi.fn(() => { throw new Error('must not materialize') })
    f.ctx.sessionQuery.observeSession.mockResolvedValue({ header: { cwd: f.workspace }, cursor: 20000, get events() { return events() }, [Symbol.dispose]: f.dispose })
    expect((await previewImage(f.ctx, f.request())).status).toBe(413)
    expect(events).not.toHaveBeenCalled()
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('does not observe a session after caller cancellation', async () => {
    const f = await previewFixture()
    const controller = new AbortController()
    controller.abort()
    expect((await previewImage(f.ctx, new Request(f.request(), { signal: controller.signal }))).status).toBe(404)
    expect(f.ctx.sessionQuery.observeSession).not.toHaveBeenCalled()
  })
  it('serves a successful edited image using the same canonical authorization', async () => {
    const f = await previewFixture()
    f.events[0].data.name = 'image_edit'
    expect((await previewImage(f.ctx, f.request())).status).toBe(200)
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('refuses changed files, target symlinks and linked parent directories', async () => {
    const f = await previewFixture()
    await writeFile(f.target, Buffer.alloc(f.png.length))
    expect((await previewImage(f.ctx, f.request())).status).toBe(404)
    await rm(f.target)
    const outside = path.join(await temp(), 'image.png'); await writeFile(outside, f.png)
    await symlink(outside, f.target)
    expect((await previewImage(f.ctx, f.request())).status).toBe(404)
    await rm(path.dirname(f.target), { recursive: true })
    await symlink(path.dirname(outside), path.dirname(f.target))
    expect((await previewImage(f.ctx, f.request())).status).toBe(404)
  })
})
