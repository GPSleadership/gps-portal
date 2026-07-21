-- Migration v107: legal_texts single source of truth + per-participant consent stamps
-- Build P0-6: Hardwire AI disclosure + consent (survey start, payment point, deliverables)
--
-- Principle: legal copy is stored ONCE, rendered EVERYWHERE, recorded PER participant.
-- Publishing a new version INSERTS a new row and flips is_active. It NEVER mutates an
-- existing row, so a recorded consent always points at the exact text that was shown.
--
-- Seeded text below is DRAFT (plain-English, pending attorney review). Alex swaps the
-- attorney-approved wording later via the owner-only admin editor -- no code deploy.

-- ── 1. Single source of truth ────────────────────────────────────────────────
create table if not exists public.legal_texts (
  id             uuid primary key default gen_random_uuid(),
  key            text        not null,
  body           text        not null,
  version        text        not null,
  effective_from timestamptz not null default now(),
  is_active      boolean     not null default true,
  updated_by     text,
  created_at     timestamptz not null default now()
);

-- At most ONE active row per key. Publishing = insert new + deactivate old.
create unique index if not exists legal_texts_one_active_per_key
  on public.legal_texts (key) where is_active;

create index if not exists legal_texts_key_idx on public.legal_texts (key);

-- Lock it down: browser never reads this with an anon key. All access is through
-- token/owner-validated server endpoints using the service key (which bypasses RLS).
alter table public.legal_texts enable row level security;

-- ── 2. Per-participant consent stamps ────────────────────────────────────────
-- Consent is stamped on the row a human enters through (the participant/token row),
-- not on each per-question response row. Historical stamps are never mutated when the
-- active text changes -- consent_text_id pins the exact version agreed to.
alter table public.diagnostic_raters
  add column if not exists consent_ai_disclosure_at timestamptz,
  add column if not exists consent_version          text,
  add column if not exists consent_text_id          uuid references public.legal_texts(id);

alter table public.survey_tokens
  add column if not exists consent_ai_disclosure_at timestamptz,
  add column if not exists consent_version          text,
  add column if not exists consent_text_id          uuid references public.legal_texts(id);

alter table public.workshop_participants
  add column if not exists consent_ai_disclosure_at timestamptz,
  add column if not exists consent_version          text,
  add column if not exists consent_text_id          uuid references public.legal_texts(id);

alter table public.external_feedback_invites
  add column if not exists consent_ai_disclosure_at timestamptz,
  add column if not exists consent_version          text,
  add column if not exists consent_text_id          uuid references public.legal_texts(id);

-- ── 3. Seed DRAFT text (pending attorney review) ─────────────────────────────
-- Insert only if that key has no active row yet, so re-running never duplicates.
insert into public.legal_texts (key, body, version, updated_by)
select v.key, v.body, '2026-07-v1-draft', 'seed'
from (values
  ('survey_consent',
   E'How your responses are used\n\nYour feedback is confidential. It is combined with other people''s and reported only in aggregate — never attributed to you by name, and only when at least three people in your group respond. Your individual answers are not shown to the person you are rating or to their sponsor.\n\nTo produce reports, your responses are processed by GPS Leadership and by trusted third-party service providers, including AI-assisted tools. They are used only to generate leadership feedback for this engagement, are not sold, and are kept only as long as needed for that purpose.\n\nQuestions: privacy@gpsleadership.org\n\n[DRAFT — pending attorney review]'),
  ('system_entry_ack',
   E'Welcome to the GPS Executive Impact System.\n\nBy continuing, you acknowledge that this system collects and processes information you and others provide to support your leadership development, including through trusted third-party and AI-assisted tools. Some features (such as Ask Alex) generate AI-assisted content. This system does not provide legal, medical, or employment advice, and GPS is not responsible for decisions you make based on its output.\n\nSee our Client Terms and Privacy Policy for details.\n\n[DRAFT — pending attorney review]'),
  ('ai_output_label',
   E'Ask Alex is AI-assisted and is not legal, medical, or employment advice. Verify important decisions independently.'),
  ('invite_line',
   E'Your responses are confidential and reported only in aggregate — never attributed, with a minimum of three responses per group. Processing includes trusted third-party and AI-assisted tools. Full details when you begin.'),
  ('checkout_notice',
   E'By completing this purchase you agree to the GPS Client Terms and Privacy Policy, including the use of trusted third-party and AI-assisted tools to deliver these services. These services are advisory and do not constitute legal, financial, medical, or employment advice.\n\n[DRAFT — pending attorney review]'),
  ('report_footer',
   E'This report was produced with AI-assisted analysis of assessment inputs. It is a leadership-development tool — not a legal, medical, or employment determination — and should be interpreted alongside professional judgment.\n\n[DRAFT — pending attorney review]'),
  ('privacy_section',
   E'AI and third-party processing: GPS uses trusted third-party service providers, including AI-assisted tools, to process assessment inputs and generate reports. Data is used only to deliver the engagement, is not sold, and is retained only as long as needed. Aggregated feedback is reported at a minimum group size of three and is never attributed to an individual.\n\n[DRAFT — pending attorney review]')
) as v(key, body)
where not exists (
  select 1 from public.legal_texts lt where lt.key = v.key and lt.is_active
);
