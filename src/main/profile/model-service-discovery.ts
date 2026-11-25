import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { composeEntries, readDisabledProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { readModelServiceConsumerDeclaration, type ModelServiceCapability, type ModelServiceConsumerDeclaration } from '../../shared/model-service'
import { readEffectiveDisabledHostPlugins } from './host-plugin-selection'
import { SAFE_MODE_PROFILE } from '../recovery/safe-mode-profile'

export interface ModelServiceConsumer {
  id: string
  version?: string
  declaration?: ModelServiceConsumerDeclaration
  capabilities: readonly ModelServiceCapability[]
  status: 'declared' | 'needs-adapter' | 'invalid-declaration'
  adapter?: 'llm-pi-ai' | 'desktop-imagegen' | 'image-generation'
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const semver = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value)
const MAX_MANIFEST_BYTES = 262_144
const MAX_PROFILE_BUNDLES = 512
const MAX_CONSUMERS = 512

type ReviewedAdapter = NonNullable<ModelServiceConsumer['adapter']>
interface ResolvedPackage {
  root: string
  installationOwned: boolean
}
interface Candidate {
  id: string
  showUnsupported?: boolean
  resolve: () => Promise<ResolvedPackage | undefined>
}
interface StaticRow {
  id?: string
  name?: string
  disabled?: unknown
  group?: unknown
  config?: unknown
  insert?: StaticRow[]
  __modelServiceSource?: number
}
interface StaticSource {
  bundleId?: string
  resolved?: ResolvedPackage
  host: boolean
}

const ADAPTERS = new Map<string, { version: string; adapter: ReviewedAdapter; capabilities: ModelServiceCapability[] }>([
  ['@deepseek-ai/dsh-llm-pi-ai', { version: '0.2.2-rc.1', adapter: 'llm-pi-ai', capabilities: ['chat.completions'] }],
  ['dsh-desktop-imagegen', { version: '0.1.0', adapter: 'desktop-imagegen', capabilities: ['chat.completions', 'image.generate'] }],
  ['dsh-image-generation', { version: '0.1.0', adapter: 'image-generation', capabilities: ['image.generate'] }]
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function json(path: string): Promise<Record<string, unknown>> {
  if ((await stat(path)).size > MAX_MANIFEST_BYTES) throw new Error('Manifest is too large')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  const parsed = record(value)
  if (!parsed) throw new Error('Invalid manifest')
  return parsed
}

function packageName(value: unknown): value is string {
  return typeof value === 'string' && PACKAGE_NAME.test(value)
}

/** Match app-boot's installation-first package lookup without executing package code. */
async function packageRootFromAnchor(anchor: string, id: string): Promise<string | undefined> {
  for (const searchPath of createRequire(anchor).resolve.paths(id) ?? []) {
    const candidate = join(searchPath, id)
    try {
      await stat(join(candidate, 'package.json'))
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
    }
  }
  return undefined
}

async function resolveProfilePackage(
  id: string,
  profileDirectory: string,
  hostModuleAnchor: string
): Promise<ResolvedPackage | undefined> {
  const installed = await packageRootFromAnchor(hostModuleAnchor, id)
  if (installed) return { root: installed, installationOwned: true }
  const profileRoot = await packageRootFromAnchor(join(profileDirectory, 'package.json'), id)
  return profileRoot ? { root: profileRoot, installationOwned: false } : undefined
}

/** Parse the Loader dialect as inert data. Never evaluate !!js or expand aliases. */
function staticPatches(source: string, sourceId: number): StaticRow[] {
  if (Buffer.byteLength(source) > MAX_MANIFEST_BYTES * 4) throw new Error('Model service patch is too large')
  const document = parseDocument(source, { logLevel: 'silent' })
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Invalid model service patch')
  let remaining = 20_000
  const data = (node: unknown, depth = 0): unknown => {
    if (--remaining < 0 || depth > 64) throw new Error('Model service patch is too complex')
    if (node == null) return null
    if (isAlias(node)) throw new Error('Model service discovery does not expand YAML aliases')
    if (isScalar(node)) return node.tag === 'tag:yaml.org,2002:js' ? { __jsExpr: String(node.value) } : node.value
    if (isSeq(node)) return node.items.map(item => data(item, depth + 1))
    if (!isMap(node)) throw new Error('Invalid model service patch node')
    const result = Object.create(null) as Record<string, unknown>
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Invalid model service patch key')
      if (pair.key.value.startsWith('__modelService')) continue
      result[pair.key.value] = data(pair.value, depth + 1)
    }
    return result
  }
  const rows = data(document.contents) as StaticRow[]
  const annotate = (row: StaticRow): void => {
    if (!record(row)) throw new Error('Invalid model service entry')
    row.__modelServiceSource = sourceId
    if (row.group === true && Array.isArray(row.config)) row.config.forEach(annotate)
  }
  for (const patch of rows) {
    if (!record(patch)) throw new Error('Invalid model service patch')
    if (patch.insert !== undefined) {
      if (!Array.isArray(patch.insert)) throw new Error('Invalid model service insertion')
      patch.insert.forEach(annotate)
    } else if (patch.group === true && Array.isArray(patch.config)) patch.config.forEach(annotate)
    // An override must not replace the original entry's source ownership.
  }
  return rows
}

async function optionalPatches(path: string, sourceId: number): Promise<StaticRow[]> {
  try { return staticPatches(await readFile(path, 'utf8'), sourceId) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function bundlePatchFiles(root: string, manifest: Record<string, unknown>): Promise<string[]> {
  const dsh = record(manifest.dsh)
  const bundle = record(dsh?.bundle)
  const declared = bundle?.patch
  if (typeof declared !== 'string' && !Array.isArray(declared)) return []
  const files = typeof declared === 'string' ? [declared] : declared
  if (!files.every(file => typeof file === 'string') || files.length > MAX_PROFILE_BUNDLES) return []
  const paths: string[] = []
  for (const file of files as string[]) {
    const path = resolve(root, file)
    const relativePath = relative(root, path)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) return []
    paths.push(path)
  }
  return paths
}

async function profileBundleIds(directory: string, profile: string): Promise<string[]> {
  let manifest: Record<string, unknown>
  try {
    manifest = await json(join(directory, 'package.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [...(PROFILE_TEMPLATES[profile]?.bundles ?? [])]
    }
    throw new Error('Model service profile could not be read')
  }
  if (!Object.hasOwn(manifest, 'dsh')) return []
  const dsh = record(manifest.dsh)
  if (!dsh) throw new Error('Model service profile manifest is invalid')
  const profileManifest = record(dsh.profile)
  if (!profileManifest) {
    if (Object.hasOwn(dsh, 'profile')) throw new Error('Model service profile manifest is invalid')
    return []
  }
  if (!Object.hasOwn(profileManifest, 'bundles')) return []
  const bundles = profileManifest.bundles
  if (!Array.isArray(bundles) || bundles.length > MAX_PROFILE_BUNDLES || !bundles.every(packageName)) {
    throw new Error('Model service profile bundle list is invalid')
  }
  return bundles
}

function addCandidate(candidates: Map<string, Candidate>, candidate: Candidate): void {
  if (candidate.id === 'dsh-desktop-model-service' || candidates.size >= MAX_CONSUMERS) return
  const previous = candidates.get(candidate.id)
  candidates.set(candidate.id, { ...candidate, showUnsupported: candidate.showUnsupported || previous?.showUnsupported })
}

async function inspectCandidate(candidate: Candidate): Promise<ModelServiceConsumer | undefined> {
  try {
    const resolved = await candidate.resolve()
    if (!resolved) throw new Error('Package is not installed')
    const pkg = await json(join(resolved.root, 'package.json'))
    if (pkg.name !== candidate.id || !semver(pkg.version)) throw new Error('Invalid package identity')

    let declaration: ModelServiceConsumerDeclaration | undefined
    try {
      declaration = readModelServiceConsumerDeclaration(pkg)
    } catch {
      return { id: candidate.id, version: pkg.version, status: 'invalid-declaration', capabilities: [] }
    }

    const reviewed = resolved.installationOwned ? ADAPTERS.get(candidate.id) : undefined
    let adapter = reviewed?.version === pkg.version ? reviewed : undefined
    if (adapter?.adapter === 'desktop-imagegen') {
      const dependencies = record(pkg.dependencies)
      if (dependencies?.['@dickpy/dsh-imagegen'] !== '1.11.0') adapter = undefined
      else {
        const upstreamPath = createRequire(join(resolved.root, 'package.json')).resolve('@dickpy/dsh-imagegen/package.json')
        const upstream = await json(upstreamPath)
        if (upstream.name !== '@dickpy/dsh-imagegen' || upstream.version !== '1.11.0') adapter = undefined
      }
    }
    if (!adapter && !declaration) {
      // Reviewed runtime bundles compose infrastructure, not model consumers.
      // Never hide declarations or unknown/replaced versions of these packages.
      if (resolved.installationOwned && pkg.version === '0.2.2-alpha.2' &&
        ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].includes(candidate.id)) return undefined
      return ADAPTERS.has(candidate.id) || candidate.showUnsupported
        ? { id: candidate.id, version: pkg.version, status: 'needs-adapter', capabilities: [] }
        : undefined
    }
    return {
      id: candidate.id,
      version: pkg.version,
      ...(declaration ? { declaration } : {}),
      capabilities: adapter?.capabilities ?? declaration?.capabilities ?? [],
      status: adapter || declaration ? 'declared' : 'needs-adapter',
      ...(adapter ? { adapter: adapter.adapter } : {})
    }
  } catch {
    if (!ADAPTERS.has(candidate.id)) return undefined
    return { id: candidate.id, status: 'invalid-declaration', capabilities: [] }
  }
}

/** Metadata is an opt-in request, not a sandbox boundary. Never execute package code. */
export async function discoverModelServiceConsumers(
  dshHome: string,
  profile: string,
  hostModuleAnchor: string,
  desktopPatchPath?: string,
  additionalOverlayPaths: readonly string[] = []
): Promise<ModelServiceConsumer[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('Invalid model service profile')
  const directory = join(dshHome, 'profiles', profile)
  const candidates = new Map<string, Candidate>()
  const disabled = readDisabledProfileBundles(directory)
  const bundles = await profileBundleIds(directory, profile)
  const sources: StaticSource[] = []
  const bundleLayers: StaticRow[][] = []
  const sourceId = (source: StaticSource): number => sources.push(source) - 1

  for (const id of bundles) {
    if (disabled.has(id)) continue
    const resolved = await resolveProfilePackage(id, directory, hostModuleAnchor)
    if (!resolved) throw new Error('Model service bundle is not installed')
    const manifest = await json(join(resolved.root, 'package.json'))
    if (manifest.name !== id) throw new Error('Invalid model service bundle identity')
    const index = sourceId({ bundleId: id, resolved, host: false })
    const layer: StaticRow[] = []
    for (const patch of await bundlePatchFiles(resolved.root, manifest)) {
      layer.push(...staticPatches(await readFile(patch, 'utf8'), index))
    }
    bundleLayers.push(layer)
  }

  const userSource = sourceId({ host: false })
  const user = await optionalPatches(join(directory, 'cordis.patch.yml'), userSource)
  const home = await optionalPatches(join(dshHome, 'cordis.patch.yml'), userSource)
  const defaults: StaticRow[] = []
  let overlays: StaticRow[] = []
  if (desktopPatchPath) {
    const hostSource = sourceId({ host: true })
    const disabledHost = profile === SAFE_MODE_PROFILE ? [] : await readEffectiveDisabledHostPlugins(dshHome)
    overlays = staticPatches(await readFile(desktopPatchPath, 'utf8'), hostSource)
    for (const patch of overlays) {
      if (!patch.insert) continue
      patch.insert = patch.insert.filter(row => !disabledHost.includes(row.name ?? ''))
      // Match prepareHostPluginSourcesPatch: only root host insertions are
      // rewritten to installation URLs. Keep the package identity separately.
      for (const row of patch.insert) {
        if (!packageName(row.name)) continue
        const id = row.name
        const index = sourceId({ host: true, bundleId: id })
        row.__modelServiceSource = index
        try { row.name = pathToFileURL(createRequire(hostModuleAnchor).resolve(id)).href }
        catch { /* Missing source will fail closed during package inspection. */ }
      }
    }
    const editableDefaults = new Map<string, string>()
    for (const [id, name] of [['imagegen', 'dsh-desktop-imagegen'], ['dsh-desktop-model-service', 'dsh-desktop-model-service']]) {
      try { editableDefaults.set(id!, pathToFileURL(createRequire(hostModuleAnchor).resolve(name!)).href) } catch { /* Not installed. */ }
    }
    overlays = overlays.map(patch => {
      if (patch.id !== undefined || !patch.insert) return patch
      return { ...patch, insert: patch.insert.filter(row => {
        if (row.id && editableDefaults.has(row.id) && row.name === editableDefaults.get(row.id) && row.config === undefined && !row.group) {
          defaults.push({ insert: [row] })
          return false
        }
        return true
      }) }
    })
  }

  for (const path of additionalOverlayPaths) overlays.push(...await optionalPatches(path, userSource))

  // Harness owns ordered insertion, ID targeting, name assertions and whole
  // config replacement. This function only parses inert data and tracks origin.
  const effective = composeEntries([...bundleLayers, defaults, user, home, overlays] as Parameters<typeof composeEntries>[0]) as StaticRow[]
  const visit = (rows: StaticRow[]): void => {
    for (const row of rows) {
      if (!record(row) || (row.disabled !== undefined && row.disabled !== false)) continue
      const origin = row.__modelServiceSource === undefined ? undefined : sources[row.__modelServiceSource]
      if (origin?.bundleId && !row.group) {
        const id = origin.bundleId
        addCandidate(candidates, { id, showUnsupported: !origin.host, resolve: origin.resolved ? async () => origin.resolved : async () => {
          const root = await packageRootFromAnchor(hostModuleAnchor, id)
          return root ? { root, installationOwned: true } : undefined
        } })
      }
      if (packageName(row.name) && !row.group) {
        const id = row.name
        addCandidate(candidates, { id, resolve: origin?.host ? async () => {
          const root = await packageRootFromAnchor(hostModuleAnchor, id)
          return root ? { root, installationOwned: true } : undefined
        } : () => resolveProfilePackage(id, directory, hostModuleAnchor) })
      }
      if (row.group === true && Array.isArray(row.config)) visit(row.config)
    }
  }
  visit(effective)

  const result = await Promise.all([...candidates.values()].map(inspectCandidate))
  return result.filter((consumer): consumer is ModelServiceConsumer => consumer !== undefined)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
