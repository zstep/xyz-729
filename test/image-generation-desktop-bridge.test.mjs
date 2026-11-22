import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
async function registry() {
  vi.resetModules()
  return import('../packages/dsh-image-generation/lib/desktop-bridge.js')
}
async function server(handler) {
  const http = createServer(handler)
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)) })
  return `http://127.0.0.1:${http.address().port}`
}
const token = 'a'.repeat(48)
const available = { available: true, reason: 'available', serviceUrl: 'https://pengbao.ecombus.net', modelSelection: 'server-managed' }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64')
const batchOptions = { n: 2, quality: 'high', detail: '', parameterContractVersion: 1, parameterRevision: 'a'.repeat(64) }

it('uses one batch route, preserves partial images and copies only safe per-image diagnostics', async () => {
  const calls = []
  const diagnostic = { requestId: `pb-${'c'.repeat(32)}`, stage: 'download', code: 'IMAGE_UPSTREAM_TIMEOUT', elapsedMs: 43, upstreamStatus: 504 }
  const gatewayUrl = await server(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    calls.push({ path: req.url, body: JSON.parse(body) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ requested: 2, complete: false, images: [{ index: 0, b64: PNG.toString('base64'), mime: 'image/png' }], failures: [{ index: 1, code: diagnostic.code, diagnostic: { ...diagnostic, jwt: token } }] }))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  expect(await module.getDesktopImageBridge().generateMany('Fixture batch', batchOptions)).toEqual({ requested: 2, complete: false, images: [{ index: 0, data: PNG, mime: 'image/png' }], failures: [{ index: 1, code: diagnostic.code, diagnostic }] })
  expect(calls).toEqual([{ path: '/v1/image-generation/generate-many', body: { prompt: 'Fixture batch', ...batchOptions } }])
})

it.each([
  { requested: 2, complete: true, images: [{ index: 0, b64: PNG.toString('base64'), mime: 'image/png' }, { index: 0, b64: PNG.toString('base64'), mime: 'image/png' }], failures: [] },
  { requested: 2, complete: false, images: [{ index: 0, b64: Buffer.from('not-png').toString('base64'), mime: 'image/png' }], failures: [{ index: 1, code: 'IMAGE_RESPONSE' }] },
  { requested: 2, complete: true, images: [], failures: [] },
])('rejects malformed batch indexes, bitmap signatures and incomplete envelopes', async payload => {
  const gatewayUrl = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)) })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().generateMany('Fixture', batchOptions)).rejects.toMatchObject({ code: 'IMAGE_RESPONSE' })
})

it('exports a one-shot registry with bound operations but no capability getter or reset', async () => {
  const module = await registry()
  expect(module.getDesktopImageBridge()).toBeUndefined()
  for (const gatewayUrl of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://127.0.0.1:1234/v1', 'http://user:key@127.0.0.1:1234', 'http://127.0.0.1:1234?key=x', 'http://127.0.0.1']) {
    expect(() => module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })).toThrow()
  }
  expect(() => module.registerDesktopImageBridge({ gatewayUrl: 'http://127.0.0.1:1234', capabilityToken: 'bad\nheader' })).toThrow()
  module.registerDesktopImageBridge({ gatewayUrl: 'http://127.0.0.1:1234', capabilityToken: token })
  expect(Object.keys(module.getDesktopImageBridge())).toEqual(['status', 'models', 'generate', 'edit', 'generateMany'])
  expect(Object.isFrozen(module.getDesktopImageBridge())).toBe(true)
  expect(JSON.stringify(module.getDesktopImageBridge())).not.toContain(token)
  expect(Object.keys(module)).not.toContain('reset')
  expect(() => module.registerDesktopImageBridge({ gatewayUrl: 'http://127.0.0.1:1235', capabilityToken: token })).toThrow(/already/)
})

it('uses fixed routes, forwards an explicit size only when provided, and keeps a private bearer header', async () => {
  const calls = []
  const gatewayUrl = await server(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: body && JSON.parse(body) })
    if (req.url.endsWith('/status')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...available, token: 'do-not-forward' })); return }
    res.setHeader('content-type', 'image/png'); res.end(Buffer.from([137, 80, 78, 71]))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  const bridge = module.getDesktopImageBridge()
  expect(await bridge.status()).toEqual(available)
  expect(await bridge.generate('A flower')).toEqual(Buffer.from([137, 80, 78, 71]))
  expect(await bridge.generate('A wide flower', { size: '2048x1024' })).toEqual(Buffer.from([137, 80, 78, 71]))
  expect(calls).toEqual([
    { path: '/v1/image-generation/status', method: 'GET', auth: `Bearer ${token}`, body: '' },
    { path: '/v1/image-generation/generate', method: 'POST', auth: `Bearer ${token}`, body: { prompt: 'A flower' } },
    { path: '/v1/image-generation/generate', method: 'POST', auth: `Bearer ${token}`, body: { prompt: 'A wide flower', size: '2048x1024' } },
  ])
})

