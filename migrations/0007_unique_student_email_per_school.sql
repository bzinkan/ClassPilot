-- Add unique constraint on school_id + email_lc to prevent duplicate students
-- This prevents race conditions during concurrent student registration

-- First, ensure email_lc is populated for all existing students
UPDATE students
SET email_lc = LOWER(student_email)
WHERE student_email IS NOT NULL AND email_lc IS NULL;

-- Create unique index on (school_id, email_lc)
-- Using email_lc for case-insensitive uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS students_school_email_unique
  ON students (school_id, email_lc)
  WHERE email_lc IS NOT NULL;

-- Add comment for documentation
COMMENT ON INDEX students_school_email_unique IS 'Ensures one student per email per school (case-insensitive)';
