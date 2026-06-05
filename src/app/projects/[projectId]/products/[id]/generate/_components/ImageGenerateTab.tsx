'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useAppStore } from '@/lib/store'
import { ImageLightbox, type LightboxImage, type ApprovalStatus } from '@/components/ImageLightbox'
import {
  Sparkles,
  Lightbulb,
  Loader2,
  AlertTriangle,
  Image as ImageIcon,
  Play,
  ChevronDown,
  ChevronUp,
  Settings,
  Camera,
  Save,
  X,
  Plus,
  Minus,
  Check,
} from 'lucide-react'
import { PromptEnhancements } from './PromptEnhancements'
import { ReferenceImagePicker } from './ReferenceImagePicker'
import { assemblePrompt, DEFAULT_ENHANCEMENTS, type PromptEnhancementValues } from './promptAssembler'

const MAX_TOTAL_REFERENCE_IMAGES = 14
const MAX_SUBJECT_LABEL_LEN = 80

type RefSlotRole = 'subject' | 'texture'

type RefSlot = {
  key: string
  reference_set_id: string
  role: RefSlotRole
  image_count_input: string
  manual: boolean
  subject_label: string
  selected_image_ids: string[]
  picker_open: boolean
}

export type InitialReferenceSetSelection = {
  reference_set_id: string
  role: RefSlotRole
  image_count: number | null
  subject_label: string | null
}

interface ImageGenerateTabProps {
  productId: string
  initialPrompt?: string
  initialReferenceSets?: InitialReferenceSetSelection[]
}

let slotKeyCounter = 0
const nextSlotKey = () => {
  slotKeyCounter += 1
  return `slot-${slotKeyCounter}`
}

const parseSlotImageCount = (value: string): number | null => {
  if (!value.trim()) return null
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.min(MAX_TOTAL_REFERENCE_IMAGES, parsed)
}

const slotContribution = (s: RefSlot): number => {
  if (s.selected_image_ids.length > 0) return s.selected_image_ids.length
  return parseSlotImageCount(s.image_count_input) ?? 0
}

// Spread the 14-image budget across slots the user hasn't manually adjusted, while
// capping each unlocked slot at its reference set's available image count. So if
// Set A has 14 images and Set B has 1, B fills to 1 and A absorbs the remaining 13.
// availableBySetId may be empty/partial — slots without a known cap are treated as
// effectively unlimited (capped only by the total budget).
const distributeBudget = (
  slots: RefSlot[],
  availableBySetId: Map<string, number | undefined>,
): RefSlot[] => {
  const isLocked = (s: RefSlot) => s.manual || s.selected_image_ids.length > 0
  const unlocked = slots.map((s, i) => ({ s, i })).filter(({ s }) => !isLocked(s))
  if (unlocked.length === 0) return slots

  const lockedTotal = slots.reduce(
    (sum, s) => (isLocked(s) ? sum + slotContribution(s) : sum),
    0,
  )
  let remaining = Math.max(0, MAX_TOTAL_REFERENCE_IMAGES - lockedTotal)

  // Water-fill: give each unlocked slot at least 1 (if possible), then distribute
  // the rest, never exceeding the set's available count.
  const cap = (setId: string) => {
    const a = availableBySetId.get(setId)
    return a == null ? MAX_TOTAL_REFERENCE_IMAGES : Math.max(0, a)
  }
  const targets = new Map<number, number>()
  for (const { i, s } of unlocked) {
    const want = Math.min(1, cap(s.reference_set_id))
    const give = Math.min(want, remaining)
    targets.set(i, give)
    remaining -= give
  }
  while (remaining > 0) {
    const openIdx = unlocked.filter(({ i, s }) => (targets.get(i) ?? 0) < cap(s.reference_set_id))
    if (openIdx.length === 0) break
    const base = Math.max(1, Math.floor(remaining / openIdx.length))
    let progressed = false
    for (const { i, s } of openIdx) {
      if (remaining <= 0) break
      const room = cap(s.reference_set_id) - (targets.get(i) ?? 0)
      const give = Math.min(base, room, remaining)
      if (give > 0) {
        targets.set(i, (targets.get(i) ?? 0) + give)
        remaining -= give
        progressed = true
      }
    }
    if (!progressed) break
  }

  return slots.map((s, i) => {
    if (isLocked(s)) return s
    const t = targets.get(i) ?? 0
    return { ...s, image_count_input: t > 0 ? String(t) : '' }
  })
}

