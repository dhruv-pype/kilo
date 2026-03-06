import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getEmbedding, chunkText } from '../../knowledge/embedding-service.js';
import * as chunkRepo from '../../database/repositories/chunk-repository.js';

/**
 * Document routes — ingest and manage knowledge documents for a bot.
 *
 * POST /api/bots/:botId/documents        — Ingest a document (chunked + embedded)
 * GET  /api/bots/:botId/documents        — List all documents
 * DELETE /api/bots/:botId/documents/:documentId — Delete a document
 */
export function documentRoutes(app: FastifyInstance, openaiApiKey: string): void {

  // POST /api/bots/:botId/documents
  app.post<{
    Params: { botId: string };
    Body: { name: string; content: string };
  }>('/api/bots/:botId/documents', async (request, reply) => {
    const { botId } = request.params;
    const { name, content } = request.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'name is required' });
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.code(400).send({ error: 'content is required' });
    }
    if (!openaiApiKey) {
      return reply.code(503).send({ error: 'OpenAI API key not configured — embeddings unavailable' });
    }

    const documentId = uuidv4();
    const chunks = chunkText(content);

    if (chunks.length === 0) {
      return reply.code(400).send({ error: 'Content produced no usable chunks' });
    }

    // Embed and insert each chunk (sequentially to avoid rate-limit bursts)
    let inserted = 0;
    for (const chunk of chunks) {
      try {
        const embedding = await getEmbedding(chunk, openaiApiKey);
        await chunkRepo.insertChunk(botId, documentId, name.trim(), chunk, embedding);
        inserted++;
      } catch (err) {
        console.error('[documents] Chunk embedding failed:', (err as Error).message);
        // Continue with remaining chunks
      }
    }

    if (inserted === 0) {
      return reply.code(502).send({ error: 'All chunks failed to embed — check OpenAI API key' });
    }

    return reply.code(201).send({
      documentId,
      name: name.trim(),
      totalChunks: chunks.length,
      insertedChunks: inserted,
    });
  });

  // GET /api/bots/:botId/documents
  app.get<{
    Params: { botId: string };
  }>('/api/bots/:botId/documents', async (request) => {
    const { botId } = request.params;
    const docs = await chunkRepo.listDocuments(botId);
    return { documents: docs };
  });

  // DELETE /api/bots/:botId/documents/:documentId
  app.delete<{
    Params: { botId: string; documentId: string };
  }>('/api/bots/:botId/documents/:documentId', async (request, reply) => {
    const { botId, documentId } = request.params;
    await chunkRepo.deleteDocument(botId, documentId);
    return reply.code(204).send();
  });
}
