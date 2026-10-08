export type ISODate = string;

export interface Provenance {
  sourceId: string;
  snapshotId?: string;
  sourceUrl?: string;
  fetchedAt?: ISODate;
  extractionMethod?: 'deterministic' | 'llm';
}

export interface Confidence {
  overall: number;                 // 0..1
  perField?: Record<string, number>;
}

export type OrgType =
  | 'ngo' | 'foundation' | 'charity' | 'association'
  | 'social_enterprise' | 'other';

export interface OrganizationIdentifiers {
  rsin?: string; kvk?: string; anbi?: boolean; websiteDomain?: string;
}

export interface Organization {
  canonicalId: string;
  names: string[];                 // aliases (NL/EN)
  type: OrgType;
  country: string;                 // ISO-3166-1 alpha-2; NL first
  identifiers: OrganizationIdentifiers;
  mission?: string;
  themes?: string[];
  sizeBand?: 'micro' | 'small' | 'medium' | 'large';
  geographicScope?: string[];
  embedding?: number[];            // mission embedding
  mergedFrom?: string[];
  provenance: Provenance[];
  confidence: Confidence;
  optedOut?: boolean;              // GDPR opt-out flag → suppress everywhere
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type SignalType =
  | 'grant_awarded' | 'grant_applied' | 'deadline_upcoming'
  | 'hiring_grants_role' | 'registry_listed' | 'search_intent'
  | 'website_signal';

export interface Signal {
  id: string;
  orgId: string;
  type: SignalType;
  strength: number;                // 0..1 base weight (see scoring)
  occurredAt: ISODate;             // event time → Timing decay
  detectedAt: ISODate;
  payload?: Record<string, unknown>;   // e.g. { funderId, grantId, amount }
  provenance: Provenance;
  confidence: Confidence;
}

export interface ScoreReason {
  factor: 'fit' | 'intent' | 'timing' | 'reachability';
  detail: string;                  // "Won €50k from {funder} 3 days ago"
  weight: number;
  sourceId?: string;
}

export interface AccountScore {
  orgId: string;
  fit: number; intent: number; timing: number; reachability: number;  // 0..1
  score: number;                   // composite 0..100
  tier: 'hot' | 'warm' | 'cold_fit' | 'low';
  reasons: ScoreReason[];
  contributingSignals: string[];
  computedAt: ISODate;
  modelVersion: string;
}

export type AcquisitionTier = 'api' | 'feed' | 'scrape' | 'internal';
export type ExtractionMethod = 'deterministic' | 'llm';
export type FetchProvider = 'http' | 'firecrawl' | 'apify' | 'grantatlas';

export interface Source {
  id: string;
  name: string;
  country: string;
  acquisitionTier: AcquisitionTier;
  extractionMethod: ExtractionMethod;
  provider: FetchProvider;
  signalTypes: SignalType[];
  schedule?: string;               // cron
  enabled: boolean;
  robotsPolicy?: string;
  license?: string;
  fetchConfig?: Record<string, unknown>;
}
