ALTER TABLE settings ADD COLUMN IF NOT EXISTS after_hours_mode text NOT NULL DEFAULT 'off';
