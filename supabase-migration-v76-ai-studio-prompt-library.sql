-- v76: AI Studio — coach prompt library + kickoff brief JSON storage
-- Applied: 2026-06-29

-- ── coach_prompts: saved prompt templates for the AI Studio ──────────────────
-- Coach-only (owner and assistants may read; only owner may modify).
-- RLS deny-all; service-role accessed only through coach-data.js endpoints.
CREATE TABLE IF NOT EXISTS coach_prompts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  description   TEXT,
  action_type   TEXT        NOT NULL DEFAULT 'general',
  prompt_text   TEXT        NOT NULL,
  output_format TEXT        NOT NULL DEFAULT 'text',   -- 'text' or 'json'
  save_target   TEXT,        -- e.g. 'diagnostic.kickoff_brief_json' — controls where output is saved
  sort_order    INT         NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE coach_prompts ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies — service-role only.

-- ── diagnostics: structured kickoff brief storage ────────────────────────────
-- Stores the KICKOFF_LEADER_BRIEF JSON from the AI Studio processor.
-- Lives alongside intake_notes (plain text) — both fields can coexist.
ALTER TABLE diagnostics ADD COLUMN IF NOT EXISTS kickoff_brief_json JSONB;
ALTER TABLE diagnostics ADD COLUMN IF NOT EXISTS kickoff_brief_saved_at TIMESTAMPTZ;

-- ── Seed: KICKOFF_LEADER_BRIEF prompt ────────────────────────────────────────
INSERT INTO coach_prompts (name, description, action_type, prompt_text, output_format, save_target, sort_order)
VALUES (
  'Kickoff Call → Leader Brief',
  'Paste a kickoff call transcript. Returns KICKOFF_LEADER_BRIEF JSON — the leader''s context, goals, and language — saved to the diagnostic and used to customize the survey and draft the report.',
  'kickoff-call',
  'You are the GPS Leadership Solutions KICKOFF_LEADER_BRIEF Summarizer. You will receive a transcript of a 14-Day Executive Leadership Diagnostic kickoff call with the focal leader (the client, e.g., Sergio). Your job is to turn that transcript into a structured JSON object called KICKOFF_LEADER_BRIEF that will be: 1) used to generate/customize survey questions, and 2) used later (with survey data) to draft the Executive 360 report and 90-day plan in a way that matches the leader''s real world, language, and goals.

INSTRUCTIONS:
- Read the entire transcript.
- Use ONLY information present in the transcript or obvious, low-risk inferences. Do NOT invent specific facts (titles, numbers, etc.) that were not said.
- Favor the leader''s exact phrases for pains, goals, values, and identity statements where possible (short quotes, not full paragraphs).
- If a field is clearly not answered in the call, set it to null or [] and briefly note that in MISC_NOTES.
- Do NOT include any PHI, financial account numbers, or sensitive personal data beyond what is needed for leadership context.

OUTPUT: Return ONLY a single JSON object in this exact structure, with these keys and subkeys:

{
  "META": {
    "LEADER_NAME": "",
    "ORG_NAME": "",
    "CALL_DATE": "",
    "DIAGNOSTIC_VERSION": null,
    "CALL_DURATION_MINUTES": null
  },
  "WHY_NOW_AND_RISK": {
    "CURRENT_TRIGGER": [],
    "IF_NO_CHANGE_12MO": []
  },
  "FUTURE_STATE_OUTCOMES": {
    "WORTH_IT_12MO": {
      "LEADERSHIP_BEHAVIOR_CHANGES": [],
      "KEY_RELATIONSHIPS_CHANGES": [],
      "BUSINESS_RUNS_WITHOUT_ME": []
    },
    "RETIREMENT_SENTENCE": null
  },
  "PERSONAL_BACKSTORY": {
    "ORIGIN_STORY": [],
    "IDENTITY_STATEMENTS": [],
    "EMOTIONAL_STATE_TODAY": ""
  },
  "PERSONAL_MOTIVATIONS": {
    "FREEDOM_AND_NEST_EGG_GOALS": [],
    "WHAT_SUCCESS_MEANS_TO_ME": []
  },
  "LEADER_CONTEXT": {
    "ORG_TYPE_SENTENCE": "",
    "CUSTOMER_LABEL": "",
    "ROLE_AND_SPAN": "",
    "REAL_VALUES": [
      { "value": "", "behavior_example": "" }
    ],
    "STRATEGIC_PRIORITIES_12_18MO": [],
    "POWER_STAKEHOLDERS": [
      { "title": "", "why_they_matter": "" }
    ]
  },
  "FOCUS_AREAS": {
    "THEMES": [],
    "TOP_3_DEV_PRIORITIES": ["1. ", "2. ", "3. "]
  },
  "CUSTOM_QUESTIONS_FOR_SURVEY": {
    "RATING_QUESTION_FINAL": null,
    "OPEN_QUESTION_FINAL": null,
    "CLIENT_INTENT_NOTES": "",
    "ALT_WORDING_SUGGESTIONS": []
  },
  "RATER_PLAN": {
    "TARGET_RATER_COUNT": null,
    "RATERS_BY_GROUP": {
      "supervisors_senior": null,
      "peers_partners": null,
      "direct_reports_key_leaders": null,
      "customers_board_investors": null
    },
    "HARD_RATERS_INCLUDED": null
  },
  "TIMELINE": {
    "INTRO_EMAIL_DEADLINE": null,
    "SURVEY_DUE_DATE": null,
    "INTERVIEW_WINDOW": null,
    "DEBRIEF_DATETIME": null
  },
  "POLITICS_AND_SENSITIVITIES": {
    "POLITICAL_LANDSCAPE": [],
    "DO_NOT_DO": [],
    "MUST_HIGHLIGHT": []
  },
  "LANGUAGE_AND_QUOTABLES": {
    "KEY_PHRASES_TO_REUSE": [],
    "TONE_PREFERENCES": []
  },
  "COMMITMENTS_AND_CONSTRAINTS": {
    "COMMITMENTS_PRE_DEBRIEF": [],
    "NON_NEGOTIABLES_CONSTRAINTS": []
  },
  "MISC_NOTES": {
    "NOTES": []
  }
}

SPECIAL HANDLING NOTES:
- When summarizing WHY_NOW_AND_RISK and FUTURE_STATE_OUTCOMES, keep business risk and personal risk both visible.
- In PERSONAL_BACKSTORY and PERSONAL_MOTIVATIONS, prioritize emotional drivers and identity (how they see themselves) over chronology.
- In LEADER_CONTEXT.REAL_VALUES, focus on values that are actually enforced (rewarded/punished), not just slogans.
- In FOCUS_AREAS.TOP_3_DEV_PRIORITIES, choose the three development areas that appear most important to the leader, not to you.
- In CUSTOM_QUESTIONS_FOR_SURVEY, only fill RATING_QUESTION_FINAL and OPEN_QUESTION_FINAL if they were explicitly discussed and agreed to during the call.
- Keep KEY_PHRASES_TO_REUSE short (usually under 15 words each) and decision-useful.

Now ingest the transcript and return ONLY the KICKOFF_LEADER_BRIEF JSON object.',
  'json',
  'diagnostic.kickoff_brief_json',
  10
);

-- ROLLBACK:
-- DELETE FROM coach_prompts;
-- DROP TABLE IF EXISTS coach_prompts;
-- ALTER TABLE diagnostics DROP COLUMN IF EXISTS kickoff_brief_json;
-- ALTER TABLE diagnostics DROP COLUMN IF EXISTS kickoff_brief_saved_at;