it('edits one bounded PNG through the private route and returns the image bytes', async () => {
  const calls = []
  const gatewayUrl = await server(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    calls.push({ path: req.url, method: req.method, body: JSON.parse(body) })
    res.setHeader('content-type', 'image/png'); res.end(PNG)
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  const bridge = module.getDesktopImageBridge()
  expect(await bridge.edit('Make it blue', { image: PNG })).toEqual(PNG)
  expect(await bridge.edit('Make it wide', { image: PNG, size: '2048x1024' })).toEqual(PNG)
  expect(calls).toEqual([
    { path: '/v1/image-generation/edit', method: 'POST', body: { prompt: 'Make it blue', image: PNG.toString('base64') } },
    { path: '/v1/image-generation/edit', method: 'POST', body: { prompt: 'Make it wide', image: PNG.toString('base64'), size: '2048x1024' } },
  ])
  for (const image of [Buffer.from('not-png'), Buffer.alloc(0)]) {
    await expect(bridge.edit('Invalid', { image })).rejects.toMatchObject({ code: 'IMAGE_INVALID_REQUEST' })
  }
  expect(calls).toHaveLength(2)
})

it.each(['request-local', 'server-only'])('exposes a bound models operation with validated %s selection and no private extras', async selection => {
  const calls = []
  const models = Array.from({ length: 256 }, (_, i) => ({ id: i === 0 ? 'x'.repeat(256) : `model-${i}`, name: i === 0 ? 'n'.repeat(256) : `Model ${i}`, secret: token }))
  const gatewayUrl = await server((req, res) => {
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ models, selection, token, url: 'https://evil.invalid' }))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  expect(await module.getDesktopImageBridge().models()).toEqual({ models: models.map(({ id, name }) => ({ id, name })), selection })
  expect(timeout).toHaveBeenCalledWith(15_000)
  expect(calls).toEqual([{ path: '/v1/image-generation/models', method: 'GET', auth: `Bearer ${token}` }])
})

it('preserves explicit IDs equal to an old display label instead of inferring default identity', async () => {
  const gatewayUrl = await server((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ models: [{ id: 'Pengbao / Server default', name: 'Custom name' }], selection: 'request-local',
      defaultModel: { id: 'Pengbao / Server default', name: 'Custom name' }, catalogStatus: 'available' }))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  expect(await module.getDesktopImageBridge().models()).toMatchObject({ defaultModel: { id: 'Pengbao / Server default', name: 'Custom name' } })
})

it.each([null, { id: 'custom-image', name: 'Custom Image', key: token }])('projects validated default metadata %j and strips all extras', async defaultModel => {
  const gatewayUrl = await server((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ models: [], selection: 'request-local', defaultModel, catalogStatus: 'default-only', key: token }))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  expect(await module.getDesktopImageBridge().models()).toEqual({ models: [], selection: 'request-local',
    defaultModel: defaultModel === null ? null : { id: 'custom-image', name: 'Custom Image' }, catalogStatus: 'default-only' })
})

it.each([
  { defaultModel: {} }, { defaultModel: 42 }, { defaultModel: [] }, { defaultModel: { id: 'desktop-managed', name: 'Invalid' } },
  { defaultModel: { id: 'ok', name: 'bad\nname' } }, { defaultModel: { id: 'ok', name: ' padded ' } }, { catalogStatus: 'unknown' }
])('rejects malformed metadata %#', async extra => {
  const gatewayUrl = await server((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ models: [], selection: 'request-local', ...extra }))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().models()).rejects.toMatchObject({ code: 'IMAGE_RESPONSE' })
})

it.each([
  null, [], {}, { models: [], selection: 'request-local-v1' }, { models: [], selection: true }, { models: {}, selection: 'request-local' },
  { models: Array.from({ length: 257 }, (_, i) => ({ id: `${i}`, name: 'Model' })), selection: 'request-local' },
  ...[{ id: 'desktop-managed', name: 'Collision' }, null, [], {}, { id: 1, name: 'Bad' }, { id: '', name: 'Bad' }, { id: ' ', name: 'Bad' }, { id: ' padded ', name: 'Bad' },
    { id: 'x'.repeat(257), name: 'Bad' }, { id: 'bad\n', name: 'Bad' }, { id: 'bad\u0085', name: 'Bad' }, { id: 'Bad' + String.fromCodePoint(0x202e), name: 'Bad' },
    { id: 'bad', name: '' }, { id: 'bad', name: 1 }, { id: 'bad', name: 'x'.repeat(257) }, { id: 'bad', name: 'Bad\n' },
    { id: 'bad', name: 'Bad' + String.fromCodePoint(0x202e) }, { id: 'bad', name: 'Bad' + String.fromCodePoint(0x2028) }].map(model => ({ models: [model], selection: 'server-only' })),
  { models: [{ id: 'dup', name: 'First' }, { id: 'dup', name: 'Second' }], selection: 'request-local' },
])('rejects malformed or unbounded catalog %#', async result => {
  const gatewayUrl = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)) })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().models()).rejects.toMatchObject({ code: 'IMAGE_RESPONSE' })
})

