-- Settings templates: named presets for global_style_settings
create table if not exists prodai_settings_templates (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references prodai_products(id) on delete cascade,
  name text not null,
  settings jsonb not null default '{}',
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_settings_templates_product on prodai_settings_templates(product_id);

-- RLS
alter table prodai_settings_templates enable row level security;

create policy "Service role full access on settings_templates"
  on prodai_settings_templates
  for all
  using (true)
  with check (true);
