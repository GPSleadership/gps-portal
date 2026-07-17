-- v102 — Feedforward: a forward-looking rater suggestion captured on the baseline +
-- day-60 + day-90 pulses (Goldsmith: ask for one thing to do MORE of going forward,
-- not feedback on the past). Stored separately from open_response/comments so it can
-- be surfaced on its own ("pick one to act on"). Leader-facing display is gated on the
-- de-identification pass (P1-C7); the coach sees it directly. Additive + backward compatible.

alter table public.survey_responses
  add column if not exists feedforward text;

-- ROLLBACK
-- alter table public.survey_responses drop column if exists feedforward;
