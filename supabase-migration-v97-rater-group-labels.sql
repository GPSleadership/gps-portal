-- v97 — Per-diagnostic rater group labels + a group note.
--
-- WHY:
-- The rater "relationship" a leader picks does not always match the org chart.
-- On the JMAA/Rosa Beckett diagnostic the four chiefs — her actual executive team —
-- were entered as "Peer". Reporting their feedback under a "Peers" heading would be
-- flatly wrong: it turns a trust failure inside her own leadership team into
-- cross-functional friction, and the numbers are not close (chiefs 3.48 trust,
-- the other reports 5.00).
--
-- The wrong fix is to move the people between buckets: merging the chiefs into
-- Direct Reports averages 3.48 into 5.00, and the single most important finding
-- in the report disappears. So we keep the bucket and rename it.
--
-- rater_group_labels: { "<group_key>": "<display name>" }
--   group_key ∈ direct_report | peer | supervisor | internal_partner | board |
--               other_colleagues | all_others | self
--   A renamed group's NAME defines what it is. The report generator is told to
--   use the name and NOT to apply the default meaning of the underlying bucket.
--
-- rater_group_note: an optional line the report must state plainly, so the leader
--   can reconcile who is actually in each group. Being explicit about what we do
--   not know beats quietly printing a label that is wrong.
--
-- Additive. Old code ignores both columns.

alter table diagnostics
  add column if not exists rater_group_labels jsonb not null default '{}'::jsonb,
  add column if not exists rater_group_note   text;

comment on column diagnostics.rater_group_labels is
  'Per-diagnostic display-name overrides for rater groups, e.g. {"peer":"Chiefs / Leadership Team"}. The bucket is unchanged; only the label the leader sees. Used because the relationship a leader picks does not always match the org chart.';

comment on column diagnostics.rater_group_note is
  'Optional plain-language note the report must state, clarifying who sits in each rater group (including what is NOT known).';

-- ROLLBACK
-- alter table diagnostics drop column if exists rater_group_labels;
-- alter table diagnostics drop column if exists rater_group_note;