it('rejects malformed JSON, wrong content types and oversized model responses', async () => {
  let type = 'application/json'; let body = '{'
  const gatewayUrl = await server((_req, res) => { res.setHeader('content-type', type); res.end(body) })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  const bridge = module.getDesktopImageBridge()
  await expect(bridge.models()).rejects.toMatchObject({ code: 'IMAGE_RESPONSE' })
  type = 'text/html'; body = JSON.stringify({ models: [], selection: 'server-only' })
  await expect(bridge.models()).rejects.toMatchObject({ code: 'IMAGE_RESPONSE' })
  type = 'application/json'; body = 'x'.repeat(1024 * 1024 + 1)
  await expect(bridge.models()).rejects.toMatchObject({ code: 'TOO_LARGE' })
})

it('forwards only a valid optional model without discovering or mutating shared state', async () => {
  const bodies = []
  const gatewayUrl = await server(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    bodies.push(JSON.parse(body))
    res.setHeader('content-type', 'image/png'); res.end(Buffer.from([137, 80, 78, 71]))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  const bridge = module.getDesktopImageBridge()
  await bridge.generate('Flower', { model: ' chosen ', size: '1024x1024', url: 'https://evil.invalid', token: 'not-forwarded' })
  await bridge.generate('Default flower')
  expect(bodies).toEqual([{ prompt: 'Flower', size: '1024x1024', model: 'chosen' }, { prompt: 'Default flower' }])
})

it('rejects invalid optional model values before any network access', async () => {
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl: 'http://127.0.0.1:1234', capabilityToken: token })
  const fetch = vi.spyOn(globalThis, 'fetch')
  for (const model of ['desktop-managed', ' desktop-managed ', null, 1, {}, [], '', ' ', 'x'.repeat(257), 'bad\n', 'bad\u007f', 'bad\u0085']) {
    await expect(module.getDesktopImageBridge().generate('Flower', { model })).rejects.toMatchObject({ code: 'IMAGE_INVALID_REQUEST' })
  }
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['IMAGE_MODEL_UNSUPPORTED', 'IMAGE_MODEL_UNAVAILABLE'])('returns a safe %s failure without upstream details', async code => {
  const gatewayUrl = await server((_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code, message: `${token} PRIVATE_PROMPT` } })) })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().generate('PRIVATE_PROMPT', { model: 'chosen' })).rejects.toMatchObject({ code, status: 400, message: expect.not.stringMatching(/PRIVATE_PROMPT|aaaa/) })
})

it.each([
  ['IMAGE_PROVIDER_AUTH', 502],
  ['IMAGE_PROVIDER_REJECTED', 502],
  ['IMAGE_FETCH', 502],
  ['IMAGE_STORE', 502],
])('preserves safe generation classification %s without provider text', async (code, status) => {
  const requestId = `pb-${'e'.repeat(32)}`
  const diagnostic = { requestId, stage: 'generation', code, elapsedMs: 41, upstreamStatus: 400,
    backend: { phase: code === 'IMAGE_FETCH' ? 'image-fetch' : code === 'IMAGE_STORE' ? 'store' : 'provider-response', elapsedMs: 19, providerStatus: 400 }, secret: token }
  const gatewayUrl = await server((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code, message: `${token} PRIVATE_PROMPT`, diagnostic } }))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().generate('PRIVATE_PROMPT')).rejects.toMatchObject({ code, status, diagnostic: expect.objectContaining({ code, backend: expect.any(Object) }), message: expect.not.stringMatching(/PRIVATE_PROMPT|aaaa/) })
})

it('distinguishes an upstream HTTP 504 from the local deadline without retrying', async () => {
  let calls = 0
  const gatewayUrl = await server((_req, res) => {
    calls += 1
    res.writeHead(504, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'unsafe-upstream-code', message: `${token} PRIVATE_PROMPT` } }))
  })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().generate('PRIVATE_PROMPT')).rejects.toMatchObject({
    code: 'IMAGE_TIMEOUT_UNKNOWN', status: 504, message: expect.stringMatching(/unknown|complete|charged|automatically/i),
  })
  expect(calls).toBe(1)
})

