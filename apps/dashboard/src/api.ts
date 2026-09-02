export type Verdict = 'SUPPORTED' | 'DRIFTED' | 'INCONCLUSIVE' | 'UNSUPPORTED_TYPE';
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Claim {
  id: string;
  originalText: string;
  subject: string;
  property: string;
  object?: string;
  scope?: Record<string, string>;
  assertedValue: unknown;
  valueType: string;
  ownership: string;
  extractionConfidence: number;
  capturedAt: string;
  status: string;
  sourceConversationId: string;
  grounding?: {
    speechAct: string;
    subjectAliasMatched: string | null;
    valueLiteralMatched: string | null;
    propertyLexemeMatched: string | null;
    passed: boolean;
    rejectedBy?: string;
  };
}

export interface Evidence {
  id: string;
  source: string;
  sourceLocator: string;
  status: string;
  value: unknown;
  authoritative: boolean;
  commitSha?: string;
  fetchedAt: string;
  evidenceHash: string;
  error?: string;
}

export interface PriorOccurrence {
  conversationId: string;
  at: string;
  excerpt: string;
  afterSourceChange: boolean;
}

export interface HistoricalChange {
  at: string;
  from: unknown;
  to: unknown;
  source: string;
  locator: string;
  commitSha?: string;
  author?: string;
  message?: string;
}

export interface DriftEvent {
  id: string;
  claimId: string;
  subject: string;
  property: string;
  assertedValue: unknown;
  actualValue: unknown;
  detectedAt: string;
  sourceChangeAt?: string;
  sourceChangeCommit?: string;
  priorOccurrences: PriorOccurrence[];
  severity: Severity;
  confirmationRequired: boolean;
  ownership: string;
  resolution: string;
}

export interface SeverityBreakdown {
  severity: Severity;
  score: number;
  factors: { name: string; points: number; because: string }[];
}

export interface DriftCard {
  drift: DriftEvent;
  claim?: Claim;
  label: string;
  systemLabel: string;
  evidence: Evidence[];
  change?: HistoricalChange;
  severityBreakdown: SeverityBreakdown;
}

export interface Status {
  startedAt: string;
  mode: string;
  registry: string;
  store: string;
  proposers: string;
  github: string;
  bee: { transport: string; connected: boolean; detail: string; cursor: string | null };
  metrics: Record<string, number>;
  registrySystems: RegistrySystem[];
}

export interface RegistrySystem {
  key: string;
  label: string;
  properties: {
    key: string;
    label: string;
    type: string;
    impact: Severity;
    claimType: string;
    source: string;
    historicalSource: string | null;
  }[];
}

export interface Timeline {
  subject: string;
  property: string;
  label: string;
  systemLabel: string;
  valueType: string;
  system: HistoricalChange[];
  spoken: { at: string; value: unknown; excerpt: string; conversationId: string; status: string; live: boolean }[];
}

export interface Coverage {
  conversations: number;
  utterances: number;
  speakers: number;
  checkable: number;
  ignored: number;
  earliest?: string;
  latest?: string;
  perProperty: { key: string; count: number }[];
}

export interface ClaimRow {
  claim: Claim;
  label: string;
  evidence: Evidence[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  status: () => req<Status>('/api/status'),
  drifts: () => req<DriftCard[]>('/api/drifts'),
  drift: (id: string) => req<DriftCard>(`/api/drifts/${id}`),
  claims: () => req<ClaimRow[]>('/api/claims'),
  coverage: () => req<Coverage>('/api/coverage'),
  timeline: (subject: string, property: string) =>
    req<Timeline>(`/api/timeline?subject=${encodeURIComponent(subject)}&property=${encodeURIComponent(property)}`),
  docsPatch: (id: string) =>
    req<{ patches: { path: string; repository?: string; changed: boolean; error?: string; hunks: { line: number; before: string; after: string }[] }[]; reason?: string }>(
      `/api/drifts/${id}/docs-patch`,
    ),
  resolve: (id: string, resolution: string) =>
    req<DriftEvent>(`/api/drifts/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution }) }),
  confirm: (id: string) => req<DriftEvent>(`/api/drifts/${id}/confirm`, { method: 'POST', body: '{}' }),
  updateUnderstanding: (id: string) =>
    req<{ factText: string; factId?: string; error?: string }>(`/api/drifts/${id}/update-understanding`, { method: 'POST', body: '{}' }),
  openPr: (id: string) => req<{ url: string; number: number; branch: string }>(`/api/drifts/${id}/docs-pr`, { method: 'POST', body: '{}' }),
  reconcile: () => req<Record<string, unknown>>('/api/reconcile', { method: 'POST', body: '{}' }),
};

export function fmt(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'enabled' : 'disabled';
  if (v === null || v === undefined) return '—';
  return String(v);
}

export function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
