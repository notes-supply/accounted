import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryRoots: string[] = []
const script = resolve(process.cwd(), 'scripts/generate-extension-registry.ts')
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'extension-registry-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'extensions/general/sample'), { recursive: true })
  mkdirSync(join(root, 'lib/extensions/_generated'), { recursive: true })
  writeFileSync(
    join(root, 'extensions.config.json'),
    JSON.stringify({ extensions: ['sample'] }),
  )
  writeFileSync(
    join(root, 'extensions/general/sample/manifest.json'),
    JSON.stringify({
      id: 'sample',
      sector: 'general',
      exportName: null,
      entryPoint: null,
      workspace: null,
      requiredEnvVars: [],
      optionalEnvVars: [],
      npmDependencies: [],
      definition: {
        name: 'Sample',
        category: 'operations',
        icon: 'Box',
        dataPattern: 'manual',
        description: 'Sample extension',
        longDescription: 'Deterministic fixture',
      },
    }),
  )
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('extension registry generator', () => {
  it('checks deterministically and fails after manifest drift', () => {
    const root = fixtureRoot()
    const env = { ...process.env, EXTENSION_REGISTRY_ROOT: root }

    const missing = spawnSync(npx, ['tsx', script, '--check'], { env, encoding: 'utf8' })
    expect(missing.status).toBe(1)

    execFileSync(npx, ['tsx', script], { env, stdio: 'pipe' })
    const generated = readFileSync(
      join(root, 'lib/extensions/_generated/sector-definitions.ts'),
      'utf8',
    )
    expect(generated).toContain('Deterministic fixture')

    const clean = spawnSync(npx, ['tsx', script, '--check'], { env, encoding: 'utf8' })
    expect(clean.status).toBe(0)

    const manifestPath = join(root, 'extensions/general/sample/manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      definition: { longDescription: string }
    }
    manifest.definition.longDescription = 'Changed consent copy'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const drifted = spawnSync(npx, ['tsx', script, '--check'], { env, encoding: 'utf8' })
    expect(drifted.status).toBe(1)
    expect(drifted.stderr).toContain('sector-definitions.ts')
  })
})
