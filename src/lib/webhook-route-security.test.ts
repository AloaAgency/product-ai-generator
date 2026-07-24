import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const API_ROOT = path.resolve(process.cwd(), 'src/app/api')
const WEBHOOK_ROUTE_PATTERN = /(?:^|\/)(?:webhooks?|callbacks?|hooks?|events?|stripe|resend|sendgrid|svix|twilio)(?:\/|$)|(?:^|\/)slack\/events(?:\/|$)|(?:^|\/)supabase\/webhooks(?:\/|$)/i
const MUTATING_HANDLER_PATTERN = /export\s+async\s+function\s+(?:POST|PUT)\b/
const USER_AUTH_PATTERN = /\b(?:getSession|getServerSession|auth\.uid|getUser|requireAuth|isAuthenticated|isAdminAuthorized|matchesRotatableSecret|secretsEqual)\b/
const RAW_BODY_PATTERN = /await\s+[A-Za-z_$][\w$]*\.text\s*\(/
const SIGNATURE_HEADER_PATTERN = /["'](?:x-slack-signature|stripe-signature|svix-signature|x-hub-signature-256|x-signature|webhook-signature)["']/i
const VERIFIER_PATTERN = /\b(?:timingSafeEqual|constructEvent|verifyWebhook|verifySignature)\b|\.verify\s*\(|new\s+Webhook\s*\(/
const GENERIC_AUTH_FAILURE_PATTERN = /["'](?:Unauthorized|Invalid webhook request|Authentication failed)["']/
const AUTH_FAILURE_STATUS_PATTERN = /status\s*:\s*(?:401|403)\b/
const TIMESTAMP_HEADER_PATTERN = /["'](?:x-[^"']*-timestamp|webhook-timestamp|svix-timestamp)["']/i
const PROVIDER_TIMESTAMP_VERIFIER_PATTERN = /\bconstructEvent\b|new\s+Webhook\s*\(|\.verify\s*\(/

type WebhookRouteAudit = {
  routePath: string
  violations: string[]
}

function firstIndex(source: string, patterns: RegExp[]): number {
  const indexes = patterns
    .map((pattern) => source.search(pattern))
    .filter((index) => index >= 0)
  return indexes.length > 0 ? Math.min(...indexes) : -1
}

function auditWebhookRouteSource(routePath: string, source: string): WebhookRouteAudit | null {
  const normalizedPath = routePath.split(path.sep).join('/')
  if (!WEBHOOK_ROUTE_PATTERN.test(normalizedPath) || !MUTATING_HANDLER_PATTERN.test(source)) {
    return null
  }
  if (USER_AUTH_PATTERN.test(source)) return null

  const violations: string[] = []
  const rawBodyIndex = source.search(RAW_BODY_PATTERN)
  const verifierIndex = source.search(VERIFIER_PATTERN)
  const parseIndex = firstIndex(source, [
    /await\s+[A-Za-z_$][\w$]*\.json\s*\(/,
    /\bJSON\.parse\s*\(/,
  ])

  if (rawBodyIndex < 0) {
    violations.push('must read the unmodified request body with await request.text()')
  }
  if (!SIGNATURE_HEADER_PATTERN.test(source)) {
    violations.push('must extract a recognized signature header')
  }
  if (verifierIndex < 0) {
    violations.push('must use a timing-safe or provider signature verifier')
  }
  if (parseIndex >= 0 && (rawBodyIndex < 0 || verifierIndex < 0 || parseIndex < verifierIndex)) {
    violations.push('must verify the raw body before parsing JSON')
  }
  if (!AUTH_FAILURE_STATUS_PATTERN.test(source) || !GENERIC_AUTH_FAILURE_PATTERN.test(source)) {
    violations.push('must reject authentication failures with a generic 401/403 response')
  }

  const hasTimestampHeader = TIMESTAMP_HEADER_PATTERN.test(source)
  const providerChecksTimestamp = PROVIDER_TIMESTAMP_VERIFIER_PATTERN.test(source)
  if (hasTimestampHeader && !providerChecksTimestamp && !/\bDate\.now\s*\(/.test(source)) {
    violations.push('must freshness-check a supplied timestamp to prevent replay')
  }

  return { routePath: normalizedPath, violations }
}

function listRouteFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listRouteFiles(absolutePath)
    return entry.name === 'route.ts' ? [absolutePath] : []
  })
}

describe('webhook route security boundary', () => {
  it('accepts a raw-body HMAC handler with a generic auth failure', () => {
    const source = `
      import { timingSafeEqual } from 'node:crypto'
      export async function POST(request: Request) {
        const rawBody = await request.text()
        const signature = request.headers.get('x-signature')
        const valid = signature && timingSafeEqual(Buffer.from(signature), Buffer.from(rawBody))
        if (!valid) return Response.json({ error: 'Unauthorized' }, { status: 401 })
        const body = JSON.parse(rawBody)
        return Response.json({ received: Boolean(body) })
      }
    `

    expect(auditWebhookRouteSource('src/app/api/webhook/route.ts', source)?.violations).toEqual([])
  })

  it('flags parsed-body verification, missing freshness checks, and specific failure responses', () => {
    const source = `
      export async function POST(request: Request) {
        const body = await request.json()
        const signature = request.headers.get('x-slack-signature')
        const timestamp = request.headers.get('x-slack-request-timestamp')
        if (!verifySignature(body, signature, timestamp)) {
          return Response.json({ error: 'Bad timestamp' }, { status: 200 })
        }
      }
    `

    expect(auditWebhookRouteSource('src/app/api/slack/events/route.ts', source)?.violations).toEqual([
      'must read the unmodified request body with await request.text()',
      'must verify the raw body before parsing JSON',
      'must reject authentication failures with a generic 401/403 response',
      'must freshness-check a supplied timestamp to prevent replay',
    ])
  })

  it('requires every unauthenticated webhook-like App Router handler to pass the audit', () => {
    const audits = listRouteFiles(API_ROOT)
      .map((filePath) => auditWebhookRouteSource(
        path.relative(process.cwd(), filePath),
        fs.readFileSync(filePath, 'utf8')
      ))
      .filter((audit): audit is WebhookRouteAudit => audit !== null)

    const violations = audits.flatMap((audit) =>
      audit.violations.map((violation) => `${audit.routePath}: ${violation}`)
    )

    expect(violations).toEqual([])
  })
})
