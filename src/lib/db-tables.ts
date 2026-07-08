/** Centralized table name constants — all tables use the prodai_ prefix */
export const T = {
  projects: 'prodai_projects',
  products: 'prodai_products',
  reference_sets: 'prodai_reference_sets',
  reference_images: 'prodai_reference_images',
  prompt_templates: 'prodai_prompt_templates',
  generation_jobs: 'prodai_generation_jobs',
  generation_job_reference_sets: 'prodai_generation_job_reference_sets',
  generated_images: 'prodai_generated_images',
  storyboards: 'prodai_storyboards',
  settings_templates: 'prodai_settings_templates',
  storyboard_scenes: 'prodai_storyboard_scenes',
} as const
