import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { ImageError, MAX_IMAGE_BYTES } from './provider.js'

async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    throw new ImageError('RUNTIME', 'The image processing runtime is unavailable.', 500)
  }
}

export async function workspaceFor(ctx, exec) {
  const session = exec.agent?.session
  if (!session?.header.cwd) throw new ImageError('WORKSPACE', 'Choose a workspace for the generated image.')
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (!['workspace-write', 'danger-full-access'].includes(policy.mode)) throw new ImageError('POLICY', 'Image generation requires workspace write permission.')
  const root = await realpath(session.header.cwd)
  if (root !== await realpath(policy.workspaceRoot) || !(await lstat(root)).isDirectory()) throw new ImageError('WORKSPACE', 'The session workspace does not match its write policy.')
  exec.signal?.throwIfAborted()
  return root
}

/** A predictable subdirectory, checked before the paid request and again before commit. */
export async function assetDirectory(root, create = false) {
  let directory = root
  for (const part of ['.workbuddy', 'generated-images']) {
    directory = path.join(directory, part)
    try {
      const info = await lstat(directory)
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) throw new ImageError('ASSET_PATH', 'The generated image directory must be a regular workspace directory.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) continue
      try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new ImageError('ASSET_PATH', 'The generated image directory must be a regular workspace directory.')
    }
  }
  return directory
}

/**
 * Read one generated PNG by its content hash. The caller never supplies a path:
 * the file must already exist in this workspace's generated-image directory and
 * its bytes must still match the returned reference.
 */
export async function readGeneratedWorkspaceImage(root, sha, signal) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha)) throw new ImageError('IMAGE', 'Invalid source image reference.', 400)
  signal?.throwIfAborted()
  const directory = await assetDirectory(root, false)
  const target = path.join(directory, `${sha}.png`)
  let file
  try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch {
    throw new ImageError('IMAGE', 'The source image is unavailable.', 404)
  }
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES || await realpath(target) !== target) {
      throw new ImageError('IMAGE', 'The source image is unavailable.', 404)
    }
    const data = Buffer.alloc(info.size)
    let offset = 0
    while (offset < data.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    signal?.throwIfAborted()
    if (offset !== data.length || createHash('sha256').update(data).digest('hex') !== sha
      || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new ImageError('IMAGE', 'The source image has changed.', 404)
    }
    return { data, sha256: sha, workspacePath: `.workbuddy/generated-images/${sha}.png` }
  } finally { await file.close() }
}

export async function normalizeImage(raw) {
  const sharp = await loadSharp()
  try {
    const image = sharp(raw, { limitInputPixels: 64_000_000, failOn: 'warning', animated: false })
    const meta = await image.metadata()
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages ?? 1) > 1 || meta.width > 8192 || meta.height > 8192) throw new Error('unsupported image')
    // The Office asset preserves alpha and full resolution; attachment storage may
    // independently compress the preview. Never label a normalized WebP as PNG.
    const { data, info } = await image.rotate().toColourspace('srgb').png().toBuffer({ resolveWithObject: true })
    if (data.length > MAX_IMAGE_BYTES) throw new ImageError('TOO_LARGE', 'The normalized image exceeds 20 MB.')
    return { data, width: info.width, height: info.height }
  } catch (error) {
    if (error instanceof ImageError) throw error
    throw new ImageError('IMAGE', 'The provider returned an unsupported or damaged image.', 502)
  }
}
