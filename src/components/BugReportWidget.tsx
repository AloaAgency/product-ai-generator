'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

interface SelectedImage {
  file: File
  preview: string
  caption: string
}

const MAX_IMAGES = 5
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export function BugReportWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [type, setType] = useState<'bug' | 'feature'>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [images, setImages] = useState<SelectedImage[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && !isSubmitting) setIsOpen(false)
  }, [isSubmitting])

  useEffect(() => {
    if (!isOpen) return
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleKeyDown])

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    const newImages: SelectedImage[] = []
    const errors: string[] = []

    Array.from(files).forEach(file => {
      if (images.length + newImages.length >= MAX_IMAGES) {
        errors.push(`Maximum ${MAX_IMAGES} images allowed`)
        return
      }
      if (!ALLOWED_TYPES.includes(file.type)) {
        errors.push(`${file.name}: Invalid file type`)
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}: File too large (max 5MB)`)
        return
      }
      newImages.push({ file, preview: URL.createObjectURL(file), caption: '' })
    })

    if (errors.length > 0) setToast({ message: errors.join('. '), type: 'error' })
    if (newImages.length > 0) setImages(prev => [...prev, ...newImages])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeImage = (index: number) => {
    setImages(prev => {
      const updated = [...prev]
      URL.revokeObjectURL(updated[index].preview)
      updated.splice(index, 1)
      return updated
    })
  }

  const updateImageCaption = (index: number, caption: string) => {
    setImages(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], caption }
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
      const formData = new FormData()
      formData.append('type', type)
      formData.append('title', title.trim())
      formData.append('description', description.trim())

      images.forEach((img, index) => {
        formData.append(`image_${index}`, img.file)
        formData.append(`caption_${index}`, img.caption || `Screenshot ${index + 1}`)
      })
      formData.append('imageCount', images.length.toString())

      const response = await fetch('/api/bug-report', {
        method: 'POST',
        body: formData,
      })

      const raw = await response.text()
      let data: any = null
      try { data = JSON.parse(raw) } catch {}

      if (response.ok && (data?.success ?? true)) {
        setToast({ message: data?.message || `${type === 'bug' ? 'Bug' : 'Feature'} report submitted`, type: 'success' })
        setTitle('')
        setDescription('')
        setType('bug')
        images.forEach(img => URL.revokeObjectURL(img.preview))
        setImages([])
        setIsOpen(false)
      } else {
        throw new Error(data?.message || `Failed to submit ${type} report`)
      }
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Failed to submit. Please try again.', type: 'error' })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-40 p-3 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg hover:scale-110 transition-all"
        title="Report Bug / Request Feature"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
      </button>

      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-20 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-white ${
          toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Modal */}
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !isSubmitting && setIsOpen(false)} />

          <div className="relative z-10 w-full max-w-lg mx-4 bg-white dark:bg-gray-800 rounded-lg shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Submit Feedback</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-500 dark:text-gray-400"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5">
              {/* Type Selection */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Type</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setType('bug')}
                    className={`flex-1 px-4 py-2 rounded-lg border-2 font-medium transition-all ${
                      type === 'bug'
                        ? 'border-red-500 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                        : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    Bug Report
                  </button>
                  <button
                    type="button"
                    onClick={() => setType('feature')}
                    className={`flex-1 px-4 py-2 rounded-lg border-2 font-medium transition-all ${
                      type === 'feature'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                        : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    Feature Request
                  </button>
                </div>
              </div>

              {/* Title */}
              <div className="mb-4">
                <label htmlFor="bug-title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Title</label>
                <input
                  id="bug-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={type === 'bug' ? 'Brief description of the issue' : 'Brief description of the feature'}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              {/* Description */}
              <div className="mb-4">
                <label htmlFor="bug-desc" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Description</label>
                <textarea
                  id="bug-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={type === 'bug'
                    ? 'What happened? What did you expect? Steps to reproduce?'
                    : 'What feature would you like? Why would it be helpful?'
                  }
                  rows={4}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  required
                />
              </div>

              {/* Image Upload */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Screenshots (optional)</label>
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
                      <div key={index} className="flex items-start gap-3 p-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700/50">
                        <img src={img.preview} alt="" className="w-16 h-16 object-cover rounded border border-gray-300 dark:border-gray-600" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate mb-1">{img.file.name}</p>
                          <input
                            type="text"
                            value={img.caption}
                            onChange={(e) => updateImageCaption(index, e.target.value)}
                            placeholder="Add a caption (optional)"
                            className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                          />
                        </div>
                        <button type="button" onClick={() => removeImage(index)} className="p-1 text-gray-400 hover:text-red-500 transition-colors">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {images.length < MAX_IMAGES && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 transition-colors text-sm"
                  >
                    Add screenshot{images.length > 0 ? ` (${images.length}/${MAX_IMAGES})` : ''}
                  </button>
                )}
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Max {MAX_IMAGES} images, 5MB each.</p>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={isSubmitting}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors disabled:opacity-50"
                >
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
