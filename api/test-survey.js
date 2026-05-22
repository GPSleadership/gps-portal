// api/test-survey.js
// Internal test endpoint for the stakeholder survey system.
// PASSWORD PROTECTED — only accessible with the coach password.
//
// Usage:
//   GET  /api/test-survey?password=YOUR_PW
//     → Returns status of all 3 new tables (stakeholders, survey_tokens, survey_responses)
//     → Lists clients with behavior_1 filled in (required to send surveys)
//
//   GET  /api/test-survey?password=YOUR_PW&client_id=UUID
//     → Everything above PLUS creates a live test baseline token for that client
//     → Returns a clickable survey URL you can open in your browser
//     → Skips email — token goes straight to the database

const SUPABASE_URL    = process.env.SUPABASE_URL    || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const SITE_URL        = process.env.SITE_URL        || 'https://portal.gpsleadership.org';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const { password, client_id } = req.query;

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!password) {
    return res.status(200).send(renderPage('Auth Required',
      `<p style="color:#DC2626;font-size:15px;">Add <code>?password=YOUR_PW</code> to the URL.</p>
       <p style="margin-top:8px;font-size:13px;color:#6B7280;">Example: <code>/api/test-survey?password=yourpassword</code></p>`
    ));
  }

  const authOk = await verifyPassword(password);
  if (!authOk) {
    return res.status(200).send(renderPage('Wrong Password',
      `<p style="color:#DC2626;font-size:15px;">Incorrect password. Use your coach dashboard password.</p>`
    ));
  }

  // ── Table health checks ───────────────────────────────────────────────────
  const checks = await Promise.all([
    checkTable('stakeholders'),
    checkTable('survey_tokens'),
    checkTable('survey_responses'),
  ]);

  const [stakeholderCheck, tokenCheck, responseCheck] = checks;

  // ── Load clients with behavior_1 set ─────────────────────────────────────
  let clientRows = '';
  let clients    = [];
  try {
    const cRes = await sbFetch(
      `/rest/v1/clients?is_active=eq.true&is_archived=eq.false&select=id,name,email,behavior_1,start_behavior&order=name`
    );
    if (cRes.ok) {
      clients = await cRes.json();
      if (clients.length === 0) {
        clientRows = `<tr><td colspan="4" style="padding:16px;color:#6B7280;text-align:center;">No active clients found.</td></tr>`;
      } else {
        clientRows = clients.map(c => {
          const behavior = c.behavior_1 || c.start_behavior || '';
          const hasBehavior = !!behavior.trim();
          const testUrl = hasBehavior
            ? `/api/test-survey?password=${encodeURIComponent(password)}&client_id=${c.id}`
            : '';
          return `<tr>
            <td style="padding:10px 12px;font-weight:700;color:#1B2A4A;">${esc(c.name)}</td>
            <td style="padding:10px 12px;font-size:12px;color:#6B7280;">${esc(c.email || '—')}</td>
            <td style="padding:10px 12px;font-size:12px;${hasBehavior ? 'color:#1B2A4A;' : 'color:#DC2626;font-style:italic;'}">${hasBehavior ? esc(behavior.substring(0,80)) + (behavior.length > 80 ? '…' : '') : '⚠ No behavior set — have client complete their plan'}</td>
            <td style="padding:10px 12px;">
              ${hasBehavior
                ? `<a href="${testUrl}" style="background:#1B2A4A;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700;">Generate Test Link</a>`
                : `<span style="color:#D1D5DB;font-size:12px;">—</span>`
              }
            </td>
          </tr>`;
        }).join('');
      }
    }
  } catch(e) {
    clientRows = `<tr><td colspan="4" style="padding:16px;color:#DC2626;">Error loading clients: ${esc(e.message)}</td></tr>`;
  }

  // ── Generate test token (if client_id provided) ───────────────────────────
  let testSurveySection = '';
  if (client_id) {
    const client = clients.find(c => c.id === client_id);
    if (!client) {
      testSurveySection = `<div style="background:#FEF2F2;border-radius:8px;padding:16px 20px;margin-bottom:24px;border-left:4px solid #DC2626;">
        <strong style="color:#DC2626;">Client not found</strong>
        <p style="font-size:13px;color:#6B7280;margin-top:4px;">No active client with that ID.</p>
      </div>`;
    } else {
      const behavior     = (client.behavior_1 || client.start_behavior || '').trim();
      const clientFirst  = client.name.split(' ')[0];
      const token        = generateToken();
      const expires      = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours

      // Create a real token but mark it as a test (stakeholder_id will be null-ish)
      // We'll use a fake stakeholder_id workaround: insert a temp stakeholder row
      let surveyUrl = '';
      let tokenError = '';
      try {
        // Check if a test stakeholder exists for this client
        const shRes = await sbFetch(
          `/rest/v1/stakeholders?client_id=eq.${client_id}&name=eq.Test+Stakeholder&select=id`
        );
        let stakeholderId = null;
        if (shRes.ok) {
          const sh = await shRes.json();
          if (sh && sh.length > 0) {
            stakeholderId = sh[0].id;
          }
        }
        if (!stakeholderId) {
          // Create a test stakeholder row
          const shInsert = await sbFetch('/rest/v1/stakeholders', 'POST', {
            client_id:    client_id,
            name:         'Test Stakeholder',
            email:        'test@gpsleadership.org',
            relationship: 'peer',
            is_supervisor: false,
            is_active:    true,
            notes:        'AUTO-CREATED for test purposes — safe to delete'
          }, { 'Prefer': 'return=representation' });
          if (shInsert.ok) {
            const shData = await shInsert.json();
            stakeholderId = shData[0]?.id;
          }
        }

        if (stakeholderId) {
          const tInsert = await sbFetch('/rest/v1/survey_tokens', 'POST', {
            token,
            client_id,
            stakeholder_id:    stakeholderId,
            checkpoint:        'baseline',
            priority_behavior: behavior || 'demonstrate effective leadership behaviors',
            client_first_name: clientFirst,
            sent_at:           new Date().toISOString(),
            expires_at:        expires,
            is_used:           false
          }, { 'Prefer': 'return=minimal' });

          if (tInsert.ok) {
            surveyUrl = `${SITE_URL}/survey?t=${token}`;
          } else {
            tokenError = await tInsert.text();
          }
        }
      } catch(e) {
        tokenError = e.message;
      }

      if (surveyUrl) {
        testSurveySection = `
          <div style="background:#F0FDF4;border-radius:8px;padding:20px 24px;margin-bottom:24px;border-left:4px solid #16A34A;">
            <div style="font-size:16px;font-weight:700;color:#166534;margin-bottom:12px;">✓ Test survey link created for ${esc(client.name)}</div>
            <div style="background:#fff;border:2px solid #16A34A;border-radius:6px;padding:12px 16px;margin-bottom:12px;">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6B7280;margin-bottom:6px;">Survey URL (expires in 2 hours)</div>
              <a href="${surveyUrl}" target="_blank" style="color:#1B2A4A;font-weight:700;font-size:14px;word-break:break-all;">${surveyUrl}</a>
            </div>
            <div style="font-size:13px;color:#166534;margin-bottom:6px;"><strong>Behavior being tested:</strong> ${esc(behavior || '—')}</div>
            <div style="font-size:12px;color:#6B7280;margin-top:10px;">
              This created a real token in your database under a "Test Stakeholder" row.
              After testing, you can remove that stakeholder from the Stakeholder Feedback section in the coach portal.
            </div>
            <div style="margin-top:14px;">
              <a href="${surveyUrl}" target="_blank" style="display:inline-block;background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-weight:700;font-size:14px;">Open Survey →</a>
            </div>
          </div>`;
      } else {
        testSurveySection = `<div style="background:#FEF2F2;border-radius:8px;padding:16px 20px;margin-bottom:24px;border-left:4px solid #DC2626;">
          <strong style="color:#DC2626;">Token creation failed</strong>
          <p style="font-size:12px;color:#6B7280;margin-top:4px;">${esc(tokenError)}</p>
        </div>`;
      }
    }
  }

  // ── Render the full page ──────────────────────────────────────────────────
  const allTablesOk = checks.every(c => c.ok);

  const tableChecks = checks.map(c => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #E5E7EB;">
      <span style="font-size:18px;">${c.ok ? '✅' : '❌'}</span>
      <div>
        <div style="font-weight:700;color:#1B2A4A;font-size:14px;">${c.table}</div>
        <div style="font-size:12px;color:#6B7280;">${c.ok ? `${c.count} row${c.count !== 1 ? 's' : ''}` : c.error}</div>
      </div>
    </div>`).join('');

  const html = `
    ${testSurveySection}

    <div style="background:${allTablesOk ? '#F0FDF4' : '#FEF2F2'};border-radius:8px;padding:16px 20px;margin-bottom:24px;border-left:4px solid ${allTablesOk ? '#16A34A' : '#DC2626'};">
      <div style="font-weight:700;font-size:15px;color:${allTablesOk ? '#166534' : '#DC2626'};margin-bottom:4px;">
        ${allTablesOk ? '✓ All 3 tables exist and are accessible' : '⚠ One or more tables not found — run supabase-migration-v3.sql'}
      </div>
      ${tableChecks}
    </div>

    <div style="background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.08);overflow:hidden;margin-bottom:24px;">
      <div style="background:#1B2A4A;padding:12px 16px;">
        <span style="color:#fff;font-weight:700;font-size:14px;">Active Clients — Survey Readiness</span>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:#F5F6F8;">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:#6B7280;">Client</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:#6B7280;">Email</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:#6B7280;">Priority Behavior (behavior_1)</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:#6B7280;">Test</th>
            </tr>
          </thead>
          <tbody>${clientRows}</tbody>
        </table>
      </div>
    </div>

    <div style="background:#F5F6F8;border-radius:8px;padding:16px 20px;font-size:13px;color:#6B7280;line-height:1.7;">
      <strong style="color:#1B2A4A;">How to run a full end-to-end test:</strong><br>
      1. Click <strong>Generate Test Link</strong> next to any client with a behavior set<br>
      2. Open the survey URL — fill it out as if you're a stakeholder<br>
      3. Submit the survey<br>
      4. Go to the coach portal → expand that client → check the Stakeholder Feedback section<br>
      5. You should see the scoreboard update with your test response<br>
      6. Clean up: remove the "Test Stakeholder" from the stakeholder list in the coach portal
    </div>
  `;

  return res.status(200).send(renderPage('Survey System Test', html));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function checkTable(tableName) {
  try {
    const r = await sbFetch(`/rest/v1/${tableName}?select=id&limit=1`, 'GET', null, {
      'Prefer': 'count=exact'
    });
    if (!r.ok) {
      const t = await r.text();
      return { table: tableName, ok: false, error: t.includes('does not exist') ? 'Table not found — run migration' : `Error: ${r.status}` };
    }
    const countHeader = r.headers.get('content-range');
    const count = countHeader ? parseInt(countHeader.split('/')[1]) || 0 : 0;
    return { table: tableName, ok: true, count };
  } catch(e) {
    return { table: tableName, ok: false, error: e.message };
  }
}

async function verifyPassword(password) {
  if (!password) return false;
  const settingsRes = await sbFetch('/rest/v1/coach_settings?key=eq.coach_password&select=value&limit=1');
  if (settingsRes.ok) {
    const settings = await settingsRes.json();
    if (settings?.[0]?.value === password) return true;
  }
  const adminRes = await sbFetch('/rest/v1/admin_accounts?is_active=eq.true&select=password');
  if (adminRes.ok) {
    const admins = await adminRes.json();
    if ((admins || []).map(a => a.password).includes(password)) return true;
  }
  return false;
}

function generateToken() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let t = '';
  for (let i = 0; i < 32; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sbFetch(path, method = 'GET', body = null, extraHeaders = {}) {
  return fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey:         SUPABASE_SECRET,
      Authorization:  `Bearer ${SUPABASE_SECRET}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function renderPage(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} | GPS Survey Test</title>
<style>
  body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#F5F6F8; margin:0; padding:0; }
  .header { background:#1B2A4A; padding:18px 28px; }
  .header .logo { color:#C9A84C; font-size:11px; letter-spacing:2px; text-transform:uppercase; font-weight:700; margin-bottom:4px; }
  .header h1 { color:#fff; font-size:18px; font-weight:700; margin:0; }
  .container { max-width:900px; margin:28px auto; padding:0 20px 60px; }
  code { background:#E5E7EB; padding:2px 6px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">GPS Leadership Solutions</div>
    <h1>Survey System — Test & Status</h1>
  </div>
  <div class="container">${content}</div>
</body>
</html>`;
}
