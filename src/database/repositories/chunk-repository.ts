import { query } from '../pool.js';
import type { RAGChunk } from '../../common/types/orchestrator.js';

export interface DocumentInfo {
  documentId: string;
  documentName: string;
  chunkCount: number;
  createdAt: Date;
}

export async function insertChunk(
  botId: string,
  documentId: string,
  documentName: string,
  content: string,
  embedding: number[],
): Promise<void> {
  // pgvector expects the embedding as a formatted array string: '[0.1,0.2,...]'
  const embeddingStr = `[${embedding.join(',')}]`;
  await query(
    `INSERT INTO document_chunks (bot_id, document_id, document_name, content, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)`,
    [botId, documentId, documentName, content, embeddingStr],
  );
}

/**
 * Search for the most similar chunks using cosine similarity.
 * Returns chunks sorted by relevance (most similar first).
 */
export async function searchChunks(
  botId: string,
  embedding: number[],
  limit = 5,
): Promise<RAGChunk[]> {
  const embeddingStr = `[${embedding.join(',')}]`;
  const result = await query<{
    content: string;
    document_id: string;
    document_name: string;
    relevance_score: number;
  }>(
    `SELECT content,
            document_id::text,
            document_name,
            1 - (embedding <=> $2::vector) AS relevance_score
     FROM document_chunks
     WHERE bot_id = $1
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [botId, embeddingStr, limit],
  );

  return result.rows.map((r) => ({
    content: r.content,
    documentId: r.document_id,
    relevanceScore: r.relevance_score,
  }));
}

/**
 * List all documents for a bot (grouped by document_id).
 */
export async function listDocuments(botId: string): Promise<DocumentInfo[]> {
  const result = await query<{
    document_id: string;
    document_name: string;
    chunk_count: string;
    created_at: Date;
  }>(
    `SELECT document_id::text,
            document_name,
            COUNT(*)::text AS chunk_count,
            MIN(created_at) AS created_at
     FROM document_chunks
     WHERE bot_id = $1
     GROUP BY document_id, document_name
     ORDER BY MIN(created_at) DESC`,
    [botId],
  );

  return result.rows.map((r) => ({
    documentId: r.document_id,
    documentName: r.document_name,
    chunkCount: parseInt(r.chunk_count, 10),
    createdAt: r.created_at,
  }));
}

/**
 * Delete all chunks for a document.
 */
export async function deleteDocument(botId: string, documentId: string): Promise<void> {
  await query(
    `DELETE FROM document_chunks WHERE bot_id = $1 AND document_id = $2`,
    [botId, documentId],
  );
}
