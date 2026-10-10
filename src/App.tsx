import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  EMPTY_CELL_PLACEHOLDER,
  EmptyState,
  FilterToolbar,
  Link,
  Modal,
  PasswordField,
  Switch,
  TextArea,
  TextField,
  Spinner,
  Table,
  Text,
  ToggleButtonGroup,
  defineColumns,
  type Key,
} from '@capra/core';
import { ReloadOutlined, UserOutlined, UsersOutlined } from '@capra/icons';
import type { Selection, SortDescriptor } from 'react-aria-components';
import {
  cloneAccess,
  describeChange,
  diffAccess,
  formatAccess,
  samePolicies,
  type AccessChange,
  type AccessMap,
  type DatasetPolicy,
} from './access';
import { AUDIT_LIMIT, AUDIT_VISIBLE, downloadAuditHistory, eventsForChanges, mergeAudit, policyChangeSummary, type AuditEvent } from './audit-log';
import {
  AccessApplyError,
  appendAuditEvents,
  applyAccessChanges,
  currentActor,
  listDatasets,
  listMembers,
  listTeams,
  loadAccess,
  loadAuditHistory,
  loadLakeSettings,
  loadSetupComplete,
  saveAuditEvents,
  saveLakeSettings,
  saveSetupComplete,
  shipAuditToLake,
  type Dataset,
  type LakeSettings,
  type Member,
  type Team,
} from './api';
import { DIRECT_ACCESS_DOCS, RAW_HTTP_DOCS, lakeProxyDetails, lakeSearchHref } from './lake-setup';
import { SetupWizard, type SetupValues } from './SetupWizard';
import { installThemeBridge, type HostTheme } from './host-theme';

type Audience = 'members' | 'teams';

type Principal = {
  id: string;
  name: string;
  detail: string;
  status: string;
};

type DatasetRow = {
  id: string;
  description: string;
  type: string;
  access: string;
  pending: string;
  read: boolean;
  maintain: boolean;
  admin: boolean;
};

type PendingNavigation =
  | { kind: 'audience'; audience: Audience }
  | { kind: 'select'; id: string }
  | { kind: 'clear' }
  | { kind: 'refresh' };

const memberColumns = defineColumns<Principal>([
  { id: 'name', label: 'Name', allowsSorting: true },
  { id: 'detail', label: 'Email', allowsSorting: true },
  { id: 'status', label: 'Status', allowsSorting: true },
]);

type HistoryRow = {
  id: string;
  when: string;
  actor: string;
  subject: string;
  dataset: string;
  change: string;
  result: string;
  lake: string;
};

const historyColumns = defineColumns<HistoryRow>([
  { id: 'when', label: 'When' },
  { id: 'actor', label: 'Who' },
  { id: 'subject', label: 'Member or team' },
  { id: 'dataset', label: 'Dataset' },
  { id: 'change', label: 'Change' },
  { id: 'result', label: 'Result' },
  { id: 'lake', label: 'Lake' },
]);

function lakeStatusText(settings: LakeSettings): string {
  const token = settings.tokenSaved ? ' An auth token is saved.' : '';
  if (settings.enabled && settings.ingestUrl) {
    return ` Lake shipping is on. New changes are also sent to ${settings.ingestUrl}.${token}`;
  }
  if (settings.ingestUrl) return ` Lake shipping is off. Saved endpoint: ${settings.ingestUrl}.${token}`;
  if (settings.tokenSaved) return ` Lake shipping is off.${token}`;
  return ' Lake shipping is off.';
}

