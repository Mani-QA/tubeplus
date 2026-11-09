CREATE TABLE categories (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, tier TEXT NOT NULL, tag TEXT, blurb TEXT, featured TEXT, n INTEGER NOT NULL, category_id INTEGER);
CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT, duration_s INTEGER, views INTEGER, channel_id INTEGER NOT NULL REFERENCES channels(id), category_id INTEGER NOT NULL REFERENCES categories(id), published_at TEXT);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE video_tags (video_id TEXT NOT NULL REFERENCES videos(id), tag_id INTEGER NOT NULL REFERENCES tags(id), PRIMARY KEY (video_id, tag_id));
CREATE INDEX idx_videos_channel ON videos(channel_id);
CREATE INDEX idx_videos_category ON videos(category_id);
CREATE INDEX idx_videos_views ON videos(views DESC);
CREATE INDEX idx_video_tags_tag ON video_tags(tag_id);
CREATE INDEX idx_videos_published ON videos(published_at);

-- v3: public playlists (no login; the creator holds an edit token).
CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  slug TEXT,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edit_token TEXT NOT NULL
);

CREATE TABLE playlist_videos (
  playlist_id TEXT NOT NULL REFERENCES playlists(id),
  video_id TEXT NOT NULL REFERENCES videos(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);

CREATE INDEX idx_playlist_videos_playlist ON playlist_videos(playlist_id, position);
CREATE INDEX idx_playlists_created ON playlists(created_at DESC);
