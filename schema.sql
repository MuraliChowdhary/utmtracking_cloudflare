-- Database schema for URL shortener
CREATE TABLE IF NOT EXISTS urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shortId TEXT UNIQUE NOT NULL,
  originalUrl TEXT NOT NULL,
  totalClicks INTEGER DEFAULT 0,
  uniqueClicks INTEGER DEFAULT 0,
  visitorDetails TEXT DEFAULT '[]',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_shortId ON urls(shortId);