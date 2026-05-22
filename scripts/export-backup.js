/**
 * GPS Portal — Manual Data Export / Backup Script
 * ─────────────────────────────────────────────────
 * Exports all clients + check-ins from Supabase to a timestamped JSON file.
 *
 * USAGE:
 *   1. One-time setup:
 *        npm install @supabase/supabase-js
 *
 *   2. Run any time you want a backup:
 *        node scripts/export-backup.js
 *
 *   Output: backups/gps-portal-backup-YYYY-MM-DD.json
 *
 * FOR AUTOMATED WEEKLY BACKUP:
 *   Option A (simplest — Vercel Cron):
 *     Add to vercel.json:
 *       "crons": [{ "path": "/api/export-cron", "schedule": "0 8 * * 1" }]
 *     Then create api/export-cron.js (see comments at bottom of this file).
 *
 *   Option B (Mac/Linux):
 *     Add to crontab (runs every Monday at 8am):
 *       0 8 * * 1 cd /path/to/gps-portal && node scripts/export-backup.js >> logs/backup.log 2>&1
 */

const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_ANON = process.env.SUPABASE_ANON || 'YOUR_SUPABASE_ANON_KEY';
const BACKUP_DIR    = path.join(__dirname, '..', 'backups');
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const db = createClient(SUPABASE_URL, SUPABASE_ANON);
  const date = new Date().toISOString().split('T')[0];

  console.log(`\n📦 GPS Portal Backup — ${date}`);

  // Fetch all data
  const [clientsRes, checkinsRes] = await Promise.all([
    db.from('clients').select('*').order('created_at', { ascending: false }),
    db.from('checkins').select('*').order('submitted_at', { ascending: false }),
  ]);

  if (clientsRes.error)  { console.error('❌ Error fetching clients:',  clientsRes.error.message);  process.exit(1); }
  if (checkinsRes.error) { console.error('❌ Error fetching check-ins:', checkinsRes.error.message); process.exit(1); }

  const payload = {
    exported_at:    new Date().toISOString(),
    export_version: '1.0',
    summary: {
      total_clients:  clientsRes.data.length,
      total_checkins: checkinsRes.data.length,
      active_clients: clientsRes.data.filter(c => c.is_active && !c.is_archived).length,
    },
    clients:  clientsRes.data,
    checkins: checkinsRes.data,
  };

  // Save to backups/ directory
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const filename = path.join(BACKUP_DIR, `gps-portal-backup-${date}.json`);
  fs.writeFileSync(filename, JSON.stringify(payload, null, 2), 'utf-8');

  console.log(`✅ Backup saved: ${filename}`);
  console.log(`   Clients: ${payload.summary.total_clients} | Check-ins: ${payload.summary.total_checkins}`);

  // Keep only last 12 backups (3 months of weekly)
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('gps-portal-backup-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length > 12) {
    files.slice(12).forEach(f => {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log(`   Pruned old backup: ${f}`);
    });
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });

/*
─────────────────────────────────────────────────────────────────────────────
TO RE-POINT BACKUPS TO CLOUD STORAGE (e.g. AWS S3, Google Drive, Dropbox):

Replace the fs.writeFileSync block above with an upload call to your
storage provider. Example for AWS S3:

  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: `gps-backups/gps-portal-backup-${date}.json`,
    Body: JSON.stringify(payload, null, 2),
    ContentType: 'application/json',
  }));

Required env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET
─────────────────────────────────────────────────────────────────────────────

GoHighLevel SYNC NOTE (for future):
When you're ready to push key plan data into GHL via their API,
the structure to sync per client would be:

  POST https://rest.gohighlevel.com/v1/contacts/
  Headers: { Authorization: "Bearer YOUR_GHL_API_KEY" }
  Body: {
    firstName: client.name.split(' ')[0],
    lastName:  client.name.split(' ').slice(1).join(' '),
    email:     client.email,
    customField: [
      { id: 'GHL_FIELD_ID_FOR_PILLAR',    value: client.tp3_pillar },
      { id: 'GHL_FIELD_ID_FOR_GOAL',      value: client.goal_statement },
      { id: 'GHL_FIELD_ID_FOR_METRIC',    value: client.metric_name },
      { id: 'GHL_FIELD_ID_FOR_WEEK',      value: currentWeek },
    ]
  }

You'd need: your GHL API key + the custom field IDs from GHL Settings.
─────────────────────────────────────────────────────────────────────────────
*/
