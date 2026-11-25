import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverModelServiceConsumers } from '../src/main/profile/model-service-discovery'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const declaration = { contractVersion: 1, capabilities: ['chat.completions'] }
async function fixture(profile = 'web') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-discovery-'))
  roots.push(root)
  const home = join(root, 'home')
  const directory = join(home, 'profiles', profile)
  const host = join(root, 'host')
  await mkdir(directory, { recursive: true })
  await mkdir(host, { recursive: true })
  const anchor = join(host, 'package.json')
  await writeFile(anchor, '{}')
  const manifest = async (bundles: string[]) => writeFile(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
  await manifest([])
  const pkg = async (id: string, options: { host?: boolean; version?: string; declaration?: unknown; patch?: string; dependencies?: Record<string, string> } = {}) => {
    const path = join(options.host ? host : directory, 'node_modules', id)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: id, version: options.version ?? '1.0.0', main: 'index.js',
      dependencies: options.dependencies, dsh: { ...(options.patch === undefined ? {} : { bundle: { patch: 'cordis.patch.yml' } }),
        ...(options.declaration === undefined ? {} : { modelService: options.declaration }) } }))
    // Discovery must only read metadata, never import the entrypoint.
    await writeFile(join(path, 'index.js'), 'throw new Error("DISCOVERY_EXECUTED_PLUGIN")')
    if (options.patch !== undefined) await writeFile(join(path, 'cordis.patch.yml'), options.patch)
    return path
  }
  const patch = (text: string) => writeFile(join(directory, 'cordis.patch.yml'), text)
  const hostPatch = join(root, 'desktop.patch.yml')
  await writeFile(hostPatch, '[]')
  const discover = (overlays?: string[]) => discoverModelServiceConsumers(home, profile, anchor, hostPatch, overlays)
  return { root, home, directory, host, anchor, manifest, pkg, patch, hostPatch, discover }
}

