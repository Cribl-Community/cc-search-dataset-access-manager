import {
  accessMapFromPolicies,
  toApplyBody,
  type AccessChange,
  type AccessMap,
  type ResourcePolicy,
} from './access';
import { eventsFromStored, isEmptyStoredHistory, LAKE_SETTINGS_KEY, lakeEventBody, lakeIngestProblem, lakeSettingsFromStored, prependAudit, type AuditEvent } from './audit-log';

export const SEARCH_GROUP = 'default_search';
const AUDIT_KEY = 'audit/events';
const LAKE_TOKEN_KEY = 'lakeIngestToken';
const SETUP_COMPLETE_KEY = 'setup/completed';

export type LakeSettings = {
  enabled: boolean;
  ingestUrl: string;
  tokenSaved: boolean;
};

export type Member = {
  id: string;
  name: string;
  email: string;
  status: string;
};

export type Team = {
  id: string;
  name: string;
  description: string;
};

export type Dataset = {
  id: string;
  description: string;
  type: string;
};

type Counted<T> = {
  items?: T[];
  totalCount?: number;
  message?: string;
};

type UserRecord = {
  id?: string;
  username?: string;
  first?: string;
  last?: string;
  email?: string;
  disabled?: boolean;
  type?: string;
};

type TeamRecord = {
  id?: string;
  name?: string;
  description?: string;
};

type DatasetRecord = {
  id?: string;
  description?: string;
  type?: string;
};

function apiBase(): string {
  const base = window.CRIBL_API_URL;
  if (!base) {
    throw new Error('Open this app from Cribl to load members, teams, and datasets.');
  }
  return base.replace(/\/$/, '');
}

async function criblJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, init);
  const text = await response.text();
  let body: (T & { message?: string }) | undefined;
  if (text) {
    try {
      body = JSON.parse(text) as T & { message?: string };
    } catch {
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      throw new Error('Cribl returned a response that was not JSON.');
    }
  }
  if (!response.ok) {
    throw new Error(body?.message || `Request failed (${response.status})`);
  }
  return (body ?? {}) as T;
}

function asList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  for (const key of ['items', 'users', 'teams']) {
    if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
}

async function fetchAllItems<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  const limit = 200;
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    const joiner = path.includes('?') ? '&' : '?';
    const body = await criblJson<Counted<T>>(`${path}${joiner}limit=${limit}&offset=${offset}`, { signal });
    const batch = asList<T>(body);
    const marker = JSON.stringify(batch[0] ?? null);
    if (batch.length === 0 || seen.has(marker)) break;
    seen.add(marker);
    items.push(...batch);
    offset += batch.length;
    if (batch.length < limit) break;
    if (body.totalCount != null && offset >= body.totalCount) break;
  }
  return items;
}

function memberName(user: UserRecord, id: string): string {
  const fullName = [user.first, user.last].filter(Boolean).join(' ').trim();
  return fullName || user.username || user.email || id;
}

function memberId(user: UserRecord): string {
  return user.id || user.email || user.username || '';
}

function toMember(user: UserRecord): Member | undefined {
  const id = memberId(user);
  if (!id || user.type === 'credential' || id.endsWith('@clients')) return undefined;
  return {
    id,
    name: memberName(user, id),
    email: user.email || user.username || id,
    status: user.disabled ? 'Disabled' : 'Active',
  };
}

async function listUsers(path: string, signal?: AbortSignal): Promise<Member[]> {
  const users = await fetchAllItems<UserRecord>(path, signal);
  return users.flatMap((user) => {
    const member = toMember(user);
    return member ? [member] : [];
  });
}

