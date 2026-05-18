'use client'

import { useEffect, useId, useRef, useState } from 'react'
import {
  AlertCircle,
  Bug,
  CheckCircle2,
  Lightbulb,
  Loader2,
  MessageSquarePlus,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useModalShortcuts } from '@/hooks/useModalShortcuts'
import {
  buildSelectedBugReportImages,
  clampBugReportText,
  createBugReportFormData,
  MAX_BUG_REPORT_IMAGES,
  MAX_BUG_REPORT_CAPTION_LENGTH,
  MAX_BUG_REPORT_DESCRIPTION_LENGTH,
  MAX_BUG_REPORT_TITLE_LENGTH,
  normalizeBugReportMultiline,
  normalizeBugReportSingleLine,
  parseBugReportResponse,
  releaseBugReportImagePreviews,
  stripBugReportControlChars,
  type SelectedBugReportImage,
  validateBugReportFiles,
} from './bugReportWidget.helpers'
import { getSafeErrorMessage } from './errorDisplay.helpers'

export function BugReportWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [type, setType] = useState<'bug' | 'feature'>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [images, setImages] = useState<SelectedBugReportImage[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const imagesRef = useRef<SelectedBugReportImage[]>([])
  const dialogTitleId = useId()
  const dialogDescriptionId = useId()

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const handleClose = () => {
    if (isSubmitting) return
    setIsOpen(false)
  }

  useModalShortcuts({
    isOpen,
    onClose: handleClose,
    onSubmit: isSubmitting ? null : () => formRef.current?.requestSubmit(),
  })

  useEffect(() => {
    imagesRef.current = images
  }, [images])

  useEffect(() => {
    return () => releaseBugReportImagePreviews(imagesRef.current)
  }, [])

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    const { acceptedFiles, errors } = validateBugReportFiles({
      currentCount: images.length,
      files: Array.from(files),
    })
    const newImages = buildSelectedBugReportImages(acceptedFiles)

    if (errors.length > 0) setToast({ message: errors.join('. '), type: 'error' })
    if (newImages.length > 0) setImages((prev) => [...prev, ...newImages])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeImage = (index: number) => {
    setImages((prev) => {
      const updated = [...prev]
      releaseBugReportImagePreviews([updated[index]])
      updated.splice(index, 1)
      return updated
    })
  }

  const updateImageCaption = (index: number, caption: string) => {
    setImages((prev) => {
      const updated = [...prev]
      updated[index] = {
        ...updated[index],
        caption: clampBugReportText(stripBugReportControlChars(caption), MAX_BUG_REPORT_CAPTION_LENGTH),
      }
      return updated
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !description.trim()) {
      setToast({ message: 'Please provide a title and description', type: 'error' })
      return
    }

    setIsSubmitting(true)
    try {
      const normalizedTitle = normalizeBugReportSingleLine(title, MAX_BUG_REPORT_TITLE_LENGTH)
      const normalizedDescription = normalizeBugReportMultiline(description, MAX_BUG_REPORT_DESCRIPTION_LENGTH)
      const formData = createBugReportFormData({
        type,
        title: normalizedTitle,
        description: normalizedDescription,
        images,
      })

      const response = await fetch('/api/bug-report', {
        method: 'POST',
        body: formData,
      })

      const raw = await response.text()
      const data = parseBugReportResponse(raw)

      if (response.ok && (data?.success ?? true)) {
        setToast({ message: data?.message || `${type === 'bug' ? 'Bug' : 'Feature'} report submitted`, type: 'success' })
        setTitle('')
        setDescription('')
        setType('bug')
        releaseBugReportImagePreviews(images)
        setImages([])
        setIsOpen(false)
      } else {
        throw new Error(getSafeErrorMessage(data?.message, `Failed to submit ${type} report. Please try again.`))
      }
    } catch (error) {
      setToast({
        message: getSafeErrorMessage(
          error instanceof Error ? error.message : null,
          'Failed to submit. Please try again.'
        ),
        type: 'error',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-40 inline-flex min-h-12 min-w-12 items-center justify-center rounded-full bg-blue-600 p-3 text-white shadow-lg transition-all hover:scale-105 hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        title="Report Bug / Request Feature"
        aria-label="Report a bug or request a feature"
      >
        <MessageSquarePlus className="h-5 w-5" />
      </button>

      {/* Toast notification */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-20 right-6 z-[110] flex max-w-sm items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl ${
            toast.type === 'success'
              ? 'border-emerald-900/40 bg-emerald-950/95 text-emerald-100'
              : 'border-red-900/40 bg-red-950/95 text-red-100'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          )}
          {toast.message}
        </div>
      )}

      {/* Modal */}
      {isOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
          aria-describedby={dialogDescriptionId}
        >
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

          <div
            className="relative z-10 mx-4 flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/10 text-blue-400">
                  <MessageSquarePlus className="h-5 w-5" />
                </div>
                <div>
                  <h2 id={dialogTitleId} className="text-lg font-semibold text-zinc-100">Submit Feedback</h2>
                  <p id={dialogDescriptionId} className="text-sm text-zinc-500">
                    Report a bug or request a feature with optional screenshots.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClose}
                disabled={isSubmitting}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Close feedback form"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form ref={formRef} onSubmit={handleSubmit} className="space-y-5 p-5">
              {/* Type Selection */}
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-400">Type</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setType('bug')}
                    aria-pressed={type === 'bug'}
                    className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                      type === 'bug'
                        ? 'border-red-800 bg-red-950/30 text-red-300'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100'
                    }`}
                  >
                    <Bug className="h-4 w-4" />
                    Bug Report
                  </button>
                  <button
                    type="button"
                    onClick={() => setType('feature')}
                    aria-pressed={type === 'feature'}
                    className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                      type === 'feature'
                        ? 'border-blue-800 bg-blue-950/30 text-blue-300'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100'
                    }`}
                  >
                    <Lightbulb className="h-4 w-4" />
                    Feature Request
                  </button>
                </div>
              </div>

              {/* Title */}
              <div>
                <label htmlFor="bug-title" className="mb-2 block text-sm font-medium text-zinc-400">Title</label>
                <input
                  id="bug-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(clampBugReportText(stripBugReportControlChars(e.target.value), MAX_BUG_REPORT_TITLE_LENGTH))}
                  placeholder={type === 'bug' ? 'Brief description of the issue' : 'Brief description of the feature'}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                  maxLength={MAX_BUG_REPORT_TITLE_LENGTH}
                  required
                />
              </div>

              {/* Description */}
              <div>
                <label htmlFor="bug-desc" className="mb-2 block text-sm font-medium text-zinc-400">Description</label>
                <textarea
                  id="bug-desc"
                  value={description}
                  onChange={(e) => setDescription(clampBugReportText(stripBugReportControlChars(e.target.value), MAX_BUG_REPORT_DESCRIPTION_LENGTH))}
                  placeholder={type === 'bug'
                    ? 'What happened? What did you expect? Steps to reproduce?'
                    : 'What feature would you like? Why would it be helpful?'
                  }
                  rows={4}
                  className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                  maxLength={MAX_BUG_REPORT_DESCRIPTION_LENGTH}
                  required
                />
              </div>

              {/* Image Upload */}
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-400">Screenshots (optional)</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  multiple
                  onChange={handleImageSelect}
                  className="hidden"
                />

                {images.length > 0 && (
                  <div className="mb-3 space-y-2">
                    {images.map((img, index) => (
                      <div key={index} className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                        <img src={img.preview} alt="" className="h-16 w-16 rounded border border-zinc-700 object-cover" />
                        <div className="flex-1 min-w-0">
                          <p className="mb-1 truncate text-xs text-zinc-500">{img.file.name}</p>
                          <input
                            type="text"
                            value={img.caption}
                            onChange={(e) => updateImageCaption(index, e.target.value)}
                            placeholder="Add a caption (optional)"
                            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                            maxLength={MAX_BUG_REPORT_CAPTION_LENGTH}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeImage(index)}
                          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
                          aria-label={`Remove screenshot ${index + 1}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {images.length < MAX_BUG_REPORT_IMAGES && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex w-full min-h-11 items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-700 px-4 py-3 text-sm text-zinc-400 transition-colors hover:border-blue-500 hover:text-blue-400"
                  >
                    <Upload className="h-4 w-4" />
                    Add screenshot{images.length > 0 ? ` (${images.length}/${MAX_BUG_REPORT_IMAGES})` : ''}
                  </button>
                )}
                <p className="mt-1 text-xs text-zinc-500">Max {MAX_BUG_REPORT_IMAGES} images, 5MB each.</p>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={isSubmitting}
                  className="flex min-h-11 flex-1 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isSubmitting ? 'Submitting...' : `Submit ${type === 'bug' ? 'Bug' : 'Feature'}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
