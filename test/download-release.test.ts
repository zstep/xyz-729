import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const require = createRequire(import.meta.url)

describe('public unsigned download release', () => {
  it('keeps production identity and disables signing, notarization and feed publication', () => {
    const pkg = require('../package.json')
    const config = require('../electron-builder.download.cjs')
    expect(config.appId).toBe('net.ecombus.pengbao.desktop')
    expect(config.productName).toBe('Pengbao AI')
    expect(config.artifactName).toBe(pkg.build.artifactName)
    expect(config.extraMetadata?.dshDesktopChannel).not.toBe('development')
    expect(config.afterSign).toBeNull()
    expect(config.mac.identity).toBeNull()
    expect(config.mac.notarize).toBe(false)
    expect(config.win.signtoolOptions.sign).toBeNull()
    expect(config.publish).toBeNull()
    expect(config.buildVersion).toBe('0.13.2.14')
    expect(config.mac.bundleShortVersion).toBe('0.13.2.14')
    expect(config.extraMetadata.shortVersion).toBe('0.13.2.14')
    const { AppInfo } = require('app-builder-lib/out/appInfo')
    const info = new AppInfo({ metadata: { ...pkg, ...config.extraMetadata }, config, isPrepackedAppAsar: false })
    // NSIS uses this value directly in VIProductVersion for its uninstaller.
    expect(info.shortVersionWindows).toBe('0.13.2.14')
  })

  it('builds natively and only publishes the catalog after all native jobs pass', async () => {
    const text = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
    const flow = parse(text)
    expect(flow.on.workflow_dispatch.inputs.mode.options).toContain('download')
    for (const job of [flow.jobs.macos, flow.jobs['windows-x64']]) {
      const build = job.steps.find((step: any) => step.name?.startsWith('Build unsigned production'))
      expect(build.if).toContain("inputs.mode == 'download'")
      expect(build.run).toContain('--publish never --config electron-builder.download.cjs')
      expect(build.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
      const upload = job.steps.find((step: any) => step.name?.startsWith('Upload unsigned production'))
      expect(upload.with.path).not.toContain('dev')
      expect(upload.with['if-no-files-found']).toBe('error')
    }
    const publish = flow.jobs['publish-downloads']
    expect(publish.needs).toEqual(['validate-dispatch', 'macos', 'windows-x64'])
    expect(publish.if).toContain("inputs.mode == 'download'")
    const upload = publish.steps.find((step: any) => step.name?.startsWith('Upload and verify'))
    expect(upload.run).toContain('--build-id "${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"')
    expect(upload.run).toContain('--source-sha "$GITHUB_SHA"')
    expect(JSON.stringify(publish)).not.toContain('configure-rollout')
    expect(JSON.stringify(publish)).not.toContain('gh release create')
  })
})
