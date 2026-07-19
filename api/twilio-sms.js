// api/twilio-sms.js
// Sends SMS through the GPS Leadership A2P Messaging Service.
// CommonJS (module.exports) so it can be require()'d from the reminder senders,
// matching how brand-link.js is consumed.
//
// Env vars (set in Vercel):
//   TWILIO_ACCOUNT_SID          AC...
//   TWILIO_API_KEY_SID          SK...
//   TWILIO_API_KEY_SECRET       (the API key secret)
//   TWILIO_MESSAGING_SERVICE_SID  MG...  (the A2P-registered Messaging Service)
//
// STOP / HELP are handled automatically by the Messaging Service's Advanced
// Opt-Out, so callers do not need to process replies.

const ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const API_KEY_SID    = process.env.TWILIO_API_KEY_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const MSG_SVC_SID    = process.env.TWILIO_MESSAGING_SERVICE_SID;

// True only when every credential is present AND the master go-live switch is on.
// SMS_LIVE must equal 'true' — it is the single switch Alex flips in Vercel only
// AFTER the A2P campaign is APPROVED. Until then every send path (opt-in confirmation,
// weekly reminders, ad-hoc coach texts) no-ops cleanly, so nothing is submitted to
// Twilio to fail against an unregistered campaign (and no dedupe stamps get burned on
// a send that never really went out). Callers use this to no-op safely.
function smsConfigured() {
  return !!(ACCOUNT_SID && API_KEY_SID && API_KEY_SECRET && MSG_SVC_SID)
      && process.env.SMS_LIVE === 'true';
}

// Best-effort E.164 formatting for US/CA numbers. Returns null if we can't be
// confident — we never guess a country code beyond the obvious 10/11-digit US case.
function normalizeE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) {
    const d = '+' + s.slice(1).replace(/\D/g, '');
    return /^\+\d{8,15}$/.test(d) ? d : null;
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;              // US/CA 10-digit
  if (d.length === 11 && d[0] === '1') return '+' + d; // 1 + 10-digit
  return null;
}

// Send one SMS. Never throws — always resolves with a result object:
//   { ok:true, sid, to }
//   { ok:false, skipped:true, reason }   (not configured / bad number — benign)
//   { ok:false, status, code, error }    (a real send failure)
async function sendSms({ to, body }) {
  if (!smsConfigured()) return { ok: false, skipped: true, reason: 'not-configured' };
  const e164 = normalizeE164(to);
  if (!e164) return { ok: false, skipped: true, reason: 'invalid-number' };
  if (!body || !String(body).trim()) return { ok: false, skipped: true, reason: 'empty-body' };

  const auth = Buffer.from(`${API_KEY_SID}:${API_KEY_SECRET}`).toString('base64');
  const form = new URLSearchParams({
    MessagingServiceSid: MSG_SVC_SID,
    To: e164,
    Body: String(body),
  });

  let r;
  try {
    r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (e) {
    return { ok: false, error: 'network: ' + e.message };
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, code: j.code, error: j.message || ('HTTP ' + r.status) };
  return { ok: true, sid: j.sid, to: e164 };
}

module.exports = { sendSms, smsConfigured, normalizeE164 };
