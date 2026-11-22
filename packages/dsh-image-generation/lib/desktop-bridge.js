import { ImageError, MAX_IMAGE_BYTES, readBounded, safeError } from './provider.js'
import { parseImageParameters, imageDiagnostic, IMAGE_BATCH_BYTES } from 'dsh-desktop-model-service/image-contract'

export const PENGBAO_SERVICE_URL = 'https://pengbao.ecombus.net'
const REASONS = new Set(['available', 'disabled', 'forbidden', 'unauthenticated', 'unavailable'])
const FAILURES = {
  IMAGE_DISABLED: ['Pengbao image generation is disabled. Ask your administrator to enable it.', 403],
  IMAGE_FORBIDDEN: ['Your Pengbao account cannot generate images. Contact your administrator.', 403],
  IMAGE_AUTH: ['Sign in to Pengbao again to generate images.', 401],
  IMAGE_NETWORK: ['Pengbao image generation is temporarily unavailable.', 503],
  IMAGE_TIMEOUT: ['The local Pengbao image generation deadline expired. The server may still complete generation and you may be charged for the image. This request will not be retried automatically.', 504],
  IMAGE_UPSTREAM_TIMEOUT: ['Pengbao image generation returned HTTP 504 (upstream timeout). The server may still complete generation and you may be charged for the image. This request will not be retried automatically.', 504],
  IMAGE_TIMEOUT_UNKNOWN: ['The image service returned HTTP 504. The timeout source is unknown. The server may still complete generation and charge for the image. This request will not be retried automatically.', 504],
  IMAGE_PARAMETERS_UNSUPPORTED: ['The image parameters are unsupported or have changed. Refresh model capabilities.', 400],
  IMAGE_RESPONSE: ['Pengbao returned an invalid image response.', 502],
  IMAGE_PROVIDER_AUTH: ['The image provider rejected authentication. This is an administrator configuration issue.', 502],
  IMAGE_PROVIDER_REJECTED: ['The image generation service rejected the request; the underlying cause is unavailable.', 502],
  IMAGE_FETCH: ['The image was generated but could not be retrieved. The request may still have been charged.', 502],
  IMAGE_STORE: ['The image was generated but could not be saved. The request may still have been charged.', 502],
  IMAGE_TOO_LARGE: ['The generated image exceeds 20 MiB.', 502],
  IMAGE_INVALID_REQUEST: ['The image description is invalid.', 400],
  IMAGE_BUSY: ['Pengbao image generation is busy. Try again later.', 429],
  IMAGE_REVOKED: ['The image session has ended. Reconnect and try again.', 401],
  IMAGE_MODEL_UNSUPPORTED: ['Pengbao does not support choosing an image model per request.', 400],
  IMAGE_MODEL_UNAVAILABLE: ['The selected image model is no longer available. Refresh the model list and try again.', 400],
}
let bridge

function validModelId(value) {
  return typeof value === 'string' && value.length <= 256 && Boolean(value.trim()) && value.trim() !== 'desktop-managed' && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value)
}

function catalogResult(result) {
  if (!result || !['request-local', 'server-only'].includes(result.selection) || !Array.isArray(result.models) || result.models.length > 256) {
    throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
  }
  const seen = new Set()
  const models = result.models.map(model => {
    if (!model || !validModelId(model.id) || model.id !== model.id.trim() || seen.has(model.id)
      || typeof model.name !== 'string' || !model.name.trim() || model.name.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(model.name)) {
      throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
    }
    seen.add(model.id)
    return { id: model.id, name: model.name }
  })
  let defaultModel
  if (result.defaultModel !== undefined) {
    if (result.defaultModel === null) defaultModel = null
    else {
      const model = result.defaultModel
      if (!validModelId(model.id) || model.id !== model.id.trim() || typeof model.name !== 'string' || !model.name.trim()
        || model.name !== model.name.trim() || model.name.length > 256 || /[\p{C}\p{Zl}\p{Zp}]/u.test(model.name)) {
        throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
      }
      defaultModel = { id: model.id, name: model.name }
    }
  }
  if (result.catalogStatus !== undefined && !['available', 'default-only'].includes(result.catalogStatus)) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
  let generationParameters
  try { generationParameters = parseImageParameters(result.generationParameters) } catch { /* Fail closed for advanced options only. */ }
  return { models, selection: result.selection,
    ...(generationParameters ? { generationParameters } : {}),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(result.catalogStatus === undefined ? {} : { catalogStatus: result.catalogStatus }) }
}

