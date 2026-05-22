/**
 * GPS Portal — Test Profile Cleanup Script
 * ─────────────────────────────────────────
 * PURPOSE: One-time hard delete of dummy / test profiles.
 *
 * USAGE:
 *   1. Install dependencies (one time):
 *        npm install @supabase/supabase-js
 *
 *   2. Set your credentials in the CONFIGURATION block below (or use env vars).
 *
 *   3. Run in DRY-RUN mode first to see what would be deleted:
 *        node scripts/cleanup-test-profiles.js --dry-run
 *
 *   4. When you're satisfied, run for real:
 *        node scripts/cleanup-test-profiles.js
 *
 * WHAT IT DELETES:
 *   Profiles whose name OR email contains any of the TEST_PATTERNS below.
 *   Edit TEST_PATTERNS to match your actual dummy data.
 *
 * SAFETY: Always does a dry-run preview and asks for confirmation before deleting.
 */

const { createClient } = require('@supabase/supabase-js');
const readline = require('readline');

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://pbnkefuqpoztcxfagiod.supabase.co';
const SUPABASE_ANON = process.env.SUPABASE_ANON || 'YOUR_SUPABASE_ANON_KEY'; // use env var in prod

// Profiles matching ANY of these patterns (case-insensitive) will be deleted.
// Add or remove patterns to match your test data.
const TEST_PATTERNS = [
  'test',
  'dummy',
  'fake',
  'sample',
  'who knew',      // your specific test client names
  'su nu',
  'new su',
];
// ────────────────────────────────────────────────────────────────────────────

const db = createClient(SUPABASE_URL, SUPABASE_ANON);
const isDryRun = process.argv.includes('--dry-run');

function matchesTestPattern(client) {
  const haystack = `${client.name || ''} ${client.email || ''} ${client.organization || ''}`.toLowerCase();
  return TEST_PATTERNS.some(p => haystack.includes(p.toLowerCase()));
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main() {
  console.log('\n🔍 GPS Portal — Test Profile Cleanup');
  console.log(isDryRun ? '   MODE: DRY RUN (nothing will be deleted)\n' : '   MODE: LIVE DELETE\n');

  const { data: clients, error } = await db.from('clients').select('id, name, email, organization, created_at');
  if (error) { console.error('❌ Failed to fetch clients:', error.message); process.exit(1); }

  const toDelete = clients.filter(matchesTestPattern);

  if (toDelete.length === 0) {
    console.log('✅ No profiles matched the test patterns. Nothing to delete.');
    return;
  }

  console.log(`Found ${toDelete.length} profile(s) matching test patterns:\n`);
  toDelete.forEach(c => {
    console.log(`  • ${c.name || '(no name)'}  |  ${c.email || '(no email)'}  |  ${c.organization || ''}  |  created: ${c.created_at?.split('T')[0]}`);
  });

  if (isDryRun) {
    console.log('\n📋 Dry run complete. Run without --dry-run to delete these profiles.');
    return;
  }

  const answer = await prompt(`\n⚠️  Delete ALL ${toDelete.length} profile(s) permanently? Type YES to confirm: `);
  if (answer.trim() !== 'YES') {
    console.log('Cancelled. Nothing was deleted.');
    return;
  }

  let deleted = 0;
  for (const client of toDelete) {
    // Delete check-ins first (no CASCADE set up in DB)
    await db.from('checkins').delete().eq('client_id', client.id);
    const { error: delErr } = await db.from('clients').delete().eq('id', client.id);
    if (delErr) {
      console.error(`  ❌ Failed to delete ${client.name}: ${delErr.message}`);
    } else {
      console.log(`  ✅ Deleted: ${client.name}`);
      deleted++;
    }
  }

  console.log(`\n✅ Done. ${deleted}/${toDelete.length} profile(s) permanently deleted.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
