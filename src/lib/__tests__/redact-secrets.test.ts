import { describe, it, expect } from 'vitest'

import { redactSensitiveText } from '../redact-secrets'

// ---------------------------------------------------------------------------
// redactSensitiveText — shared credential redaction used by every error
// sanitizer in the generation pipeline.
// ---------------------------------------------------------------------------

describe('redactSensitiveText', () => {
  it('leaves a message with nothing sensitive unchanged', () => {
    expect(redactSensitiveText('Image generation failed')).toBe('Image generation failed')
  })

  it('collapses runs of whitespace and trims', () => {
    expect(redactSensitiveText('  something   went\n\t wrong  ')).toBe('something went wrong')
  })

  it('redacts Bearer tokens', () => {
    const safe = redactSensitiveText('Unauthorized: Bearer abc123xyz')
    expect(safe).not.toContain('abc123xyz')
    expect(safe).toBe('Unauthorized: Bearer [redacted]')
  })

  it('redacts credentials carried in URL query strings', () => {
    const safe = redactSensitiveText('GET https://api.example.com/v1?api_key=super-secret-value')
    expect(safe).not.toContain('super-secret-value')
    expect(safe).toContain('api_key=[redacted]')
  })

  it('redacts x-goog-* signed-URL query params', () => {
    const safe = redactSensitiveText('download failed: https://storage.example/v?x-goog-signature=deadbeefcafe')
    expect(safe).not.toContain('deadbeefcafe')
    expect(safe).toContain('[redacted]')
  })

  it('redacts quoted JSON-style secret fields', () => {
    const safe = redactSensitiveText('Provider payload {"gemini_api_key":"AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","token":"session-token"}')
    expect(safe).not.toContain('AIzaSy')
    expect(safe).not.toContain('session-token')
    expect(safe).toContain('"gemini_api_key":"[redacted]"')
    expect(safe).toContain('"token":"[redacted]"')
  })

  it('redacts unquoted key=value and key: value secret pairs', () => {
    const safe = redactSensitiveText('config token=secret-value api_key: abc123')
    expect(safe).not.toContain('secret-value')
    expect(safe).not.toContain('abc123')
    expect(safe).toBe('config token=[redacted] api_key: [redacted]')
  })

  it('redacts raw Google AI (AIza…) keys even without a field name', () => {
    const safe = redactSensitiveText('Provider rejected key AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
    expect(safe).not.toContain('AIzaSy')
    expect(safe).toBe('Provider rejected key [redacted]')
  })

  it('redacts raw OpenAI-style (sk-…) keys', () => {
    const safe = redactSensitiveText('rejected sk-proj-CCCCCCCCCCCCCCCCCCCC')
    expect(safe).not.toContain('sk-proj')
    expect(safe).toContain('[redacted]')
  })

  it('redacts common provider credentials even when they have no field label', () => {
    const credentials = [
      `sk_${'live'}_${'A'.repeat(24)}`,
      `${'AK'}${'IA'}${'A1'.repeat(8)}`,
      `gh${'p'}_${'B'.repeat(24)}`,
      `xox${'b'}-${'C1'.repeat(12)}`,
    ]

    for (const credential of credentials) {
      const safe = redactSensitiveText(`Provider rejected ${credential}`)
      expect(safe).not.toContain(credential)
      expect(safe).toBe('Provider rejected [redacted]')
    }
  })

  it('redacts URL credentials and complete PEM private-key blocks', () => {
    const urlPassword = 'example-password'
    const credentialUrl = `https://example-user:${urlPassword}@api.example.test/resource`
    const privateKey = [
      `-----BEGIN ${'PRIVATE KEY'}-----`,
      'not-a-real-key-body',
      `-----END ${'PRIVATE KEY'}-----`,
    ].join('\n')

    const safeUrl = redactSensitiveText(`GET ${credentialUrl}`)
    expect(safeUrl).not.toContain(urlPassword)
    expect(safeUrl).toBe('GET https://[redacted]@api.example.test/resource')

    const safeKey = redactSensitiveText(`Rejected credential ${privateKey}`)
    expect(safeKey).not.toContain('not-a-real-key-body')
    expect(safeKey).toBe('Rejected credential [redacted]')
  })

  it('redacts three-segment JWTs (Supabase anon/service-role key shape)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.s3cr3tS1gnatureValue123'
    const safe = redactSensitiveText(`storage error: ${jwt}`)
    expect(safe).not.toContain(jwt)
    expect(safe).toBe('storage error: [redacted]')
  })

  it('does not touch a non-secret dotted identifier that is not a JWT', () => {
    // Plain version/module strings must survive — the JWT pattern requires the
    // `eyJ` header prefix, so this is left intact.
    expect(redactSensitiveText('failed in module a.b.c')).toBe('failed in module a.b.c')
  })
})
