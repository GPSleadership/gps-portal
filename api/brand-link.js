// Shared branding helper for outbound external emails.
//
// Standard: in any email to an external stakeholder, the FIRST mention of
// "GPS Leadership Solutions" is hyperlinked so they can learn about us in one click.
// The destination depends on the leader's segment:
//   - Trucking (industry or org contains "truck")        -> /truck-dealers/
//   - Government (state / local / federal, or GS grade)  -> /ses-diagnostic/
//   - Everyone else                                      -> /executive-diagnostic/
//
// Pass whatever object you have (a client row, a diagnostic row, a workshop row);
// the helper reads industry / organization / client_org / client_org_name / org / gs_grade
// if present and falls back to the executive link when there is no signal.

const BASE = 'https://gpsleadership.org';
const LINK_TRUCK = BASE + '/truck-dealers/';
const LINK_GOV   = BASE + '/ses-diagnostic/';
const LINK_EXEC  = BASE + '/executive-diagnostic/';

function gpsDiagnosticLink(ctx) {
  ctx = ctx || {};
  const s = [
    ctx.industry,
    ctx.organization,
    ctx.client_org,
    ctx.client_org_name,
    ctx.org,
  ].filter(Boolean).join(' ').toLowerCase();
  if (s.indexOf('truck') !== -1) return LINK_TRUCK;
  // Industry tag, GS grade, or a recognizable federal/state agency name -> government.
  if (ctx.gs_grade ||
      /government|federal|state\/local|management and budget|\bgao\b|executive office of the president|public education department/.test(s)) {
    return LINK_GOV;
  }
  return LINK_EXEC;
}

// Hyperlinks the first un-linked occurrence of "GPS Leadership Solutions" in an
// HTML body. Leaves subsequent mentions as plain text. Safe to call on any string.
function autoLinkBrand(html, url) {
  if (!html) return html;
  url = url || LINK_EXEC;
  let done = false;
  return String(html).replace(/GPS Leadership Solutions/g, function (match, offset, full) {
    if (done) return match;
    // Skip if this occurrence is already inside an <a> ... </a>.
    const before = full.slice(0, offset);
    if (before.lastIndexOf('<a') > before.lastIndexOf('</a>')) return match;
    done = true;
    return '<a href="' + url + '" style="color:#01949A;text-decoration:underline;">' + match + '</a>';
  });
}

// STANDARD: a paste-able raw-link fallback to place directly under any CTA button
// in an external email. Workplace email security (Proofpoint/Microsoft Safe Links,
// web filters, etc.) frequently rewrites or strips the button's link, so a click
// does nothing. This gives the recipient the real URL to copy and paste. Use this
// under EVERY survey-link or portal-link button we send to an external recipient.
function pasteLink(url, align) {
  if (!url) return '';
  align = align || 'left';
  return '<p style="text-align:' + align + ';font-size:13px;color:#555;margin:8px 0 0;line-height:1.5;">'
    + 'Button not working? Some workplace email systems block links. Copy and paste this address into your browser:<br>'
    + '<span style="color:#004369;word-break:break-all;">' + url + '</span></p>';
}

module.exports = { gpsDiagnosticLink, autoLinkBrand, pasteLink, LINK_TRUCK, LINK_GOV, LINK_EXEC };
