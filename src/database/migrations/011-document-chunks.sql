-- Migration 011: Document chunks with pgvector for RAG
-- Stores text chunks and their embeddings for similarity search.
-- Requires the pgvector extension (available on Supabase, Neon, RDS with pgvector).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_chunks (
  chunk_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  document_id   UUID NOT NULL,
  document_name TEXT NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_chunks_bot_id    ON document_chunks(bot_id);
CREATE INDEX idx_document_chunks_doc_id    ON document_chunks(document_id);

-- HNSW index for fast approximate nearest-neighbor search (pgvector >= 0.5)
-- Works on empty tables and does not require tuning a `lists` parameter.
CREATE INDEX idx_document_chunks_embedding ON document_chunks
  USING hnsw (embedding vector_cosine_ops);
