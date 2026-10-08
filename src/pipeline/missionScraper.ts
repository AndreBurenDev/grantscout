import { extractDoelstelling } from '../ai/llm.js';

const FETCH_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 8000);

/** Strip HTML to readable text (best-effort, no DOM). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch a URL and return its visible text, or undefined on any failure. */
export async function fetchPageText(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GrantScout/1.0)' },
    });
    if (!res.ok) return undefined;
    const html = await res.text();
    const text = htmlToText(html);
    return text.length > 50 ? text : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort: scrape an org's website and return a concise doelstelling.
 * Falls back to a trimmed snippet of the page text if LLM extraction is
 * unavailable, and to undefined if the site can't be read at all.
 */
export async function scrapeDoelstelling(
  orgName: string,
  website: string,
): Promise<string | undefined> {
  const text = await fetchPageText(website);
  if (!text) return undefined;
  const extracted = await extractDoelstelling(orgName, text);
  return extracted || text.slice(0, 280);
}
