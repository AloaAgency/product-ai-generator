/**
 * Centralized Claude model configuration
 */

export interface ModelConfig {
  name: string;
  maxTokens: number;
  description: string;
  costPer1kTokens?: {
    input: number;
    output: number;
  };
}

export const CLAUDE_FAST_MODEL: ModelConfig = {
  name: 'claude-haiku-4-5-20251001',
  maxTokens: 4096,
  description: 'Claude Haiku 4.5 - Fast and cost-effective',
  costPer1kTokens: { input: 0.001, output: 0.005 },
};

export const CLAUDE_SMART_MODEL: ModelConfig = {
  name: 'claude-sonnet-4-5-20250929',
  maxTokens: 8192,
  description: 'Claude Sonnet 4.5 - Advanced reasoning and creativity',
  costPer1kTokens: { input: 0.003, output: 0.015 },
};

export const ENRICHMENT_MODELS: ModelConfig[] = [
  CLAUDE_FAST_MODEL,
  CLAUDE_SMART_MODEL,
];

export const GENERATION_MODELS: ModelConfig[] = [
  CLAUDE_SMART_MODEL,
];

export function estimateCost(
  model: ModelConfig,
  inputTokens: number,
  outputTokens: number
): number {
  if (!model.costPer1kTokens) return 0;
  return (inputTokens / 1000) * model.costPer1kTokens.input +
    (outputTokens / 1000) * model.costPer1kTokens.output;
}
