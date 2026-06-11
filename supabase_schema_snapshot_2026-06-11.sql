-- GPS Leadership Portal — Supabase schema snapshot
-- Generated 2026-06-11 from project pbnkefuqpoztcxfagiod (public schema).
-- Column inventory for every table. Use alongside the dated migration files
-- (supabase-migration-v44..v51) for the full DDL history.
-- Format:  table.column  type  [NOT NULL]
--
-- NOTE: confirms this session's additive columns:
--   clients.website, organizations.website,
--   teams.poc_name / teams.poc_email / teams.poc_phone

  admin_accounts.id bigint NOT NULL
  admin_accounts.created_at timestamp with time zone
  admin_accounts.name text NOT NULL
  admin_accounts.email text
  admin_accounts.password text NOT NULL
  admin_accounts.role text NOT NULL
  admin_accounts.is_active boolean NOT NULL
  admin_accounts.notes text
  clients.id uuid NOT NULL
  clients.organization text
  clients.industry text
  clients.revenue_band text
  clients.title text
  clients.phone text
  clients.website text
  clients.in_coaching_program boolean
  clients.is_workshop_participant boolean NOT NULL
  clients.is_sponsor boolean NOT NULL
  diagnostics.id uuid NOT NULL
  diagnostics.client_id uuid
  diagnostics.tier text NOT NULL
  diagnostics.status text NOT NULL
  diagnostics.interviews_enabled boolean NOT NULL
  diagnostics.interview_calendar_link text
  diagnostics.report_pdf_url text
  diagnostics.is_archived boolean NOT NULL
  diagnostics.poc_name text
  diagnostics.poc_email text
  diagnostics.poc_token text
  organizations.id uuid NOT NULL
  organizations.name text NOT NULL
  organizations.industry text
  organizations.size_band text
  organizations.tags ARRAY NOT NULL
  organizations.logo_url text
  organizations.notes text
  organizations.website text
  organizations.created_at timestamp with time zone NOT NULL
  organizations.updated_at timestamp with time zone NOT NULL
  teams.id uuid NOT NULL
  teams.name text NOT NULL
  teams.client_org_name text
  teams.team_type text NOT NULL
  teams.active boolean NOT NULL
  teams.archived_at timestamp with time zone
  teams.poc_name text
  teams.poc_email text
  teams.poc_phone text
  sponsor_teams.id uuid NOT NULL
  sponsor_teams.sponsor_id uuid NOT NULL
  sponsor_teams.team_id uuid NOT NULL
  sponsor_teams.confidentiality_mode text NOT NULL
  sponsor_teams.supervises_client_ids jsonb NOT NULL
  team_members.id uuid NOT NULL
  team_members.team_id uuid NOT NULL
  team_members.client_id uuid NOT NULL
  team_members.role text
  team_members.is_coaching_client boolean NOT NULL
  workshops.id uuid NOT NULL
  workshops.client_org_name text
  workshops.engagement_kind text NOT NULL
  workshops.organization_id uuid
  workshop_participants.id uuid NOT NULL
  workshop_participants.workshop_id uuid NOT NULL
  workshop_participants.client_id uuid NOT NULL
  workshop_participants.last_reminder_at timestamp with time zone
--
-- (Full per-column inventory for all 40+ tables was captured in the generation
--  query; the above lists the tables touched or relevant this session. For the
--  complete column list across every table, re-run the information_schema.columns
--  query in the survival-package skill against project pbnkefuqpoztcxfagiod.)
