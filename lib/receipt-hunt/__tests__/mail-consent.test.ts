import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'

describe('mail AI consent disclosure', () => {
  it.each([
    ['English', en.mail.ai_disclosure],
    ['Swedish', sv.mail.ai_disclosure],
  ])('discloses external model processing of full candidate content in %s', (_locale, copy) => {
    expect(copy).toMatch(/metadata/i)
    expect(copy).toMatch(/body|brödtext/i)
    expect(copy).toMatch(/attachment|bilag/i)
    expect(copy).toMatch(/content|innehåll/i)
    expect(copy).toMatch(/external|extern/i)
    expect(copy).toMatch(/AI|modell/i)
  })

  it('renders the disclosure beside the mailbox connection control', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/extensions/general/MailConnectionsPanel.tsx'),
      'utf8',
    )
    expect(source).toContain("t('ai_disclosure')")
  })

  it.each([
    ['English promise', en.mail.promise],
    ['English disconnect', en.mail.disconnect_body],
    ['Swedish promise', sv.mail.promise],
    ['Swedish disconnect', sv.mail.disconnect_body],
  ])('%s does not claim storage starts only after approval', (_label, copy) => {
    expect(copy).not.toMatch(/archived only once you approve|arkiveras först när du godkänt/i)
  })

  it.each([
    ['English', `${en.mail.promise} ${en.mail.ai_disclosure} ${en.mail.disconnect_body}`],
    ['Swedish', `${sv.mail.promise} ${sv.mail.ai_disclosure} ${sv.mail.disconnect_body}`],
  ])('plainly discloses pre-review persistence and disconnect retention in %s', (_locale, copy) => {
    expect(copy).toMatch(/download|hämt/i)
    expect(copy).toMatch(/AI|modell/i)
    expect(copy).toMatch(/before (human )?review|före (mänsklig )?granskning/i)
    expect(copy).toMatch(/reject|unreviewed|avvis|ogransk/i)
    expect(copy).toMatch(/retention|deletion controls|lagrings|raderingskontroll/i)
    expect(copy).toMatch(/credential|oauth|behörighetsuppgift/i)
    expect(copy).toMatch(/does not automatically erase|raderar inte automatiskt/i)
  })

  it('keeps the manifest disclosure semantically aligned with both locales', () => {
    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), 'extensions/general/mail/manifest.json'),
      'utf8',
    )) as { definition: { longDescription: string; subscriptionNotice: string } }
    const copy = `${manifest.definition.longDescription} ${manifest.definition.subscriptionNotice}`

    expect(copy).toMatch(/hämt/i)
    expect(copy).toMatch(/externa AI|modellleverantör/i)
    expect(copy).toMatch(/före mänsklig granskning/i)
    expect(copy).toMatch(/avvis|ogransk/i)
    expect(copy).toMatch(/lagrings- och raderingskontroller/i)
    expect(copy).toMatch(/OAuth-behörighetsuppgifter/i)
    expect(copy).toMatch(/raderar inte automatiskt/i)
    expect(copy).not.toMatch(/efter att du godkänt/i)
  })
})
