-- Table for tracking Telegram forum topics / event folders
CREATE TABLE IF NOT EXISTS topics (
  topic_id INTEGER PRIMARY KEY,
  topic_name TEXT NOT NULL
);

-- Table for storing photo and video metadata
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_unique_id TEXT UNIQUE,
  thumb_file_id TEXT NOT NULL,
  full_file_id TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  caption TEXT,
  sender TEXT,
  topic_id INTEGER DEFAULT 0,
  topic_name TEXT DEFAULT 'General',
  created_at INTEGER,
  media_type TEXT DEFAULT 'photo',
  duration INTEGER DEFAULT 0,
  message_id INTEGER DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_photos_topic ON photos(topic_id);
CREATE INDEX IF NOT EXISTS idx_photos_created ON photos(created_at DESC);
