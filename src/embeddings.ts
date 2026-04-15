import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

const CHARS_PER_TOKEN = 4;

export interface Chunk {
  index: number;
  text: string;
}

export interface EmbeddedChunk extends Chunk {
  chunkIndex: number;
  embedding: number[];
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens?: number;
}

/**
 * Split a transcript into overlapping chunks suitable for embedding.
 *
 * Token count is approximated via character length (~4 chars/token for English).
 * Tries to break on sentence boundaries; falls back to word boundaries.
 */
export function chunkTranscript(text: string, options: ChunkOptions): Chunk[] {
  if (!text || !text.trim()) {
    throw new Error("chunkTranscript: input is empty");
  }

  const maxChars = options.maxTokens * CHARS_PER_TOKEN;
  const overlapChars = (options.overlapTokens ?? 0) * CHARS_PER_TOKEN;

  if (text.length <= maxChars) {
    return [{ index: 0, text: text.trim() }];
  }

  const chunks: Chunk[] = [];
  let cursor = 0;
  let chunkIndex = 0;

  while (cursor < text.length) {
    const end = Math.min(cursor + maxChars, text.length);
    let sliceEnd = end;

    if (end < text.length) {
      const window = text.slice(cursor, end);
      const sentenceMatch = window.match(/[.!?]\s[^.!?]*$/);
      if (sentenceMatch && sentenceMatch.index !== undefined) {
        sliceEnd = cursor + sentenceMatch.index + 1;
      } else {
        const lastSpace = window.lastIndexOf(" ");
        if (lastSpace > maxChars * 0.5) {
          sliceEnd = cursor + lastSpace;
        }
      }
    }

    const chunkText = text.slice(cursor, sliceEnd).trim();
    if (chunkText) {
      chunks.push({ index: chunkIndex++, text: chunkText });
    }

    if (sliceEnd >= text.length) break;

    const nextCursor = overlapChars > 0 ? Math.max(cursor + 1, sliceEnd - overlapChars) : sliceEnd;
    cursor = nextCursor;
  }

  return chunks;
}

export interface EmbeddingOptions {
  client: OpenAI;
  model?: string;
  retries?: number;
  retryDelayMs?: number;
}

export async function generateEmbeddings(
  chunks: Chunk[],
  options: EmbeddingOptions,
): Promise<EmbeddedChunk[]> {
  const model = options.model ?? EMBEDDING_MODEL;
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await options.client.embeddings.create({
        model,
        input: chunks.map((c) => c.text),
      });

      return response.data.map((item, i) => {
        if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Embedding dimension mismatch: got ${item.embedding.length}, expected ${EMBEDDING_DIMENSIONS}`,
          );
        }
        return {
          index: chunks[i].index,
          chunkIndex: chunks[i].index,
          text: chunks[i].text,
          embedding: item.embedding,
        };
      });
    } catch (err) {
      lastErr = err;
      if ((err as Error).message?.toLowerCase().includes("dimension")) throw err;
      const status = (err as { status?: number }).status;
      const retryable = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === retries - 1) throw err;
      const delay = retryDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}
