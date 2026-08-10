/**
 * Reading a message well enough to know whether it carries an underlag.
 *
 * The case that matters is the one a provkörning caught: asking Gmail for
 * `format=metadata` returns headers and no `payload.parts`, so every message
 * looks attachment-free and the hunt can never file anything. These tests pin
 * the format and the MIME walk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getMessageSummary } from '../gmail-client'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', (...args: unknown[]) => mockFetch(...args))

function respond(message: Record<string, unknown>) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(message),
    text: () => Promise.resolve(''),
  })
}

const HEADERS = [
  { name: 'Subject', value: 'Faktura-20251070' },
  { name: 'From', value: 'info@tic.io' },
]

beforeEach(() => vi.clearAllMocks())

describe('getMessageSummary', () => {
  it('asks for the full message, because metadata omits the parts tree', async () => {
    respond({ id: 'm1', payload: { headers: HEADERS } })
    await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')

    const url = String(mockFetch.mock.calls[0][0])
    expect(url).toContain('format=full')
    // The bug this replaces: metadata returns no payload.parts at all.
    expect(url).not.toContain('format=metadata')
  })

  it('finds a PDF nested inside a forwarded message', async () => {
    // Forwarding is how most of these receipts arrive, and it buries the
    // attachment two levels down inside a message/rfc822 part.
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { size: 12 } },
          {
            mimeType: 'message/rfc822',
            parts: [
              {
                mimeType: 'multipart/mixed',
                parts: [
                  { mimeType: 'text/html', body: { size: 900 } },
                  {
                    mimeType: 'application/pdf',
                    filename: 'faktura.pdf',
                    body: { attachmentId: 'att-deep', size: 51200 },
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual(['att-deep'])
    expect(candidate.bodyIsReceipt).toBe(false)
  })

  it('accepts supported image MIME types explicitly marked as attachments', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          {
            mimeType: 'image/jpeg',
            filename: 'receipt.jpg',
            headers: [{ name: ' content-disposition ', value: '  AtTaChMeNt ; filename="receipt.jpg"' }],
            body: { attachmentId: 'jpeg-receipt', size: 300 },
          },
          {
            mimeType: 'image/png',
            filename: 'receipt.png',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="receipt.png"' }],
            body: { attachmentId: 'png-receipt', size: 400 },
          },
          {
            mimeType: 'image/webp',
            filename: 'receipt.webp',
            headers: [{ name: 'Content-Disposition', value: ' ATTACHMENT ; filename="receipt.webp"' }],
            body: { attachmentId: 'webp-receipt', size: 500 },
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual(['jpeg-receipt', 'png-receipt', 'webp-receipt'])
    expect(candidate.attachmentNames).toEqual(['receipt.jpg', 'receipt.png', 'receipt.webp'])
    expect(candidate.bodyIsReceipt).toBe(false)
  })

  it('does not mistake an explicitly inline logo for an underlag', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          {
            mimeType: 'image/png',
            filename: 'logo.png',
            headers: [
              { name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
              { name: 'Content-ID', value: '<logo@example.com>' },
            ],
            body: { attachmentId: 'logo', size: 400 },
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual([])
    expect(candidate.bodyIsReceipt).toBe(true)
  })

  it('accepts supported octet-stream extensions with image dispositions enforced', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          {
            mimeType: 'application/octet-stream',
            filename: 'receipt.pdf',
            body: { attachmentId: 'octet-pdf', size: 400 },
          },
          {
            mimeType: 'application/octet-stream',
            filename: 'receipt.jpg',
            headers: [{ name: 'Content-Disposition', value: 'attachment ; filename="receipt.jpg"' }],
            body: { attachmentId: 'octet-jpg', size: 500 },
          },
          {
            mimeType: 'application/octet-stream',
            filename: 'receipt.JPEG',
            headers: [{ name: 'Content-Disposition', value: 'ATTACHMENT;filename="receipt.JPEG"' }],
            body: { attachmentId: 'octet-jpeg', size: 500 },
          },
          {
            mimeType: 'application/octet-stream',
            filename: 'receipt.png',
            headers: [{ name: 'content-disposition', value: ' attachment ; filename="receipt.png"' }],
            body: { attachmentId: 'octet-png', size: 600 },
          },
          {
            mimeType: 'application/octet-stream',
            filename: 'receipt.webp',
            headers: [{ name: 'Content-Disposition', value: ' attachment ; filename="receipt.webp"' }],
            body: { attachmentId: 'octet-webp', size: 700 },
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual([
      'octet-pdf',
      'octet-jpg',
      'octet-jpeg',
      'octet-png',
      'octet-webp',
    ])
  })

  it('rejects explicit inline parts for every supported direct and octet-stream type', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          {
            mimeType: 'application/pdf', filename: 'receipt.pdf',
            headers: [{ name: 'Content-Disposition', value: ' inline ; filename="receipt.pdf"' }],
            body: { attachmentId: 'inline-pdf', size: 400 },
          },
          {
            mimeType: 'image/jpeg', filename: 'logo.jpg',
            headers: [{ name: 'Content-Disposition', value: 'INLINE ; filename="logo.jpg"' }],
            body: { attachmentId: 'inline-jpeg', size: 400 },
          },
          {
            mimeType: 'image/webp', filename: 'logo.webp',
            headers: [{ name: 'Content-Disposition', value: 'inline;filename="logo.webp"' }],
            body: { attachmentId: 'inline-webp', size: 400 },
          },
          {
            mimeType: 'application/octet-stream', filename: 'logo.png',
            headers: [{ name: 'Content-Disposition', value: 'inline ; filename="logo.png"' }],
            body: { attachmentId: 'inline-octet-image', size: 400 },
          },
          {
            mimeType: 'application/octet-stream', filename: 'receipt.pdf',
            headers: [{ name: 'Content-Disposition', value: ' INLINE ; filename="receipt.pdf"' }],
            body: { attachmentId: 'inline-octet-pdf', size: 400 },
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual([])
    expect(candidate.bodyIsReceipt).toBe(true)
  })

  it('requires explicit attachment disposition for every supported image candidate', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          { mimeType: 'image/jpeg', filename: 'receipt.jpg', body: { attachmentId: 'jpeg', size: 400 } },
          { mimeType: 'image/png', filename: 'receipt.png', body: { attachmentId: 'png', size: 400 } },
          { mimeType: 'image/webp', filename: 'receipt.webp', body: { attachmentId: 'webp', size: 400 } },
          {
            mimeType: 'application/octet-stream',
            filename: 'receipt.png',
            body: { attachmentId: 'octet-image', size: 400 },
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual([])
  })

  it('rejects explicit and octet-stream GIFs plus other unsupported named files', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          {
            mimeType: 'image/gif',
            filename: 'receipt.gif',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="receipt.gif"' }],
            body: { attachmentId: 'explicit-gif', size: 400 },
          },
          {
            mimeType: 'application/octet-stream',
            filename: 'receipt.gif',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="receipt.gif"' }],
            body: { attachmentId: 'octet-gif', size: 400 },
          },
          {
            mimeType: 'text/plain',
            filename: 'receipt.txt',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="receipt.txt"' }],
            body: { attachmentId: 'text-file', size: 400 },
          },
          {
            mimeType: 'application/octet-stream',
            filename: 'receipt.zip',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="receipt.zip"' }],
            body: { attachmentId: 'octet-zip', size: 400 },
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual([])
  })

  it('does not ingest an anonymous inline image part', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          {
            mimeType: 'image/gif',
            headers: [{ name: 'Content-ID', value: '<tracking@example.com>' }],
            body: { attachmentId: 'tracking-pixel', size: 43 },
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual([])
  })

  it('reports a genuinely attachment-free mail as a body receipt', async () => {
    respond({
      id: 'm1',
      payload: { headers: HEADERS, mimeType: 'text/html', body: { size: 4000 } },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.bodyIsReceipt).toBe(true)
    expect(candidate.subject).toBe('Faktura-20251070')
  })

  it('combines the caller deadline with the per-request Gmail timeout', async () => {
    respond({ id: 'm1', payload: { headers: HEADERS } })
    const controller = new AbortController()

    await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io', controller.signal)

    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
    controller.abort(new Error('run deadline'))
    expect(init.signal?.aborted).toBe(true)
  })
})
