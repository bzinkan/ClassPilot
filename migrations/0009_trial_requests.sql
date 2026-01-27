-- Trial Requests table: Schools requesting to start a free trial
-- Super Admin reviews these requests and manually sets up school accounts

CREATE TABLE IF NOT EXISTS trial_requests (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  school_name TEXT NOT NULL,
  school_domain TEXT NOT NULL,
  admin_first_name TEXT NOT NULL,
  admin_last_name TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  admin_phone TEXT,
  estimated_students TEXT,
  estimated_teachers TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'contacted', 'converted', 'declined'
  notes TEXT, -- Super admin notes about this request
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP, -- When super admin processed this request
  processed_by TEXT -- Super admin user ID who processed it
);

-- Index for quick lookup of pending requests
CREATE INDEX IF NOT EXISTS trial_requests_status_idx ON trial_requests(status);

-- Index for searching by email
CREATE INDEX IF NOT EXISTS trial_requests_email_idx ON trial_requests(LOWER(admin_email));
