-- Migration: Single table remote_access with type (neocore | device)
-- Port 80 for HTTP, 5001 for WebSocket (fixed in app)
-- One row per NeoCore instance or per Device; site_id FK to sites

-- If you have an existing remote_access table with different columns, adjust or drop first.
-- Example for a fresh table:

CREATE TABLE IF NOT EXISTS remote_access (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('neocore', 'device')),
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INT,
  ip VARCHAR(45),
  CONSTRAINT uq_remote_access_site_type_slug UNIQUE (site_id, type, slug)
);

CREATE INDEX IF NOT EXISTS idx_remote_access_site_id ON remote_access(site_id);
CREATE INDEX IF NOT EXISTS idx_remote_access_type ON remote_access(type);
CREATE INDEX IF NOT EXISTS idx_remote_access_active ON remote_access(is_active) WHERE is_active = true;

-- Example rows:
-- INSERT INTO remote_access (site_id, type, slug, name, ip, display_order) VALUES
--   (1, 'neocore', '0', 'NeoCore 0', '10.9.0.5', 0),
--   (1, 'neocore', '1', 'NeoCore 1', '10.9.0.6', 1),
--   (1, 'device', 'device1', 'Edge Device', '172.16.2.100', 0),
--   (1, 'device', 'device2', 'Device 2', '172.16.2.101', 1);