function formatWhen(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

const teamColumns = defineColumns<Principal>([
  { id: 'name', label: 'Name', allowsSorting: true },
  { id: 'detail', label: 'Description', allowsSorting: true },
]);

function sortRows<T extends { id: string }>(items: T[], sort: SortDescriptor, valueFor: (item: T, column: string) => string): T[] {
  const column = String(sort.column);
  const sorted = [...items].sort((left, right) => valueFor(left, column).localeCompare(valueFor(right, column)));
  return sort.direction === 'descending' ? sorted.reverse() : sorted;
}

function matchesQuery(query: string, values: string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => value.toLowerCase().includes(needle));
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function App() {
  const [theme, setTheme] = useState<HostTheme>(() => (
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  ));
  const [audience, setAudience] = useState<Audience>('members');
  const [members, setMembers] = useState<Member[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [principalQuery, setPrincipalQuery] = useState('');
  const [datasetQuery, setDatasetQuery] = useState('');
  const [principalSort, setPrincipalSort] = useState<SortDescriptor>({ column: 'name', direction: 'ascending' });
  const [datasetSort, setDatasetSort] = useState<SortDescriptor>({ column: 'id', direction: 'ascending' });
  const [savedAccess, setSavedAccess] = useState<AccessMap>({});
  const [draftAccess, setDraftAccess] = useState<AccessMap>({});
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState('');
  const [auditUnreadable, setAuditUnreadable] = useState<string | undefined>();
  const [auditQuery, setAuditQuery] = useState('');
  const [lakeSettings, setLakeSettings] = useState<LakeSettings>({ enabled: false, ingestUrl: '', tokenSaved: false });
  const [lakeOpen, setLakeOpen] = useState(false);
  const [lakeEnabled, setLakeEnabled] = useState(false);
  const [lakeUrl, setLakeUrl] = useState('');
  const [lakeToken, setLakeToken] = useState('');
  const [lakeFormError, setLakeFormError] = useState('');
  const [lakeSaving, setLakeSaving] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupCopyStatus, setSetupCopyStatus] = useState('');
  const lakeRequest = useRef(0);

  useEffect(() => installThemeBridge(setTheme), []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([
      listMembers(controller.signal),
      listTeams(controller.signal),
      listDatasets(controller.signal),
    ])
      .then((results) => {
        if (controller.signal.aborted) return;
        const [nextMembers, nextTeams, nextDatasets] = results;
        const failures: string[] = [];
        if (nextMembers.status === 'fulfilled') setMembers(nextMembers.value);
        else failures.push(`Members: ${errorMessage(nextMembers.reason)}`);
        if (nextTeams.status === 'fulfilled') setTeams(nextTeams.value);
        else failures.push(`Teams: ${errorMessage(nextTeams.reason)}`);
        if (nextDatasets.status === 'fulfilled') setDatasets(nextDatasets.value);
        else failures.push(`Datasets: ${errorMessage(nextDatasets.reason)}`);
        setListError(failures.filter(Boolean).join(' '));
        setListLoading(false);
      });
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    let retry: number | undefined;
    const loadHistory = (attempt: number) => {
      loadAuditHistory(controller.signal)
        .then((stored) => {
          if (controller.signal.aborted) return;
          setAuditEvents((current) => mergeAudit(current, stored.events));
          setAuditUnreadable(stored.unreadable);
          setAuditError('');
          setAuditLoading(false);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const message = errorMessage(error);
          if (!message) return;
          if (attempt < 4) {
            retry = window.setTimeout(() => loadHistory(attempt + 1), 500);
            return;
          }
          setAuditError(message);
          setAuditLoading(false);
        });
    };
    loadHistory(0);
    const request = lakeRequest.current + 1;
    lakeRequest.current = request;
    Promise.all([loadLakeSettings(controller.signal), loadSetupComplete(controller.signal)])
      .then(([settings, setupComplete]) => {
        if (controller.signal.aborted || request !== lakeRequest.current) return;
        setLakeSettings(settings);
        if (!setupComplete && !settings.enabled && !settings.ingestUrl && !settings.tokenSaved) {
          setSetupOpen(true);
        }
      })
      .catch(() => {
        // History still loads when Lake settings are absent.
      });
    return () => {
      controller.abort();
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [reloadToken]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const controller = new AbortController();
    const datasetIds = new Set(datasets.map((dataset) => dataset.id));
    loadAccess(audience, selectedId, datasetIds, controller.signal)
      .then((access) => {
        setSavedAccess(access);
        setDraftAccess(cloneAccess(access));
        setAccessLoading(false);
      })
      .catch((error: unknown) => {
        const message = errorMessage(error);
        if (!message) return;
        setAccessError(message);
        setAccessLoading(false);
      });
    return () => controller.abort();
  }, [audience, datasets, selectedId]);

  const principals = useMemo<Principal[]>(() => (
    audience === 'members'
      ? members.map((member) => ({ id: member.id, name: member.name, detail: member.email, status: member.status }))
      : teams.map((team) => ({ id: team.id, name: team.name, detail: team.description || EMPTY_CELL_PLACEHOLDER, status: '' }))
  ), [audience, members, teams]);

  const selected = principals.find((principal) => principal.id === selectedId);
  const changes = useMemo(
    () => diffAccess(savedAccess, draftAccess, datasets.map((dataset) => dataset.id)),
    [datasets, draftAccess, savedAccess],
  );
  const dirty = changes.length > 0;

  const visiblePrincipals = useMemo(() => {
    const filtered = principals.filter((principal) => matchesQuery(principalQuery, [principal.name, principal.detail, principal.status]));
    return sortRows(filtered, principalSort, (principal, column) => {
      if (column === 'detail') return principal.detail;
      if (column === 'status') return principal.status;
      return principal.name;
    });
  }, [principalQuery, principalSort, principals]);

  const datasetRows = useMemo(() => {
    const rows: DatasetRow[] = datasets
      .filter((dataset) => matchesQuery(datasetQuery, [dataset.id, dataset.description, dataset.type]))
      .map((dataset) => {
        const saved = savedAccess[dataset.id] ?? [];
        const draft = draftAccess[dataset.id] ?? [];
        return {
          id: dataset.id,
          description: dataset.description || EMPTY_CELL_PLACEHOLDER,
          type: dataset.type || EMPTY_CELL_PLACEHOLDER,
          access: formatAccess(saved),
          pending: samePolicies(saved, draft) ? EMPTY_CELL_PLACEHOLDER : 'Unsaved',
          read: draft.includes('DatasetRead'),
          maintain: draft.includes('DatasetMaintain'),
          admin: draft.includes('DatasetAdmin'),
        };
      });
    return sortRows(rows, datasetSort, (row, column) => {
      if (column === 'description') return row.description;
      if (column === 'type') return row.type;
      if (column === 'access') return row.access;
      if (column === 'pending') return row.pending;
      return row.id;
    });
  }, [datasetQuery, datasetSort, datasets, draftAccess, savedAccess]);

  const datasetColumns = useMemo(() => defineColumns<DatasetRow>([
    { id: 'id', label: 'Dataset', allowsSorting: true },
    { id: 'type', label: 'Type', allowsSorting: true },
    { id: 'description', label: 'Description', allowsSorting: true },
    { id: 'access', label: 'Current access', allowsSorting: true },
    { id: 'pending', label: 'Pending', allowsSorting: true },
    {
      id: 'read',
      label: 'Read',
      render: (_value, item) => (
        <Checkbox
          aria-label={`Read access for ${item.id}`}
          checked={item.read}
          disabled={saving || accessLoading}
          onChange={(event) => updatePolicy(item.id, 'DatasetRead', event.currentTarget.checked)}
        />
      ),
    },
    {
      id: 'maintain',
      label: 'Maintainer',
      render: (_value, item) => (
        <Checkbox
          aria-label={`Maintainer access for ${item.id}`}
          checked={item.maintain}
          disabled={saving || accessLoading}
          onChange={(event) => updatePolicy(item.id, 'DatasetMaintain', event.currentTarget.checked)}
        />
      ),
    },
    {
      id: 'admin',
      label: 'Admin',
      render: (_value, item) => (
        <Checkbox
          aria-label={`Admin access for ${item.id}`}
          checked={item.admin}
          disabled={saving || accessLoading}
          onChange={(event) => updatePolicy(item.id, 'DatasetAdmin', event.currentTarget.checked)}
        />
      ),
    },
  ]), [accessLoading, saving]);

  function updatePolicy(datasetId: string, policy: DatasetPolicy, checked: boolean) {
    setDraftAccess((current) => {
      const nextPolicies = new Set(current[datasetId] ?? []);
      if (checked) nextPolicies.add(policy);
      else nextPolicies.delete(policy);
      return { ...current, [datasetId]: [...nextPolicies] };
    });
    setNotice('');
  }

  function applyNavigation(next: PendingNavigation) {
    if (next.kind === 'audience') {
      setAudience(next.audience);
      setSelectedId('');
      setPrincipalQuery('');
      setSavedAccess({});
      setDraftAccess({});
      setAccessLoading(false);
      setAccessError('');
    } else if (next.kind === 'select') {
      setSelectedId(next.id);
      setSavedAccess({});
      setDraftAccess({});
      setAccessLoading(true);
      setAccessError('');
    } else if (next.kind === 'clear') {
      setSelectedId('');
      setSavedAccess({});
      setDraftAccess({});
      setAccessLoading(false);
      setAccessError('');
    } else {
      setListLoading(true);
      setListError('');
      if (selectedId) {
        setAccessLoading(true);
        setSavedAccess({});
        setDraftAccess({});
        setAccessError('');
      }
      setAuditLoading(true);
      setReloadToken((token) => token + 1);
    }
    setSaveError('');
    setNotice('');
  }

  function requestNavigation(next: PendingNavigation) {
    if (dirty) {
      setPendingNavigation(next);
      return;
    }
    applyNavigation(next);
  }

  function onPrincipalSelection(keys: Selection) {
    if (keys === 'all') return;
    const nextId = [...keys][0];
    if (typeof nextId !== 'string') {
      requestNavigation({ kind: 'clear' });
      return;
    }
    if (nextId === selectedId) return;
    requestNavigation({ kind: 'select', id: nextId });
  }

  async function rememberChanges(subject: Principal, pendingChanges: readonly AccessChange[], error?: unknown): Promise<string> {
    try {
      const actor = await currentActor();
      const partial = error instanceof AccessApplyError;
      const errors = partial
        ? Object.fromEntries(error.message.split('\n').map((line) => {
          const split = line.indexOf(': ');
          return [line.slice(0, split), line.slice(split + 2)];
        }))
        : undefined;
      const incoming = eventsForChanges({
        changes: pendingChanges,
        actor,
        audience,
        subjectId: subject.id,
        subjectName: subject.name,
        failedDatasetIds: partial ? new Set(error.failedDatasetIds) : undefined,
        failureMessage: error ? errorMessage(error) : undefined,
        errors,
      });
      const recorded = await appendAuditEvents(incoming);
      setAuditUnreadable(undefined);
      setAuditError('');
      const delivered = await deliverToLake(recorded, incoming);
      setAuditEvents((current) => mergeAudit(current, delivered.events));
      return delivered.note;
    } catch (historyError) {
      const message = errorMessage(historyError);
      return message ? ` Access history could not be saved: ${message}` : ' Access history could not be saved.';
    }
  }

  async function deliverToLake(recorded: AuditEvent[], incoming: readonly AuditEvent[]): Promise<{ events: AuditEvent[]; note: string }> {
    const settings = await loadLakeSettings();
    setLakeSettings(settings);
    if (!settings.enabled || !settings.ingestUrl) return { events: recorded, note: '' };
    const incomingIds = new Set(incoming.map((event) => event.id));
    const outcome = await shipAuditToLake(incoming, settings.ingestUrl);
    const failed = new Set(outcome.failedIds);
    const next = recorded.map((event) => {
      if (!incomingIds.has(event.id)) return event;
      return failed.has(event.id)
        ? { ...event, lake: 'failed' as const, lakeError: outcome.error }
        : { ...event, lake: 'sent' as const };
    });
    await saveAuditEvents(next);
    return {
      events: next,
      note: outcome.error ? ` The Lake copy failed: ${outcome.error}` : '',
    };
  }

  function openLakeSettings() {
    setLakeEnabled(lakeSettings.enabled);
    setLakeUrl(lakeSettings.ingestUrl);
    setLakeToken('');
    setLakeFormError('');
    setSetupCopyStatus('');
    setLakeOpen(true);
  }

  async function saveLake() {
    const request = lakeRequest.current + 1;
    lakeRequest.current = request;
    setLakeSaving(true);
    setLakeFormError('');
    try {
      const saved = await saveLakeSettings({ enabled: lakeEnabled, ingestUrl: lakeUrl, token: lakeToken });
      if (request !== lakeRequest.current) return;
      setLakeSettings(saved);
      setLakeEnabled(saved.enabled);
      setLakeUrl(saved.ingestUrl);
      setLakeToken('');
      setLakeOpen(false);
    } catch (error) {
      if (request !== lakeRequest.current) return;
      setLakeFormError(errorMessage(error));
      try {
        const saved = await loadLakeSettings();
        if (request !== lakeRequest.current) return;
        setLakeSettings((current) => ({
          ...saved,
          ingestUrl: saved.ingestUrl || current.ingestUrl,
        }));
        if (saved.ingestUrl) {
          setLakeEnabled(saved.enabled);
          setLakeUrl(saved.ingestUrl);
        }
      } catch {
        // Keep the form values the user just entered.
      }
    } finally {
      setLakeSaving(false);
    }
  }

  async function completeSetup(values: SetupValues) {
    const saved = await saveLakeSettings(values);
    await saveSetupComplete();
    setLakeSettings(saved);
    setLakeEnabled(saved.enabled);
    setLakeUrl(saved.ingestUrl);
    setLakeToken('');
    setSetupOpen(false);
  }

  async function skipSetup() {
    await saveSetupComplete();
    setSetupOpen(false);
  }

  async function copySetupConfig() {
    const json = lakeProxyDetails(lakeUrl).json;
    if (!json) return;
    try {
      await navigator.clipboard.writeText(json);
      setSetupCopyStatus('Copied');
    } catch {
      setSetupCopyStatus('Select the configuration and copy it manually.');
    }
  }

  async function saveAccess() {
    if (!selected) return;
    const pendingChanges = changes;
    const subject = selected;
    setConfirmOpen(false);
    setSaving(true);
    setSaveError('');
    try {
      await applyAccessChanges(audience, subject.id, pendingChanges);
      const datasetIds = new Set(datasets.map((dataset) => dataset.id));
      const access = await loadAccess(audience, subject.id, datasetIds);
      setSavedAccess(access);
      setDraftAccess(cloneAccess(access));
      const historyNote = await rememberChanges(subject, pendingChanges);
      setNotice(`Updated dataset access for ${subject.name}.${historyNote}`);
    } catch (error) {
      setSaveError(errorMessage(error));
      const historyNote = await rememberChanges(subject, pendingChanges, error);
      if (historyNote) setSaveError((current) => `${current}${historyNote}`);
      try {
        const datasetIds = new Set(datasets.map((dataset) => dataset.id));
        const access = await loadAccess(audience, subject.id, datasetIds);
        setSavedAccess(access);
        if (error instanceof AccessApplyError) {
          const failed = new Set(error.failedDatasetIds);
          setDraftAccess((current) => {
            const next = cloneAccess(access);
            for (const datasetId of failed) next[datasetId] = [...(current[datasetId] ?? [])];
            return next;
          });
        } else {
          setDraftAccess(cloneAccess(access));
        }
      } catch (reloadError) {
        setAccessError(errorMessage(reloadError));
      }
    } finally {
      setSaving(false);
    }
  }

  const visibleAuditEvents = auditEvents.slice(0, AUDIT_VISIBLE);
  const historyRows = useMemo(() => visibleAuditEvents
    .map((event) => ({
      id: event.id,
      when: formatWhen(event.at),
      actor: event.actorName,
      subject: `${event.subjectName} (${event.audience === 'members' ? 'Member' : 'Team'})`,
      dataset: event.datasetId,
      change: policyChangeSummary(event.add, event.remove),
      result: event.result === 'success' ? 'Success' : event.error ? `Failed: ${event.error}` : 'Failed',
      lake: event.lake === 'sent' ? 'Sent' : event.lake === 'failed' ? (event.lakeError ? `Failed: ${event.lakeError}` : 'Failed') : EMPTY_CELL_PLACEHOLDER,
    }))
    .filter((row) => matchesQuery(auditQuery, [row.when, row.actor, row.subject, row.dataset, row.change, row.result, row.lake])),
  [visibleAuditEvents, auditQuery]);

  const audienceLabel = audience === 'members' ? 'Members' : 'Teams';
  const previewChanges = changes.slice(0, 12).map(describeChange);
  const hiddenChangeCount = changes.length - previewChanges.length;

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-intro">
          <Text as="h1" variant="heading-lg">Dataset access</Text>
          <Text color="subtle">
            Choose a member or team, then grant, change, or remove Search dataset access.
          </Text>
        </div>
        <div className="header-actions">
          <Button variant="secondary" onClick={() => setSetupOpen(true)}>
            Setup
          </Button>
          <Button variant="tertiary" onClick={() => setDraftAccess(cloneAccess(savedAccess))} disabled={!dirty || saving}>
            Discard
          </Button>
          <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={!dirty || !selected || saving} pending={saving}>
            Save access
          </Button>
        </div>
      </header>

      {listError && <Alert appearance="danger" title="Could not load Search access data">{listError}</Alert>}
      {saveError && <Alert appearance="danger" title="Some access changes failed">{saveError}</Alert>}
      {notice && (
        <Alert appearance="success" title="Access updated" onDismiss={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      <div className="metrics">
        <div className="metric">
          <Card>
            <Card.Content>
              <Text variant="body-sm-normal" color="subtle">Members</Text>
              <Text as="p" variant="metric-md">{listLoading ? EMPTY_CELL_PLACEHOLDER : members.length}</Text>
            </Card.Content>
          </Card>
        </div>
        <div className="metric">
          <Card>
            <Card.Content>
              <Text variant="body-sm-normal" color="subtle">Teams</Text>
              <Text as="p" variant="metric-md">{listLoading ? EMPTY_CELL_PLACEHOLDER : teams.length}</Text>
            </Card.Content>
          </Card>
        </div>
        <div className="metric">
          <Card>
            <Card.Content>
              <Text variant="body-sm-normal" color="subtle">Datasets</Text>
              <Text as="p" variant="metric-md">{listLoading ? EMPTY_CELL_PLACEHOLDER : datasets.length}</Text>
            </Card.Content>
          </Card>
        </div>
        <div className="metric">
          <Card>
            <Card.Content>
              <Text variant="body-sm-normal" color="subtle">Unsaved changes</Text>
              <Text as="p" variant="metric-md">{changes.length}</Text>
            </Card.Content>
          </Card>
        </div>
      </div>

      <div className="toolbar-row">
        <ToggleButtonGroup
          aria-label="Choose members or teams"
          disallowEmptySelection
          selectedKeys={new Set<Key>([audience])}
          onSelectionChange={(keys) => {
            const next = [...keys][0];
            if (next === 'members' || next === 'teams') requestNavigation({ kind: 'audience', audience: next });
          }}
          items={[
            { key: 'members', text: 'Members', icon: UserOutlined },
            { key: 'teams', text: 'Teams', icon: UsersOutlined },
          ]}
        />
        <Button
          variant="secondary"
          leadingIcon={ReloadOutlined}
          onClick={() => requestNavigation({ kind: 'refresh' })}
          disabled={listLoading || saving}
        >
          Refresh
        </Button>
      </div>

      <Spinner isPending={listLoading} title="Loading members, teams, and datasets">
        <div className="workspace">
          <section className="panel principals">
            <div className="section-heading">
              <Text as="h2" variant="heading-sm">{audienceLabel}</Text>
              <Text color="subtle">{visiblePrincipals.length}</Text>
            </div>
            <FilterToolbar
              selectedKeys={new Set()}
              filterInputProps={{
                'aria-label': `Filter ${audienceLabel.toLowerCase()}`,
                placeholder: `Filter ${audienceLabel.toLowerCase()}`,
                value: principalQuery,
                onChange: setPrincipalQuery,
              }}
            />
            {visiblePrincipals.length === 0 ? (
              <EmptyState
                illustration="EmptyFolder"
                theme={theme}
                title={`No ${audienceLabel.toLowerCase()} to show`}
                description={principalQuery ? 'Try a different filter.' : listError ? 'The list could not be loaded. See the message above.' : `This workspace has no ${audienceLabel.toLowerCase()} yet.`}
              />
            ) : (
              <div className="table-scroll">
                <Table
                  columns={audience === 'members' ? memberColumns : teamColumns}
                  visibleColumns={audience === 'members' ? ['name', 'detail', 'status'] : ['name', 'detail']}
                  items={visiblePrincipals}
                  density="compact"
                  selectionMode="single"
                  selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
                  onSelectionChange={onPrincipalSelection}
                  sortDescriptor={principalSort}
                  onSortChange={setPrincipalSort}
                />
              </div>
            )}
          </section>

          <section className="panel datasets">
            <div className="section-copy">
              <Text as="h2" variant="heading-sm">
                {selected ? `Datasets for ${selected.name}` : 'Datasets'}
              </Text>
              <Text color="subtle">
                Checked boxes are saved together. Current access is the access granted directly to this {audience === 'members' ? 'member' : 'team'}.
              </Text>
            </div>
            {!selected && (
              <EmptyState
                illustration="EmptySuitcase"
                theme={theme}
                size="lg"
                title={`Select a ${audience === 'members' ? 'member' : 'team'}`}
                description="Choose someone from the list to see every dataset and their current access."
              />
            )}
            {selected && (
              <>
                <Alert appearance="info" title="Direct access only">
                  Team membership, product roles, and workspace permissions can grant access that is not listed here.
                </Alert>
                {accessError && <Alert appearance="danger" title="Could not load access">{accessError}</Alert>}
                <FilterToolbar
                  selectedKeys={new Set()}
                  filterInputProps={{
                    'aria-label': 'Filter datasets',
                    placeholder: 'Filter datasets',
                    value: datasetQuery,
                    onChange: setDatasetQuery,
                  }}
                />
                <Spinner isPending={accessLoading} title="Loading dataset access">
                  {datasetRows.length === 0 ? (
                    <EmptyState
                      illustration="EmptyFolder"
                      theme={theme}
                      title="No datasets to show"
                      description={datasetQuery ? 'Try a different filter.' : 'This Search workspace has no datasets yet.'}
                    />
                  ) : (
                    <div className="table-scroll">
                      <Table
                        columns={datasetColumns}
                        visibleColumns={['id', 'type', 'description', 'access', 'pending', 'read', 'maintain', 'admin']}
                        items={datasetRows}
                        density="compact"
                        sortDescriptor={datasetSort}
                        onSortChange={setDatasetSort}
                      />
                    </div>
                  )}
                </Spinner>
              </>
            )}
          </section>
        </div>
      </Spinner>

      <section className="panel history">
        <div className="section-heading">
          <div className="section-copy">
            <Text as="h2" variant="heading-sm">Access history{auditLoading ? '' : ` (${auditEvents.length})`}</Text>
            <Text color="subtle">
              Each saved change stays in this list, with the person, the member or team, the dataset, and the permissions added or removed. This list shows the newest {AUDIT_VISIBLE}. Up to {AUDIT_LIMIT} are kept, and Export downloads all of them.
              {lakeStatusText(lakeSettings)}
            </Text>
          </div>
          <div className="header-actions">
            <Button
              variant="secondary"
              onClick={() => downloadAuditHistory(auditEvents, auditUnreadable)}
              disabled={auditLoading}
            >
              Export
            </Button>
            {lakeSearchHref(lakeSettings.ingestUrl) && (
              <ButtonLink
                variant="secondary"
                href={lakeSearchHref(lakeSettings.ingestUrl)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Lake audit logs
              </ButtonLink>
            )}
            <Button variant="secondary" onClick={openLakeSettings}>
              Lake shipping
            </Button>
          </div>
        </div>
        {auditError && <Alert appearance="danger" title="Could not load access history">{auditError}</Alert>}
        {auditUnreadable !== undefined && (
          <Alert appearance="warning" title="Earlier history is in an older format">
            The app could not read the history saved before this version. Export includes that stored value as it is. The next saved change backs it up and starts a new readable history.
          </Alert>
        )}
        <FilterToolbar
          selectedKeys={new Set()}
          filterInputProps={{
            'aria-label': 'Filter access history',
            placeholder: 'Filter access history',
            value: auditQuery,
            onChange: setAuditQuery,
          }}
        />
        {auditLoading ? (
          <EmptyState
            illustration="EmptyFolder"
            theme={theme}
            title="Loading access history"
            description="Saved changes are being read."
          />
        ) : historyRows.length === 0 ? (
          <EmptyState
            illustration="EmptyFolder"
            theme={theme}
            title={auditError ? 'Access history could not be read' : 'No access history to show'}
            description={auditError
              ? 'The saved history was left unchanged.'
              : auditQuery
                ? 'Try a different filter.'
                : 'Saved access changes will appear here.'}
          />
        ) : (
          <div className="table-scroll">
            <Table
              columns={historyColumns}
              visibleColumns={lakeSettings.enabled || auditEvents.some((event) => event.lake)
                ? ['when', 'actor', 'subject', 'dataset', 'change', 'result', 'lake']
                : ['when', 'actor', 'subject', 'dataset', 'change', 'result']}
              items={historyRows}
              density="compact"
            />
          </div>
        )}
      </section>

      <Modal
        isOpen={lakeOpen}
        onIsOpenChange={setLakeOpen}
        title="Lake shipping"
        size="lg"
        footer={null}
      >
        <div className="section-copy">
          <Text color="subtle">
            Saved changes stay in Access history and in the export file whether this is on or off. Turning it on adds a second output: a copy of each new change is sent by HTTPS POST.
          </Text>
          <Text>
            Create the endpoint and token first.{' '}
            <Link href={DIRECT_ACCESS_DOCS} isExternal>Direct Access instructions</Link>
            {' '}or{' '}
            <Link href={RAW_HTTP_DOCS} isExternal>Lakehouse Raw HTTP instructions</Link>
            .
          </Text>
          <div className="header-actions">
            <Switch
              aria-label="Also send a copy of each saved change to Lake"
              checked={lakeEnabled}
              onChange={(event) => setLakeEnabled(event.currentTarget.checked)}
            />
            <Text>Also send a copy of each saved change to Lake</Text>
          </div>
          <TextField
            label="Ingest URL"
            value={lakeUrl}
            onChange={(value) => {
              setLakeUrl(value);
              setSetupCopyStatus('');
            }}
            placeholder="https://host:port/datasets/dataset_id"
            helperText="Direct Access: the JSON ingest URL, including /datasets/ and the dataset id. Lakehouse: the Raw HTTP address, such as https://search.main.example.cribl.cloud:20000."
          />
          <PasswordField
            label="Auth token"
            value={lakeToken}
            onChange={setLakeToken}
            helperText={lakeSettings.tokenSaved ? 'A token is already saved. Leave this blank to keep it.' : 'Paste the auth token from that source. It is stored encrypted and sent as the Authorization header.'}
          />
          {lakeProxyDetails(lakeUrl).json && (
            <div className="section-copy">
              <Text as="h3" variant="heading-xs">External API Access</Text>
              <Text color="subtle">
                The hostname and port below are derived from the ingest URL.
              </Text>
              <TextArea
                aria-label="External API Access configuration"
                value={lakeProxyDetails(lakeUrl).json}
                readOnly
                rows={13}
              />
              <div className="header-actions">
                <Button variant="secondary" onClick={() => { void copySetupConfig(); }}>
                  Copy configuration
                </Button>
                {setupCopyStatus && <Text color="subtle">{setupCopyStatus}</Text>}
              </div>
              <Text>
                Copy this configuration. Then open Apps, select this app, open Settings, and select External API Access. Append the copied object to the array already shown, and save. Do not replace the existing array.
              </Text>
            </div>
          )}
          {lakeProxyDetails(lakeUrl).problem && (
            <Alert appearance="warning" title="External access entry unavailable">
              {lakeProxyDetails(lakeUrl).problem}
            </Alert>
          )}
          <Text color="subtle">
            The token is not shown again after you save it. Cribl allows this app to call only hostnames that were declared for the app. The first time you use a new ingest hostname, that hostname has to be added to the app before events will send.
          </Text>
          {lakeFormError && <Alert appearance="danger" title="Could not save Lake shipping">{lakeFormError}</Alert>}
          <div className="header-actions">
            <Button variant="secondary" onClick={() => setLakeOpen(false)} disabled={lakeSaving}>Cancel</Button>
            <Button variant="primary" onClick={() => { void saveLake(); }} pending={lakeSaving}>Save</Button>
          </div>
        </div>
      </Modal>

      {setupOpen && (
        <SetupWizard
          isOpen
          initialValues={{
            enabled: lakeSettings.enabled,
            ingestUrl: lakeSettings.ingestUrl,
            token: '',
          }}
          tokenSaved={lakeSettings.tokenSaved}
          onClose={() => setSetupOpen(false)}
          onComplete={completeSetup}
          onSkip={skipSetup}
        />
      )}

      <Modal
        isOpen={confirmOpen}
        onIsOpenChange={setConfirmOpen}
        title="Update dataset access"
        confirmButtonText="Update access"
        onConfirm={() => { void saveAccess(); }}
      >
        <div className="section-copy">
          <Text>
            {selected
              ? `Update dataset access for ${selected.name} (${selected.id}). This changes live Search permissions.`
              : 'Update dataset access.'}
          </Text>
          <ul className="change-list">
            {previewChanges.map((change) => <li key={change}><Text>{change}</Text></li>)}
          </ul>
          {hiddenChangeCount > 0 && <Text color="subtle">{hiddenChangeCount} more dataset changes are included.</Text>}
        </div>
      </Modal>

      <Modal
        isOpen={pendingNavigation !== null}
        onIsOpenChange={(open) => { if (!open) setPendingNavigation(null); }}
        title="Discard unsaved access changes"
        confirmButtonText="Discard changes"
        onConfirm={() => {
          if (pendingNavigation) applyNavigation(pendingNavigation);
          setPendingNavigation(null);
        }}
      >
        <Text>
          You have unsaved dataset access changes{selected ? ` for ${selected.name}` : ''}. Discard them before continuing.
        </Text>
      </Modal>
    </div>
  );
}

export default App;
