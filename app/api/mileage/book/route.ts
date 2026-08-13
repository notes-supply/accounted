import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BookMileagePeriodSchema } from '@/lib/api/schemas'
import { bookMileagePeriod } from '@/lib/mileage/mileage-service'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

export const POST = withRouteContext(
  'mileage.book',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, BookMileagePeriodSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const result = await bookMileagePeriod(supabase, companyId, user.id, {
      from: body.from,
      to: body.to,
      entryDate: body.entry_date,
      counterAccount: body.counter_account,
      employeeId: body.employee_id,
    })

    if (!result.ok) {
      switch (result.code) {
        case 'NO_TRIPS':
          return NextResponse.json(
            { error: 'Inga obokförda resor i den valda perioden' },
            { status: 400 }
          )
        case 'MIXED_EMPLOYEES':
          return NextResponse.json(
            { error: 'Resorna i perioden gäller flera anställda. Bokför per anställd.' },
            { status: 400 }
          )
        case 'PERIOD_NOT_OPEN':
          return NextResponse.json(
            { error: 'Bokföringsdatumet ligger i en stängd eller låst period' },
            { status: 400 }
          )
        case 'CLAIM_LOST':
        case 'TRIPS_CHANGED':
          return NextResponse.json(
            { error: 'Körjournalen ändrades samtidigt av en annan bokning. Ladda om och försök igen.' },
            { status: 409 }
          )
        case 'CLAIM_RELEASE_FAILED':
          log.error('mileage claim release requires recovery', undefined, {
            operation: 'mileage.book',
            companyId,
            reason: result.reason,
            claimedTripIds: result.claimedTripIds,
            releasedTripIds: result.releasedTripIds,
            detail: result.detail,
          })
          return errorResponseFromCode(result.code, log, {
            requestId,
            status: 500,
            messageSv:
              'Resorna kunde inte återställas efter en avbruten bokning. Försök inte igen innan körjournalen har kontrollerats.',
            messageEn:
              'The trips could not be released after an aborted booking. Do not retry until the mileage log has been reviewed.',
          })
        case 'POST_COMMIT_UNCERTAIN':
          log.error('mileage voucher outcome requires recovery', undefined, {
            operation: 'mileage.book',
            companyId,
            entityType: 'journal_entry',
            entityId: result.journalEntryId,
            voucherNumber: result.voucherNumber,
          })
          return errorResponseFromCode(result.code, log, {
            requestId,
            status: 500,
            messageSv:
              'Verifikatet kan ha bokförts, men resultatet kunde inte bekräftas. Försök inte igen innan verifikatet och körjournalen har kontrollerats.',
            messageEn:
              'The voucher may have been posted, but the outcome could not be confirmed. Do not retry until the voucher and mileage log have been reviewed.',
            details: {
              journal_entry_id: result.journalEntryId,
              voucher_number: result.voucherNumber,
            },
          })
        case 'STAMP_FAILED':
          log.error('mileage stamp failed after verifikat creation', undefined, {
            operation: 'mileage.book',
            companyId,
            entityType: 'journal_entry',
            entityId: result.journalEntryId,
            voucherNumber: result.voucherNumber,
          })
          return errorResponseFromCode(result.code, log, {
            requestId,
            status: 500,
            messageSv:
              'Verifikatet skapades men alla resor kunde inte markeras som bokförda. Kontrollera körjournalen innan du bokför perioden igen.',
            messageEn:
              'The voucher was created, but not every trip could be marked as posted. Review the mileage log before booking the period again.',
            details: {
              journal_entry_id: result.journalEntryId,
              voucher_series: result.voucherSeries,
              voucher_number: result.voucherNumber,
            },
          })
      }
      const unhandledResult: never = result
      throw new Error(`Unhandled mileage booking result: ${String(unhandledResult)}`)
    }

    return NextResponse.json({
      data: {
        journal_entry_id: result.journalEntryId,
        voucher_series: result.voucherSeries,
        voucher_number: result.voucherNumber,
        trip_count: result.tripCount,
        total_amount: result.totalAmount,
        summaries: result.summaries,
      },
    })
  },
  { requireWrite: true }
)