export async function listMembers(signal?: AbortSignal): Promise<Member[]> {
  const failures: string[] = [];
  const collected: Member[] = [];
  // Cribl.Cloud workspace members are listed per product. /system/users is the on-prem list.
  for (const path of ['/products/search/users', '/system/users']) {
    try {
      collected.push(...await listUsers(path, signal));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      failures.push(error instanceof Error ? error.message : 'Request failed');
    }
  }
  const members = [...new Map(collected.map((member) => [member.id, member])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  if (members.length === 0 && failures.length > 0) {
    throw new Error(failures[0]);
  }
  return members;
}

export async function listTeams(signal?: AbortSignal): Promise<Team[]> {
  const teams = await fetchAllItems<TeamRecord>('/system/teams', signal);
  return teams
    .filter((team) => team.id)
    .map((team) => ({
      id: team.id as string,
      name: team.name || (team.id as string),
      description: team.description || '',
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listDatasets(signal?: AbortSignal): Promise<Dataset[]> {
  const datasets = await fetchAllItems<DatasetRecord>(`/m/${SEARCH_GROUP}/search/datasets`, signal);
  return datasets
    .filter((dataset) => dataset.id)
    .map((dataset) => ({
      id: dataset.id as string,
      description: dataset.description || '',
      type: dataset.type || '',
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadAccess(audience: 'members' | 'teams', subjectId: string, datasetIds: ReadonlySet<string>, signal?: AbortSignal): Promise<AccessMap> {
  const path = audience === 'members'
    ? `/products/search/users/${encodeURIComponent(subjectId)}/acl?type=datasets`
    : `/system/teams/${encodeURIComponent(subjectId)}/acl?type=datasets`;
  const policies = await fetchAllItems<ResourcePolicy>(path, signal);
  return accessMapFromPolicies(policies, datasetIds);
}

export class AccessApplyError extends Error {
  failedDatasetIds: string[];

  constructor(failures: string[], failedDatasetIds: string[]) {
    super(failures.join('\n'));
    this.name = 'AccessApplyError';
    this.failedDatasetIds = failedDatasetIds;
  }
}

async function mapPool<T>(items: readonly T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const run = async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  };
  const workers = Array.from({ length: Math.min(size, items.length) }, () => run());
  await Promise.all(workers);
}

export async function applyAccessChanges(
  audience: 'members' | 'teams',
  subjectId: string,
  changes: readonly AccessChange[],
): Promise<void> {
  const suffix = audience === 'members' ? 'acl/apply' : 'acl/teams/apply';
  const failures: string[] = [];
  const failedDatasetIds: string[] = [];
  await mapPool(changes, 4, async (change) => {
    const path = `/m/${SEARCH_GROUP}/search/datasets/${encodeURIComponent(change.datasetId)}/${suffix}`;
    try {
      await criblJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toApplyBody(change, subjectId)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      failures.push(`${change.datasetId}: ${message}`);
      failedDatasetIds.push(change.datasetId);
    }
  });
  if (failures.length > 0) {
    throw new AccessApplyError(failures, failedDatasetIds);
  }
}

export async function currentActor(): Promise<{ id: string; name: string }> {
  const getUser = window.getCriblUser;
  if (!getUser) return { id: '', name: 'Unknown user' };
  const user = await getUser();
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
    || user.username
    || user.email
    || user.id;
  return { id: user.id, name };
}

export type StoredAudit = {
  events: AuditEvent[];
  /** Raw stored text when it exists but is not a readable history document. */
  unreadable?: string;
};

export async function loadAuditHistory(signal?: AbortSignal): Promise<StoredAudit> {
  const raw = await readAuditRaw(signal);
  if (raw === undefined || raw.trim() === '') return { events: [] };
  const events = eventsFromStored(raw);
  if (events.length === 0 && !isEmptyStoredHistory(raw)) return { events: [], unreadable: raw };
  return { events };
}

async function readAuditRaw(signal?: AbortSignal): Promise<string | undefined> {
  const scanned = await readAuditFromScan(signal);
  if (scanned !== undefined) return scanned;
  const response = await fetch(`${apiBase()}/kvstore/${AUDIT_KEY}`, { signal });
  if (response.status === 404) return undefined;
  const text = await response.text();
  if (!response.ok) throw new Error(await errorText(response, text));
  return text;
}

async function readAuditFromScan(signal?: AbortSignal): Promise<string | undefined> {
  const scan = await fetch(`${apiBase()}/kvstore/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: 'audit/', limit: 50 }),
    signal,
  });
  if (!scan.ok) return undefined;
  const body = await scan.json() as { items?: Array<{ key?: unknown; value?: unknown }> };
  const items = Array.isArray(body.items) ? body.items : [];
  const entry = items.find((item) => item.key === AUDIT_KEY)
    ?? items.find((item) => typeof item.key === 'string' && item.key.endsWith(AUDIT_KEY));
  if (!entry || entry.value === undefined || entry.value === null) return undefined;
  return typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
}

export async function saveAuditEvents(events: readonly AuditEvent[], signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${apiBase()}/kvstore/${AUDIT_KEY}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ events }),
    signal,
  });
  if (!response.ok) throw new Error(await errorText(response));
}

export async function appendAuditEvents(incoming: readonly AuditEvent[], signal?: AbortSignal): Promise<AuditEvent[]> {
  const stored = await loadAuditHistory(signal);
  if (incoming.length === 0) return stored.events;
  if (stored.unreadable !== undefined) await backupUnreadableAudit(stored.unreadable, signal);
  const next = prependAudit(stored.events, incoming);
  await saveAuditEvents(next, signal);
  return next;
}

async function backupUnreadableAudit(raw: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${apiBase()}/kvstore/audit/unreadable/${Date.now()}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: raw,
    signal,
  });
  if (!response.ok) throw new Error(`The old history could not be backed up, so it was left in place. ${await errorText(response)}`);
}

export async function loadLakeSettings(signal?: AbortSignal): Promise<LakeSettings> {
  const [record, tokenSaved] = await Promise.all([
    readLakeRecord(signal),
    tokenIsSaved(signal),
  ]);
  return {
    enabled: record.enabled,
    ingestUrl: record.ingestUrl,
    tokenSaved,
  };
}

export async function loadSetupComplete(signal?: AbortSignal): Promise<boolean> {
  const stored = await readKv(SETUP_COMPLETE_KEY, signal);
  if (stored === true || stored === 'true') return true;
  return Boolean(stored && typeof stored === 'object' && (stored as { completed?: unknown }).completed === true);
}

export async function saveSetupComplete(signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${apiBase()}/kvstore/${SETUP_COMPLETE_KEY}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: 'true',
    signal,
  });
  if (!response.ok) throw new Error(await errorText(response));
}

export async function saveLakeSettings(input: { enabled: boolean; ingestUrl: string; token: string }, signal?: AbortSignal): Promise<LakeSettings> {
  const ingestUrl = input.ingestUrl.trim();
  const token = input.token.trim();
  const tokenAlreadySaved = token ? true : await tokenIsSaved(signal);
  if (input.enabled) {
    const problem = lakeIngestProblem(ingestUrl);
    if (problem) throw new Error(problem);
    if (!tokenAlreadySaved) throw new Error('Enter the ingest auth token.');
  }
  const settingsResponse = await fetch(`${apiBase()}/kvstore/${LAKE_SETTINGS_KEY}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ enabled: input.enabled, ingestUrl }),
    signal,
  });
  if (!settingsResponse.ok) throw new Error(await errorText(settingsResponse));
  if (token) await writeLakeToken(token, signal);
  const saved = await loadLakeSettings(signal);
  if (saved.ingestUrl !== ingestUrl || saved.enabled !== input.enabled) {
    throw new Error('The Lake endpoint was not stored.');
  }
  return { ...saved, tokenSaved: saved.tokenSaved || Boolean(token) };
}

export async function shipAuditToLake(events: readonly AuditEvent[], ingestUrl: string): Promise<{ failedIds: string[]; error: string }> {
  const failedIds: string[] = [];
  let error = '';
  for (const event of events) {
    if (error) {
      failedIds.push(event.id);
      continue;
    }
    try {
      const response = await fetch(ingestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(lakeEventBody(event)),
      });
      if (!response.ok) {
        error = response.status === 403
          ? 'Cribl blocked that Lake hostname. It has to be allowed for this app before events can ship.'
          : await errorText(response);
        failedIds.push(event.id);
      }
    } catch (shipError) {
      error = shipError instanceof Error ? shipError.message : 'Lake ingest failed.';
      failedIds.push(event.id);
    }
  }
  return { failedIds, error };
}

async function writeLakeToken(token: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${apiBase()}/kvstore/${encodeURIComponent(LAKE_TOKEN_KEY)}?encrypted=true`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: token,
    signal,
  });
  if (!response.ok) throw new Error(await errorText(response));
}

async function readLakeRecord(signal?: AbortSignal): Promise<{ enabled: boolean; ingestUrl: string }> {
  const scanned = await readLakeFromScan(signal);
  if (scanned) return scanned;
  try {
    const fetched = lakeSettingsFromStored(await readKv(LAKE_SETTINGS_KEY, signal));
    if (fetched) return fetched;
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  return { enabled: false, ingestUrl: '' };
}

async function readLakeFromScan(signal?: AbortSignal): Promise<{ enabled: boolean; ingestUrl: string } | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    let response: Response;
    try {
      response = await fetch(`${apiBase()}/kvstore/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix: 'audit/', limit: 50, ...(cursor ? { cursor } : {}) }),
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      return undefined;
    }
    if (!response.ok) return undefined;
    let body: { items?: Array<{ key?: unknown; value?: unknown }>; nextCursor?: unknown };
    try {
      body = await response.json() as { items?: Array<{ key?: unknown; value?: unknown }>; nextCursor?: unknown };
    } catch {
      return undefined;
    }
    const items = Array.isArray(body.items) ? body.items : [];
    const entry = items.find((item) => typeof item.key === 'string' && (item.key === LAKE_SETTINGS_KEY || item.key.endsWith(`/${LAKE_SETTINGS_KEY}`)));
    if (entry) {
      const parsed = lakeSettingsFromStored(entry.value) ?? lakeSettingsFromStored(entry);
      if (parsed) return parsed;
    }
    cursor = typeof body.nextCursor === 'string' ? body.nextCursor : undefined;
    if (!cursor) return undefined;
  }
  return undefined;
}

async function tokenIsSaved(signal?: AbortSignal): Promise<boolean> {
  try {
    if (await kvKeyExists(LAKE_TOKEN_KEY, signal)) return true;
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  try {
    const response = await fetch(`${apiBase()}/kvstore/${encodeURIComponent(LAKE_TOKEN_KEY)}`, { signal });
    if (response.status === 404) return false;
    if (!response.ok) return false;
    const text = (await response.text()).trim();
    return text.length > 0 && text !== 'null' && text !== '{}' && text !== '[]';
  } catch (error) {
    if (isAbort(error)) throw error;
    return false;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readKv(key: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${apiBase()}/kvstore/${key}`, { signal });
  if (response.status === 404) return undefined;
  const text = await response.text();
  if (!response.ok) throw new Error(await errorText(response, text));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function kvKeyExists(key: string, signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`${apiBase()}/kvstore/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: key }),
    signal,
  });
  if (response.status === 404) return false;
  const text = await response.text();
  if (!response.ok) throw new Error(await errorText(response, text));
  if (!text) return false;
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return text.includes(key);
  }
  return listedKeys(body).some((listed) => listed === key || listed.endsWith(`/${key}`));
}

function listedKeys(body: unknown, depth = 0): string[] {
  if (depth > 6 || body == null) return [];
  if (typeof body === 'string') return [body];
  if (Array.isArray(body)) return body.flatMap((item) => listedKeys(item, depth + 1));
  if (typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const names = ['key', 'id', 'name'].flatMap((field) => (typeof record[field] === 'string' ? [record[field]] : []));
  const nested = ['items', 'keys', 'data'].flatMap((field) => (record[field] === undefined ? [] : listedKeys(record[field], depth + 1)));
  return [...names, ...nested];
}

async function errorText(response: Response, text = ''): Promise<string> {
  const bodyText = text || await response.text();
  try {
    const body = JSON.parse(bodyText) as { message?: string };
    if (body.message) return body.message;
  } catch {
    // The error body was not JSON.
  }
  return `Request failed (${response.status})`;
}
