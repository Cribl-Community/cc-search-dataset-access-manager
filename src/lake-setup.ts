export type LakeProxyConfig = {
  id: string;
  timeout: number;
  paths: {
    allowlist: string[];
  };
  headers: {
    inject: {
      Authorization: string;
    };
    allowlist: string[];
  };
  rejectUnauthorized: boolean;
};

export const DIRECT_ACCESS_DOCS = 'https://docs.cribl.io/lake/direct-access/';
export const RAW_HTTP_DOCS = 'https://docs.cribl.io/search/source-raw-http/';

/** Returns the Lake dataset id from a Direct Access ingest URL, or '' for other endpoints. */
export function lakeDatasetId(ingestUrl: string): string {
  try {
    const { pathname } = new URL(ingestUrl.trim());
    const id = pathname.split('/datasets/')[1]?.split('/')[0] ?? '';
    return decodeURIComponent(id);
  } catch {
    return '';
  }
}

/** Builds a Leader UI link that runs a new search over the Lake audit dataset. */
export function lakeSearchHref(ingestUrl: string): string {
  const datasetId = lakeDatasetId(ingestUrl);
  if (!datasetId) return '';
  const params = new URLSearchParams({
    q: `dataset="${datasetId}" | sort by _time desc | limit 100`,
    et: '-7d',
    lt: 'now',
    run: 'true',
  });
  return `/search/new?${params.toString()}`;
}

export type LakeProxyDetails = {
  config?: LakeProxyConfig;
  json: string;
  problem: string;
};

/** Builds the App Settings > External API Access entry for a Lake ingest URL. */
export function lakeProxyDetails(ingestUrl: string): LakeProxyDetails {
  const value = ingestUrl.trim();
  if (!value) return { json: '', problem: '' };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { json: '', problem: 'Enter a full URL to generate the External API Access entry.' };
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return { json: '', problem: 'The ingest URL must be a full HTTPS URL.' };
  }

  const config: LakeProxyConfig = {
    id: parsed.host,
    timeout: 30000,
    paths: {
      allowlist: [parsed.pathname.includes('/datasets/') ? '/datasets/' : '/'],
    },
    headers: {
      inject: {
        Authorization: 'kv.lakeIngestToken',
      },
      allowlist: ['content-type', 'accept'],
    },
    rejectUnauthorized: true,
  };

  return {
    config,
    json: JSON.stringify(config, null, 2),
    problem: '',
  };
}
