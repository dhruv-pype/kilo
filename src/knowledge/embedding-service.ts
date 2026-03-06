/**
 * Embedding service — generates vector embeddings for text using OpenAI.
 *
 * Uses raw fetch (same pattern as the OpenAI provider in llm-gateway/providers/openai.ts).
 * Model: text-embedding-3-small (1536 dimensions, fast and cheap).
 */

const EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/**
 * Get a 1536-dimension embedding vector for the given text.
 * Throws if the API call fails.
 */
export async function getEmbedding(text: string, apiKey: string): Promise<number[]> {
  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.trim(),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Embedding API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { data: { embedding: number[] }[] };
  const embedding = data.data[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Embedding API returned unexpected response shape');
  }
  return embedding;
}

/**
 * Split text into chunks of approximately `maxChars` characters.
 * Splits on paragraph boundaries (double newlines) where possible,
 * falling back to sentence boundaries, then character limits.
 */
export function chunkText(text: string, maxChars = 1500): string[] {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // Paragraph itself is too long — split by sentences
      const sentences = para.match(/[^.!?]+[.!?]+/g) ?? [para];
      for (const sentence of sentences) {
        if ((current + ' ' + sentence).length > maxChars && current.length > 0) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          current = current ? current + ' ' + sentence : sentence;
        }
      }
    } else if ((current + '\n\n' + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}
