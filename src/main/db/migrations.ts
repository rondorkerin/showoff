/**
 * Numbered, append-only migrations. Never edit a shipped migration — v1 users'
 * archives have to survive every version after it.
 */
export interface Migration {
  id: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  context     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recordings (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  dir         TEXT NOT NULL,
  duration_ms INTEGER,
  width       INTEGER,
  height      INTEGER,
  poster_path TEXT,
  status      TEXT NOT NULL DEFAULT 'recording',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recordings_project_idx ON recordings (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recordings_created_idx ON recordings (created_at DESC);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  path         TEXT NOT NULL,
  duration_ms  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracks_recording_idx ON tracks (recording_id);

CREATE TABLE IF NOT EXISTS transcripts (
  id           TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  language     TEXT,
  text         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transcripts_recording_idx ON transcripts (recording_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id            TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  text          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_transcript_idx ON transcript_segments (transcript_id, start_ms);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  recording_id TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_recording_idx ON notes (recording_id);
CREATE INDEX IF NOT EXISTS notes_project_idx ON notes (project_id);

CREATE TABLE IF NOT EXISTS clips (
  id           TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  hashtags     JSONB NOT NULL DEFAULT '[]'::jsonb,
  hook         TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT '',
  score        REAL NOT NULL DEFAULT 5,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  rank         INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clips_recording_idx ON clips (recording_id, rank);

CREATE TABLE IF NOT EXISTS clip_renders (
  id          TEXT PRIMARY KEY,
  clip_id     TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  poster_path TEXT,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  bytes       BIGINT NOT NULL DEFAULT 0,
  captions    BOOLEAN NOT NULL DEFAULT false,
  webcam_pip  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS renders_clip_idx ON clip_renders (clip_id);

CREATE TABLE IF NOT EXISTS tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS recording_tags (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  tag_id       TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (recording_id, tag_id)
);

CREATE TABLE IF NOT EXISTS embeddings (
  id           TEXT PRIMARY KEY,
  recording_id TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  ref_id       TEXT,
  text         TEXT NOT NULL,
  start_ms     INTEGER,
  end_ms       INTEGER,
  embedding    vector(768),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS embeddings_recording_idx ON embeddings (recording_id);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  recording_id TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  stage        TEXT,
  progress     REAL NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_recording_idx ON jobs (recording_id, created_at DESC);
`
  },
  {
    id: 2,
    name: 'fulltext',
    sql: `
-- Lexical search sits alongside the vector search: exact product names and
-- error strings are what people actually type, and embeddings are bad at those.
CREATE INDEX IF NOT EXISTS transcripts_fts_idx
  ON transcripts USING GIN (to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS segments_fts_idx
  ON transcript_segments USING GIN (to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS notes_fts_idx
  ON notes USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,'')));
`
  },
  {
    id: 3,
    name: 'answers',
    sql: `
-- The clarifying-question answers are part of the record: they explain why a
-- cut came out the way it did, and they seed the next recording's context.
CREATE TABLE IF NOT EXISTS recording_answers (
  id           TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS answers_recording_idx ON recording_answers (recording_id);
`
  }
]
