import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { findMatchingTemplates, getTemplateById } from '../booking-templates'

describe('dance-event VAT cutover guidance and suggestions', () => {
  it('suggests the 6% revenue template for admission-specific dance-event terms after cutover', () => {
    const transaction = makeTransaction({
      amount: 500,
      date: '2026-07-02',
      description: 'Biljett till dansband och danskväll',
    })
    const matches = findMatchingTemplates(transaction)
    const template = matches.find((match) => match.template.id === 'revenue_reduced_6')

    expect(template).toBeDefined()
    expect(template?.template.vat_treatment).toBe('reduced_6')
    expect(template?.template.vat_rate).toBe(0.06)
  })

  it.each([
    ['before cutover', '2026-06-30'],
    ['missing date', ''],
    ['invalid date', '2026-02-30'],
  ])('does not suggest 6% for dance admission with %s', (_label, date) => {
    const matches = findMatchingTemplates(makeTransaction({
      amount: 500,
      date,
      description: 'Biljett till dansband och danskväll',
    }))
    expect(matches.some((match) => match.template.id === 'revenue_reduced_6')).toBe(false)
  })

  it.each(['2026-07-01', '2027-01-15'])('allows dance admission on %s', (date) => {
    const matches = findMatchingTemplates(makeTransaction({
      amount: 500,
      date,
      description: 'Biljett till dansband',
    }))
    expect(matches.some((match) => match.template.id === 'revenue_reduced_6')).toBe(true)
  })

  it('preserves unrelated 6% categories before the dance cutover', () => {
    const matches = findMatchingTemplates(makeTransaction({
      amount: 500,
      date: '2026-06-30',
      description: 'Försäljning av böcker',
    }))
    expect(matches.some((match) => match.template.id === 'revenue_reduced_6')).toBe(true)
  })

  it('does not broaden suggestions to bare dance or generic admission terms', () => {
    const template = getTemplateById('revenue_reduced_6')
    expect(template?.keywords).not.toContain('dans')
    expect(template?.keywords).not.toContain('entré')
  })

  it('preserves the pre-effective 25% rule and prepayment warning in guidance', () => {
    const skill = readFileSync(
      resolve(process.cwd(), '.claude/skills/swedish-vat/SKILL.md'),
      'utf8',
    )
    const reference = readFileSync(
      resolve(
        process.cwd(),
        '.claude/skills/swedish-vat/references/vat-compliance-reference.md',
      ),
      'utf8',
    )

    expect(skill).toContain('from 1 July 2026; 25% through 30 June 2026')
    expect(reference).toContain('Tickets sold and paid before 2026-07-01 keep 25%')
  })
})
