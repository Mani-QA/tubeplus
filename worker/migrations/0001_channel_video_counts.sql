-- Backfill channels.n from the live video rows.
-- The Worker's drawer, search placeholder, and unfiltered result counts
-- read this column instead of scanning videos. Daily ingest keeps it
-- updated after this. Safe to re-run.
UPDATE channels SET n = (
  SELECT COUNT(*) FROM videos WHERE videos.channel_id = channels.id
);
