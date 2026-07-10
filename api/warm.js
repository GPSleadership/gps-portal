// Endpoint warming — keeps the client-facing serverless functions hot so real
// users (especially a prospect opening the Decision Room) never wait on a cold
// start. A cron hits this every few minutes; it fans out lightweight ?ping=1
// requests to each target function, which return 200 immediately, before any
// auth or database work. The ping simply forces each function's container to be
// warm and ready for the next real request.
//
// Cheap, self-contained, and safe to call: it returns no data and only pings
// our own endpoints. Cost is negligible for this traffic profile.
export default async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const base  = `${proto}://${req.headers.host}`;

  // Prospect- and client-facing functions worth keeping hot.
  const targets = ['sponsor-data', 'sponsor', 'portal-data', 'get-client', 'ask', 'diagnostic'];

  const warmed = {};
  await Promise.all(targets.map(async function (t) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}/api/${t}?ping=1`, { method: 'GET' });
      warmed[t] = { status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      warmed[t] = { error: (e && e.message) || 'fetch failed', ms: Date.now() - t0 };
    }
  }));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, cron: isVercelCron, warmed, at: new Date().toISOString() });
}
