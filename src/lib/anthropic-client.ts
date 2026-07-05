import Anthropic from '@anthropic-ai/sdk'

// Per-attempt timeout for Claude API calls. The Anthropic SDK defaults to a
// 10-minute timeout, so a hung request would otherwise hold a serverless
// function open until the platform's own maxDuration. Bounding it here fails
// fast into each route's existing catch instead — mirroring the timeout
// convention already used for the Gemini/LTX fetches in video-generation.ts.
const ANTHROPIC_REQUEST_TIMEOUT_MS = 60_000

/**
 * Construct an Anthropic client with a bounded per-request timeout.
 *
 * `maxRetries` is left at the SDK default (2) — it already retries transient
 * 408/409/429/5xx and connection errors with exponential backoff, which is the
 * graceful-degradation behavior we want for these AI-assist routes.
 */
export function createAnthropicClient(): Anthropic {
  return new Anthropic({ timeout: ANTHROPIC_REQUEST_TIMEOUT_MS, maxRetries: 2 })
}
