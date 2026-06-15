// GPS Leadership — Portal Visibility & Tier Engine
// Pure, read-only resolver. Given a leader's stored flags + product records,
// returns the UI visibility/config object. It NEVER mutates data and is UI-only:
// all security/anonymity/sponsor checks remain enforced server-side. Rules R1-R17
// implement the locked spec verbatim. Safe to inline into client.html.

function resolvePortalVisibility(input) {
  var i = input || {};

  // ── R1: derived is_coaching_client ────────────────────────────────────────
  var isCoaching = !!(i.in_coaching_program || i.coaching_sessions_enabled ||
    i.is_active_coaching || i.engagement_type === 'diagnostic_plus_coaching');

  // ── Portal state: R2 (hard states) -> R4 (coaching bypass) -> R3 (90-day) ──
  var state;
  if (i.is_archived) {
    state = 'archived';
  } else if (i.portal_locked) {
    state = 'locked';
  } else if (isCoaching) {
    state = 'active';                                   // R4: coaching ignores the timer
  } else if (i.portal_first_active_at) {
    var ms = Date.parse(i.current_date) - Date.parse(i.portal_first_active_at);
    var days = Math.floor(ms / 86400000);
    if (days > 90) state = 'complimentary_expired';
    else if (days >= 85) state = 'complimentary_warning';
    else state = 'active';
  } else {
    state = 'active';                                   // non-coaching, no timer started yet
  }

  var activeOrWarn = (state === 'active' || state === 'complimentary_warning');
  var ended = (state === 'complimentary_expired' || state === 'locked' || state === 'archived');

  // ── Tabs ───────────────────────────────────────────────────────────────────
  // R5: My Plan — visible if has plan or coaching; if neither but still active/
  // warning it's visible (shows the onboarding wizard); hidden once ended.
  var myPlan = (!ended && (i.has_90_day_plan || isCoaching || activeOrWarn)) ? 'visible' : 'hidden';
  // R7: Results
  var myResults = (activeOrWarn && (i.has_90_day_plan || (i.has_diagnostic && i.has_progress_history))) ? 'visible' : 'hidden';
  // R8: Diagnostic
  var myDiagnostic = (activeOrWarn && i.has_diagnostic) ? 'visible' : 'hidden';
  // R9: Decision Room
  var decisionRoom = (activeOrWarn && i.is_sponsor) ? 'visible' : 'hidden';
  // R10: Workshops
  var myWorkshops = (activeOrWarn && i.is_workshop_participant) ? 'visible' : 'hidden';
  // R11: Ask Alex
  var askAlexVisible = (activeOrWarn && i.ask_alex_enabled);
  var askAlex = askAlexVisible ? 'visible' : 'hidden';

  // ── Ask Alex config: R11 state + R12 context/cap ────────────────────────────
  var askState = askAlexVisible ? 'enabled' : 'disabled';
  var contextLevel, capHint;
  if (!askAlexVisible) {
    contextLevel = 'global_only'; capHint = null;
  } else if (isCoaching && i.has_90_day_plan) {
    contextLevel = '+plan_and_progress'; capHint = 20;
  } else if (i.has_diagnostic && !isCoaching) {
    contextLevel = '+diagnostic'; capHint = 10;
  } else {
    contextLevel = 'global_only'; capHint = 5;          // rare edge (incl. coaching pre-plan)
  }

  // ── Sections ────────────────────────────────────────────────────────────────
  // R6
  var weeklyCheckIns = (activeOrWarn && i.has_90_day_plan) ? 'visible' : 'hidden';
  var coachingAttendance = (state === 'active' && isCoaching && i.coaching_sessions_enabled) ? 'visible' : 'hidden';
  // R13
  var toolkit = (activeOrWarn && myPlan === 'visible') ? 'visible' : 'hidden';
  var meetYourCoach = (state === 'active' && isCoaching) ? 'visible' : 'hidden';
  // R14
  var exploreUpsell = (activeOrWarn && !isCoaching) ? 'visible' : 'hidden';
  // R3 banner — only during the warning window
  var countdownBanner = (state === 'complimentary_warning') ? 'visible' : 'hidden';
  // R16
  var accessEnded = ended ? 'visible' : 'hidden';

  // ── R15: contact coach ──────────────────────────────────────────────────────
  var contactCoach;
  if (state === 'active' && isCoaching) contactCoach = 'full';
  else if (!isCoaching && activeOrWarn) contactCoach = 'locked';
  else contactCoach = 'hidden';

  // ── R2: hard states force everything off (after the per-item logic, override) ─
  if (ended) {
    myPlan = myResults = myDiagnostic = decisionRoom = myWorkshops = askAlex = 'hidden';
    askState = 'disabled'; contextLevel = 'global_only'; capHint = null;
    weeklyCheckIns = coachingAttendance = toolkit = meetYourCoach = exploreUpsell = countdownBanner = 'hidden';
    contactCoach = 'hidden';
    accessEnded = 'visible';
  }

  return {
    portal_state: state,
    tabs: {
      my_plan: myPlan, my_results: myResults, my_diagnostic: myDiagnostic,
      decision_room: decisionRoom, my_workshops: myWorkshops, ask_alex: askAlex,
    },
    sections: {
      weekly_check_ins: weeklyCheckIns,
      coaching_attendance_stat: coachingAttendance,
      executive_leadership_toolkit: toolkit,
      meet_your_coach_card: meetYourCoach,
      explore_coaching_upsell_card: exploreUpsell,
      complimentary_countdown_banner: countdownBanner,
      access_ended_screen: accessEnded,
    },
    ask_alex_config: { state: askState, context_level: contextLevel, daily_cap_hint: capHint },
    contact_coach_mode: contactCoach,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { resolvePortalVisibility };
