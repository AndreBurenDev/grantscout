/**
 * Console domain types. These mirror the stored document shapes
 * (see ../../../src/core/types.ts and the writers in src/pipeline) so that
 * real and seeded data flow through unchanged.
 */

// ---- Pipeline Runs (collection: syncLogs) ----
// Written by src/pipeline/sensor.ts and src/orchestrator/hubspot.ts.
export type RunStatus =
  | 'success'
  | 'error'
  | 'dry-run'
  | 'queued'
  | 'running'

export interface Run {
  id: string
  sourceId?: string // ingest runs
  service?: string // service runs, e.g. 'hubspot'
  timestamp: Date
  orgsIngested?: number
  signalsIngested?: number
  prospectsCount?: number
  snapshotId?: string
  status: RunStatus
  error?: string
}

// ---- Organizations (collection: organizations) ----
export type OrgType =
  | 'ngo'
  | 'foundation'
  | 'charity'
  | 'association'
  | 'social_enterprise'
  | 'other'

export interface OrganizationIdentifiers {
  rsin?: string
  kvk?: string
  anbi?: boolean
  websiteDomain?: string
}

export interface Organization {
  canonicalId: string
  names: string[]
  type: OrgType
  country: string
  identifiers: OrganizationIdentifiers
  mission?: string
  themes?: string[]
  sizeBand?: 'micro' | 'small' | 'medium' | 'large'
  geographicScope?: string[]
  optedOut?: boolean
  createdAt?: Date
  updatedAt?: Date
}

// ---- Account Scores (collection: accountScores) ----
export type Tier = 'hot' | 'warm' | 'cold_fit' | 'low'

export interface ScoreReason {
  factor: 'fit' | 'intent' | 'timing' | 'reachability'
  detail: string
  weight: number
  sourceId?: string
}

export interface AccountScore {
  id: string // doc id (canonically == orgId)
  orgId: string
  fit: number
  intent: number
  timing: number
  reachability: number
  score: number // composite 0..100
  tier: Tier
  reasons: ScoreReason[]
  contributingSignals: string[]
  computedAt?: Date
  modelVersion?: string
  orgName?: string // joined client-side from organizations
}

// ---- Signals (collection: signals) ----
export interface SignalSummary {
  id: string
  type: string
  occurredAt?: Date
  strength?: number
  sourceId?: string
}

// ---- Grant opportunities (collection: grants) — from GrantAtlas ----
export interface GrantOpportunity {
  id: string
  title: string
  description?: string
  funderId: string
  funderName?: string
  fundingMin?: number
  fundingMax?: number
  currency?: string
  dateOpen?: Date
  dateClose?: Date
  rolling?: boolean
  geographicScope?: string[]
  sectors?: string[]
  organizationTypes?: string[]
  grantType?: string
  tags?: string[]
  ngoEligible?: boolean
  status: string // active | upcoming | closed | archived
  sourceUrl?: string
}

// ---- Sources (collection: sources) ----
export type AcquisitionTier = 'api' | 'feed' | 'scrape' | 'internal'
export type ExtractionMethod = 'deterministic' | 'llm'
export type FetchProvider = 'http' | 'firecrawl' | 'apify' | 'grantatlas'
export type SignalType =
  | 'grant_awarded'
  | 'grant_applied'
  | 'deadline_upcoming'
  | 'hiring_grants_role'
  | 'registry_listed'
  | 'search_intent'
  | 'website_signal'

export interface Source {
  id: string
  name: string
  country: string
  acquisitionTier: AcquisitionTier
  extractionMethod: ExtractionMethod
  provider: FetchProvider
  signalTypes: SignalType[]
  schedule?: string // cron
  enabled: boolean
  lastRunAt?: Date
  lastRunStatus?: RunStatus
}

// ---- Review Queue (collection: reviewQueue) — console-owned ----
export type ReviewStatus = 'pending' | 'approved' | 'rejected'
export type ReviewPriority = 'high' | 'medium' | 'low'

export interface ReviewItem {
  id: string
  orgId?: string
  title: string
  priority: ReviewPriority
  reason: string
  submittedBy: string
  status: ReviewStatus
  createdAt?: Date
  reviewedBy?: string
  reviewedAt?: Date
}

// ---- Settings (collection: settings, doc: console) — console-owned ----
export interface ConsoleSettings {
  autoRunEnabled: boolean
  emailOnFailure: boolean
  debugLogging: boolean
  minRelevanceScore: number
  minFitScore: number
  updatedAt?: Date
  updatedBy?: string
}

export const DEFAULT_SETTINGS: ConsoleSettings = {
  autoRunEnabled: true,
  emailOnFailure: true,
  debugLogging: false,
  minRelevanceScore: 70,
  minFitScore: 75,
}
