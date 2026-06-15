-- ════════════════════════════════════════════════════════════════════════════
-- Seed: diagnostic nurture templates  ⚠️ NOT YET APPLIED — hold until Alex approves.
-- 5 editable nurture templates (one per touch), is_approved = FALSE so the cron
-- uses the built-in fallback until reviewed/approved under Communication ->
-- Templates (14-Day Diagnostic group). ON CONFLICT DO NOTHING so re-running never
-- overwrites edited copy. Placeholders: {{first_name}}, {{leader_name}}, {{org}}.
-- Copy is drafted in Alex's voice: name the problem, why it happens, one move to
-- test in 7 days, CTA warming across the sequence. Recipient is the diagnostic
-- LEADER (the buyer), never raters.
-- ════════════════════════════════════════════════════════════════════════════

insert into email_templates (template_key, label, subject, body_text, is_approved) values
('diagnostic_nurture_1', 'Diagnostic Nurture 1 (Day +1)', 'One change from your diagnostic',
 E'Hi {{first_name}},\n\nYour diagnostic gave you a clear read on where your leadership creates leverage and where it leaks. Most leaders read it, nod, and change nothing. The ones who get value pick a single item and run a 7-day test.\n\nSo pick one. The decision that keeps bouncing back to you. The meeting that never ends in a decision. The direct report you cannot stop checking on. One.\n\nFor the next 7 days, change how you handle just that one thing. Watch what happens.\n\nThat is the whole method. Small, specific, tested in a week.\n\nReply and tell me which one you picked. I read every response.\n\n- Alex Tremble, GPS Leadership Solutions', false),

('diagnostic_nurture_2', 'Diagnostic Nurture 2 (Day +15)', 'The decision that should not reach your desk',
 E'Hi {{first_name}},\n\nHere is a pattern I see in almost every operations-heavy business: the company only moves when the CEO gets involved. It feels like leadership. It is actually a bottleneck.\n\nThe fix is not delegating more tasks. It is delegating decisions.\n\nThis week, pick one recurring decision that lands on your desk and should not. Hand it to the person closest to the work. Give them the guardrail (the budget, the deadline, the one non-negotiable) and let them decide inside it.\n\nYou are not giving up control. You are deciding once instead of fifty times.\n\nOne decision, one owner, one guardrail. Test it this week.\n\n- Alex Tremble', false),

('diagnostic_nurture_3', 'Diagnostic Nurture 3 (Day +29)', 'Why your team waits for you',
 E'Hi {{first_name}},\n\nWhen a team will not take ownership, the instinct is to question their commitment. Usually the problem is clarity, not character.\n\nPeople do not own what they do not clearly own. If two people could each assume the other has it, neither will.\n\nThis week, take one stalled project and name a single owner out loud. Not a committee. One name, accountable for the outcome, with the authority to make the calls.\n\nThen step back and let them. The hardest part is your silence.\n\nTrust follows clarity. Give the clarity first.\n\n- Alex Tremble', false),

('diagnostic_nurture_4', 'Diagnostic Nurture 4 (Day +43)', 'The meeting rule that buys back hours',
 E'Hi {{first_name}},\n\nMeetings are where leadership time goes to die. The cause is rarely too many meetings. It is meetings with no decision to make.\n\nTry one rule this week: every recurring meeting on your calendar must name the decision it exists to make. If it has one, keep it and make the decision. If it does not, it is an update, and an update is an email.\n\nRun that test across your standing meetings. Most leaders cut two or three and get hours back.\n\nProtect your calendar like it is the scarce resource it is.\n\n- Alex Tremble', false),

('diagnostic_nurture_5', 'Diagnostic Nurture 5 (Day +57, final)', 'What most CEOs do next',
 E'Hi {{first_name}},\n\nIt has been a few weeks since your diagnostic. By now you have either acted on it or filed it. Both are normal.\n\nIf you want to actually move the needle, here is what most CEOs I work with do next: a focused debrief to turn the diagnostic into a short list of changes, then a coaching sprint to install them while the pressure is real.\n\nNo long program. A clear system, a few high-leverage moves, and the accountability to make them stick.\n\nIf that is useful, reply and I will send the details. If not, keep the diagnostic close and run one test a month. That alone will put you ahead of most.\n\n- Alex Tremble', false)
on conflict (template_key) do nothing;

-- ROLLBACK
-- delete from email_templates where template_key in ('diagnostic_nurture_1','diagnostic_nurture_2','diagnostic_nurture_3','diagnostic_nurture_4','diagnostic_nurture_5');