it.each(['IMAGE_TIMEOUT', 'IMAGE_UPSTREAM_TIMEOUT'])('preserves trusted gateway %s over HTTP 504 and copies only safe diagnostic fields', async code => {
  let calls = 0
  const diagnostic = { requestId: `pb-${'a'.repeat(32)}`, stage: 'generation', code, elapsedMs: 100,
    ...(code === 'IMAGE_UPSTREAM_TIMEOUT' ? { upstreamStatus: 504 } : {}) }
  const gatewayUrl = await server((_req, res) => { calls++; res.writeHead(504, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code, message: `${token} PRIVATE_PROMPT`, diagnostic: { ...diagnostic, secret: token } } })) })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().generate('PRIVATE_PROMPT')).rejects.toMatchObject({ code, diagnostic, message: expect.not.stringContaining('PRIVATE_PROMPT') })
  expect(calls).toBe(1)
})

it('classifies a malformed HTTP 504 body as unknown rather than asserting an upstream source', async () => {
  let calls = 0
  const gatewayUrl = await server((_req, res) => { calls++; res.writeHead(504, { 'content-type': 'text/html' }); res.end('<html>private prompt and key</html>') })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().generate('fixture')).rejects.toMatchObject({ code: 'IMAGE_TIMEOUT_UNKNOWN', message: expect.stringMatching(/source is unknown/) })
  expect(calls).toBe(1)
})

it('rejects invalid sizes before network access', async () => {
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl: 'http://127.0.0.1:1234', capabilityToken: token })
  const bridge = module.getDesktopImageBridge()
  for (const size of ['', '0x512', '8193x1', '8001x8000', '1024*1024']) {
    await expect(bridge.generate('Flower', { size })).rejects.toMatchObject({ code: 'IMAGE_INVALID_REQUEST' })
  }
})


it('redacts arbitrary error messages and only propagates known safe codes', async () => {
  let code = 'IMAGE_FORBIDDEN'
  const gatewayUrl = await server((_req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code, message: `${token} PRIVATE_PROMPT`, type: 'secret' } })) })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  const bridge = module.getDesktopImageBridge()
  await expect(bridge.generate('PRIVATE_PROMPT')).rejects.toMatchObject({ code: 'IMAGE_FORBIDDEN', status: 403 })
  try { await bridge.generate('PRIVATE_PROMPT') } catch (error) { expect(error.message).not.toMatch(/PRIVATE_PROMPT|aaaa/) }
  code = 'unsafe-private-code'
  await expect(bridge.generate('Flower')).rejects.toMatchObject({ code: 'IMAGE_NETWORK' })
})

it('rejects redirects without sending the capability to the redirect target', async () => {
  const calls = vi.fn((_req, res) => res.end())
  const target = await server(calls)
  const gatewayUrl = await server((_req, res) => { res.writeHead(307, { Location: target }); res.end() })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  await expect(module.getDesktopImageBridge().generate('Flower')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  await expect(module.getDesktopImageBridge().models()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  expect(calls).not.toHaveBeenCalled()
})

it('rejects content types, cumulative oversized bodies and malformed status', async () => {
  let type = 'image/svg+xml'; let data = 'svg'
  const gatewayUrl = await server((_req, res) => { res.setHeader('content-type', type); res.end(data) })
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl, capabilityToken: token })
  const bridge = module.getDesktopImageBridge()
  await expect(bridge.generate('Flower')).rejects.toMatchObject({ code: 'IMAGE_RESPONSE' })
  type = 'image/png'; data = Buffer.alloc(20 * 1024 * 1024 + 1)
  await expect(bridge.generate('Flower')).rejects.toMatchObject({ code: 'TOO_LARGE' })
  type = 'application/json'; data = JSON.stringify({ ...available, available: false })
  await expect(bridge.status()).rejects.toMatchObject({ code: 'IMAGE_RESPONSE' })
})

it('propagates cancellation and bounds the whole operation with a timeout', async () => {
  const module = await registry(); module.registerDesktopImageBridge({ gatewayUrl: 'http://127.0.0.1:1234', capabilityToken: token })
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    if (options.signal.aborted) { reject(options.signal.reason); return }
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  }))
  const bridge = module.getDesktopImageBridge(); const controller = new AbortController()
  const pending = bridge.generate('Flower', { signal: controller.signal }); controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  // Inject the timeout signal, rather than waiting for a production deadline.
  const timeout = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
  const timed = bridge.generate('Flower'); timeout.abort(new DOMException('timeout', 'TimeoutError'))
  await expect(timed).rejects.toMatchObject({ code: 'IMAGE_TIMEOUT', message: expect.stringMatching(/local|complete|charged|automatically/i) })
})
