// api/tools-catalog.js
// Server-side mirror of the client portal's tool library (client.html
// TOOLS_CATALOG) for email use — names, one-line descriptions, and categories
// only. Emails link into the portal's Resources tab (token link), never to raw
// Drive URLs, so access tiers and usage tracking keep working.
//
// CommonJS (module.exports) so the reminder senders can require() it, matching
// brand-link.js / twilio-sms.js.
//
// toolOfTheWeek(date?) — deterministic weekly rotation over the client-facing
// pool (core + diagnostic levels; coach-facing 'coaching' tools and books are
// excluded). Same tool for every client in a given ISO week; advances weekly;
// wraps around. No config required, nothing hardcoded to a single tool.
// If the coach wants to PIN a specific tool, an approved
// 'tool_of_week_override' row in email_templates (body_text = tool id) wins —
// editable from Communication > Templates like every other email string.

const TOOLS = [
  // Foundations
  { id: 't_45principles', name: 'The 45 Executive Operating Principles', cat: 'Foundations', level: 'core', desc: 'The core operating principles behind GPS leadership.' },
  { id: 't_fieldguide', name: 'The Executive Operating Principles — Field Guide', cat: 'Foundations', level: 'core', desc: 'A working guide to applying the operating principles day to day.' },
  { id: 't_tp3onepager', name: 'GPS TP3 Culture Change One-Pager', cat: 'Foundations', level: 'core', desc: 'How Trust, Proactivity, and Productivity drive results, on one page.' },
  { id: 't_tp3high', name: 'High-Trust. High-Proactivity. High-Productivity.', cat: 'Foundations', level: 'core', desc: 'The TP3 model and why it moves the business.' },
  { id: 't_accel', name: 'Your Leadership Acceleration Guide', cat: 'Foundations', level: 'core', desc: 'An orientation to accelerating your leadership growth.' },
  { id: 't_career', name: 'Executive Life & Career Trajectory Blueprint', cat: 'Foundations', level: 'core', desc: 'Map where your career is headed and what to build next.' },
  // Assess
  { id: 't_bottlenecks', name: 'The 5 CEO Bottlenecks Scorecard', cat: 'Assess', level: 'core', desc: 'Score the five places the business slows down when you get involved.' },
  { id: 't_execscorecard', name: 'The GPS Executive Leadership Scorecard', cat: 'Assess', level: 'core', desc: 'A quick read on where your leadership stands today.' },
  { id: 't_talent', name: 'Executive Talent Snapshot', cat: 'Assess', level: 'diagnostic', desc: 'A fast view of bench strength and talent risk on your team.' },
  { id: 't_workforce', name: 'GPS Workforce Capability', cat: 'Assess', level: 'diagnostic', desc: 'Assess where your workforce can and cannot deliver.' },
  { id: 't_readiness', name: 'Program Management Readiness & Alignment Checklist', cat: 'Assess', level: 'diagnostic', desc: 'Check whether a program is set up to actually land.' },
  // Align
  { id: 't_alignqs', name: 'Executive Alignment Quickstart', cat: 'Align', level: 'core', desc: 'A fast way to get your team pointed the same direction.' },
  { id: 't_alignbp', name: 'GPS Alignment Blueprint', cat: 'Align', level: 'diagnostic', desc: 'The full method for aligning a leadership team.' },
  { id: 't_workingagree', name: 'Strategic Working Agreements Worksheet', cat: 'Align', level: 'diagnostic', desc: 'Set explicit agreements on how your team operates.' },
  { id: 't_influencemap', name: 'Executive Influence Alignment Map', cat: 'Align', level: 'diagnostic', desc: 'Map the stakeholders you need aligned and how to move them.' },
  { id: 't_relmatrix', name: 'Executive Relationship Matrix', cat: 'Align', level: 'diagnostic', desc: 'See the key relationships that make or break your results.' },
  { id: 't_mgrreset', name: 'Manager–Employee Relationship Reset', cat: 'Align', level: 'diagnostic', desc: 'Reset a strained manager–report relationship.' },
  // Communicate
  { id: 't_speakimpact', name: 'GPS Speak with Impact', cat: 'Communicate', level: 'core', desc: 'Make your message land the first time.' },
  { id: 't_decisionchk', name: 'Decision-Ready Communication — Quick Checklist', cat: 'Communicate', level: 'core', desc: 'A pre-flight checklist so your ask gets a decision.' },
  { id: 't_pressureplay', name: 'Under-Pressure Communication Playbook', cat: 'Communicate', level: 'core', desc: 'Stay clear and composed when the stakes are high.' },
  { id: 't_pressuresnap', name: 'Under-Pressure Communication Snapshot', cat: 'Communicate', level: 'core', desc: 'The one-page version of the under-pressure playbook.' },
  { id: 't_pcp', name: 'Speaking Under Pressure — Pause / Clarify / Punt Card', cat: 'Communicate', level: 'core', desc: 'A pocket card for when you are put on the spot.' },
  { id: 't_decisionbp', name: 'Decision-Ready Communication Blueprint', cat: 'Communicate', level: 'diagnostic', desc: 'Structure any message so leaders can decide fast.' },
  { id: 't_speakplaybook', name: 'The Executive Speaking Playbook', cat: 'Communicate', level: 'diagnostic', desc: 'The full system for high-stakes executive communication.' },
  { id: 't_speakext', name: 'The Extended Speaking Guide', cat: 'Communicate', level: 'diagnostic', desc: 'A deeper reference for speaking with presence.' },
  { id: 't_presence', name: 'Presence Feedback Rubric', cat: 'Communicate', level: 'diagnostic', desc: 'Score and sharpen your executive presence.' },
  // Hard Conversations
  { id: 't_brave', name: 'Brave Conversation Blueprint', cat: 'Hard Conversations', level: 'core', desc: 'Plan and hold the conversation you have been avoiding.' },
  { id: 't_clear', name: 'GPS CLEAR Feedback Tool (Exec)', cat: 'Hard Conversations', level: 'diagnostic', desc: 'A simple structure for feedback that changes behavior.' },
  { id: 't_trustaccel', name: 'The Trust Accelerator Conversation', cat: 'Hard Conversations', level: 'diagnostic', desc: 'A conversation that rebuilds trust quickly.' },
  { id: 't_connguide', name: 'Executive 360 Connection Conversation Guide', cat: 'Hard Conversations', level: 'diagnostic', desc: 'Turn 360 feedback into a real conversation.' },
  { id: 't_perfprep', name: 'Executive Performance Conversation Prep Guide', cat: 'Hard Conversations', level: 'diagnostic', desc: 'Prepare for a performance conversation that sticks.' },
  // Delegate
  { id: 't_1on1', name: 'GPS 1-on-1 Meeting Alignment Guide', cat: 'Delegate', level: 'core', desc: 'Run 1-on-1s that actually move work forward.' },
  { id: 't_toomuchtime', name: 'Where I’m Spending Too Much Time', cat: 'Delegate', level: 'core', desc: 'Find the work you should stop doing yourself.' },
  { id: 't_delegos', name: 'GPS Delegation Operating System', cat: 'Delegate', level: 'diagnostic', desc: 'A repeatable system for handing off the right work.' },
  { id: 't_timeblueprint', name: 'The Time Alignment Blueprint', cat: 'Delegate', level: 'diagnostic', desc: 'Align your calendar to what actually matters.' },
  // Decide
  { id: 't_premortemlite', name: 'Pre-Mortem Playbook (Lite, 10 min)', cat: 'Decide', level: 'core', desc: 'A fast way to surface why a plan might fail, before it does.' },
  { id: 't_premortemdeep', name: 'Pre-Mortem Playbook (Deep, 20-30 min)', cat: 'Decide', level: 'diagnostic', desc: 'The full pre-mortem for high-stakes decisions.' },
  // Ownership
  { id: 't_ownreset', name: 'Own the Outcome — Personal Accountability Reset', cat: 'Ownership', level: 'diagnostic', desc: 'Reset accountability when ownership has slipped.' },
  // Plan
  { id: 't_90pip', name: '90-Day PIP (Fillable)', cat: 'Plan', level: 'diagnostic', desc: 'Turn feedback into a concrete 90-day plan.' },
  { id: 't_90impact', name: '90-Day Leadership Impact Plan (360)', cat: 'Plan', level: 'diagnostic', desc: 'Build the 90-day behavior plan off your 360.' },
];

// ISO-8601 week number (UTC). Deterministic: same result for every run in a week.
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);            // nearest Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil((((date - yearStart) / 86400000) + 1) / 7) };
}

function toolOfTheWeek(date) {
  const d = date instanceof Date ? date : new Date();
  const { year, week } = isoWeek(d);
  const idx = ((year * 53 + week) % TOOLS.length + TOOLS.length) % TOOLS.length;
  return TOOLS[idx];
}

function toolById(id) {
  return TOOLS.find(t => t.id === id) || null;
}

module.exports = { TOOLS, toolOfTheWeek, toolById, isoWeek };
