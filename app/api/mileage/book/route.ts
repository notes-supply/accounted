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
      if (result.code === 'NO_TRIPS') {
        return NextResponse.json(
          { error: 'Inga obokförda resor i den valda perioden' },
          { status: 400 }
        )
      }
      if (result.code === 'MIXED_EMPLOYEES') {
        return NextResponse.json(
          { error: 'Resorna i perioden gäller flera anställda. Bokför per anställd.' },
          { status: 400 }
        )
      }
      if (result.code === 'PERIOD_NOT_OPEN') {
        return NextResponse.json(
          { error: 'Bokföringsdatumet ligger i en stängd eller låst period' },
          { status: 400 }
        )
      }
      if (result.code === 'CLAIM_LOST' || result.code === 'TRIPS_CHANGED') {
        return errorResponseFromCode('MILEAGE_CLAIM_CONFLICT', log, {
          requestId,
          status: 409,
          messageSv:
            'Körjournalen ändrades samtidigt av en annan bokning. Ladda om och försök igen.',
          messageEn:
            'The mileage log changed during another booking. Reload and try again.',
          details: { retryable: true },
        })
      }
      if (result.code === 'RELEASE_INCOMPLETE') {
        return errorResponseFromCode('MILEAGE_CLAIM_RELEASE_INCOMPLETE', log, {
          requestId,
          status: 500,
          messageSv:
            'Bokningen avbröts men alla milersättningsanspråk kunde inte verifieras som frigivna. Försök inte igen innan körjournalen har kontrollerats.',
          messageEn:
            'Booking stopped, but not all mileage claims could be verified as released. Do not retry before the mileage log has been reconciled.',
          details: { retryable: false },
        })
      }

      const identity = {
        ...(result.journalEntryId
          ? { journal_entry_id: result.journalEntryId }
          : {}),
        ...(result.voucherNumber !== undefined
          ? { voucher_number: result.voucherNumber }
          : {}),
        ...(result.voucherSeries !== undefined
          ? { voucher_series: result.voucherSeries }
          : {}),
        retryable: false,
      }
      if (result.code === 'POST_COMMIT_IDENTITY_AMBIGUOUS') {
        return errorResponseFromCode('MILEAGE_POST_COMMIT_IDENTITY_AMBIGUOUS', log, {
          requestId,
          status: 500,
          messageSv:
            'Bokföringen kan redan vara genomförd men kunde inte läsas tillbaka säkert. Försök inte igen innan verifikationen har kontrollerats.',
          messageEn:
            'The posting may already be committed but could not be read back safely. Do not retry before the journal has been reconciled.',
          details: identity,
        })
      }

      // STAMP_FAILED: the verifikat exists, but the complete mileage link was
      // not verified. Preserve durable journal identity and make retry unsafe.
      return errorResponseFromCode('MILEAGE_STAMP_INCOMPLETE', log, {
        requestId,
        status: 500,
        messageSv:
          'Verifikatet skapades men alla resor kunde inte markeras som bokförda. Försök inte igen innan körjournalen har kontrollerats.',
        messageEn:
          'The journal entry was created, but not every trip could be stamped as booked. Do not retry before the mileage log has been reconciled.',
        details: identity,
      })
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
