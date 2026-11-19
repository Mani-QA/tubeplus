-- Support id-first listing queries that filter a channel then sort by views,
-- used by watch-page "more from this channel" and /channel pages.
-- IF NOT EXISTS so this is safe to re-run.
CREATE INDEX IF NOT EXISTS idx_videos_channel_views ON videos(channel_id, views DESC);
