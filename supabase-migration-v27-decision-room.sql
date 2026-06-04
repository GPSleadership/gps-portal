-- ============================================================================
-- GPS Leadership Portal — Migration v27: DECISION ROOM
-- ============================================================================
--
--  Adds the Decision Room object model on top of the existing schema.
--  Post-cutover security posture (v26): every table has RLS ENABLED with NO
--  anon policies. The anon role is denied by default; ONLY the service_role key
--  (used by the api/*.js serverless endpoints) reaches these tables. These new
--  tables follow the same posture: RLS enabled, zero policies = deny-all.
--
--  Reuse, don't duplicate:
--    • A "Member" is an existing `clients` row. team_members joins clients→teams.
--    • A member's diagnostic / TP3 / self-vs-raters live in the existing
--      diagnostics / diagnostic_raters / diagnostic_responses tables
--      (linked by diagnostics.client_id = clients.id).
--    • The 90-day stakeholder scoreboard + check-ins live in the existing
--      stakeholders / survey_tokens / survey_responses / checkins tables
--      (linked by client_id). The Decision Room AGGREGATES these in the
--      sponsor-data endpoint; it does not copy them.
--
--  New tables here hold only what is genuinely new: teams + coach-authored
--  narrative, the team↔member join, sponsors + their per-engagement access,
--  recommendations, and external signals.
--
--  Idempotent (IF NOT EXISTS). A ROLLBACK block is at the bottom.
-- ============================================================================

BEGIN;

-- ── teams ───────────────────────────────────────────────────────────────────
-- One leadership team. Carries the coach-authored, sponsor-read-only narrative
-- (AI-drafted in production, coach-editable). Snapshot TP3 is point-in-time and
-- frozen at survey close; it is stored here as the coach/report pipeline writes
-- it, never recomputed live by the sponsor endpoint.
CREATE TABLE IF NOT EXISTS teams (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  client_org_name    TEXT,
  team_type          TEXT NOT NULL DEFAULT 'Custom'
                     CHECK (team_type IN ('Exec','Director/Manager','Custom')),
  primary_sponsor_id UUID,                 -- → sponsors.id (set after sponsor exists)
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  -- coach-authored narrative (sponsor read-only)
  quick_read         TEXT,
  summary            TEXT,
  last_updated       DATE,
  themes             JSONB,                -- { strengths:[], riskPatterns:[] }
  start_stop_continue JSONB,              -- { start:[], stop:[], continue:[] }
  intent_impact      JSONB,                -- [ { intent, impact }, ... ]
  snapshot           JSONB,                -- { surveyClosed, asOf, tp3:{...}, completion:{...} }
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── team_members ─────────────────────────────────────────────────────────────
-- Joins an existing clients row (the Member base record) to a team.
-- Member = clients row; Diagnostic + Coaching = stackable engagements already
-- modeled by an optional diagnostics row + coaching fields on clients.
CREATE TABLE IF NOT EXISTS team_members (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id            UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  client_id          UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role               TEXT,                 -- e.g. "COO", "General Manager"
  is_coaching_client BOOLEAN NOT NULL DEFAULT FALSE,
  coach_summary      TEXT,                 -- one-line "Net:" summary, sponsor read-only
  -- Coach-AUTHORED per-member Decision Room content that has no home in the
  -- existing tables: 90-day focus (goal/behaviors/metrics), succession
  -- (readiness, successorIdentified, bench[]), readiness_level for the talent
  -- grid. This is NOT duplicated diagnostic data — the TP3 self-vs-raters,
  -- stakeholder scoreboard, and engagement numbers are aggregated live in the
  -- endpoint from diagnostics / survey_responses / checkins and never stored.
  report_json        JSONB,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, client_id)
);

-- ── sponsors ─────────────────────────────────────────────────────────────────
-- A first-class viewing account. NOT a coaching client: no goals, plan,
-- check-ins, or Ask Alex. Authenticated by a token in the URL, exactly like the
-- diagnostic leader page.
CREATE TABLE IF NOT EXISTS sponsors (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  email                TEXT,
  sponsor_token        TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  confidentiality_default TEXT NOT NULL DEFAULT 'standard'
                       CHECK (confidentiality_default IN ('standard','private')),
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  token_last_used_at   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── sponsor_teams ────────────────────────────────────────────────────────────
-- A sponsor can sponsor one or more teams. Confidentiality is PER ENGAGEMENT.
-- supervises_client_ids: the members (clients.id) this sponsor is the supervisor
-- of — this is what drives the hard feedback gate and the supervisor-stakeholder
-- link. show_succession_to_sponsor lets the strictest confidential deals hide
-- per-leader readiness without a code change.
CREATE TABLE IF NOT EXISTS sponsor_teams (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id           UUID NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  team_id              UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  confidentiality_mode TEXT NOT NULL DEFAULT 'standard'
                       CHECK (confidentiality_mode IN ('standard','private')),
  supervises_client_ids JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array of clients.id
  show_succession_to_sponsor BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sponsor_id, team_id)
);

-- ── recommendations ──────────────────────────────────────────────────────────
-- Coach-authored "next moves." Only Approved + visible_to_client rows ever
-- reach a sponsor (the sponsor endpoint filters server-side).
CREATE TABLE IF NOT EXISTS recommendations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id            UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  short_title        TEXT NOT NULL,
  description        TEXT,
  rationale          TEXT,
  category           TEXT NOT NULL DEFAULT 'optional_accelerator'
                     CHECK (category IN ('included_in_current_scope','optional_accelerator')),
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','needs_edit','approved','archived')),
  visible_to_client  BOOLEAN NOT NULL DEFAULT FALSE,
  owner              TEXT,
  timeframe          TEXT,
  created_from_doc_ids JSONB,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── external_signals ─────────────────────────────────────────────────────────
-- Field observations. Only visible_to_client rows reach a sponsor.
CREATE TABLE IF NOT EXISTS external_signals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id            UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  by_name            TEXT,
  by_role            TEXT,
  channel            TEXT,                 -- Coach | CEO | External_Consultant
  level              TEXT NOT NULL DEFAULT 'yellow'
                     CHECK (level IN ('green','yellow','red')),
  date_observed      DATE,
  summary            TEXT,
  tags               JSONB,
  visible_to_client  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── indexes for the endpoint's lookups ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sponsors_token         ON sponsors (sponsor_token);
CREATE INDEX IF NOT EXISTS idx_sponsor_teams_sponsor  ON sponsor_teams (sponsor_id);
CREATE INDEX IF NOT EXISTS idx_sponsor_teams_team     ON sponsor_teams (team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team      ON team_members (team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_client    ON team_members (client_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_team   ON recommendations (team_id);
CREATE INDEX IF NOT EXISTS idx_external_signals_team  ON external_signals (team_id);

-- ── RLS: enable, no policies = deny-all to anon (service role bypasses) ──────
ALTER TABLE teams            ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsors         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsor_teams    ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_signals ENABLE ROW LEVEL SECURITY;

-- Belt-and-suspenders: make sure the public roles hold no table grants either.
REVOKE ALL ON teams, team_members, sponsors, sponsor_teams, recommendations, external_signals FROM anon, authenticated;

COMMIT;

-- ============================================================================
-- ROLLBACK (run manually if needed):
-- BEGIN;
--   DROP TABLE IF EXISTS external_signals;
--   DROP TABLE IF EXISTS recommendations;
--   DROP TABLE IF EXISTS sponsor_teams;
--   DROP TABLE IF EXISTS sponsors;
--   DROP TABLE IF EXISTS team_members;
--   DROP TABLE IF EXISTS teams;
-- COMMIT;
-- ============================================================================
