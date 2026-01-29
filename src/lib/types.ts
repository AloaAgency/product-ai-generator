export interface Product {
  id: string
  user_id: string
  name: string
  description: string | null
  global_style_settings: GlobalStyleSettings
  created_at: string
  updated_at: string
}

export interface GlobalStyleSettings {
  subject_rule?: string
  lens?: string
  camera_height?: string
  color_grading?: string
  lighting?: string
  style?: string
  constraints?: string
  reference_rule?: string
  default_resolution?: '2K' | '4K'
  default_aspect_ratio?: '16:9' | '1:1' | '9:16'
  default_fidelity?: string
  custom_suffix?: string
}

export interface ReferenceSet {
  id: string
  product_id: string
  name: string
  description: string | null
  is_active: boolean
  display_order: number
  created_at: string
}

export interface ReferenceImage {
  id: string
  reference_set_id: string
  storage_path: string
  public_url: string | null
  file_name: string
  mime_type: string
  file_size: number | null
  display_order: number
  created_at: string
}

export interface PromptTemplate {
  id: string
  product_id: string
  name: string
  prompt_text: string
  scene_title: string | null
  prompt_type: 'image' | 'video'
  tags: string[]
  created_at: string
  updated_at: string
}

export interface GenerationJob {
  id: string
  product_id: string
  prompt_template_id: string | null
  reference_set_id: string
  final_prompt: string
  variation_count: number
  resolution: string
  aspect_ratio: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  completed_count: number
  failed_count: number
  error_message: string | null
  generation_model: string
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface GeneratedImage {
  id: string
  job_id: string | null
  variation_number: number
  storage_path: string
  public_url: string | null
  thumb_storage_path: string | null
  thumb_public_url: string | null
  preview_storage_path: string | null
  preview_public_url: string | null
  mime_type: string
  file_size: number | null
  approval_status: 'approved' | 'rejected' | 'pending' | null
  notes: string | null
  media_type: 'image' | 'video'
  scene_id: string | null
  scene_name: string | null
  created_at: string
}

export interface Storyboard {
  id: string
  product_id: string
  name: string
  image_ids: string[]
  scenes?: StoryboardScene[]
  created_at: string
  updated_at: string
}

export interface StoryboardScene {
  id: string
  product_id: string
  storyboard_id: string | null
  scene_order: number | null
  title: string | null
  prompt_text: string | null
  end_frame_prompt: string | null
  motion_prompt: string | null
  generation_model: string
  paired: boolean
  start_frame_image_id: string | null
  end_frame_image_id: string | null
  created_at: string
  updated_at: string
}
