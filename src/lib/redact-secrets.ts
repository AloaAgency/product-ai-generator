/**
 * Strip credential-bearing substrings out of free-text before it is persisted to
 * the database, written to logs, or surfaced to a client.
 *
 * This is the single source of truth shared by every error sanitizer
 * (`sanitizeWorkerErrorMessage`, `sanitizeExternalErrorMessage`,
 * `sanitizePublicErrorMessage`) and by log statements that echo external
 * error messages (storage retries, bug-tracker responses).
 * Keeping one implementation prevents the redaction rules from drifting apart —
 * a weaker copy is exactly how a provider key (e.g. the `AIza…` Gemini/Veo key
 * passed via `x-goog-api-key`) ends up echoed back inside a stored job error.
 *
 * Only redaction and whitespace normalization happen here; callers own their own
 * fallback string and length-truncation policy.
 */
export function redactSensitiveText(value: string): string {
  return value
    // PEM private keys may span lines. Remove the full block before whitespace
    // normalization so neither the body nor its delimiters reach a log sink.
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
      '[redacted]'
    )
    .replace(/\s+/g, ' ')
    // `Authorization: Bearer <token>` and bare `Bearer <token>` forms.
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    // Credentials embedded in URL authority sections.
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    // Credentials carried in URL query strings (signed URLs, callback URLs).
    .replace(/([?&](?:access_token|api[_-]?key|authorization|signature|sig|token|x-amz-[^=]+|x-goog-[^=]+)=)[^&\s]+/gi, '$1[redacted]')
    // Quoted JSON-style secret fields, e.g. `"gemini_api_key":"AIza…"`.
    .replace(/((?:"?(?:[a-z0-9_-]*api[_-]?key|authorization|secret|signature|token|password|cookie|set-cookie)"?\s*:\s*"))[^"]+(")/gi, '$1[redacted]$2')
    .replace(/((?:'?(?:[a-z0-9_-]*api[_-]?key|authorization|secret|signature|token|password|cookie|set-cookie)'?\s*:\s*'))[^']+(')/gi, '$1[redacted]$2')
    // Unquoted `key: value` / `key=value` secret pairs.
    .replace(/((?:[a-z0-9_-]*api[_-]?key|authorization|secret|signature|token|password|cookie|set-cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    // Three-segment JWTs — the shape of Supabase anon/service-role keys.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
    // Common raw credential prefixes that can appear without a field label.
    .replace(/\b(?:sk_live_|sk_test_|pk_live_)[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, '[redacted]')
    .replace(/\b(?:ghp_|gho_|ghs_)[A-Za-z0-9_]{12,}\b/g, '[redacted]')
    .replace(/\b(?:xoxb-|xoxp-)[A-Za-z0-9-]{12,}\b/g, '[redacted]')
    // Raw Google AI (Gemini/Veo) API keys.
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]')
    // Raw OpenAI-style keys.
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .trim()
}
