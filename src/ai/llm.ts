// Local AI for GrantScout: mission embeddings (Fit scoring) and mission extraction, both through Ollama on the
// Mac Mini. No paid API is called from here. Without OLLAMA_BASE_URL (development, tests) embeddings fall back
// to a deterministic keyword mock and extraction is skipped.
import { createHash } from 'crypto';
import { config } from '../core/config.js';

const embeddingCache = new Map<string, number[]>();

/** 'real' once an Ollama embedding has succeeded, 'mock' once we fell back; never mixed within one process. */
let embedMode: 'unknown' | 'real' | 'mock' = 'unknown';

/** Test hook: forget the cache and the chosen mode. */
export function resetEmbeddingState(): void {
  embeddingCache.clear();
  embedMode = 'unknown';
}

async function ollamaEmbed(text: string): Promise<number[]> {
  const res = await fetch(`${config.ollamaBaseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.embedModel, input: text }),
    signal: AbortSignal.timeout(config.llmTimeoutMs),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { embeddings?: number[][] };
  const values = json.embeddings?.[0];
  if (!values || values.length === 0) throw new Error('ollama embed: empty response');
  return values;
}

/**
 * Embedding for an organisation's mission text, used for Fit scoring (mission ↔ ICP centroid similarity).
 * Real embeddings need OLLAMA_BASE_URL and EMBED_MODEL. If the very first call fails the process uses the
 * keyword mock throughout; a failure after a success throws, so real and mock vectors are never compared.
 */
export async function embedMission(mission: string): Promise<number[]> {
  if (!mission) return getMockEmbedding('');

  const hash = createHash('sha256').update(mission).digest('hex');
  const cached = embeddingCache.get(hash);
  if (cached) return cached;

  let embedding: number[];
  const configured = !!(config.ollamaBaseUrl && config.embedModel);
  if (configured && embedMode !== 'mock') {
    try {
      embedding = await ollamaEmbed(mission);
      embedMode = 'real';
    } catch (e) {
      if (embedMode === 'real') throw e;
      console.warn(`[llm] embeddings unavailable, using the keyword mock for this run: ${(e as Error).message}`);
      embedMode = 'mock';
      embedding = getMockEmbedding(mission);
    }
  } else {
    embedMode = 'mock';
    embedding = getMockEmbedding(mission);
  }

  embeddingCache.set(hash, embedding);
  return embedding;
}

/** Which scoring model produced the Fit numbers; stored on every AccountScore. */
export function embeddingModelVersion(): string {
  return embedMode === 'real' ? `ollama:${config.embedModel}` : 'keyword-v1';
}

/** Deterministic mock embedding based on mission keyword presence. */
function getMockEmbedding(mission: string): number[] {
  const keywords = {
    env: ['environment', 'sustainability', 'climate', 'green', 'ecological'],
    health: ['health', 'medical', 'care', 'disease', 'disability', 'wellness'],
    education: ['education', 'learning', 'school', 'training', 'knowledge'],
    social: ['social', 'poverty', 'disadvantaged', 'marginalized', 'equity'],
    humanitarian: ['humanitarian', 'disaster', 'emergency', 'relief', 'crisis'],
  };
  const words = mission.toLowerCase().split(/\s+/);
  const scores = Object.values(keywords).map((ks) => words.filter((w) => ks.some((k) => w.includes(k))).length);
  const total = scores.reduce((a, b) => a + b, 0);
  return scores.map((s) => (total > 0 ? s / Math.max(total, 1) : 0.2));
}

/** Cosine similarity between two embeddings. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const minLen = Math.min(a.length, b.length);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < minLen; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** ICP centroid: the average embedding of the seed missions. */
export async function computeICPCentroid(seedMissions: string[]): Promise<number[]> {
  if (seedMissions.length === 0) return getMockEmbedding('education social humanitarian');
  const embeddings: number[][] = [];
  for (const m of seedMissions) embeddings.push(await embedMission(m)); // sequential: one local GPU
  const dims = embeddings[0]?.length || 0;
  const centroid: number[] = [];
  for (let i = 0; i < dims; i++) {
    centroid.push(embeddings.reduce((sum, emb) => sum + (emb[i] || 0), 0) / embeddings.length);
  }
  return centroid;
}

/** Fit score: similarity between an organisation's mission embedding and the ICP centroid. */
export async function computeFitScore(orgMission: string, icpCentroid: number[]): Promise<number> {
  return cosineSimilarity(await embedMission(orgMission), icpCentroid);
}

/**
 * Extract a concise mission (doelstelling) for an organisation from scraped website text with the local model.
 * Returns undefined when no model is configured, on any error, or when the model cannot tell.
 */
export async function extractDoelstelling(orgName: string, pageText: string): Promise<string | undefined> {
  if (!config.ollamaBaseUrl || !config.llmModel || !pageText.trim()) return undefined;
  const prompt =
    `Hieronder staat websitetekst van de Nederlandse goededoelenorganisatie "${orgName}". ` +
    `Geef in een bondige zin (in het Nederlands) de doelstelling/missie van de organisatie. ` +
    `Als de tekst geen duidelijke doelstelling bevat, antwoord exact: ONBEKEND.\n\nTekst:\n` +
    pageText.slice(0, 5000);
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.llmModel,
        stream: false,
        // A thinking model (gemma4) otherwise spends the whole output budget reasoning and returns an empty answer.
        think: false,
        messages: [{ role: 'user', content: prompt }],
        options: { temperature: 0, num_predict: 300 },
      }),
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { message?: { content?: string } };
    const text = json.message?.content?.trim();
    if (!text || /^onbekend/i.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** Liveness of the Ollama server (health endpoint). */
export async function ollamaReachable(timeoutMs = 4000): Promise<boolean | null> {
  if (!config.ollamaBaseUrl) return null;
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}
