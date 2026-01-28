export type ImageResolution = '2K' | '4K'

export interface CostEstimate {
  images: number
  resolution: ImageResolution
  imageCost: number
  analysisCost: number
  totalCost: number
}

const parseCost = (value?: string) => {
  const parsed = value ? Number.parseFloat(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

const IMAGE_COST_2K = parseCost(process.env.IMAGE_COST_2K)
const IMAGE_COST_4K = parseCost(process.env.IMAGE_COST_4K)
const ANALYSIS_COST_PER_1K = parseCost(process.env.CLAUDE_COST_PER_1K)

export const estimateGenerationCost = ({
  images,
  resolution,
  analysisTokens,
}: {
  images: number
  resolution: ImageResolution
  analysisTokens?: number
}): CostEstimate => {
  const imageCostPer = resolution === '4K' ? IMAGE_COST_4K : IMAGE_COST_2K
  const analysisCost = analysisTokens ? (analysisTokens / 1000) * ANALYSIS_COST_PER_1K : 0
  const imageCost = images * imageCostPer

  return {
    images,
    resolution,
    imageCost,
    analysisCost,
    totalCost: imageCost + analysisCost,
  }
}
