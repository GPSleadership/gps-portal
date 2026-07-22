-- v111: renewal_config.sample_readout_url — Decision Room "See a sample readout" proof
--
-- P1 (frontier batch 5B). The Decision Room's sprint CTAs asked a sponsor to commit
-- $10k with no proof asset in sight. This adds an admin-editable link to a sample
-- readout (the Marcus Holt demo diagnostic by default) rendered beside the inline and
-- sticky CTAs. Editable, never hardcoded: clear the column to hide the link entirely;
-- point it at a sample PDF instead if Alex prefers (Section 6.3 input).

alter table public.renewal_config
  add column if not exists sample_readout_url text;

-- Seed with the existing Marcus Holt demo diagnostic (pending Alex's confirmation of
-- which sample asset to use). Only fills when empty — never overwrites an edit.
update public.renewal_config
   set sample_readout_url = 'https://portal.gpsleadership.org/diagnostic-leader?token=demo-mholt-ceo-ridgeline'
 where id = 1 and (sample_readout_url is null or sample_readout_url = '');

-- ROLLBACK
-- alter table public.renewal_config drop column if exists sample_readout_url;
