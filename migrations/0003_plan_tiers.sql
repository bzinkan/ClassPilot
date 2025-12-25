ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS plan_tier text NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS active_until timestamp;

UPDATE schools
SET plan_status = 'active'
WHERE plan_status = 'trialing';
