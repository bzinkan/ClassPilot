ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS max_licenses integer DEFAULT 100;

UPDATE schools
SET max_licenses = 100
WHERE max_licenses IS NULL;
