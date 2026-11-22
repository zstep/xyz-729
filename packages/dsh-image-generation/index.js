import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { createSettings } from './lib/settings.js'
import { generate, readBounded, safeError, ImageError } from './lib/provider.js'
import { assetDirectory, normalizeImage, readGeneratedWorkspaceImage, workspaceFor } from './lib/assets.js'
import { commitImage, writerPlan } from './lib/commit.js'
import { previewImage } from './lib/preview.js'
import { managedPrompt } from './lib/managed-provider.js'

export const name = 'dsh-image-generation'
export const inject = ['credentials', 'connection', 'tools', 'skills', 'systemPrompt', 'sandboxPolicy', 'sandbox', 'subprocess', 'sessionQuery']
export const Config = z.object({})
export const IMAGE_PROMPT_SECTION = 'tool:image-generation'
export const UNCONFIGURED_IMAGE_PROMPT = 'Do not call image_generate while unavailable. Check Settings > Plugins > Image generation: Pengbao may require sign-in, administrator enablement, permission or a connection retry; custom providers need saved configuration. Never ask for an API key in conversation.'
export const CONFIGURED_IMAGE_PROMPT = 'For image creation, load the generate-image Skill and call image_generate. To modify a generated image, call image_edit with source.kind="generated" and the sha256 returned by image_generate or a previous image_edit; do not generate a replacement when the user asks to preserve the image. Presentations and documents may call image_generate in parallel for multiple visuals. Reuse its PNG workspace path in PPT and Word. The user configures this shared capability in Settings > Plugins > Image generation. In Pengbao mode prompts go to Pengbao and its configured image service; generated files are saved by the backend to the current account cloud files as well as the local workspace. Do not create a web chat or delete cloud files.'

export function imageTool(ctx, settings) {
  return defineTool({
    name: 'image_generate',
    description: 'Generate one photo, illustration or background through the configured image provider and save an Office-compatible PNG in the session workspace. Available Pengbao managed mode needs no separate API key or saved provider setup; custom providers require configuration. Load the generate-image Skill first. A presentation may call this concurrently for multiple visuals. Keep charts, tables and simple diagrams editable.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Visual subject, composition, palette, lighting, and space for document or slide text.' },
      size: { type: 'string', description: 'Optional exact output dimensions as WIDTHxHEIGHT pixels when explicitly requested. Each side is at most 8192 pixels and total area at most 64 megapixels; omit to use provider defaults.' },
      style_context: { type: 'string', description: 'Shared brand, template and illustration style for consistency across the document.' },
      purpose: { type: 'string', enum: ['general', 'presentation', 'document', 'web', 'marketing'] },
      aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'Target composition; actual dimensions are returned. OpenAI uses its closest supported canvas.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        asset_id: { type: 'string', required: true }, workspace_path: { type: 'string', required: true },
        media_type: { type: 'string', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
        bytes: { type: 'integer', required: true }, sha256: { type: 'string', required: true },
        provider: { type: 'string', required: true }, model: { type: 'string' }, model_selection: { type: 'string', enum: ['server-managed'] },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'execute', title: 'Generate image', rawInput: args }),
    async execute(args, exec) {
      try {
        const root = await workspaceFor(ctx, exec)
        await assetDirectory(root)
        await writerPlan(ctx, root, exec)
        const spec = await settings.active(exec.signal)
        if (spec.provider === 'pengbao') ctx.logger.info('image-generation: generation started; provider=pengbao model_selection=server-managed')
        else ctx.logger.info('image-generation: generation started; provider=%s model=%s', spec.provider, spec.model)
        const raw = spec.provider === 'pengbao'
          ? await spec.generate(managedPrompt(args), { signal: exec.signal, ...(args.size === undefined ? {} : { size: args.size }) })
          : await generate(spec.provider, spec, spec.key, args, { signal: exec.signal })
        const image = await normalizeImage(raw)
        // Recheck live session permissions after a potentially long provider call.
        if (await workspaceFor(ctx, exec) !== root) throw new Error('workspace changed')
        const asset = await commitImage(ctx, root, image.data, exec)
        ctx.logger.info('image-generation: generation saved; provider=%s sha256=%s', spec.provider, asset.sha256)
        return { ...asset, asset_id: `sha256:${asset.sha256}`, media_type: 'image/png', width: image.width, height: image.height, bytes: image.data.length, provider: spec.provider, ...(spec.provider === 'pengbao' ? { model_selection: 'server-managed' } : { model: spec.model }) }
      } catch (error) {
        const safe = safeError(error)
        ctx.logger.info('image-generation: generation failed; code=%s http=%s provider_code=%s parameter=%s request_id=%s', safe.code, safe.providerStatus, safe.providerCode, safe.parameter, safe.requestId)
        throw safe
      }
    },
  })
}

