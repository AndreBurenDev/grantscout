import { organizationId, signalId } from '../../core/ids.js';
import type { Organization, Signal, Provenance } from '../../core/types.js';

export interface JobPosting {
  title: string;
  company?: string;
  description: string;
  postedDate?: string;
  url?: string;
}

/**
 * Extract hiring signals from job postings.
 * Identifies organizations actively recruiting for grants/fundraising roles.
 * Will use the local LLM to extract org name and role from unstructured job text.
 * TODO: Implement LLM extraction; for now returns mock results.
 */
export async function extractHiringSignals(
  jobPostings: JobPosting[],
  snapshotId: string
): Promise<{ orgs: Organization[]; signals: Signal[] }> {
  const now = new Date().toISOString();
  const orgs: Organization[] = [];
  const signals: Signal[] = [];
  const seenOrgIds = new Set<string>();

  for (const posting of jobPostings) {
    // TODO: Extract org name from posting.company or description via the local LLM
    // For now, use mock extraction based on keywords
    const extracted = extractOrgFromPosting(posting);

    if (!extracted) continue;

    const { orgName, country, confidence } = extracted;
    const canonicalId = organizationId(country, orgName);

    // Create org if not yet seen in this batch
    if (!seenOrgIds.has(canonicalId)) {
      seenOrgIds.add(canonicalId);

      const provenance: Provenance = {
        sourceId: 'hiring-nl',
        snapshotId,
        extractionMethod: 'llm',
        fetchedAt: now,
      };

      const org: Organization = {
        canonicalId,
        names: [orgName],
        type: 'ngo',
        country,
        identifiers: {},
        provenance: [provenance],
        confidence: { overall: confidence * 0.7, perField: { name: confidence * 0.7 } },
        createdAt: now,
        updatedAt: now,
      };

      orgs.push(org);
    }

    // Emit hiring signal
    const provenance: Provenance = {
      sourceId: 'hiring-nl',
      snapshotId,
      extractionMethod: 'llm',
      sourceUrl: posting.url,
      fetchedAt: now,
    };

    const postedDate = posting.postedDate || now;

    const signal: Signal = {
      id: signalId(canonicalId, 'hiring_grants_role', postedDate, 'hiring-nl'),
      orgId: canonicalId,
      type: 'hiring_grants_role',
      strength: 0.9, // High intent: actively recruiting
      occurredAt: postedDate,
      detectedAt: now,
      payload: {
        jobTitle: posting.title,
        jobUrl: posting.url,
        description: posting.description.slice(0, 500), // Truncate for storage
      },
      provenance,
      confidence: { overall: confidence * 0.7 },
    };

    signals.push(signal);
  }

  return { orgs, signals };
}

/**
 * Mock extraction of org from job posting.
 * TODO: Replace with real LLM extraction.
 */
function extractOrgFromPosting(posting: JobPosting): {
  orgName: string;
  country: string;
  confidence: number;
} | null {
  const text = `${posting.title} ${posting.company || ''} ${posting.description}`.toLowerCase();

  // Keywords indicating grants/fundraising roles
  const grantKeywords = ['subsidie', 'fonds', 'grants', 'fundraising', 'fondsen', 'financiering'];
  const hasGrantKeyword = grantKeywords.some(k => text.includes(k));

  if (!hasGrantKeyword) {
    return null;
  }

  // Try to extract org from company field
  if (posting.company && posting.company.length > 2) {
    return {
      orgName: posting.company,
      country: 'NL',
      confidence: 0.8,
    };
  }

  // Try to extract from description (mock: look for patterns)
  const patterns = [
    /(?:voor|bij|van|der|de)\s+([A-Z][a-z\s]+(?:NGO|Stichting|Organisatie))/i,
    /([A-Z][a-z\s]+)\s+(?:zoekt|werft|heeft)\s+(?:een\s+)?(?:subsidie|fonds)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return {
        orgName: match[1].trim(),
        country: 'NL',
        confidence: 0.6,
      };
    }
  }

  return null;
}
