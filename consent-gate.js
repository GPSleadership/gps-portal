/* consent-gate.js — GPS Executive Impact System
 * ONE shared consent gate for EVERY survey surface. Rendered before question one on
 * any screen where a human submits responses about a person or an organization.
 *
 * Design intent: a new survey type inherits this by default. If a survey page can
 * render its questions without calling GPSConsentGate.mount(), the design is wrong —
 * so the server submit endpoints ALSO reject responses with no recorded consent
 * (defense in depth; the UI gate is not the only line).
 *
 * The wording is NEVER hardcoded here. It is fetched live from /api/legal-text
 * (single source of truth = legal_texts table). This file is only the mechanism.
 *
 * Usage (each surface passes its own recorder, since each survey persists the stamp
 * through its own token-validated endpoint):
 *
 *   GPSConsentGate.mount(document.getElementById('consent-slot'), {
 *     key: 'survey_consent',
 *     beginLabel: 'Begin →',
 *     recordConsent: async (textId, version) => {
 *        // return true on success, false to block starting
 *        return await myRecorder(textId, version);
 *     },
 *     onProceed: () => startSurvey(),
 *   });
 */
(function () {
  var STYLE_ID = 'gpscg-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.gpscg{max-width:620px;margin:0 auto;font-family:inherit;}',
      '.gpscg-card{background:#fff;border:1px solid #e3e7ee;border-radius:14px;padding:20px 18px;box-shadow:0 2px 14px rgba(20,40,80,.06);}',
      '.gpscg-lead{font-size:14.5px;line-height:1.5;color:#1f2a44;margin:0 0 12px;}',
      '.gpscg-details{border-top:1px solid #eef1f6;margin-top:4px;padding-top:10px;}',
      '.gpscg-details>summary{cursor:pointer;font-size:13.5px;font-weight:600;color:#1c4fb3;list-style:none;user-select:none;padding:2px 0;}',
      '.gpscg-details>summary::-webkit-details-marker{display:none;}',
      '.gpscg-details>summary::after{content:" \\203A";}',
      '.gpscg-details[open]>summary::after{content:" \\2039";}',
      '.gpscg-body{font-size:13.5px;line-height:1.55;color:#2b3550;margin-top:10px;white-space:pre-wrap;}',
      '.gpscg-consent{display:flex;gap:10px;align-items:flex-start;margin-top:16px;font-size:14px;color:#1f2a44;cursor:pointer;}',
      '.gpscg-consent input{margin-top:3px;width:18px;height:18px;flex:0 0 auto;}',
      '.gpscg-begin{margin-top:16px;width:100%;padding:13px 16px;border:0;border-radius:10px;font-size:15px;font-weight:700;color:#fff;background:#1c4fb3;cursor:pointer;transition:opacity .15s;}',
      '.gpscg-begin:disabled{opacity:.42;cursor:not-allowed;}',
      '.gpscg-ver{margin-top:10px;font-size:11px;color:#8b93a6;text-align:center;}',
      '.gpscg-err{margin-top:10px;font-size:13px;color:#b42318;}',
      '.gpscg-block{max-width:520px;margin:40px auto;padding:28px 22px;background:#fff;border:1px solid #e3e7ee;border-radius:14px;text-align:center;font-size:15px;color:#2b3550;line-height:1.5;}'
    ].join('');
    document.head.appendChild(s);
  }

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // First line of the body is the lead; the rest sits inside the expander.
  function splitLead(body) {
    var txt = String(body || '').trim();
    var nl = txt.indexOf('\n');
    if (nl === -1) return { lead: txt, rest: '' };
    return { lead: txt.slice(0, nl).trim(), rest: txt.slice(nl + 1).trim() };
  }

  async function fetchActive(key) {
    try {
      var r = await fetch('/api/legal-text?key=' + encodeURIComponent(key), { headers: { 'Accept': 'application/json' } });
      if (!r.ok) return null;
      var j = await r.json();
      return (j && j.ok && j.active) ? j : null;
    } catch (e) { return null; }
  }

  var GPSConsentGate = {
    /* Returns true if the gate is showing and armed, false if it hard-blocked
     * (no active text). Never proceeds to the survey on its own — it calls
     * opts.onProceed only after consent is ticked AND recorded. */
    mount: async function (container, opts) {
      opts = opts || {};
      injectStyle();
      if (!container) return false;
      var key = opts.key || 'survey_consent';
      var beginLabel = opts.beginLabel || 'Begin →';

      var active = await fetchActive(key);
      if (!active) {
        // Fail safe: if there is no active consent text, a human must not be able to
        // start answering. (The send-invite guardrail should stop it reaching here.)
        container.innerHTML = '<div class="gpscg-block">This survey isn’t open just yet. Please check back with the person who invited you, or contact <b>privacy@gpsleadership.org</b>.</div>';
        if (typeof opts.onBlocked === 'function') opts.onBlocked();
        return false;
      }

      var parts = splitLead(active.body);
      var html = '' +
        '<div class="gpscg"><div class="gpscg-card">' +
          '<p class="gpscg-lead">' + esc(parts.lead) + '</p>' +
          (parts.rest ? (
            '<details class="gpscg-details"><summary>How your responses are handled</summary>' +
            '<div class="gpscg-body">' + esc(parts.rest) + '</div></details>'
          ) : '') +
          '<label class="gpscg-consent"><input type="checkbox" id="gpscg-chk">' +
            '<span>I understand how my responses will be used and I’m ready to begin.</span></label>' +
          '<button class="gpscg-begin" id="gpscg-begin" disabled>' + esc(beginLabel) + '</button>' +
          '<div class="gpscg-err" id="gpscg-err" style="display:none"></div>' +
          '<div class="gpscg-ver">Version ' + esc(active.version) + '</div>' +
        '</div></div>';
      container.innerHTML = html;

      var chk = container.querySelector('#gpscg-chk');
      var btn = container.querySelector('#gpscg-begin');
      var err = container.querySelector('#gpscg-err');
      chk.addEventListener('change', function () { btn.disabled = !chk.checked; });

      btn.addEventListener('click', async function () {
        if (!chk.checked) return;
        btn.disabled = true; err.style.display = 'none';
        var ok = true;
        if (typeof opts.recordConsent === 'function') {
          try { ok = await opts.recordConsent(active.id, active.version); }
          catch (e) { ok = false; }
        }
        if (ok === false) {
          err.textContent = 'We couldn’t record your consent just now. Please try again in a moment.';
          err.style.display = 'block';
          btn.disabled = false;
          return;
        }
        if (typeof opts.onProceed === 'function') opts.onProceed(active);
      });
      return true;
    }
  };

  window.GPSConsentGate = GPSConsentGate;
})();
