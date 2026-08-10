import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'

describe('production mail availability copy', () => {
  it.each([
    ['English', en.mail.preview_disabled],
    ['Swedish', sv.mail.preview_disabled],
  ])('states the disabled boundary and credential warning in %s', (_locale, copy) => {
    expect(copy).toMatch(/automated|automatisk/i)
    expect(copy).toMatch(/new connections|nya kopplingar/i)
    expect(copy).toMatch(/backfill|historisk sökning/i)
    expect(copy).toMatch(/do not grant|bevilja inte/i)
    expect(copy).toMatch(/visible|visas/i)
    expect(copy).toMatch(/disconnect|kopplas från/i)
  })

  it('hides the connect control when the server reports it unavailable', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/extensions/general/MailConnectionsPanel.tsx'),
      'utf8',
    )

    expect(source).toContain('connectAvailable ?')
    expect(source).toContain("t('preview_disabled')")
    expect(source).not.toContain("t('promise')")
    expect(source).not.toContain("t('ai_disclosure')")
  })

  it('keeps the manifest and generated definition aligned with the disabled boundary', () => {
    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), 'extensions/general/mail/manifest.json'),
      'utf8',
    )) as { definition: { description: string; longDescription: string; subscriptionNotice: string } }
    const generated = readFileSync(
      resolve(process.cwd(), 'lib/extensions/_generated/sector-definitions.ts'),
      'utf8',
    )
    const copy = [
      manifest.definition.description,
      manifest.definition.longDescription,
      manifest.definition.subscriptionNotice,
    ].join(' ')

    expect(copy).toMatch(/Automatisk sökning/i)
    expect(copy).toMatch(/nya kopplingar/i)
    expect(copy).toMatch(/historisk sökning/i)
    expect(copy).toMatch(/Begär inte nya brevlådebehörigheter/i)
    expect(copy).toMatch(/visas och kopplas från/i)
    expect(generated).toContain(JSON.stringify(manifest.definition.description))
    expect(generated).toContain(JSON.stringify(manifest.definition.longDescription))
    expect(generated).toContain(JSON.stringify(manifest.definition.subscriptionNotice))
  })
})
