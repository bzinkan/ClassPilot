ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS plan_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS disabled_at timestamp,
  ADD COLUMN IF NOT EXISTS disabled_reason text,
  ADD COLUMN IF NOT EXISTS school_session_version integer NOT NULL DEFAULT 1;

UPDATE schools
SET
  is_active = CASE WHEN status = 'suspended' THEN false ELSE is_active END,
  plan_status = CASE
    WHEN status = 'trial' THEN 'trialing'
    WHEN status = 'suspended' THEN 'canceled'
    ELSE plan_status
  END;
