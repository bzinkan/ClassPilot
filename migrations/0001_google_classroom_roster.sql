-- IDs are stored as uuid in Postgres but modeled as strings in the app layer.
CREATE TABLE IF NOT EXISTS google_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  refresh_token text NOT NULL,
  scope text,
  token_type text,
  expiry_date timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS classroom_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id text NOT NULL,
  course_id text NOT NULL,
  name text NOT NULL,
  section text,
  room text,
  description_heading text,
  owner_id text,
  last_synced_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (school_id, course_id)
);

CREATE TABLE IF NOT EXISTS classroom_course_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id text NOT NULL,
  course_id text NOT NULL,
  student_id text NOT NULL,
  google_user_id text,
  student_email_lc text,
  created_at timestamp NOT NULL DEFAULT now(),
  last_seen_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (school_id, course_id, student_id)
);

CREATE INDEX IF NOT EXISTS classroom_course_students_school_course_idx
  ON classroom_course_students (school_id, course_id);

CREATE INDEX IF NOT EXISTS classroom_course_students_school_student_idx
  ON classroom_course_students (school_id, student_id);

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS google_user_id text;
