import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('self-hosted extension preset', () => {
  it('includes Enable Banking for self-hosted bank synchronization', () => {
    const presetPath = resolve(process.cwd(), 'docker/extensions.self-hosted.json')
    const preset = JSON.parse(readFileSync(presetPath, 'utf8')) as { extensions: string[] }

    expect(preset.extensions).toContain('enable-banking')
  })
})
