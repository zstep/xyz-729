import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPengbaoGateway, type PengbaoGateway, type PengbaoGatewayOptions } from '../src/main/enterprise/gateway'

const servers: Server[] = []
const gateways: PengbaoGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('not listening')
  return `http://127.0.0.1:${address.port}`
}

async function gatewayFor(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, options: Partial<PengbaoGatewayOptions> = {}) {
  const upstream = await listen(handler)
  const gateway = await startPengbaoGateway({
    jwt: 'private-jwt',
    fetch: (input, init) => fetch(input.toString().replace('https://pengbao.ecombus.net', upstream), init),
    ...options
  })
  gateways.push(gateway)
  return gateway
}

function request(gateway: PengbaoGateway, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string; noAuth?: boolean; token?: string } = {}): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${gateway.url}${options.path ?? '/v1/models'}`, {
      method: options.method ?? 'GET',
      headers: { ...(options.noAuth ? {} : { Authorization: `Bearer ${options.token ?? gateway.capabilityToken}` }), ...options.headers }
    }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

const chat = (body: unknown) => ({ method: 'POST', path: '/v1/chat/completions', body: JSON.stringify(body) })

describe('Pengbao gateway', () => {
  it('publishes bounded HTML through the authenticated account API', async () => {
    const upstream = vi.fn((req: IncomingMessage, res: ServerResponse) => {
      expect(req.url).toBe('/api/v1/published')
      expect(req.headers.authorization).toBe('Bearer private-jwt')
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => { expect(JSON.parse(body)).toEqual({ html: '<!doctype html><title>Test</title>' }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: 'https://link.pengbao.ecombus.net/p/abcdef0123456789', expires_at: null })) })
    })
    const gateway = await gatewayFor(upstream)
    await expect(gateway.publishHtml('<!doctype html><title>Test</title>')).resolves.toEqual({ url: 'https://link.pengbao.ecombus.net/p/abcdef0123456789', expires_at: null })
    await expect(gateway.publishHtml('x'.repeat(5 * 1024 * 1024 + 1))).rejects.toThrow('Invalid HTML artifact')
  })

  it('does not publish empty HTML', async () => {
    const gateway = await gatewayFor(() => { throw new Error('must not forward') })
    await expect(gateway.publishHtml('')).rejects.toThrow('Invalid HTML artifact')
  })


  it('mounts video routes with a separate revoked model-scoped lease', async () => {
    let submissions = 0
    const gateway = await gatewayFor((req, res) => {
      if (req.url === '/api/v1/videos/proxy/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'seedance-2-0', name: 'Seedance', provider: 'volcengine', protocol: 'ark' }] })); return }
      if (req.url === '/api/v1/videos/proxy/submit/ark') { submissions++; res.setHeader('content-type', 'application/json'); res.end('{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"queued"}'); return }
      res.writeHead(404); res.end()
    })
    const send = (token: string, model = 'seedance-2-0') => request(gateway, { token, method: 'POST', path: '/v1/contents/generations/tasks', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, content: [{ type: 'text', text: 'fixture' }], duration: 5 }) })
    expect((await send(gateway.capabilityToken)).status).toBe(401)
    const lease = gateway.createVideoLease(['seedance-2-0'])
    expect((await send(lease.capabilityToken)).status).toBe(200)
    expect((await send(lease.capabilityToken, 'not-granted')).status).toBe(403)
    lease.revoke()
    expect((await send(lease.capabilityToken)).status).toBe(401)
    expect(submissions).toBe(1)
  })
  it.each(['http', 'transport', 'invalid-json'] as const)('reports safe defaults metadata %s failures without exposing upstream bodies', async mode => {
    const failures: unknown[] = []
    const gateway = await gatewayFor((req, res) => {
      expect(req.url).toBe('/api/config')
      if (mode === 'transport') { req.socket.destroy(); return }
      res.writeHead(mode === 'http' ? 503 : 200, { 'content-type': 'application/json' })
      res.end('private-jwt INTERNAL invalid-json')
    }, { onFailure: failure => failures.push(failure) })
    const response = await request(gateway, { path: '/v1/model-service/defaults' })
    expect(response.status).toBe(502)
    expect(response.body).not.toMatch(/private-jwt|INTERNAL/)
    expect(failures).toEqual([expect.objectContaining({
      requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/),
      kind: mode === 'http' ? 'upstream-http' : mode === 'transport' ? 'transport' : 'upstream-response',
      upstreamRoute: 'config', phase: mode === 'transport' ? 'request' : mode === 'http' ? 'headers' : 'body',
      ...(mode === 'transport' ? {} : { upstreamStatus: mode === 'http' ? 503 : 200 })
    })])
    expect(JSON.stringify(failures)).not.toMatch(/private-jwt|INTERNAL|invalid-json/)
  })

  it('reports metadata timeout even when transport ignores cancellation', async () => {
    const failures: unknown[] = []
    const gateway = await gatewayFor(() => {}, { timeoutMs: 80, fetch: async () => new Promise<Response>(() => {}), onFailure: failure => failures.push(failure) })
    expect((await request(gateway, { path: '/v1/model-service/defaults' })).status).toBe(504)
    expect(failures).toEqual([expect.objectContaining({ kind: 'timeout', upstreamRoute: 'config', phase: 'request', abortReason: 'deadline' })])
  })

  it('requires exact Host including port, capability auth, exact paths, and no browser headers', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('{}') })
    const gateway = await gatewayFor(upstream)
    expect((await request(gateway, { noAuth: true })).status).toBe(401)
    const rejectedHeaders: Record<string, string>[] = [{ Host: 'evil.test' }, { Host: '127.0.0.1:1' }, { Host: `localhost:${gateway.port}` }, { Origin: '' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Mode': 'no-cors' }]
    for (const headers of rejectedHeaders) {
      expect((await request(gateway, { headers })).status).toBe(403)
    }
    for (const path of ['/v1/models/extra', '/v1/models?x=1', '/api/v1/models', '/v1/%6dodels']) {
      expect((await request(gateway, { path })).status).toBe(404)
    }
    expect((await request(gateway, { method: 'OPTIONS' })).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
    const result = await request(gateway)
    expect(result.status).toBe(200)
    expect(result.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('projects the authenticated image default into the matching model metadata', async () => {
    const gateway = await gatewayFor(async (req, res) => {
      if (req.url === '/api/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [
          { id: 'gpt-image-2.5-sunburst', name: 'Sunburst' },
          { id: 'chat-model', name: 'Chat' }
        ] }))
        return
      }
      if (req.url === '/api/v1/images/metadata') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          models: [{ id: 'gpt-image-2.5-sunburst', name: 'Sunburst' }],
          defaultModel: { id: 'gpt-image-2.5-sunburst', name: 'Sunburst' },
          selection: 'request-local',
          catalogStatus: 'available'
        }))
        return
      }
      res.end('{}')
    })
    const result = await request(gateway)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ data: [
      { id: 'gpt-image-2.5-sunburst', name: 'Sunburst', info: { meta: { imageModelId: 'gpt-image-2.5-sunburst' } } },
      { id: 'chat-model', name: 'Chat' }
    ] })
  })

  it('does not project an image default absent from the image catalog', async () => {
    const gateway = await gatewayFor(async (req, res) => {
      if (req.url === '/api/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'chat-model', name: 'Chat' }] }))
        return
      }
      if (req.url === '/api/v1/images/metadata') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ models: [], defaultModel: { id: 'gpt-image-2.5-sunburst', name: 'Sunburst' }, selection: 'request-local', catalogStatus: 'default-only' }))
        return
      }
      res.end('{}')
    })
    const result = await request(gateway)
    expect(JSON.parse(result.body)).toEqual({ data: [{ id: 'chat-model', name: 'Chat' }] })
  })

  it('preserves explicit imageModelId metadata over the server default', async () => {
    const gateway = await gatewayFor(async (req, res) => {
      if (req.url === '/api/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'gpt-image-2.5-sunburst', info: { meta: { imageModelId: 'explicit-image' } } }] }))
        return
      }
      if (req.url === '/api/v1/images/metadata') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ models: [{ id: 'gpt-image-2.5-sunburst', name: 'Sunburst' }], defaultModel: { id: 'gpt-image-2.5-sunburst', name: 'Sunburst' }, selection: 'request-local', catalogStatus: 'available' }))
        return
      }
      res.end('{}')
    })
    const result = await request(gateway)
    expect(JSON.parse(result.body).data[0].info.meta.imageModelId).toBe('explicit-image')
  })

  it('accepts Node fetch while still rejecting browser-originated requests', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('{"data":[]}') })
    const gateway = await gatewayFor(upstream)
    const response = await fetch(`${gateway.url}/v1/models`, {
      headers: { Authorization: `Bearer ${gateway.capabilityToken}` }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [] })
    expect(upstream).toHaveBeenCalledOnce()
    expect((await request(gateway, { headers: { 'Sec-Fetch-Mode': 'navigate' } })).status).toBe(403)
    expect((await request(gateway, { headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(403)
  })

  it('maps fixed paths, preserves nested tool association and sources/error SSE, and strips headers', async () => {
    const messages = [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'ok' }]
    const seen: { url?: string; headers?: IncomingMessage['headers']; body?: unknown } = {}
    const sse = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\ndata: {"sources":["source"]}\n\ndata: {"error":{"message":"provider event"}}\n\ndata: [DONE]\n\n'
    const gateway = await gatewayFor(async (req, res) => {
      seen.url = req.url
      seen.headers = req.headers
      let text = ''
      for await (const chunk of req) text += chunk
      seen.body = text ? JSON.parse(text) : undefined
      res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'secret=1', 'x-internal': 'private-jwt', 'access-control-allow-origin': '*' })
      res.end(sse)
    })
    const result = await request(gateway, { ...chat({ model: 'm', messages, custom_cloud_field: true }), headers: { 'x-secret': 'nope', Cookie: 'session=secret' } })
    expect(result.status).toBe(200)
    expect(result.body).toBe(sse)
    expect(seen.url).toBe('/api/v1/chat/completions')
    expect(seen.body).toEqual({ model: 'm', messages, tools: [], features: { memory: true } })
    expect(seen.headers?.authorization).toBe('Bearer private-jwt')
    expect(seen.headers?.['x-secret']).toBeUndefined()
    expect(seen.headers?.cookie).toBeUndefined()
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.headers['x-internal']).toBeUndefined()
    expect(result.headers['access-control-allow-origin']).toBeUndefined()
    await request(gateway)
    expect(seen.url).toBe('/api/v1/models')
  })

  it('preserves image input inside messages without granting image-generation access', async () => {
    const messages = [{ role: 'user', content: [
      { type: 'text', text: 'Describe this fixture' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' } }
    ] }]
    let forwarded: unknown
    const gateway = await gatewayFor(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      forwarded = JSON.parse(text)
      res.end('{"choices":[]}')
    })
    expect((await request(gateway, chat({ model: 'vision', messages }))).status).toBe(200)
    expect(forwarded).toEqual({ model: 'vision', messages, tools: [], features: { memory: true } })
    expect((await request(gateway, { method: 'POST', path: '/v1/images/generations', body: '{}' })).status).toBe(401)
  })

  it.each(['chat_id', 'id', 'session_id', 'parent_id', 'tool_ids', 'metadata', 'features', 'files'])('rejects cloud orchestration %s before upstream', async key => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('{}') })
    const gateway = await gatewayFor(upstream)
    expect((await request(gateway, chat({ model: 'm', messages: [], [key]: 'bad' }))).status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses redirects and sanitizes upstream errors and exceptions', async () => {
    let calls = 0
    const gateway = await gatewayFor((_req, res) => {
      calls += 1
      res.writeHead(302, { location: '/stolen', 'set-cookie': 'token=private-jwt' })
      res.end('private-jwt')
    })
    const result = await request(gateway)
    expect(result.status).toBe(502)
    expect(result.body).not.toContain('private-jwt')
    expect(result.headers.location).toBeUndefined()
    expect(calls).toBe(1)
    const failed = await gatewayFor((_req, res) => { res.writeHead(500); res.end('private-jwt') })
    expect((await request(failed)).body).not.toContain('private-jwt')
    const throwing = await gatewayFor(() => {}, { fetch: async () => { throw new Error('private-jwt INTERNAL') } })
    expect((await request(throwing)).body).not.toMatch(/private-jwt|INTERNAL/)
  })

  it.each([400, 401, 403, 404, 413, 422, 429, 500, 502, 503, 504])('preserves upstream HTTP %s without exposing its body or headers', async status => {
    const onFailure = vi.fn()
    const gateway = await gatewayFor((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain', 'set-cookie': 'secret=private-jwt', 'x-internal': 'private-jwt' })
      res.end('stream timeout private-jwt INTERNAL https://upstream.invalid')
    }, { onFailure })
    const result = await request(gateway, chat({ model: 'm', messages: [], tools: [] }))
    expect(result.status).toBe(status)
    expect(JSON.parse(result.body)).toMatchObject({ error: { type: 'upstream_error', upstream_status: status } })
    expect(result.body).not.toMatch(/private-jwt|INTERNAL|upstream\.invalid|stream timeout/)
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.headers['x-internal']).toBeUndefined()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure.mock.calls[0]).toEqual([{ requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), kind: 'upstream-http', upstreamStatus: status, elapsedMs: expect.any(Number), phase: 'headers', bytesReceived: 0, upstreamHeadersMs: expect.any(Number) }])
    if (status === 504) expect(JSON.parse(result.body).error.message).toContain('timed out')
  })

  it('generates a fresh correlation ID per attempt and ignores caller-supplied IDs', async () => {
    const onFailure = vi.fn()
    const ids: string[] = []
    const gateway = await gatewayFor((req, res) => {
      ids.push(String(req.headers['x-pengbao-request-id']))
      res.writeHead(504)
      res.end('private-jwt')
    }, { onFailure })
    for (let i = 0; i < 2; i++) {
      const result = await request(gateway, { ...chat({ model: 'm', messages: [] }), headers: { 'X-Pengbao-Request-Id': 'private-jwt' } })
      expect(result.status).toBe(504)
      expect(result.headers['x-pengbao-request-id']).toBeUndefined()
      expect(result.body).not.toContain(ids[i])
      expect(onFailure.mock.calls[i]?.[0].requestId).toBe(ids[i])
    }
    expect(ids.every(id => /^pb-[a-f0-9]{32}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('private-jwt')
  })

  it('does not replay timed-out requests or invalidate the account route', async () => {
    const onFailure = vi.fn()
    let calls = 0
    const gateway = await gatewayFor((_req, res) => {
      calls += 1
      if (calls === 1) { res.writeHead(504); res.end('stream timeout'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    }, { onFailure })
    expect((await request(gateway, chat({ model: 'm', messages: [], tools: [] }))).status).toBe(504)
    expect(calls).toBe(1)
    const recovered = await request(gateway, chat({ model: 'm', messages: [], tools: [] }))
    expect(recovered.status).toBe(200)
    expect(recovered.body).toBe('data: [DONE]\n\n')
    expect(calls).toBe(2)
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('records only safe transport metadata and isolates diagnostic callback failures', async () => {
    const onFailure = vi.fn(() => { throw new Error('diagnostic sink failed') })
    const gateway = await gatewayFor(() => {}, { onFailure, fetch: async () => { throw new Error('private-jwt INTERNAL') } })
    const result = await request(gateway)
    expect(result.status).toBe(502)
    expect(result.body).not.toMatch(/private-jwt|INTERNAL|diagnostic/)
    expect(onFailure.mock.calls[0]).toEqual([{ requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), kind: 'transport', elapsedMs: expect.any(Number), phase: 'request', bytesReceived: 0 }])
  })

  it.each([false, true])('distinguishes a post-header reset with body bytes=%s without replay or sensitive diagnostics', async withBody => {
    const onFailure = vi.fn()
    let upstreamStream: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamStream = controller
        if (withBody) controller.enqueue(new TextEncoder().encode('data: private-jwt\n\n'))
      }
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const gateway = await gatewayFor(() => {}, { fetch: fetcher, onFailure })
    const response = await fetch(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } })
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (!reader || !upstreamStream) throw new Error('missing stream')
    if (withBody) expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: private-jwt\n\n')
    const failedRead = reader.read()
    upstreamStream.error(new Error('private-jwt INTERNAL', { cause: { code: 'UND_ERR_SOCKET', message: 'private-jwt' } }))
    await expect(failedRead).rejects.toThrow()
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
    expect(onFailure.mock.calls[0]?.[0]).toEqual({
      requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), kind: 'transport', upstreamStatus: 200, phase: withBody ? 'body' : 'headers',
      bytesReceived: withBody ? Buffer.byteLength('data: private-jwt\n\n') : 0,
      elapsedMs: expect.any(Number), upstreamHeadersMs: expect.any(Number), transportCode: 'UND_ERR_SOCKET',
      ...(withBody ? { firstByteMs: expect.any(Number), lastByteMs: expect.any(Number) } : {})
    })
    expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(/private-jwt|INTERNAL|message/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not include unknown transport codes in diagnostics', async () => {
    const onFailure = vi.fn()
    const gateway = await gatewayFor(() => {}, { onFailure, fetch: async () => {
      throw new Error('private-jwt', { cause: { code: 'private-jwt' } })
    } })
    expect((await request(gateway)).status).toBe(502)
    expect(onFailure.mock.calls[0]?.[0]).not.toHaveProperty('transportCode')
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('private-jwt')
  })

  it('classifies a silent upstream deadline separately from downstream cancellation', async () => {
    const onFailure = vi.fn()
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private-jwt')), { once: true }))
    })
    const gateway = await gatewayFor(() => {}, { onFailure, timeoutMs: 100, fetch: fetcher })
    expect((await request(gateway)).status).toBe(504)
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ kind: 'timeout', phase: 'request', bytesReceived: 0, abortReason: 'deadline' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([false, true])('attributes a post-header deadline with body bytes=%s to the local timer', async withBody => {
    const onFailure = vi.fn()
    const cancel = vi.fn()
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { if (withBody) controller.enqueue(new TextEncoder().encode('data: first\n\n')) },
      cancel
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const gateway = await gatewayFor(() => {}, { onFailure, timeoutMs: 250, fetch: fetcher })
    const response = await fetch(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } })
    expect(response.status).toBe(200)
    await expect(response.text()).rejects.toThrow()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ kind: 'timeout', phase: withBody ? 'body' : 'headers', abortReason: 'deadline', upstreamStatus: 200 })
    expect(onFailure.mock.calls[0]?.[0]).not.toHaveProperty('transportCode')
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('preserves a quiet interval and subsequent SSE bytes without inventing an idle deadline', async () => {
    const onFailure = vi.fn()
    let upstreamStream: ReadableStreamDefaultController<Uint8Array> | undefined
    const gateway = await gatewayFor(() => {}, { onFailure, timeoutMs: 2000, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { upstreamStream = controller }
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await fetch(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } })
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!upstreamStream) throw new Error('missing stream')
    upstreamStream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
    upstreamStream.close()
    expect(await response.text()).toBe('data: [DONE]\n\n')
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('keeps active chat SSE alive beyond the preflight budget without replay', async () => {
    const onFailure = vi.fn()
    let calls = 0
    const gateway = await gatewayFor((_req, res) => {
      calls++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let count = 0
      const timer = setInterval(() => {
        if (++count === 8) { clearInterval(timer); res.end('data: [DONE]\n\n') }
        else res.write(': actual upstream activity\n\n')
      }, 35)
      res.once('close', () => clearInterval(timer))
    }, { timeoutMs: 100, chatIdleTimeoutMs: 180, chatMaxDurationMs: 1500, imageTimeoutMs: 100, onFailure })
    const result = await request(gateway, chat({ model: 'm', messages: [], stream: true }))
    expect(result.status).toBe(200)
    expect(result.body).toBe(': actual upstream activity\n\n'.repeat(7) + 'data: [DONE]\n\n')
    expect(calls).toBe(1)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it.each(['request', 'headers', 'body'] as const)('bounds chat upstream silence during %s with an idle diagnosis', async phase => {
    const onFailure = vi.fn()
    const cancel = vi.fn()
    const fetcher = vi.fn(async () => {
      if (phase === 'request') return new Promise<Response>(() => {})
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { if (phase === 'body') controller.enqueue(new TextEncoder().encode('data: first\n\n')) },
        cancel
      }), { headers: { 'content-type': 'text/event-stream' } })
    })
    const gateway = await gatewayFor(() => {}, { timeoutMs: 1000, chatIdleTimeoutMs: 100, chatMaxDurationMs: 1500, fetch: fetcher, onFailure })
    if (phase === 'request') expect((await request(gateway, chat({ model: 'm', messages: [] }))).status).toBe(504)
    else await expect(request(gateway, chat({ model: 'm', messages: [] }))).rejects.toThrow()
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'timeout', phase, abortReason: 'deadline', timeoutStage: 'upstream-idle' }))
    expect(onFailure.mock.calls[0]?.[0].elapsedMs).toBeLessThan(800)
    if (phase !== 'request') expect(cancel).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('bounds active chat by an independent total deadline', async () => {
    const onFailure = vi.fn()
    const gateway = await gatewayFor((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const timer = setInterval(() => res.write(': active\n\n'), 25)
      res.once('close', () => clearInterval(timer))
    }, { timeoutMs: 1000, chatIdleTimeoutMs: 150, chatMaxDurationMs: 220, onFailure })
    await expect(request(gateway, chat({ model: 'm', messages: [] }))).rejects.toThrow()
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'timeout', timeoutStage: 'chat-total', abortReason: 'deadline', phase: 'body' }))
    expect(onFailure.mock.calls[0]?.[0].elapsedMs).toBeLessThan(800)
  })

  it('does not renew chat idle time for empty upstream chunks', async () => {
    const onFailure = vi.fn()
    let timer: ReturnType<typeof setInterval> | undefined
    const gateway = await gatewayFor(() => {}, { timeoutMs: 1000, chatIdleTimeoutMs: 100, chatMaxDurationMs: 1500, onFailure,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { timer = setInterval(() => controller.enqueue(new Uint8Array()), 20) },
        cancel() { clearInterval(timer) }
      }), { headers: { 'content-type': 'text/event-stream' } }) })
    try {
      await expect(request(gateway, chat({ model: 'm', messages: [] }))).rejects.toThrow()
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ timeoutStage: 'upstream-idle', bytesReceived: 0, phase: 'headers' }))
    } finally { clearInterval(timer) }
  })

  it.each(['declared', 'received'] as const)('diagnoses local %s body overflow using only bounded numeric metadata', async source => {
    const onFailure = vi.fn(() => { throw new Error('private sink') })
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('{}') })
    const gateway = await gatewayFor(upstream, { maxChatBodyBytes: 64, onFailure })
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'PRIVATE'.repeat(30) }] })
    const response = await request(gateway, { ...chat({}), body,
      headers: source === 'declared' ? { 'Content-Length': String(Buffer.byteLength(body)) } : { 'Transfer-Encoding': 'chunked' } })
    expect(response.status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      requestId: expect.stringMatching(/^pb-[a-f0-9]{32}$/), kind: 'request-size', phase: 'request',
      elapsedMs: expect.any(Number), bytesReceived: 0, requestBytes: Buffer.byteLength(body), maxBodyBytes: 64, sizeSource: source
    })
    expect(JSON.stringify(onFailure.mock.calls) + response.body).not.toMatch(/PRIVATE|private sink|private-jwt/)
  })

  it('allows chat first-byte silence beyond the old socket/preflight timeout', async () => {
    const gateway = await gatewayFor((_req, res) => {
      const timer = setTimeout(() => res.end('{"choices":[]}'), 200)
      res.once('close', () => clearTimeout(timer))
    }, { timeoutMs: 80, imageTimeoutMs: 80, chatIdleTimeoutMs: 500, chatMaxDurationMs: 1500 })
    expect((await request(gateway, chat({ model: 'm', messages: [] }))).body).toBe('{"choices":[]}')
  })

  it('keeps chat upload bounded by preflight time without dispatch', async () => {
    const onFailure = vi.fn()
    const fetcher = vi.fn(async () => Response.json({}))
    const gateway = await gatewayFor(() => {}, { timeoutMs: 100, chatIdleTimeoutMs: 1000, onFailure, fetch: fetcher })
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${gateway.url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.capabilityToken}`, 'Transfer-Encoding': 'chunked' } }, res => {
        res.resume()
        res.once('end', () => { req.destroy(); resolve(res.statusCode ?? 0) })
      })
      req.on('error', reject)
      req.write('{"model":')
    })
    expect(status).toBe(504)
    expect(fetcher).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'timeout', timeoutStage: 'preflight', phase: 'request' }))
  })

  it('bounds blocked chat downstream separately from upstream inactivity', async () => {
    const onFailure = vi.fn()
    const cancel = vi.fn()
    let pulls = 0
    const gateway = await gatewayFor(() => {}, { timeoutMs: 2000, chatIdleTimeoutMs: 180, chatMaxDurationMs: 2000, onFailure,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(64 * 1024)) }, cancel
      }), { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(`${gateway.url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.capabilityToken}` } }, res => { res.pause(); resolve(res) })
      req.on('error', reject)
      req.end(JSON.stringify({ model: 'm', messages: [] }))
    })
    try {
      await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce(), { timeout: 1200 })
      expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ kind: 'timeout', timeoutStage: 'downstream-blocked', abortReason: 'deadline' })
      expect(pulls).toBeLessThan(512)
      expect(cancel).toHaveBeenCalledOnce()
    } finally { response.destroy() }
  })

  it('cleans completed chat timers and releases slots before subsequent requests', async () => {
    const failures = vi.fn()
    const gateway = await gatewayFor((_req, res) => { res.end('data: [DONE]\n\n') }, {
      maxConcurrent: 1, timeoutMs: 80, chatIdleTimeoutMs: 80, chatMaxDurationMs: 120, onFailure: failures
    })
    for (let i = 0; i < 2; i++) expect((await request(gateway, chat({ model: 'm', messages: [] }))).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(failures).not.toHaveBeenCalled()
    expect((await request(gateway)).status).toBe(200)
  })

  it.each([0, -1, NaN, 0.5, Number.MAX_SAFE_INTEGER])('rejects unsafe chat timer limits: %s', async limit => {
    for (const field of ['chatIdleTimeoutMs', 'chatMaxDurationMs']) {
      await expect(startPengbaoGateway({ jwt: 'fixture', [field]: limit })).rejects.toThrow('Invalid gateway limit')
    }
  })

  it('keeps a pipelined chat alive when a sibling chat completes first', async () => {
    const gateway = await gatewayFor((_req, res) => {
      const delay = calls++ === 0 ? 25 : 250
      const timer = setTimeout(() => res.end('data: [DONE]\n\n'), delay)
      res.once('close', () => clearTimeout(timer))
    }, { timeoutMs: 80, imageTimeoutMs: 80, chatIdleTimeoutMs: 500, chatMaxDurationMs: 1500 })
    let calls = 0
    const socket = netConnect(gateway.port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject) })
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`pipelined responses=${(Buffer.concat(chunks).toString().match(/data: \[DONE\]/g) ?? []).length}`)), 3000)
      const finish = () => { clearTimeout(timeout); resolve() }
      socket.on('data', chunk => {
        chunks.push(chunk)
        if ((Buffer.concat(chunks).toString().match(/data: \[DONE\]/g) ?? []).length === 2) finish()
      })
      socket.once('error', error => { clearTimeout(timeout); reject(error) })
      socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: ${gateway.url.slice('http://'.length)}\r\nAuthorization: Bearer ${gateway.capabilityToken}\r\nContent-Type: application/json\r\nContent-Length: 27\r\nConnection: keep-alive\r\n\r\n{"model":"m","messages":[]}`)
      socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: ${gateway.url.slice('http://'.length)}\r\nAuthorization: Bearer ${gateway.capabilityToken}\r\nContent-Type: application/json\r\nContent-Length: 27\r\nConnection: keep-alive\r\n\r\n{"model":"m","messages":[]}`)
    })
    socket.destroy()
  })

  it('forwards multi-megabyte chat bodies that exceed the metadata cap', async () => {
    const received: number[] = []
    const gateway = await gatewayFor((req, res) => {
      let size = 0
      req.on('data', chunk => { size += chunk.length })
      req.on('end', () => {
        received.push(size)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: [DONE]\n\n')
      })
    })
    const body = JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'conversation '.repeat(340_000) }]
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024)
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gateway.capabilityToken}`, 'Content-Type': 'application/json' },
      body
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    // The gateway re-serializes the validated body, so compare bounds rather than exact bytes.
    expect(received).toHaveLength(1)
    expect(received[0]).toBeGreaterThan(4 * 1024 * 1024)
  })

  it('delivers an oversized chat body error the client can read instead of a transport reset', async () => {
    const upstream = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end('{}') })
    const gateway = await gatewayFor(upstream, { maxChatBodyBytes: 64 })
    // One MiB was enough to surface as ECONNRESET before the body was drained.
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] })
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gateway.capabilityToken}`, 'Content-Type': 'application/json' },
      body
    })
    expect(response.status).toBe(413)
    expect(await response.text()).not.toContain('x')
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([0, -1, NaN, 0.5, Infinity])('rejects unsafe chat body limits: %s', async limit => {
    await expect(startPengbaoGateway({ jwt: 'fixture', maxChatBodyBytes: limit })).rejects.toThrow('Invalid gateway limit')
  })

  it('limits bodies, invalid JSON, concurrency, and request duration', async () => {
    let markStarted: () => void = () => { throw new Error('request gate not initialized') }
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gateway = await gatewayFor(() => { markStarted() }, { maxChatBodyBytes: 64, maxConcurrent: 1, timeoutMs: 1000 })
    expect((await request(gateway, chat({ model: 'm', messages: [], padding: 'x'.repeat(100) }))).status).toBe(413)
    expect((await request(gateway, { method: 'POST', path: '/v1/chat/completions', body: '{' })).status).toBe(400)
    const pending = request(gateway)
    // Wait until the first request owns the slot instead of racing two connections.
    await started
    expect((await request(gateway)).status).toBe(429)
    expect((await pending).status).toBe(504)
  })

  it.each(['models', 'chat'])('streams %s before completion and cancels the upstream reader on downstream disconnect', async route => {
    let closed = false
    const onFailure = vi.fn()
    const gateway = await gatewayFor((_req, res) => {
      res.on('close', () => { closed = true })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
    }, { onFailure })
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${gateway.url}/v1/${route === 'chat' ? 'chat/completions' : 'models'}`, { method: route === 'chat' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${gateway.capabilityToken}` } }, res => {
        res.once('data', chunk => {
          expect(chunk.toString()).toBe('data: first\n\n')
          res.destroy()
          resolve()
        })
      })
      req.on('error', reject)
      req.end(route === 'chat' ? JSON.stringify({ model: 'm', messages: [] }) : undefined)
    })
    await vi.waitFor(() => expect(closed).toBe(true))
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ kind: 'cancelled', abortReason: 'downstream', phase: 'body', bytesReceived: Buffer.byteLength('data: first\n\n') })
  })

  it('applies downstream backpressure instead of reading the entire upstream stream', async () => {
    let pulls = 0
    const cancel = vi.fn()
    const gateway = await gatewayFor(() => {}, { fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1024))
      },
      cancel
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(`${gateway.url}/v1/models`, { headers: { Authorization: `Bearer ${gateway.capabilityToken}` } }, res => {
        res.pause()
        resolve(res)
      })
      req.on('error', reject)
      req.end()
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const boundedPulls = pulls
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(pulls).toBe(boundedPulls)
    expect(pulls).toBeLessThan(512)
    response.destroy()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it.each(['models', 'chat'])('revokes only its own grants and aborts only their active %s requests', async route => {
    const signals: AbortSignal[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const gateway = await gatewayFor(() => {}, { fetch: fetcher })
    const first = gateway.createModelServiceGrant(['chat.completions'])
    const second = gateway.createModelServiceGrant(['chat.completions'])
    expect(first).toMatchObject({ contractVersion: 1, gatewayUrl: gateway.url, capabilities: ['chat.completions'] })

    const routeOptions = route === 'chat' ? chat({ model: 'm', messages: [] }) : {}
    const firstRequest = request(gateway, { ...routeOptions, token: first.capabilityToken }).catch(() => undefined)
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    const secondRequest = request(gateway, { ...routeOptions, token: second.capabilityToken }).catch(() => undefined)
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    const legacyRequest = request(gateway, routeOptions).catch(() => undefined)
    await vi.waitFor(() => expect(signals).toHaveLength(3))

    first.revoke()
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true))
    expect(signals[1]?.aborted).toBe(false)
    expect(signals[2]?.aborted).toBe(false)
    expect((await request(gateway, { token: first.capabilityToken })).status).toBe(401)
    await Promise.all([firstRequest])
    second.revoke()
    expect((await request(gateway, { token: second.capabilityToken })).status).toBe(401)
    await secondRequest
    await gateway.stop()
    await legacyRequest
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('keeps sibling requests registered after one request completes', async () => {
    const signals: AbortSignal[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      signals.push(signal)
      if (signals.length === 1) return Response.json({ data: [] })
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    const gateway = await gatewayFor(() => {}, { fetch: fetcher })
    const grant = gateway.createModelServiceGrant(['chat.completions'])
    expect((await request(gateway, { token: grant.capabilityToken })).status).toBe(200)
    const pending = request(gateway, { token: grant.capabilityToken }).catch(() => undefined)
    await vi.waitFor(() => expect(signals).toHaveLength(2))

    grant.revoke()
    await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true))
    expect(signals[0]?.aborted).toBe(false)
    await pending
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects unsupported and duplicate model service scopes', async () => {
    const gateway = await gatewayFor(() => {})
    expect(() => gateway.createModelServiceGrant([])).toThrow('Unsupported model service grant')
    expect(() => gateway.createModelServiceGrant(['chat.completions', 'chat.completions'])).toThrow('Unsupported model service grant')
    expect(() => gateway.createModelServiceGrant(['video.generate'] as unknown as Parameters<typeof gateway.createModelServiceGrant>[0])).toThrow('Unsupported model service grant')
    expect(() => gateway.createModelServiceGrant(['image.generate'])).toThrow('Unsupported model service grant')
  })

  it('stop aborts every upstream request, closes clients, and is idempotent', async () => {
    const signals: AbortSignal[] = []
    const gateway = await gatewayFor(() => {}, { fetch: async (_input, init) => {
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private-jwt')), { once: true }))
    } })
    const pending = [request(gateway).catch(() => undefined), request(gateway).catch(() => undefined)]
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    await Promise.all([gateway.stop(), gateway.stop()])
    await Promise.all(pending)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    await expect(request(gateway)).rejects.toThrow()
  })
})