export function ImageGenerateTab({
  productId,
  initialPrompt,
  initialReferenceSets,
}: ImageGenerateTabProps) {
  const promptTemplates = useAppStore((s) => s.promptTemplates)
  const referenceSets = useAppStore((s) => s.referenceSets)
  const referenceImages = useAppStore((s) => s.referenceImages)
  const currentJob = useAppStore((s) => s.currentJob)
  const currentProduct = useAppStore((s) => s.currentProduct)
  const aiLoading = useAppStore((s) => s.aiLoading)
  const fetchPromptTemplates = useAppStore((s) => s.fetchPromptTemplates)
  const createPromptTemplate = useAppStore((s) => s.createPromptTemplate)
  const updatePromptTemplate = useAppStore((s) => s.updatePromptTemplate)
  const fetchReferenceSets = useAppStore((s) => s.fetchReferenceSets)
  const fetchReferenceImages = useAppStore((s) => s.fetchReferenceImages)
  const startGeneration = useAppStore((s) => s.startGeneration)
  const fetchJobStatus = useAppStore((s) => s.fetchJobStatus)
  const retryGenerationJob = useAppStore((s) => s.retryGenerationJob)
  const buildPrompt = useAppStore((s) => s.buildPrompt)
  const suggestPrompts = useAppStore((s) => s.suggestPrompts)
  const updateImageApproval = useAppStore((s) => s.updateImageApproval)
  const deleteImage = useAppStore((s) => s.deleteImage)

  const [prompt, setPrompt] = useState('')
  const [variationCountInput, setVariationCountInput] = useState('15')
  const [resolution, setResolution] = useState('2K')
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [didInitDefaults, setDidInitDefaults] = useState(false)
  const [suggestions, setSuggestions] = useState<
    { name: string; prompt_text: string }[]
  >([])
  const [refSlots, setRefSlots] = useState<RefSlot[]>([])
  const [didInitRefSlots, setDidInitRefSlots] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [loadedTemplateId, setLoadedTemplateId] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [signedUrlsById, setSignedUrlsById] = useState<Record<string, { signed_url?: string | null; thumb_signed_url?: string | null; preview_signed_url?: string | null; expires_at?: number }>>({})
  const signedUrlsRef = useRef(signedUrlsById)
  useEffect(() => { signedUrlsRef.current = signedUrlsById }, [signedUrlsById])

  // Photographic settings overrides
  const [photoLens, setPhotoLens] = useState('')
  const [photoCameraHeight, setPhotoCameraHeight] = useState('')
  const [photoLighting, setPhotoLighting] = useState('')
  const [photoColorGrading, setPhotoColorGrading] = useState('')
  const [photoStyle, setPhotoStyle] = useState('')
  const [photoSettingsExpanded, setPhotoSettingsExpanded] = useState(false)

  // Prompt enhancements
  const [enhancements, setEnhancements] = useState<PromptEnhancementValues>(DEFAULT_ENHANCEMENTS)

  // Reference image
  const [referenceImageId, setReferenceImageId] = useState<string | null>(null)
  const [referenceThumbUrl, setReferenceThumbUrl] = useState<string | null>(null)
  const [showRefPicker, setShowRefPicker] = useState(false)

  const ensureSignedUrls = useCallback(async (imageId: string) => {
    const cached = signedUrlsRef.current[imageId]
    if (cached?.expires_at && cached.expires_at - Date.now() > 60_000) return cached
    const res = await fetch(`/api/images/${imageId}/signed`)
    if (!res.ok) return null
    const data = await res.json()
    const next = { ...signedUrlsRef.current, [imageId]: data }
    signedUrlsRef.current = next
    setSignedUrlsById(next)
    return data
  }, [])

  useEffect(() => {
    fetchPromptTemplates(productId)
    fetchReferenceSets(productId)
  }, [productId, fetchPromptTemplates, fetchReferenceSets])

  // Pre-fill prompt from query param
  useEffect(() => {
    if (initialPrompt && !prompt) {
      setPrompt(initialPrompt)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt])

  useEffect(() => {
    setDidInitDefaults(false)
  }, [productId])

  useEffect(() => {
    if (!currentProduct || currentProduct.id !== productId || didInitDefaults) return
    const defaults = currentProduct.global_style_settings || {}
    if (defaults.default_resolution) {
      setResolution(defaults.default_resolution)
    }
    if (defaults.default_aspect_ratio) {
      setAspectRatio(defaults.default_aspect_ratio)
    }
    if (defaults.default_variation_count) {
      setVariationCountInput(String(defaults.default_variation_count))
    }
    if (defaults.lens) setPhotoLens(defaults.lens)
    if (defaults.camera_height) setPhotoCameraHeight(defaults.camera_height)
    if (defaults.lighting) setPhotoLighting(defaults.lighting)
    if (defaults.color_grading) setPhotoColorGrading(defaults.color_grading)
    if (defaults.style) setPhotoStyle(defaults.style)
    setDidInitDefaults(true)
  }, [currentProduct, productId, didInitDefaults])

  const productSets = useMemo(
    () => referenceSets.filter((rs) => rs.type === 'product' || !rs.type),
    [referenceSets]
  )
  const textureSets = useMemo(
    () => referenceSets.filter((rs) => rs.type === 'texture'),
    [referenceSets]
  )

  const availableBySetId = useMemo(() => {
    const m = new Map<string, number | undefined>()
    for (const [setId, imgs] of Object.entries(referenceImages)) {
      m.set(setId, imgs?.length ?? 0)
    }
    return m
  }, [referenceImages])

  // Seed slots once the reference set catalog has loaded. Prefer initialReferenceSets from the
  // regenerate URL flow; otherwise default to a single subject slot pointed at the active set.
  useEffect(() => {
    if (didInitRefSlots) return
    if (referenceSets.length === 0) return
    const productIds = new Set(productSets.map((rs) => rs.id))
    const textureIds = new Set(textureSets.map((rs) => rs.id))

    const hydrated: RefSlot[] = []
    if (initialReferenceSets && initialReferenceSets.length > 0) {
      for (const sel of initialReferenceSets) {
        const allowed = sel.role === 'subject' ? productIds : textureIds
        if (!allowed.has(sel.reference_set_id)) continue
        hydrated.push({
          key: nextSlotKey(),
          reference_set_id: sel.reference_set_id,
          role: sel.role,
          image_count_input: sel.image_count != null ? String(sel.image_count) : '',
          manual: sel.image_count != null,
          subject_label: sel.subject_label ?? '',
          selected_image_ids: [],
          picker_open: false,
        })
      }
    }
    if (hydrated.length === 0 && productSets.length > 0) {
      const active = productSets.find((rs) => rs.is_active) ?? productSets[0]
      hydrated.push({
        key: nextSlotKey(),
        reference_set_id: active.id,
        role: 'subject',
        image_count_input: '',
        manual: false,
        subject_label: '',
        selected_image_ids: [],
        picker_open: false,
      })
    }
    setRefSlots(distributeBudget(hydrated, new Map()))
    setDidInitRefSlots(true)
  }, [referenceSets, productSets, textureSets, initialReferenceSets, didInitRefSlots])

  // Eagerly fetch images for each referenced set so we know the available count
  // (drives auto-distribute caps) and can render the picker without a click delay.
  useEffect(() => {
    const seen = new Set<string>()
    for (const s of refSlots) {
      if (!s.reference_set_id || seen.has(s.reference_set_id)) continue
      seen.add(s.reference_set_id)
      if (!(s.reference_set_id in referenceImages)) {
        fetchReferenceImages(productId, s.reference_set_id)
      }
    }
  }, [refSlots, referenceImages, productId, fetchReferenceImages])

  // When new available counts arrive, re-balance unlocked slots to honor caps
  // (e.g. 14+1 should auto-shift from 7/7 → 13/1 once we know B only has 1 image).
  useEffect(() => {
    if (!didInitRefSlots) return
    setRefSlots((prev) => {
      const next = distributeBudget(prev, availableBySetId)
      const changed = next.some((s, i) => s.image_count_input !== prev[i]?.image_count_input)
      return changed ? next : prev
    })
  }, [availableBySetId, didInitRefSlots])

  // Poll job status
  useEffect(() => {
    if (!activeJobId) return
    const poll = () => { fetchJobStatus(productId, activeJobId) }
    poll()
    pollingRef.current = setInterval(poll, 3000)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [activeJobId, productId, fetchJobStatus])

  // Stop polling when job is done
  useEffect(() => {
    if (
      currentJob &&
      (currentJob.status === 'completed' || currentJob.status === 'failed')
    ) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      setGenerating(false)
    }
    // Only react to status transitions, not every poll update to the job object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentJob?.status])

  const handleRefine = async () => {
    if (!prompt.trim()) return
    const refined = await buildPrompt(productId, prompt)
    setPrompt(refined)
  }

  const handleSuggest = async () => {
    const results = await suggestPrompts(productId)
    setSuggestions(results)
  }

  const loadedTemplate = useMemo(
    () => (loadedTemplateId ? promptTemplates.find((t) => t.id === loadedTemplateId) ?? null : null),
    [loadedTemplateId, promptTemplates]
  )

  const openSaveTemplate = () => {
    setTemplateName(loadedTemplate?.name ?? '')
    setShowSaveTemplate(true)
  }

  const handleSaveTemplate = async ({ asNew }: { asNew: boolean }) => {
    const name = templateName.trim()
    if (!name) return
    setSavingTemplate(true)
    try {
      if (!asNew && loadedTemplate) {
        await updatePromptTemplate(productId, loadedTemplate.id, {
          name,
          prompt_text: prompt,
        })
      } else {
        const created = await createPromptTemplate(productId, {
          name,
          prompt_text: prompt,
        })
        if (created?.id) setLoadedTemplateId(created.id)
      }
      setTemplateName('')
      setShowSaveTemplate(false)
    } finally {
      setSavingTemplate(false)
    }
  }

  const handleGenerate = async () => {
    if (!prompt.trim() || aiLoading) return
    const variationCountValue = parseVariationCount(variationCountInput)
    if (!variationCountValue) return
    const payloadRefSets = buildRefSetsPayload(refSlots)
    if (!payloadRefSets) return

    // Assemble prompt with enhancements
    let finalPrompt = assemblePrompt(prompt, enhancements)
    if (referenceImageId) {
      finalPrompt += ' Use the attached reference image for visual guidance.'
    }

    setGenerating(true)
    try {
      const job = await startGeneration(productId, {
        prompt_text: finalPrompt,
        variation_count: variationCountValue,
        resolution,
        aspect_ratio: aspectRatio,
        reference_sets: payloadRefSets,
        lens: photoLens || undefined,
        camera_height: photoCameraHeight || undefined,
        lighting: photoLighting || undefined,
        color_grading: photoColorGrading || undefined,
        style: photoStyle || undefined,
      })
      setActiveJobId(job.id)
    } catch {
      setGenerating(false)
    }
  }

  const handleRetry = async () => {
    if (!currentJob) return
    setRetrying(true)
    try {
      const job = await retryGenerationJob(productId, currentJob.id)
      setGenerating(true)
      setActiveJobId(null)
      setTimeout(() => setActiveJobId(job.id), 0)
    } finally {
      setRetrying(false)
    }
  }

  const lightboxImages: LightboxImage[] = useMemo(() => {
    if (!currentJob?.images) return []
    return currentJob.images.map((img) => ({
      id: img.id,
      public_url: img.public_url,
      thumb_public_url: img.thumb_public_url,
      preview_public_url: img.preview_public_url,
      signed_url: signedUrlsById[img.id]?.signed_url ?? null,
      thumb_signed_url: signedUrlsById[img.id]?.thumb_signed_url ?? null,
      preview_signed_url: signedUrlsById[img.id]?.preview_signed_url ?? null,
      file_name: img.storage_path?.split('/').pop() ?? null,
      variation_number: img.variation_number,
      approval_status: img.approval_status ?? 'pending',
      notes: img.notes,
    }))
  }, [currentJob?.images, signedUrlsById])

  const handleApprovalChange = async (imageId: string, status: ApprovalStatus) => {
    if (status === 'rejected') {
      await deleteImage(imageId)
    } else {
      await updateImageApproval(imageId, status)
    }
  }

  const completedOrImages = currentJob
    ? Math.max(currentJob.completed_count ?? 0, currentJob.images?.length ?? 0)
    : 0
  const progress =
    currentJob && currentJob.variation_count
      ? Math.round((completedOrImages / currentJob.variation_count) * 100)
      : 0

  const parseVariationCount = (value: string) => {
    if (!value.trim()) return null
    const parsed = parseInt(value, 10)
    if (!Number.isFinite(parsed)) return null
    if (parsed < 1) return null
    return Math.min(100, parsed)
  }
  const variationCountValue = parseVariationCount(variationCountInput)
  const slotImageCounts = refSlots.map((s) => {
    if (s.selected_image_ids.length > 0) return s.selected_image_ids.length
    return parseSlotImageCount(s.image_count_input)
  })
  const totalImageCount = slotImageCounts.reduce<number>((sum, n) => sum + (n ?? 0), 0)
  const subjectSlotCount = refSlots.filter((s) => s.role === 'subject').length

  const buildRefSetsPayload = (slots: RefSlot[]) => {
    const payload = slots.map((slot) => {
      if (!slot.reference_set_id) return null
      const label = slot.role === 'subject' ? slot.subject_label.trim().slice(0, MAX_SUBJECT_LABEL_LEN) : ''
      if (slot.selected_image_ids.length > 0) {
        return {
          reference_set_id: slot.reference_set_id,
          role: slot.role,
          image_count: slot.selected_image_ids.length,
          image_ids: [...slot.selected_image_ids],
          subject_label: label ? label : null,
        }
      }
      const count = parseSlotImageCount(slot.image_count_input)
      if (count == null) return null
      return {
        reference_set_id: slot.reference_set_id,
        role: slot.role,
        image_count: count,
        subject_label: label ? label : null,
      }
    })
    if (payload.some((p) => p === null)) return null
    return payload as NonNullable<(typeof payload)[number]>[]
  }

  const updateSlot = (key: string, patch: Partial<Omit<RefSlot, 'key'>>) => {
    setRefSlots((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }
  // Changing the underlying set invalidates any image-id selection — IDs are
  // bound to the previous set's images. Reset selection to keep state consistent.
  const changeSlotReferenceSet = (key: string, referenceSetId: string) => {
    setRefSlots((prev) =>
      distributeBudget(
        prev.map((s) =>
          s.key === key
            ? { ...s, reference_set_id: referenceSetId, selected_image_ids: [] }
            : s,
        ),
        availableBySetId,
      ),
    )
  }
  const removeSlot = (key: string) => {
    setRefSlots((prev) => distributeBudget(prev.filter((s) => s.key !== key), availableBySetId))
  }
  const addSlot = (role: RefSlotRole) => {
    const pool = role === 'subject' ? productSets : textureSets
    if (pool.length === 0) return
    const first = pool[0]
    setRefSlots((prev) =>
      distributeBudget(
        [
          ...prev,
          {
            key: nextSlotKey(),
            reference_set_id: first.id,
            role,
            image_count_input: '',
            manual: false,
            subject_label: '',
            selected_image_ids: [],
            picker_open: false,
          },
        ],
        availableBySetId,
      ),
    )
  }
  const currentTotal = totalImageCount
  const incrementSlot = (key: string) => {
    setRefSlots((prev) =>
      prev.map((s) => {
        if (s.key !== key) return s
        if (s.selected_image_ids.length > 0) return s // selection drives count
        const current = parseSlotImageCount(s.image_count_input) ?? 0
        const available = availableBySetId.get(s.reference_set_id) ?? MAX_TOTAL_REFERENCE_IMAGES
        const otherTotal = currentTotal - current
        const ceiling = Math.min(MAX_TOTAL_REFERENCE_IMAGES - otherTotal, available)
        const next = Math.min(ceiling, current + 1)
        if (next <= current) return s
        return { ...s, image_count_input: String(next), manual: true }
      }),
    )
  }
  const decrementSlot = (key: string) => {
    setRefSlots((prev) =>
      prev.map((s) => {
        if (s.key !== key) return s
        if (s.selected_image_ids.length > 0) return s
        const current = parseSlotImageCount(s.image_count_input) ?? 1
        return {
          ...s,
          image_count_input: String(Math.max(1, current - 1)),
          manual: true,
        }
      }),
    )
  }
  const splitEvenly = () => {
    setRefSlots((prev) =>
      distributeBudget(
        prev.map((s) => ({ ...s, manual: false, selected_image_ids: [] })),
        availableBySetId,
      ),
    )
  }
  const togglePicker = (key: string) => {
    setRefSlots((prev) =>
      prev.map((s) => (s.key === key ? { ...s, picker_open: !s.picker_open } : s)),
    )
  }
  const toggleImageSelection = (key: string, imageId: string) => {
    setRefSlots((prev) =>
      prev.map((s) => {
        if (s.key !== key) return s
        const isSelected = s.selected_image_ids.includes(imageId)
        if (isSelected) {
          const nextIds = s.selected_image_ids.filter((id) => id !== imageId)
          return {
            ...s,
            selected_image_ids: nextIds,
            image_count_input: nextIds.length > 0 ? String(nextIds.length) : s.image_count_input,
          }
        }
        // Reject if adding would push total above the 14-image budget.
        const slotCurrent = s.selected_image_ids.length > 0
          ? s.selected_image_ids.length
          : (parseSlotImageCount(s.image_count_input) ?? 0)
        const otherTotal = currentTotal - slotCurrent
        if (otherTotal + s.selected_image_ids.length + 1 > MAX_TOTAL_REFERENCE_IMAGES) {
          return s
        }
        const nextIds = [...s.selected_image_ids, imageId]
        return {
          ...s,
          selected_image_ids: nextIds,
          image_count_input: String(nextIds.length),
          manual: true,
        }
      }),
    )
  }
  const clearSlotSelection = (key: string) => {
    setRefSlots((prev) =>
      distributeBudget(
        prev.map((s) =>
          s.key === key
            ? { ...s, selected_image_ids: [], manual: false, image_count_input: '' }
            : s,
        ),
        availableBySetId,
      ),
    )
  }

  const failedCount = currentJob?.failed_count ?? 0
  const hasFailures = failedCount > 0
  const errorMessage = currentJob?.error_message
  const canRetry = !!currentJob && (currentJob.status === 'failed' || ((currentJob.completed_count ?? 0) === 0 && failedCount > 0))
  const displayStatus = currentJob
    ? (canRetry && currentJob.status !== 'failed' ? 'failed' : currentJob.status)
    : null

  const disabledReasons: string[] = []
  if (!prompt.trim()) disabledReasons.push('Enter a prompt')
  if (refSlots.length === 0) disabledReasons.push('Add at least one reference set')
  if (refSlots.length > 0 && subjectSlotCount < 1) disabledReasons.push('Include at least one subject reference set')
  if (refSlots.some((s) => !s.reference_set_id)) disabledReasons.push('Choose a set for every reference slot')
  if (refSlots.length > 0 && slotImageCounts.some((n) => n == null)) {
    disabledReasons.push('Set image count to 1 or more for every reference slot')
  }
  if (totalImageCount > MAX_TOTAL_REFERENCE_IMAGES) {
    disabledReasons.push(`Reduce total image count (currently ${totalImageCount}, max ${MAX_TOTAL_REFERENCE_IMAGES})`)
  }
  if (!variationCountValue) disabledReasons.push('Enter a variation count (1–100)')
  const isGenerateDisabled = aiLoading || generating || disabledReasons.length > 0

  return (
    <div className="space-y-8">
      {/* Reference Sets */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">Reference Sets</h2>
          <div className="flex items-center gap-3 text-xs">
            <span className={totalImageCount > MAX_TOTAL_REFERENCE_IMAGES ? 'text-red-400' : 'text-zinc-500'}>
              Total: {totalImageCount} / {MAX_TOTAL_REFERENCE_IMAGES} max
            </span>
            {refSlots.length > 1 && (
              <button
                type="button"
                onClick={splitEvenly}
                className="text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-200 hover:underline"
              >
                Split evenly
              </button>
            )}
          </div>
        </div>
        {refSlots.length > 0 && (
          <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-zinc-800">
            {refSlots.map((s) => {
              const count = parseSlotImageCount(s.image_count_input) ?? 0
              if (count === 0) return null
              return (
                <div
                  key={s.key}
                  style={{ flex: count }}
                  className={s.role === 'subject' ? 'bg-blue-500/80' : 'bg-purple-500/80'}
                />
              )
            })}
            {totalImageCount < MAX_TOTAL_REFERENCE_IMAGES && (
              <div style={{ flex: MAX_TOTAL_REFERENCE_IMAGES - totalImageCount }} />
            )}
          </div>
        )}

        {productSets.length === 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-yellow-600 bg-yellow-950/40 px-4 py-3 text-yellow-300 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>No product reference sets found. Create one on the References page first.</span>
          </div>
        )}

        {refSlots.length === 0 && productSets.length > 0 && (
          <p className="text-xs text-zinc-500">No reference sets selected yet — add a subject below.</p>
        )}

        <div className="space-y-2">
          {refSlots.map((slot) => {
            const pool = slot.role === 'subject' ? productSets : textureSets
            const setImages = referenceImages[slot.reference_set_id] ?? []
            const available = setImages.length
            const hasSelection = slot.selected_image_ids.length > 0
            const slotCount = hasSelection
              ? slot.selected_image_ids.length
              : (parseSlotImageCount(slot.image_count_input) ?? 0)
            const otherTotal = totalImageCount - slotCount
            const remainingBudget = Math.max(0, MAX_TOTAL_REFERENCE_IMAGES - otherTotal)
            const canIncrement = !hasSelection && slotCount < Math.min(available || MAX_TOTAL_REFERENCE_IMAGES, remainingBudget)
            return (
              <div
                key={slot.key}
                className="rounded-lg border border-zinc-800 bg-zinc-800/30 p-3 space-y-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      slot.role === 'subject'
                        ? 'bg-blue-900/50 text-blue-300'
                        : 'bg-purple-900/50 text-purple-300'
                    }`}
                  >
                    {slot.role}
                  </span>
                  <div className="relative flex-1 min-w-[180px]">
                    <select
                      value={slot.reference_set_id}
                      onChange={(e) => changeSlotReferenceSet(slot.key, e.target.value)}
                      className="w-full appearance-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 pr-9 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                    >
                      {pool.length === 0 && <option value="">No {slot.role} sets available</option>}
                      {pool.map((rs) => (
                        <option key={rs.id} value={rs.id}>
                          {rs.name}{rs.is_active ? ' (Active)' : ''}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                  </div>
                  {hasSelection ? (
                    <div className="inline-flex items-center gap-1 rounded-lg border border-blue-700/60 bg-blue-900/30 px-2.5 py-1.5 text-xs text-blue-200">
                      <Check className="h-3.5 w-3.5" />
                      <span>{slot.selected_image_ids.length} picked</span>
                    </div>
                  ) : (
                    <div className="flex items-stretch overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
                      <button
                        type="button"
                        onClick={() => decrementSlot(slot.key)}
                        aria-label="Decrease image count"
                        className="px-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="0"
                        value={slot.image_count_input}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^0-9]/g, '')
                          updateSlot(slot.key, { image_count_input: v, manual: true })
                        }}
                        onBlur={() => {
                          const parsed = parseSlotImageCount(slot.image_count_input)
                          if (parsed == null && slot.image_count_input.trim()) {
                            updateSlot(slot.key, { image_count_input: '1' })
                            return
                          }
                          // Clamp on blur so typed values can't exceed available count
                          // or the remaining 14-image budget.
                          if (parsed != null) {
                            const ceiling = Math.max(1, Math.min(
                              available || MAX_TOTAL_REFERENCE_IMAGES,
                              remainingBudget + slotCount,
                            ))
                            if (parsed > ceiling) {
                              updateSlot(slot.key, { image_count_input: String(ceiling) })
                            }
                          }
                        }}
                        className="w-10 bg-transparent px-1 py-2 text-center text-sm text-zinc-100 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => incrementSlot(slot.key)}
                        disabled={!canIncrement}
                        aria-label="Increase image count"
                        className="px-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  <button
                    onClick={() => removeSlot(slot.key)}
                    aria-label="Remove reference set"
                    className="rounded-lg border border-zinc-700 bg-zinc-900 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-zinc-400 hover:text-red-400 hover:border-red-900 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {slot.role === 'subject' && (
                  <div className="space-y-1">
                    <input
                      type="text"
                      placeholder="Subject label (optional) — e.g. red truck"
                      maxLength={MAX_SUBJECT_LABEL_LEN}
                      value={slot.subject_label}
                      onChange={(e) => updateSlot(slot.key, { subject_label: e.target.value })}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                )}

                {/* Picker toggle */}
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => togglePicker(slot.key)}
                    className="inline-flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    {slot.picker_open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {hasSelection
                      ? `Picked ${slot.selected_image_ids.length} of ${available || '?'}`
                      : available > 0
                        ? `Pick specific images (${available} available)`
                        : 'Pick specific images'}
                  </button>
                  {hasSelection && (
                    <button
                      type="button"
                      onClick={() => clearSlotSelection(slot.key)}
                      className="text-xs text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-200 hover:underline"
                    >
                      Clear selection
                    </button>
                  )}
                </div>

                {slot.picker_open && (
                  setImages.length === 0 ? (
                    <p className="text-xs text-zinc-500">
                      {slot.reference_set_id in referenceImages
                        ? 'No images in this set yet.'
                        : 'Loading images…'}
                    </p>
                  ) : (
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-7">
                      {setImages.map((img) => {
                        const selectionIdx = slot.selected_image_ids.indexOf(img.id)
                        const selected = selectionIdx >= 0
                        const wouldExceedBudget = !selected && otherTotal + slot.selected_image_ids.length + 1 > MAX_TOTAL_REFERENCE_IMAGES
                        const disabled = wouldExceedBudget
                        return (
                          <button
                            key={img.id}
                            type="button"
                            onClick={() => toggleImageSelection(slot.key, img.id)}
                            disabled={disabled}
                            className={`group relative aspect-square overflow-hidden rounded-md border transition-colors ${
                              selected
                                ? 'border-blue-500 ring-2 ring-blue-500/60'
                                : 'border-zinc-700 hover:border-zinc-500'
                            } ${disabled ? 'opacity-30 cursor-not-allowed' : ''}`}
                          >
                            {img.public_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={img.public_url} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center bg-zinc-900">
                                <ImageIcon className="h-5 w-5 text-zinc-600" />
                              </div>
                            )}
                            {selected && (
                              <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-[10px] font-semibold text-white">
                                {selectionIdx + 1}
                              </div>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => addSlot('subject')}
            disabled={productSets.length === 0}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 min-h-[44px] inline-flex items-center justify-center text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            + Add subject
          </button>
          <button
            onClick={() => addSlot('texture')}
            disabled={textureSets.length === 0}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 min-h-[44px] inline-flex items-center justify-center text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            + Add texture
          </button>
        </div>

        {totalImageCount > MAX_TOTAL_REFERENCE_IMAGES && (
          <div className="flex items-center gap-2 rounded-md border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>Total image count exceeds the maximum of {MAX_TOTAL_REFERENCE_IMAGES}. Reduce the counts.</span>
          </div>
        )}
      </section>

      {/* Prompt Section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Prompt</h2>

        {/* Template dropdown */}
        {promptTemplates.length > 0 && (
          <div className="relative">
            <select
              className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              value={loadedTemplateId ?? ''}
              onChange={(e) => {
                const tmpl = promptTemplates.find((t) => t.id === e.target.value)
                if (tmpl) {
                  setPrompt(tmpl.prompt_text)
                  setLoadedTemplateId(tmpl.id)
                }
              }}
            >
              <option value="" disabled>
                Load from template...
              </option>
              {promptTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          </div>
        )}

        <textarea
          rows={5}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
          placeholder="Describe the product image you want to generate..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
          <button
            onClick={handleRefine}
            disabled={aiLoading || !prompt.trim()}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2.5 text-sm font-medium hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px]"
          >
            {aiLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            AI Refine
          </button>
          <button
            onClick={handleSuggest}
            disabled={aiLoading}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2.5 text-sm font-medium hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px]"
          >
            {aiLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Lightbulb className="h-4 w-4" />
            )}
            AI Suggest
          </button>
          <button
            onClick={openSaveTemplate}
            disabled={!prompt.trim() || savingTemplate}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800 px-4 py-2.5 text-sm font-medium hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px]"
          >
            <Save className="h-4 w-4" />
            {loadedTemplate ? 'Save Template' : 'Save as Template'}
          </button>
        </div>

        {/* Save Template inline form */}
        {showSaveTemplate && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              placeholder="Template name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && templateName.trim()) {
                  handleSaveTemplate({ asNew: !loadedTemplate })
                }
                if (e.key === 'Escape') setShowSaveTemplate(false)
              }}
            />
            <div className="flex gap-2">
              {loadedTemplate ? (
                <>
                  <button
                    onClick={() => handleSaveTemplate({ asNew: false })}
                    disabled={!templateName.trim() || savingTemplate}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors min-h-[44px]"
                  >
                    {savingTemplate ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update'}
                  </button>
                  <button
                    onClick={() => handleSaveTemplate({ asNew: true })}
                    disabled={!templateName.trim() || savingTemplate}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors min-h-[44px]"
                  >
                    Save as New
                  </button>
                </>
              ) : (
                <button
                  onClick={() => handleSaveTemplate({ asNew: true })}
                  disabled={!templateName.trim() || savingTemplate}
                  className="flex-1 sm:flex-none inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors min-h-[44px]"
                >
                  {savingTemplate ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                </button>
              )}
              <button
                onClick={() => setShowSaveTemplate(false)}
                className="flex-1 sm:flex-none rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors min-h-[44px]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => {
                  setPrompt(s.prompt_text)
                  setSuggestions([])
                }}
                className="text-left rounded-lg border border-zinc-800 bg-zinc-800/50 p-4 hover:border-blue-500 hover:bg-zinc-800 transition-colors"
              >
                <p className="text-sm font-medium text-zinc-200">{s.name}</p>
                <p className="mt-1 text-xs text-zinc-400 line-clamp-3">
                  {s.prompt_text}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Prompt Enhancements */}
      <PromptEnhancements values={enhancements} onChange={setEnhancements} />

      {/* Photographic Settings */}
      <section className="space-y-3">
        <button
          onClick={() => setPhotoSettingsExpanded((prev) => !prev)}
          className="flex w-full min-h-[44px] items-center justify-between text-left"
        >
          <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
            <Camera className="h-4 w-4 text-zinc-400" />
            Photographic Settings
          </h2>
          <ChevronDown
            className={`h-4 w-4 text-zinc-500 transition-transform ${
              photoSettingsExpanded ? 'rotate-180' : ''
            }`}
          />
        </button>
        {photoSettingsExpanded && (
          <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-800/30 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400">Lens</label>
                <input
                  type="text"
                  value={photoLens}
                  onChange={(e) => setPhotoLens(e.target.value)}
                  placeholder="e.g., 85mm f/1.4"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400">Camera Height</label>
                <input
                  type="text"
                  value={photoCameraHeight}
                  onChange={(e) => setPhotoCameraHeight(e.target.value)}
                  placeholder="e.g., Eye level"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Lighting</label>
              <input
                type="text"
                value={photoLighting}
                onChange={(e) => setPhotoLighting(e.target.value)}
                placeholder="e.g., Soft key light with rim accent"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Color Grading</label>
              <input
                type="text"
                value={photoColorGrading}
                onChange={(e) => setPhotoColorGrading(e.target.value)}
                placeholder="Color treatment and mood..."
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Style</label>
              <input
                type="text"
                value={photoStyle}
                onChange={(e) => setPhotoStyle(e.target.value)}
                placeholder="Overall visual style..."
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        )}
      </section>

      {/* Reference Image */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-300">Reference Image</h2>
        <div className="flex items-center gap-3">
          {referenceImageId && referenceThumbUrl ? (
            <div className="relative h-16 w-16 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={referenceThumbUrl} alt="Reference" className="h-full w-full object-cover" />
              <button
                onClick={() => { setReferenceImageId(null); setReferenceThumbUrl(null) }}
                className="absolute -top-1 -right-1 rounded-full bg-zinc-900 border border-zinc-700 p-0.5 text-zinc-400 hover:text-zinc-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button
              onClick={() => setShowRefPicker(true)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              {referenceImageId ? 'Change' : 'Attach Reference'}
            </button>
            {referenceImageId && (
              <button
                onClick={() => { setReferenceImageId(null); setReferenceThumbUrl(null) }}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Settings Section */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Settings
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">
              Variations
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={variationCountInput}
              onChange={(e) => setVariationCountInput(e.target.value)}
              onBlur={() => {
                const parsed = parseVariationCount(variationCountInput)
                setVariationCountInput(String(parsed ?? 1))
              }}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">
              Resolution
            </label>
            <div className="relative">
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              >
                <option value="2K">2K</option>
                <option value="4K">4K</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">
              Aspect Ratio
            </label>
            <div className="relative">
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                className="w-full appearance-none rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 pr-10 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
              >
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
                <option value="9:16">9:16</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            </div>
          </div>
        </div>
      </section>

      {/* Generate Button */}
      <div className="space-y-2">
        <button
          onClick={handleGenerate}
          disabled={isGenerateDisabled}
          title={
            disabledReasons.length > 0
              ? `To generate:\n• ${disabledReasons.join('\n• ')}`
              : undefined
          }
          className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {generating ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Play className="h-5 w-5" />
          )}
          {generating ? 'Generating...' : 'Generate Images'}
        </button>
        {!generating && !aiLoading && disabledReasons.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-yellow-500 mt-0.5" />
            <div>
              <span className="font-medium text-zinc-300">To generate, you need to:</span>
              <ul className="mt-1 space-y-0.5">
                {disabledReasons.map((reason) => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Active Job Monitor */}
      {currentJob && activeJobId && (displayStatus === 'running' || displayStatus === 'pending' || displayStatus === 'completed' || displayStatus === 'failed') && (
        <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-800/30 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Job Progress</h2>
            <div className="flex items-center gap-2">
              {canRetry && (
                <button
                  onClick={handleRetry}
                  disabled={retrying || generating}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {retrying ? 'Retrying...' : 'Retry'}
                </button>
              )}
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  displayStatus === 'completed'
                    ? 'bg-green-900/50 text-green-400'
                    : displayStatus === 'failed'
                      ? 'bg-red-900/50 text-red-400'
                      : 'bg-blue-900/50 text-blue-400'
                }`}
              >
                {displayStatus}
              </span>
            </div>
          </div>

          {errorMessage && (
            <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
              <span className="font-medium">Error:</span> {errorMessage}
            </div>
          )}

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>
                {displayStatus === 'pending' ? (
                  'Starting generation...'
                ) : displayStatus === 'completed' ? (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images
                    {hasFailures ? ` · ${failedCount} failed` : ''} — Complete
                  </>
                ) : displayStatus === 'failed' ? (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images · {failedCount} failed
                  </>
                ) : completedOrImages === 0 ? (
                  'Generating images...'
                ) : (
                  <>
                    {completedOrImages} / {currentJob.variation_count} images
                    {hasFailures ? ` · ${failedCount} failed` : ''}
                  </>
                )}
              </span>
              {(displayStatus !== 'pending' && !(displayStatus === 'running' && completedOrImages === 0)) && (
                <span>{progress}%</span>
              )}
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-700 overflow-hidden">
              {displayStatus === 'completed' ? (
                <div className="h-full w-full rounded-full bg-green-500 transition-all duration-500" />
              ) : displayStatus === 'failed' ? (
                <div
                  className="h-full rounded-full bg-red-500 transition-all duration-500"
                  style={{ width: `${Math.max(progress, 5)}%` }}
                />
              ) : (displayStatus === 'pending' || (displayStatus === 'running' && completedOrImages === 0)) ? (
                <div className="h-full w-1/3 rounded-full bg-blue-500 animate-pulse-bar" />
              ) : (
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              )}
            </div>
          </div>

          {/* Generated image thumbnails */}
          {currentJob.images && currentJob.images.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {currentJob.images.map((img, index) => (
                <button
                  key={img.id}
                  onClick={() => setLightboxIndex(index)}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 hover:border-zinc-500 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500"
                >
                  {(img.thumb_public_url || img.public_url) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={img.thumb_public_url || img.public_url || ''}
                      alt=""
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ImageIcon className="h-6 w-6 text-zinc-600" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && lightboxImages.length > 0 && (
        <ImageLightbox
          images={lightboxImages}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={(index) => setLightboxIndex(index)}
          onApprovalChange={handleApprovalChange}
          onRequestSignedUrls={ensureSignedUrls}
        />
      )}

      {/* Reference Image Picker Modal */}
      <ReferenceImagePicker
        isOpen={showRefPicker}
        onClose={() => setShowRefPicker(false)}
        onSelect={(imageId, thumbUrl) => {
          setReferenceImageId(imageId)
          setReferenceThumbUrl(thumbUrl)
          setShowRefPicker(false)
        }}
        productId={productId}
      />
    </div>
  )
}
