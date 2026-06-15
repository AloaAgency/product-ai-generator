/**
 * Strip credential-bearing substrings out of free-text before it is persisted to
 * the database, written to logs, or surfaced to a client.
 *
 * This is the single source of truth shared by every error sanitizer in the
 * generation pipeline (`sanitizeWorkerErrorMessage`, `sanitizeExternalErrorMessage`).
 * Keeping one implementation prevents the redaction rules from drifting apart —
 * a weaker copy is exactly how a provider key (e.g. the `AIza…` Gemini/Veo key
 * passed via `x-goog-api-key`) ends up echoed back inside a stored job error.
 *
 * Only redaction and whitespace normalization happen here; callers own their own
 * fallback string and length-truncation policy.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    // `Authorization: Bearer <token>` and bare `Bearer <token>` forms.
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    // Credentials carried in URL query strings (signed URLs, callback URLs).
    .replace(/([?&](?:access_token|api[_-]?key|authorization|signature|sig|token|x-amz-[^=]+|x-goog-[^=]+)=)[^&\s]+/gi, '$1[redacted]')
    // Quoted JSON-style secret fields, e.g. `"gemini_api_key":"AIza…"`.
    .replace(/((?:"?(?:[a-z0-9_-]*api[_-]?key|authorization|secret|signature|token|password|cookie|set-cookie)"?\s*:\s*"))[^"]+(")/gi, '$1[redacted]$2')
    .replace(/((?:'?(?:[a-z0-9_-]*api[_-]?key|authorization|secret|signature|token|password|cookie|set-cookie)'?\s*:\s*'))[^']+(')/gi, '$1[redacted]$2')
    // Unquoted `key: value` / `key=value` secret pairs.
    .replace(/((?:[a-z0-9_-]*api[_-]?key|authorization|secret|signature|token|password|cookie|set-cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    // Three-segment JWTs — the shape of Supabase anon/service-role keys.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
    // Raw Google AI (Gemini/Veo) API keys.
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]')
    // Raw OpenAI-style keys.
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .trim()
}
