import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'

type MailDefinition = {
  description: string
  longDescription: string
  subscriptionNotice: string
}

const EMPTY_GENERATED_SECTOR_DEFINITIONS = [
  '// AUTO-GENERATED: do not edit. Run `npm run setup:extensions` to regenerate.',
  "import type { ExtensionDefinition } from '../types'",
  '',
  'export const EXTENSION_DEFINITIONS: Record<string, ExtensionDefinition[]> = {',
  '}',
  '',
].join('\n')

function expectMailDefinitionInGeneratedRegistry(
  generated: string,
  definition: MailDefinition,
) {
  if (generated === EMPTY_GENERATED_SECTOR_DEFINITIONS) return

  expect(generated).toContain(JSON.stringify(definition.description))
  expect(generated).toContain(JSON.stringify(definition.longDescription))
  expect(generated).toContain(JSON.stringify(definition.subscriptionNotice))
}

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
    )) as { definition: MailDefinition }
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
    expectMailDefinitionInGeneratedRegistry(generated, manifest.definition)
  })

  it('allows Mail to be absent only from the canonical empty generated registry', () => {
    const definition: MailDefinition = {
      description: 'description bytes',
      longDescription: 'long description bytes',
      subscriptionNotice: 'subscription notice bytes',
    }
    const completeNonEmptyRegistry = [
      JSON.stringify(definition.description),
      JSON.stringify(definition.longDescription),
      JSON.stringify(definition.subscriptionNotice),
    ].join('\n')
    const nonEmptyRegistryWithoutMail = EMPTY_GENERATED_SECTOR_DEFINITIONS.replace(
      '{\n}',
      "{\n  'general': [],\n}",
    )
    const driftedNonEmptyRegistry = completeNonEmptyRegistry.replace(
      JSON.stringify(definition.longDescription),
      JSON.stringify('drifted long description bytes'),
    )

    expect(() => expectMailDefinitionInGeneratedRegistry(
      EMPTY_GENERATED_SECTOR_DEFINITIONS,
      definition,
    )).not.toThrow()
    expect(() => expectMailDefinitionInGeneratedRegistry(
      completeNonEmptyRegistry,
      definition,
    )).not.toThrow()
    expect(() => expectMailDefinitionInGeneratedRegistry(
      nonEmptyRegistryWithoutMail,
      definition,
    )).toThrow()
    expect(() => expectMailDefinitionInGeneratedRegistry(
      driftedNonEmptyRegistry,
      definition,
    )).toThrow()
  })
})
