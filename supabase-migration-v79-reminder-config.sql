-- Migration v79: reminder_config singleton table
-- GPS Leadership Solutions
-- Controls when/how check-in reminders fire, editable from coach dashboard.
-- Cron switches from day-specific schedules to hourly; runtime checks this table.

CREATE TABLE IF NOT EXISTS reminder_config (
  id                      int PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  sms_enabled             boolean NOT NULL DEFAULT true,
  sms_day_of_week         int     NOT NULL DEFAULT 1   -- 0=Sun 1=Mon … 6=Sat (UTC)
                            CHECK (sms_day_of_week BETWEEN 0 AND 6),
  sms_hour_utc            int     NOT NULL DEFAULT 14  -- hour (0–23) when SMS fires
                            CHECK (sms_hour_utc BETWEEN 0 AND 23),
  sms_template            text    NOT NULL DEFAULT 'Hi {{first_name}}, your Week {{week}} check-in is ready — takes 90 sec. {{link}}',
  followup_enabled        boolean NOT NULL DEFAULT true,
  followup_day_of_week    int     NOT NULL DEFAULT 4   -- Thursday
                            CHECK (followup_day_of_week BETWEEN 0 AND 6),
  followup_hour_utc       int     NOT NULL DEFAULT 17
                            CHECK (followup_hour_utc BETWEEN 0 AND 23),
  sms_provider            text    NOT NULL DEFAULT 'twilio',
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Insert default row (no-op if row already exists)
INSERT INTO reminder_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- RLS: service role only — no anon access
ALTER TABLE reminder_config ENABLE ROW LEVEL SECURITY;
-- (no anon policies — deny-all for public; coach-data.js uses SUPABASE_SECRET_KEY)

COMMENT ON TABLE reminder_config IS
  'Singleton config row (id=1) for check-in reminder timing/messaging. '
  'Read/written only by api/coach-data.js (SUPABASE_SECRET_KEY). '
  'send-reminders.js loads this at cron runtime so changes take effect without redeploy.';

-- ROLLBACK:
-- DROP TABLE IF EXISTS reminder_config;