/**
 * Return only bound operations, never the private gateway URL or capability.
 * @returns {undefined | Readonly<{
 *   status: (options?: {signal?: AbortSignal}) => Promise<{available: boolean, reason: string, serviceUrl: string, modelSelection: 'server-managed'}>,
 *   models: (options?: {signal?: AbortSignal}) => Promise<{models: {id: string, name: string}[], selection: 'request-local' | 'server-only', defaultModel?: {id: string, name: string}|null, catalogStatus?: 'available'|'default-only'}>,
 *   generate: (prompt: string, options?: {size?: string, model?: string, signal?: AbortSignal}) => Promise<Buffer>,
 *   generateMany: (prompt: string, options: import('dsh-desktop-model-service').ImageGenerateManyOptions) => Promise<import('dsh-desktop-model-service').ImageBatchResult>
 * }>}
 */
export function getDesktopImageBridge() { return bridge }

/**
 * Private, one-shot handoff from the desktop runtime. The capability lives only
 * in these closures for this process; this is not a sandbox for other plugins.
 * @param {{gatewayUrl: string, capabilityToken: string}} registration
 */
export function registerDesktopImageBridge({ gatewayUrl, capabilityToken } = {}) {
  if (bridge) throw new Error('Desktop image bridge is already registered.')
  let url
  try { url = new URL(gatewayUrl) } catch { throw new Error('Invalid desktop image gateway.') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || typeof capabilityToken !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(capabilityToken)) throw new Error('Invalid desktop image bridge registration.')
  const base = `${url.origin}/v1/image-generation`
  async function request(operation, prompt, options = {}) {
    const generate = operation === 'generate' || operation === 'generate-many'
    const batch = operation === 'generate-many'
    const edit = operation === 'edit'
    const longRunning = generate || edit
    if (edit) {
      if (!(options.image instanceof Uint8Array) || options.image.length === 0 || options.image.length > MAX_IMAGE_BYTES) {
        throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
      }
      if (!Buffer.from(options.image).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
      }
    }
    if (edit && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    if (edit && options.size !== undefined) {
      if (typeof options.size !== 'string' || options.size.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(options.size)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
      if (!/^(?:1|2|4)K$/.test(options.size) && !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(options.size)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    }
    if (batch && ((!Number.isSafeInteger(options.n) || options.n < 1 || options.n > 4) ||
      (options.parameterContractVersion !== undefined && options.parameterContractVersion !== 1) ||
      (options.parameterRevision !== undefined && (typeof options.parameterRevision !== 'string' || !/^[a-f0-9]{64}$/.test(options.parameterRevision))))) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    if (generate && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    if (generate && options.size !== undefined) {
      if (typeof options.size !== 'string' || options.size.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(options.size)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
      if (!/^(?:1|2|4)K$/.test(options.size) && !/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(options.size)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
      if (/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(options.size)) {
        const dimensions = options.size.split('x').map(Number)
        const width = dimensions[0] ?? 0
        const height = dimensions[1] ?? 0
        if (width > 8192 || height > 8192 || width * height > 64_000_000) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
      }
    }
    if (generate && options.model !== undefined && !validModelId(options.model)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    if (generate && options.n !== undefined && (!Number.isSafeInteger(options.n) || options.n < 1 || options.n > 4)) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    if (generate && options.quality !== undefined && (typeof options.quality !== 'string' || options.quality.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(options.quality))) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    if (generate && options.detail !== undefined && (typeof options.detail !== 'string' || options.detail.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(options.detail))) throw new ImageError('IMAGE_INVALID_REQUEST', ...FAILURES.IMAGE_INVALID_REQUEST)
    // Keep the generation/download phase below the 240-second tool budget,
    // reserving time for status, PNG normalization and the sandbox commit.
    const signal = AbortSignal.any([AbortSignal.timeout(longRunning ? 210_000 : 15_000), ...(options.signal ? [options.signal] : [])])
    try {
      signal.throwIfAborted()
      let requestBody
      if (longRunning) {
        requestBody = { prompt, ...(options.size === undefined ? {} : { size: options.size }) }
        if (edit) requestBody.image = Buffer.from(options.image).toString('base64')
        if (generate) {
          if (options.model !== undefined) requestBody.model = options.model.trim()
          if (options.n !== undefined) requestBody.n = options.n
          if (options.quality !== undefined) requestBody.quality = options.quality
          if (options.detail !== undefined) requestBody.detail = options.detail
          if (batch && options.parameterContractVersion !== undefined) requestBody.parameterContractVersion = options.parameterContractVersion
          if (batch && options.parameterRevision !== undefined) requestBody.parameterRevision = options.parameterRevision
        }
      }
      const response = await fetch(`${base}/${operation}`, {
        method: longRunning ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${capabilityToken}`, ...(longRunning ? { 'Content-Type': 'application/json' } : {}) },
        ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
      })
      if (!response.ok) {
        let code, diagnostic
        try { const payload = JSON.parse((await readBounded(response, 16_384, signal)).toString('utf8'))?.error; code = payload?.code; diagnostic = imageDiagnostic(payload?.diagnostic) }
        catch { signal.throwIfAborted() /* Ignore all free-form gateway error text. */ }
        const safeCode = Object.hasOwn(FAILURES, code) ? code : response.status === 504 ? 'IMAGE_TIMEOUT_UNKNOWN' : 'IMAGE_NETWORK'
        const failure = new ImageError(safeCode, ...FAILURES[safeCode])
        if (diagnostic && diagnostic.code === safeCode) failure.diagnostic = diagnostic
        throw failure
      }
      if (operation === 'status') {
        const result = JSON.parse((await readBounded(response, 16_384, signal)).toString('utf8'))
        if (!REASONS.has(result?.reason) || result.available !== (result.reason === 'available') || result.serviceUrl !== PENGBAO_SERVICE_URL || result.modelSelection !== 'server-managed') {
          throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
        }
        return { available: result.available, reason: result.reason, serviceUrl: PENGBAO_SERVICE_URL, modelSelection: 'server-managed' }
      }
      if (operation === 'models') {
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
        let result
        try { result = JSON.parse((await readBounded(response, 1024 * 1024, signal)).toString('utf8')) }
        catch (error) {
          if (error instanceof SyntaxError) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
          throw error
        }
        return catalogResult(result)
      }
      if (batch) {
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
        let result
        try { result = JSON.parse((await readBounded(response, Math.ceil(IMAGE_BATCH_BYTES * 4 / 3) + 65_536, signal)).toString('utf8')) }
        catch (error) { signal.throwIfAborted(); if (error instanceof ImageError) throw error; throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE) }
        if (!result || result.requested !== options.n || !Array.isArray(result.images) || !Array.isArray(result.failures) ||
          result.images.length + result.failures.length !== options.n || result.complete !== (result.failures.length === 0)) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
        const seen = new Set(); let total = 0
        const index = value => { if (!Number.isSafeInteger(value) || value < 0 || value >= options.n || seen.has(value)) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE); seen.add(value); return value }
        const images = result.images.map(image => {
          index(image?.index)
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mime) || typeof image.b64 !== 'string' || image.b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.b64)) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
          if (image.b64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw new ImageError('IMAGE_TOO_LARGE', ...FAILURES.IMAGE_TOO_LARGE)
          const data = Buffer.from(image.b64, 'base64'); total += data.length
          if (data.toString('base64') !== image.b64) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
          if (!data.length || data.length > MAX_IMAGE_BYTES || total > IMAGE_BATCH_BYTES) throw new ImageError('IMAGE_TOO_LARGE', ...FAILURES.IMAGE_TOO_LARGE)
          const valid = image.mime === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.mime === 'image/jpeg' ? data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255 : data.length >= 12 && data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP'
          if (!valid) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
          return { index: image.index, data, mime: image.mime }
        })
        const failures = result.failures.map(failure => {
          const code = Object.hasOwn(FAILURES, failure?.code) ? failure.code : 'IMAGE_RESPONSE'
          const diagnostic = imageDiagnostic(failure?.diagnostic)
          return { index: index(failure?.index), code, ...(diagnostic?.code === code ? { diagnostic } : {}) }
        })
        return { requested: options.n, images, failures, complete: result.complete }
      }
      if (edit) {
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/png') throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
        const data = await readBounded(response, MAX_IMAGE_BYTES, signal)
        if (!data.length || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
        signal.throwIfAborted()
        return data
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new ImageError('IMAGE_RESPONSE', ...FAILURES.IMAGE_RESPONSE)
      const data = await readBounded(response, MAX_IMAGE_BYTES, signal)
      signal.throwIfAborted()
      return data
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new ImageError('IMAGE_TIMEOUT', ...FAILURES.IMAGE_TIMEOUT)
      if (error?.name === 'AbortError' && longRunning) throw new ImageError('CANCELLED', 'Image operation cancelled. The server may still have generated and charged for the image.', 499)
      throw safeError(error)
    }
  }
  bridge = Object.freeze({ status: options => request('status', undefined, options), models: options => request('models', undefined, options), generate: (prompt, options) => request('generate', prompt, options), edit: (prompt, options) => request('edit', prompt, options), generateMany: (prompt, options) => request('generate-many', prompt, options) })
}
