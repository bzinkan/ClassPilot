-- Add Super Admin configurable tracking hours to schools table
-- These fields allow Super Admin to set per-school monitoring windows

-- Tracking start hour (0-23), default 7 AM
ALTER TABLE schools ADD COLUMN IF NOT EXISTS tracking_start_hour integer NOT NULL DEFAULT 7;

-- Tracking end hour (0-23), default 5 PM (17:00)
ALTER TABLE schools ADD COLUMN IF NOT EXISTS tracking_end_hour integer NOT NULL DEFAULT 17;

-- Premium feature: 24/7 monitoring (overrides start/end hours)
ALTER TABLE schools ADD COLUMN IF NOT EXISTS is_24_hour_enabled boolean NOT NULL DEFAULT false;

-- School timezone for tracking hour calculations (IANA format)
ALTER TABLE schools ADD COLUMN IF NOT EXISTS school_timezone text NOT NULL DEFAULT 'America/New_York';
