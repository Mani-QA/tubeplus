-- TubePlus v3 migration — apply ONCE to a D1 that already has the v1/v2
-- seeds (the live database). Fresh rebuilds use data/schema.sql, which
-- already includes these columns/tables, so this file is NOT for them.
--
-- Apply from the box: npx wrangler d1 execute tubeplus-db --remote --file=data/migrate_v3.sql
-- (Do NOT run against a fresh rebuild — the ALTER will fail because the
-- column already exists there.)

-- Part A — RSS freshness: when a video was published (from the RSS feed).
-- Seed videos stay NULL (the snapshot has no publish dates).
ALTER TABLE videos ADD COLUMN published_at TEXT;

-- A channel's category is a property of the channel (the per-video
-- category_id comes from it). Backfilled by backfill_channel_category.sql.
ALTER TABLE channels ADD COLUMN category_id INTEGER;

-- Part D — public playlists (no login; the creator holds an edit token).
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  slug TEXT,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edit_token TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_videos (
  playlist_id TEXT NOT NULL REFERENCES playlists(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(published_at);
CREATE INDEX IF NOT EXISTS idx_playlist_videos_playlist ON playlist_videos(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_playlists_created ON playlists(created_at DESC);