describe('static model consumer discovery follows Harness composition', () => {
  it('discovers opt-in packages without executing them and lists unknown bundles as needing adaptation', async () => {
    const f = await fixture()
    await f.pkg('fixture-consumer', { declaration, patch: '- insert:\n    - id: consumer\n      name: fixture-consumer\n' })
    await f.pkg('fixture-unknown', { patch: '- insert:\n    - id: unknown\n      name: fixture-unknown\n' })
    await f.manifest(['fixture-consumer', 'fixture-unknown'])
    expect(await f.discover()).toEqual([
      { id: 'fixture-consumer', version: '1.0.0', declaration, status: 'declared', capabilities: ['chat.completions'] },
      { id: 'fixture-unknown', version: '1.0.0', status: 'needs-adapter', capabilities: [] }
    ])
  })

  it('omits reviewed infrastructure bundles without hiding declarations or unknown replacements', async () => {
    const f = await fixture()
    const id = '@deepseek-ai/dsh-base'
    await f.pkg(id, { host: true, version: '0.2.2-alpha.2', patch: '- insert:\n    - id: base\n      name: fixture-infrastructure\n' })
    await f.manifest([id])
    expect(await f.discover()).toEqual([])
    await f.pkg(id, { host: true, version: '0.2.2-alpha.2', declaration, patch: '- insert:\n    - id: base\n      name: fixture-infrastructure\n' })
    expect((await f.discover())[0]).toMatchObject({ id, status: 'declared' })
    await f.pkg(id, { host: true, version: '0.2.2', patch: '- insert:\n    - id: base\n      name: fixture-infrastructure\n' })
    expect((await f.discover())[0]).toMatchObject({ id, status: 'needs-adapter' })
  })

  it('composes ordered insertions, group targeting, name assertions and later home overrides', async () => {
    const f = await fixture()
    await f.pkg('fixture-consumer', { declaration })
    await f.pkg('fixture-bundle', { patch: '- insert:\n    - id: group\n      group: true\n      config: []\n- id: group\n  insert:\n    - id: consumer\n      name: fixture-consumer\n- id: consumer\n  name: wrong-name\n  disabled: true\n' })
    await f.manifest(['fixture-bundle'])
    expect((await f.discover()).some(c => c.id === 'fixture-consumer')).toBe(true)
    await f.patch('- id: consumer\n  disabled: true\n')
    expect(await f.discover()).toEqual([])
    await writeFile(join(f.home, 'cordis.patch.yml'), '- id: consumer\n  name: fixture-consumer\n  disabled: false\n')
    expect((await f.discover()).some(c => c.id === 'fixture-consumer')).toBe(true)
  })

  it('does not let enabled children escape a disabled parent and handles whole group config replacement', async () => {
    const f = await fixture()
    await f.pkg('fixture-consumer', { declaration })
    await f.pkg('fixture-bundle', { patch: '- insert:\n    - id: group\n      group: true\n      disabled: true\n      config:\n        - id: consumer\n          name: fixture-consumer\n          disabled: false\n' })
    await f.manifest(['fixture-bundle'])
    expect(await f.discover()).toEqual([])
    await f.patch('- id: group\n  disabled: false\n')
    expect((await f.discover()).some(c => c.id === 'fixture-consumer')).toBe(true)
    await f.patch('- id: group\n  disabled: false\n  config: []\n')
    expect(await f.discover()).toEqual([])
  })

  it('does not apply overrides before insertion or after a mismatched name assertion', async () => {
    const f = await fixture()
    await f.pkg('fixture-consumer', { declaration, patch: '- id: consumer\n  disabled: true\n- insert:\n    - id: consumer\n      name: fixture-consumer\n- id: consumer\n  name: different\n  disabled: true\n' })
    await f.manifest(['fixture-consumer'])
    expect((await f.discover())[0]?.status).toBe('declared')
  })

  it('honors disabled market bundles, including malformed disabled package contents', async () => {
    const f = await fixture()
    await f.pkg('fixture-consumer', { declaration, patch: 'not valid patch' })
    await f.manifest(['fixture-consumer'])
    await mkdir(join(f.directory, '.dsh-market'))
    await writeFile(join(f.directory, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['fixture-consumer'] }))
    expect(await f.discover()).toEqual([])
  })

  it('requires the exact installation-owned reviewed adapter version', async () => {
    const f = await fixture()
    const id = '@deepseek-ai/dsh-llm-pi-ai'
    await f.pkg(id, { host: true, version: '0.2.2-rc.1' })
    await f.pkg('fixture-bundle', { patch: `- insert:\n    - id: llm-pi-ai\n      name: '${id}'\n` })
    await f.manifest(['fixture-bundle'])
    expect((await f.discover()).find(c => c.id === id)).toMatchObject({ status: 'declared', adapter: 'llm-pi-ai' })
    await f.pkg(id, { host: true, version: '0.2.1-rc.4' })
    expect((await f.discover()).find(c => c.id === id)).toMatchObject({ status: 'needs-adapter', capabilities: [] })
    await rm(join(f.host, 'node_modules', id), { recursive: true })
    await f.pkg(id, { version: '0.2.2-rc.1' })
    expect((await f.discover()).find(c => c.id === id)).toMatchObject({ status: 'needs-adapter', capabilities: [] })
  })

  it('seeds host imagegen before user preferences and checks its installed upstream dependency', async () => {
    const f = await fixture()
    await f.pkg('@dickpy/dsh-imagegen', { host: true, version: '1.11.0' })
    await f.pkg('dsh-desktop-imagegen', { host: true, version: '0.1.0', dependencies: { '@dickpy/dsh-imagegen': '1.11.0' } })
    // A same-name Profile package must never replace the installation source.
    await f.pkg('dsh-desktop-imagegen', { version: '99.0.0' })
    await writeFile(f.hostPatch, '- insert:\n    - id: imagegen\n      name: dsh-desktop-imagegen\n')
    expect((await f.discover())[0]).toMatchObject({ version: '0.1.0', adapter: 'desktop-imagegen' })
    await f.patch('- id: imagegen\n  disabled: true\n')
    expect(await f.discover()).toEqual([])
    await f.patch('- id: imagegen\n  disabled: false\n')
    await f.pkg('@dickpy/dsh-imagegen', { host: true, version: '1.12.0' })
    expect((await f.discover())[0]).toMatchObject({ status: 'needs-adapter', capabilities: [] })
  })

  it('keeps ordinary Desktop insertions after user overrides and honors final runtime overlays', async () => {
    const f = await fixture()
    await f.pkg('fixture-host', { host: true, declaration })
    await writeFile(f.hostPatch, '- insert:\n    - id: host\n      name: fixture-host\n')
    await f.patch('- id: host\n  disabled: true\n')
    expect((await f.discover())[0]?.status).toBe('declared')
    const overlay = join(f.root, 'last.yml')
    await writeFile(overlay, '- id: host\n  disabled: true\n')
    expect(await f.discover([overlay])).toEqual([])
  })

  it('never evaluates dynamic disabled expressions and does not grant unknown future capabilities', async () => {
    const f = await fixture()
    await f.pkg('fixture-consumer', { declaration, patch: '- insert:\n    - id: consumer\n      name: fixture-consumer\n      disabled: !!js "process.exit(42)"\n' })
    await f.manifest(['fixture-consumer'])
    expect(await f.discover()).toEqual([])
    await f.patch('- id: consumer\n  disabled: false\n')
    expect((await f.discover())[0]?.status).toBe('declared')
    await f.pkg('fixture-consumer', { declaration: { contractVersion: 1, capabilities: ['video.generate'] }, patch: '- insert:\n    - name: fixture-consumer\n' })
    expect((await f.discover())[0]).toMatchObject({ status: 'invalid-declaration', capabilities: [] })
  })

  it('reads Safe Mode user rows instead of silently reviving disabled consumers', async () => {
    const f = await fixture('desktop-safe-mode')
    await f.pkg('fixture-consumer', { declaration, patch: '- insert:\n    - id: consumer\n      name: fixture-consumer\n' })
    await f.manifest(['fixture-consumer'])
    await f.patch('- id: consumer\n  disabled: true\n')
    expect(await f.discover()).toEqual([])
  })

  it('fails closed for malformed active layers and missing active bundles', async () => {
    const f = await fixture()
    await f.manifest(['missing-bundle'])
    await expect(f.discover()).rejects.toThrow('not installed')
    await f.manifest([])
    await f.patch('- insert: !!js "[]"')
    await expect(f.discover()).rejects.toThrow('Invalid model service insertion')
  })
})
