-- Mailhop D1 (SQLite) schema
-- --------------------------
-- Table: aliases
--  - Each row defines a forward rule from an alias (under example.com)
--    to a real destination address.
--  - We normalize and compare addresses case-insensitively.

CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The full alias address (e.g., "alias@example.com")
  -- Store in lowercase; enforce uniqueness case-insensitively.
  address TEXT UNIQUE NOT NULL COLLATE NOCASE,

  -- The real destination (e.g., "destination@example.net"), stored lowercase as well.
  forward_to TEXT NOT NULL,

  -- Optional notes for the user/CLI.
  notes TEXT,

  -- Unix seconds; consistent with server code (Math.floor(Date.now()/1000)).
  created_at INTEGER DEFAULT (strftime('%s', 'now')),

  -- NEW (optional): when 1, allow base alias to match plus-address forms.
  -- If you don't need to toggle this per-alias, you can omit this column.
  allow_plus INTEGER NOT NULL DEFAULT 1
);

-- Fast lookups by alias address.
CREATE INDEX IF NOT EXISTS idx_address ON aliases (address);

-- Helpful when listing all aliases for a destination.
CREATE INDEX IF NOT EXISTS idx_forward_to ON aliases (forward_to);

-- Persistent, capped email routing logs
CREATE TABLE IF NOT EXISTS email_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,                   -- unix seconds
  message_id  TEXT,
  from_addr   TEXT,
  to_addr     TEXT,
  route       TEXT,                               -- exact | base+tag | none | invalid-domain | exception
  base_addr   TEXT,                               -- present for base+tag
  dest_addr   TEXT,                               -- forward_to when forwarding
  result      TEXT,                               -- forwarded | rejected | error | loop-rejected
  size_bytes  INTEGER,
  error       TEXT                                -- optional error string
);

-- Keep only the most recent N rows (change 10000 to your preferred cap)
CREATE TRIGGER IF NOT EXISTS email_logs_cap
AFTER INSERT ON email_logs
BEGIN
  DELETE FROM email_logs
  WHERE id NOT IN (
    SELECT id FROM email_logs ORDER BY id DESC LIMIT 10000
  );
END;

