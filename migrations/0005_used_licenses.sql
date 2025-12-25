ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS used_licenses integer NOT NULL DEFAULT 0;

UPDATE schools
SET used_licenses = student_counts.count
FROM (
  SELECT school_id, count(*)::integer AS count
  FROM students
  GROUP BY school_id
) AS student_counts
WHERE schools.id = student_counts.school_id;
