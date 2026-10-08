import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { config } from '../src/core/config.js';
import { embedMission, embeddingModelVersion, extractDoelstelling, ollamaReachable, resetEmbeddingState } from '../src/ai/llm.js';

const cfg = config as { ollamaBaseUrl: string; llmModel: string; embedModel: string };
const saved = { ...cfg };

beforeEach(() => resetEmbeddingState());
afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(cfg, { ollamaBaseUrl: saved.ollamaBaseUrl, llmModel: saved.llmModel, embedModel: saved.embedModel });
});

function stubFetch(handler: (url: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    return handler(url, body);
  }));
  return calls;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

describe('extractDoelstelling', () => {
  it('does nothing without a configured model', async () => {
    cfg.ollamaBaseUrl = ''; cfg.llmModel = '';
    const calls = stubFetch(() => json({}));
    expect(await extractDoelstelling('Org', 'tekst')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('asks the local model with thinking disabled and returns its answer', async () => {
    cfg.ollamaBaseUrl = 'http://ollama.test'; cfg.llmModel = 'gemma4';
    const calls = stubFetch(() => json({ message: { content: '  Hulp aan kinderen in oorlog.  ' } }));
    expect(await extractDoelstelling('War Child', 'websitetekst')).toBe('Hulp aan kinderen in oorlog.');
    expect(calls[0].url).toBe('http://ollama.test/api/chat');
    // A thinking model otherwise spends the whole token budget reasoning and returns an empty answer.
    expect(calls[0].body).toMatchObject({ model: 'gemma4', stream: false, think: false });
  });

  it('returns undefined for an empty answer, ONBEKEND, an HTTP error and a network failure', async () => {
    cfg.ollamaBaseUrl = 'http://ollama.test'; cfg.llmModel = 'gemma4';
    stubFetch(() => json({ message: { content: '' }, done_reason: 'length' }));
    expect(await extractDoelstelling('Org', 'tekst')).toBeUndefined();
    stubFetch(() => json({ message: { content: 'ONBEKEND.' } }));
    expect(await extractDoelstelling('Org', 'tekst')).toBeUndefined();
    stubFetch(() => json({ error: 'boom' }, 500));
    expect(await extractDoelstelling('Org', 'tekst')).toBeUndefined();
    stubFetch(() => { throw new Error('ECONNREFUSED'); });
    expect(await extractDoelstelling('Org', 'tekst')).toBeUndefined();
  });

  it('skips blank page text', async () => {
    cfg.ollamaBaseUrl = 'http://ollama.test'; cfg.llmModel = 'gemma4';
    const calls = stubFetch(() => json({}));
    expect(await extractDoelstelling('Org', '   ')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('embedMission', () => {
  it('uses the keyword mock when no embedding model is configured', async () => {
    cfg.ollamaBaseUrl = 'http://ollama.test'; cfg.embedModel = '';
    const calls = stubFetch(() => json({}));
    expect(await embedMission('education for children')).toHaveLength(5);
    expect(calls).toHaveLength(0);
    expect(embeddingModelVersion()).toBe('keyword-v1');
  });

  it('uses Ollama embeddings when configured, and caches per text', async () => {
    cfg.ollamaBaseUrl = 'http://ollama.test'; cfg.embedModel = 'embed-x';
    const calls = stubFetch(() => json({ embeddings: [[0.1, 0.2, 0.3]] }));
    expect(await embedMission('a mission')).toEqual([0.1, 0.2, 0.3]);
    expect(await embedMission('a mission')).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'http://ollama.test/api/embed', body: { model: 'embed-x', input: 'a mission' } });
    expect(embeddingModelVersion()).toBe('ollama:embed-x');
  });

  it('falls back to the mock for the whole run when the first call fails', async () => {
    cfg.ollamaBaseUrl = 'http://ollama.test'; cfg.embedModel = 'embed-x';
    const calls = stubFetch(() => json({ error: 'This server does not support embeddings' }, 501));
    expect(await embedMission('health care')).toHaveLength(5);
    expect(await embedMission('climate')).toHaveLength(5);
    expect(calls).toHaveLength(1); // it does not keep hammering a server that cannot embed
    expect(embeddingModelVersion()).toBe('keyword-v1');
  });

  it('throws rather than mixing real and mock vectors when a later call fails', async () => {
    cfg.ollamaBaseUrl = 'http://ollama.test'; cfg.embedModel = 'embed-x';
    let n = 0;
    stubFetch(() => (++n === 1 ? json({ embeddings: [[1, 0, 0]] }) : json({ error: 'gone' }, 500)));
    await embedMission('first');
    await expect(embedMission('second')).rejects.toThrow(/ollama embed 500/);
  });
});

describe('ollamaReachable', () => {
  it('is null when not configured, true on 2xx, false otherwise', async () => {
    cfg.ollamaBaseUrl = '';
    expect(await ollamaReachable()).toBeNull();
    cfg.ollamaBaseUrl = 'http://ollama.test';
    stubFetch(() => json({ version: '1' }));
    expect(await ollamaReachable()).toBe(true);
    stubFetch(() => { throw new Error('refused'); });
    expect(await ollamaReachable()).toBe(false);
  });
});
