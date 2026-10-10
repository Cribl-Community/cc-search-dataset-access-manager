export const ACCESS_LEVELS = [
  { policy: 'DatasetRead', label: 'Read' },
  { policy: 'DatasetMaintain', label: 'Maintainer' },
  { policy: 'DatasetAdmin', label: 'Admin' },
] as const;

export type DatasetPolicy = (typeof ACCESS_LEVELS)[number]['policy'];

export type AccessMap = Record<string, DatasetPolicy[]>;

export type ResourcePolicy = {
  type?: string;
  id?: string;
  gid?: string;
  policy?: string;
};

export type AccessChange = {
  datasetId: string;
  add: DatasetPolicy[];
  remove: DatasetPolicy[];
};

const KNOWN_POLICIES = new Set<string>(ACCESS_LEVELS.map((level) => level.policy));

export function isDatasetPolicy(policy: string): policy is DatasetPolicy {
  return KNOWN_POLICIES.has(policy);
}

export function policyLabel(policy: DatasetPolicy): string {
  return ACCESS_LEVELS.find((level) => level.policy === policy)?.label ?? policy;
}

export function formatAccess(policies: readonly DatasetPolicy[]): string {
  const labels = ACCESS_LEVELS.filter((level) => policies.includes(level.policy)).map((level) => level.label);
  return labels.length > 0 ? labels.join(', ') : 'No access';
}

export function samePolicies(left: readonly DatasetPolicy[], right: readonly DatasetPolicy[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((policy) => rightSet.has(policy));
}

export function cloneAccess(access: AccessMap): AccessMap {
  return Object.fromEntries(Object.entries(access).map(([datasetId, policies]) => [datasetId, [...policies]]));
}

export function accessMapFromPolicies(policies: readonly ResourcePolicy[], datasetIds: ReadonlySet<string>): AccessMap {
  const map: AccessMap = {};
  for (const entry of policies) {
    if (entry.type !== 'datasets' || !entry.policy || !isDatasetPolicy(entry.policy)) continue;
    const datasetId = entry.id && datasetIds.has(entry.id)
      ? entry.id
      : entry.gid && datasetIds.has(entry.gid)
        ? entry.gid
        : undefined;
    if (!datasetId) continue;
    const current = map[datasetId] ?? [];
    if (!current.includes(entry.policy)) map[datasetId] = [...current, entry.policy];
  }
  return map;
}

export function diffAccess(saved: AccessMap, draft: AccessMap, datasetIds: readonly string[]): AccessChange[] {
  const changes: AccessChange[] = [];
  for (const datasetId of datasetIds) {
    const before = new Set(saved[datasetId] ?? []);
    const after = new Set(draft[datasetId] ?? []);
    const add = ACCESS_LEVELS.map((level) => level.policy).filter((policy) => after.has(policy) && !before.has(policy));
    const remove = ACCESS_LEVELS.map((level) => level.policy).filter((policy) => before.has(policy) && !after.has(policy));
    if (add.length > 0 || remove.length > 0) changes.push({ datasetId, add, remove });
  }
  return changes;
}

export function describeChange(change: AccessChange): string {
  const parts: string[] = [];
  if (change.add.length > 0) parts.push(`grant ${change.add.map(policyLabel).join(', ')}`);
  if (change.remove.length > 0) parts.push(`remove ${change.remove.map(policyLabel).join(', ')}`);
  return `${change.datasetId}: ${parts.join('; ')}`;
}

export function toApplyBody(change: AccessChange, subjectId: string): { add?: Record<string, string[]>; rm?: Record<string, string[]> } {
  const body: { add?: Record<string, string[]>; rm?: Record<string, string[]> } = {};
  if (change.add.length > 0) {
    body.add = Object.fromEntries(change.add.map((policy) => [policy, [subjectId]]));
  }
  if (change.remove.length > 0) {
    body.rm = Object.fromEntries(change.remove.map((policy) => [policy, [subjectId]]));
  }
  return body;
}
