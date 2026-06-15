-- ════════════════════════════════════════════════════════════════════════════
-- v64: diagnostic nurture state (2026-06-14)  ⚠️ NOT YET APPLIED — hold until Alex approves.
-- Additive only. Nurture state lives on the diagnostics row because that row owns
-- the leader's contact email + completion state + the client_id link used to
-- detect conversion to coaching. A diagnostic-only leader is nurtured; the moment
-- they convert to coaching the cron stops (re-checked every send).
--
-- All columns default to inert values, so applying this changes NO behavior until
-- the nurture cron + a trigger flip nurture_active = true. Safe to apply anytime.
-- ════════════════════════════════════════════════════════════════════════════

alter table diagnostics add column if not exists nurture_active        boolean not null default false;  -- master on/off for this leader
alter table diagnostics add column if not exists nurture_emails_sent   integer not null default 0;      -- touches sent so far (cap enforced in code)
alter table diagnostics add column if not exists nurture_next_at        timestamptz;                     -- when the next touch is due (null = nothing scheduled)
alter table diagnostics add column if not exists nurture_last_sent_at   timestamptz;
alter table diagnostics add column if not exists nurture_claimed_at     timestamptz;                     -- fire-once claim guard (mirrors invites_schedule_claimed_at)
alter table diagnostics add column if not exists nurture_opened_count   integer not null default 0;      -- soft signal (Apple MPP inflates opens)
alter table diagnostics add column if not exists nurture_last_opened_at timestamptz;
alter table diagnostics add column if not exists nurture_last_clicked_at timestamptz;                    -- the real "warming up" signal
alter table diagnostics add column if not exists nurture_unsubscribed   boolean not null default false;  -- honored by the cron; set via unsubscribe link

-- Cron lookup: due, active, not unsubscribed.
create index if not exists idx_diagnostics_nurture_due on diagnostics (nurture_next_at) where nurture_active = true and nurture_unsubscribed = false;

-- ROLLBACK
-- drop index if exists idx_diagnostics_nurture_due;
-- alter table diagnostics drop column if exists nurture_unsubscribed;
-- alter table diagnostics drop column if exists nurture_last_clicked_at;
-- alter table diagnostics drop column if exists nurture_last_opened_at;
-- alter table diagnostics drop column if exists nurture_opened_count;
-- alter table diagnostics drop column if exists nurture_claimed_at;
-- alter table diagnostics drop column if exists nurture_last_sent_at;
-- alter table diagnostics drop column if exists nurture_next_at;
-- alter table diagnostics drop column if exists nurture_emails_sent;
-- alter table diagnostics drop column if exists nurture_active;
