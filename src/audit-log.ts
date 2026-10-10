import { policyLabel, type AccessChange, type DatasetPolicy } from './access';

export const AUDIT_LIMIT = 400;
export const AUDIT_VISIBLE = 10;

export type AuditAudience = 'members' | 'teams';
export type AuditResult = 'success' | 'failed';

export type AuditEvent = {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  audience: AuditAudience;
  subjectId: string;
  subjectName: string;
  datasetId: string;
  add: DatasetPolicy[];
  remove: DatasetPolicy[];
  result: AuditResult;
  error?: string;
  lake?: 'sent' | 'failed';
  lakeError?: string;
};

export function prependAudit(existing: readonly AuditEvent[], incoming: readonly AuditEvent[], limit = AUDIT_LIMIT): AuditEvent[] {
  return [...incoming, ...existing].slice(0, limit);
}

/** Keeps rows already on screen when a later read comes back empty or older. */
export function mergeAudit(current: readonly AuditEvent[], incoming: readonly AuditEvent[], limit = AUDIT_LIMIT): AuditEvent[] {
  const byId = new Map<string, AuditEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) {
    const previous = byId.get(event.id);
    byId.set(event.id, previous ? { ...previous, ...event } : event);
  }
  return [...byId.values()].sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
}

export const LAKE_SETTINGS_KEY = 'audit/lake';

/** Reads Lake shipping settings out of a KV get or scan body. */
export function lakeSettingsFromStored(body: unknown): { enabled: boolean; ingestUrl: string } | undefined {
  const found = findLakeRecord(body, 0);
  if (!found) return undefined;
  return {
    enabled: found.enabled === true,
    ingestUrl: typeof found.ingestUrl === 'string' ? found.ingestUrl : '',
  };
}

function findLakeRecord(body: unknown, depth: number): { enabled?: unknown; ingestUrl?: unknown } | undefined {
  if (depth > 8 || body == null) return undefined;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return undefined;
    try {
      return findLakeRecord(JSON.parse(trimmed) as unknown, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = findLakeRecord(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if ('ingestUrl' in record || 'enabled' in record) return record;
  if (typeof record.key === 'string' && !isLakeSettingsKey(record.key)) return undefined;
  for (const nested of [record.value, record.data, record.item, record.items]) {
    if (nested === undefined) continue;
    const found = findLakeRecord(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function isLakeSettingsKey(key: string): boolean {
  return key === LAKE_SETTINGS_KEY || key.endsWith(`/${LAKE_SETTINGS_KEY}`);
}

export function lakeIngestProblem(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'Enter the full https ingest URL.';
  }
  if (parsed.protocol !== 'https:') return 'The ingest URL must start with https.';
  if (!parsed.hostname) return 'Enter the full https ingest URL.';
  if (!parsed.pathname.includes('/datasets/')) return '';
  const datasetId = parsed.pathname.split('/datasets/')[1]?.replace(/\/$/, '');
  if (!datasetId) return 'Add the Lake dataset id to the end of the Direct Access URL.';
  return '';
}

/** Lake copy of an access change, with fields in the same order as the Access history table. */
export function lakeEventBody(event: AuditEvent): Record<string, string | number> {
  const change = policyChangeSummary(event.add, event.remove);
  const subjectKind = event.audience === 'members' ? 'Member' : 'Team';
  const result = event.result === 'success' ? 'Success' : event.error ? `Failed: ${event.error}` : 'Failed';
  const atMs = Date.parse(event.at);
  return {
    _time: Number.isNaN(atMs) ? Date.now() / 1000 : atMs / 1000,
    actorName: event.actorName,
    subject: `${event.subjectName} (${subjectKind})`,
    datasetId: event.datasetId,
    change,
    result,
  };
}

export function downloadAuditHistory(events: readonly AuditEvent[], unreadable?: string): void {
  const content = unreadable === undefined
    ? JSON.stringify(events, null, 2)
    : JSON.stringify({ events, unreadableStoredValue: unreadable }, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'dataset-access-history.json';
  link.click();
  URL.revokeObjectURL(url);
}

export function policyChangeSummary(add: readonly DatasetPolicy[], remove: readonly DatasetPolicy[]): string {
  const parts: string[] = [];
  if (add.length > 0) parts.push(`Grant ${add.map(policyLabel).join(', ')}`);
  if (remove.length > 0) parts.push(`Remove ${remove.map(policyLabel).join(', ')}`);
  return parts.join('; ') || 'No permission change';
}

export function eventsForChanges(input: {
  changes: readonly AccessChange[];
  actor: { id: string; name: string };
  audience: AuditAudience;
  subjectId: string;
  subjectName: string;
  failedDatasetIds?: ReadonlySet<string>;
  failureMessage?: string;
  errors?: Readonly<Record<string, string>>;
  at?: string;
}): AuditEvent[] {
  const at = input.at ?? new Date().toISOString();
  const allFailed = input.failedDatasetIds == null && Boolean(input.failureMessage);
  return input.changes.map((change, index) => {
    const failed = allFailed || Boolean(input.failedDatasetIds?.has(change.datasetId));
    return {
      id: `${at}-${change.datasetId}-${index}`,
      at,
      actorId: input.actor.id,
      actorName: input.actor.name,
      audience: input.audience,
      subjectId: input.subjectId,
      subjectName: input.subjectName,
      datasetId: change.datasetId,
      add: [...change.add],
      remove: [...change.remove],
      result: failed ? 'failed' : 'success',
      error: failed ? input.errors?.[change.datasetId] || input.failureMessage : undefined,
    };
  });
}

export function eventsFromStored(body: unknown): AuditEvent[] {
  return eventList(body).filter(isAuditEvent);
}

/** True when the stored document is a real empty history, not an unreadable body. */
export function isEmptyStoredHistory(body: unknown): boolean {
  const events = eventList(body);
  return events.length === 0 && storedDocument(body) !== undefined;
}

function eventList(body: unknown): unknown[] {
  const value = storedDocument(body);
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { events?: unknown }).events)) {
    return (value as { events: unknown[] }).events;
  }
  return [];
}

function storedDocument(body: unknown): unknown {
  const value = unwrapStored(storedValue(body));
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { events?: unknown }).events)) return value;
  return undefined;
}

function storedValue(body: unknown): unknown {
  let value = body;
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth += 1) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return value;
}

function unwrapStored(body: unknown, depth = 0): unknown {
  if (depth > 6) return body;
  const value = storedValue(body);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (value.length === 1) return unwrapStored(value[0], depth + 1);
    return value;
  }
  const record = value as { value?: unknown; data?: unknown; item?: unknown; items?: unknown; events?: unknown };
  if (Array.isArray(record.events)) return record;
  for (const nested of [record.value, record.data, record.item, record.items]) {
    if (nested === undefined) continue;
    const unwrapped = unwrapStored(nested, depth + 1);
    if (Array.isArray(unwrapped)) return unwrapped;
    if (unwrapped && typeof unwrapped === 'object' && Array.isArray((unwrapped as { events?: unknown }).events)) return unwrapped;
  }
  return record;
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<AuditEvent>;
  return typeof event.id === 'string'
    && typeof event.at === 'string'
    && typeof event.datasetId === 'string'
    && (event.result === 'success' || event.result === 'failed')
    && Array.isArray(event.add)
    && Array.isArray(event.remove);
}