export function imageEditTool(ctx, settings) {
  return defineTool({
    name: 'image_edit',
    description: 'Edit one image generated earlier in this session and save the result as a new Office-compatible PNG. Pass the sha256 from image_generate or a previous image_edit result; the original file is never overwritten. Use image_generate for a new image instead. Available in Pengbao managed mode; other providers must be configured for generation only.',
    parameters: {
      source: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['generated'], required: true },
          sha256: { type: 'string', required: true, description: 'sha256 of an image_generate or image_edit result in this session.' },
        },
      },
      prompt: { type: 'string', required: true, description: 'How to transform the source image. Preserve what the user asked to keep.' },
      size: { type: 'string', description: 'Optional exact output dimensions as WIDTHxHEIGHT pixels, or a named tier accepted by the service.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        asset_id: { type: 'string', required: true }, workspace_path: { type: 'string', required: true },
        media_type: { type: 'string', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
        bytes: { type: 'integer', required: true }, sha256: { type: 'string', required: true },
        provider: { type: 'string', required: true }, model: { type: 'string' }, model_selection: { type: 'string', enum: ['server-managed'] },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'execute', title: 'Edit image', rawInput: args }),
    async execute(args, exec) {
      try {
        if (args?.source?.kind !== 'generated' || typeof args.source.sha256 !== 'string') throw new ImageError('IMAGE', 'Invalid source image reference.', 400)
        if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 8000) throw new ImageError('IMAGE', 'The image edit description is invalid.', 400)
        const root = await workspaceFor(ctx, exec)
        const source = await readGeneratedWorkspaceImage(root, args.source.sha256, exec.signal)
        await assetDirectory(root)
        await writerPlan(ctx, root, exec)
        const spec = await settings.active(exec.signal)
        if (spec.provider !== 'pengbao' || typeof spec.edit !== 'function') throw new ImageError('IMAGE', 'Image editing is available only in Pengbao managed mode.', 400)
        ctx.logger.info('image-generation: edit started; provider=pengbao model_selection=server-managed')
        const raw = await spec.edit(args.prompt.trim(), { image: source.data, signal: exec.signal, ...(args.size === undefined ? {} : { size: args.size }) })
        const image = await normalizeImage(raw)
        if (await workspaceFor(ctx, exec) !== root) throw new Error('workspace changed')
        const asset = await commitImage(ctx, root, image.data, exec)
        ctx.logger.info('image-generation: edit saved; provider=pengbao sha256=%s', asset.sha256)
        return { ...asset, asset_id: `sha256:${asset.sha256}`, media_type: 'image/png', width: image.width, height: image.height, bytes: image.data.length, provider: 'pengbao', model_selection: 'server-managed' }
      } catch (error) {
        const safe = safeError(error)
        ctx.logger.info('image-generation: edit failed; code=%s http=%s provider_code=%s parameter=%s request_id=%s', safe.code, safe.providerStatus, safe.providerCode, safe.parameter, safe.requestId)
        throw safe
      }
    },
  })
}

export async function apply(ctx) {
  // Endpoint/model/key are committed together by the credential provider, so a
  // failed save cannot pair an old key with a newly persisted endpoint.
  const settings = createSettings(ctx)
  const jsonResponse = async (run) => {
    try {
      return Response.json(await run(), { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      const safe = safeError(error)
      return Response.json({ code: safe.code, error: safe.message }, { status: safe.status, headers: { 'Cache-Control': 'no-store' } })
    }
  }
  const registerJson = (path, methods, fetch) => ctx.connection.fetch.register({
    path, methods, requestBody: 'buffered', fetch,
  })
  registerJson('/api/image-generation.settings', ['GET'], request => jsonResponse(() => settings.describe(request.signal)))
  for (const suffix of ['save', 'models']) {
    registerJson(`/api/image-generation.${suffix}`, ['POST'], request => jsonResponse(async () => settings[suffix](
      JSON.parse((await readBounded(request, 16_384, request.signal)).toString('utf8')), request.signal,
    )))
  }
  ctx.tools.register(imageTool(ctx, settings))
  ctx.tools.register(imageEditTool(ctx, settings))
  registerJson('/api/image-generation.preview', ['GET'], request => previewImage(ctx, request))
  const locator = new URL('./skills/generate-image/SKILL.md', import.meta.url)
  const candidate = {
    name: 'generate-image', description: 'Create reusable photos, illustrations and backgrounds for presentations, documents and other image requests with the configured image_generate tool.',
    invocation: { modelInvocable: true, userInvocable: true }, provider: name, source: 'bundled', rank: BUNDLED_SKILL_RANK,
    locator, resourceBase: { kind: 'directory', path: fileURLToPath(new URL('.', locator)) },
  }
  ctx.skills.registerProvider(() => ({ name, list: async () => [candidate], get: async selected => selected.name === candidate.name
    ? { ...candidate, content: (await readFile(locator, 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim() } : undefined }))
  ctx.systemPrompt.section({ name: IMAGE_PROMPT_SECTION, order: 114, text: UNCONFIGURED_IMAGE_PROMPT })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    let configured = false
    try {
      configured = await settings.isConfigured({ background: true })
    } catch (error) {
      ctx.logger.info('image-generation: prompt assembly treated configuration as unset; code=%s', safeError(error).code)
    }
    const assembly = await next()
    return {
      ...assembly,
      sections: assembly.sections.map(section => section.name === IMAGE_PROMPT_SECTION
        ? { ...section, text: configured ? CONFIGURED_IMAGE_PROMPT : UNCONFIGURED_IMAGE_PROMPT }
        : section),
    }
  })
}
