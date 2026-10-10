import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageFirst = process.argv.includes('--package');

loadLocalEnv(path.join(root, '.cribl.local.env'));

const baseUrl = required('CRIBL_BASE_URL').replace(/\/$/, '');
const clientId = required('CRIBL_CLIENT_ID');
const clientSecret = required('CRIBL_CLIENT_SECRET');
const audience = process.env.CRIBL_AUDIENCE || 'https://api.cribl.cloud';

if (packageFirst) {
  const packed = spawnSync('npm', ['run', 'package'], { cwd: root, stdio: 'inherit' });
  if (packed.status !== 0) process.exit(packed.status ?? 1);
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const archiveName = `${pkg.name}-${pkg.version}.tgz`;
const archivePath = path.join(root, 'build', archiveName);
if (!existsSync(archivePath)) {
  fail(`Missing ${path.relative(root, archivePath)}. Run npm run package, or npm run deploy -- --package.`);
}

try {
  await deploy(pkg, archiveName, archivePath, clientId, clientSecret, audience);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function deploy(pkg, archiveName, archivePath, clientId, clientSecret, audience) {
  const token = await login(clientId, clientSecret, audience);
  const installed = await findInstalledApp(token, process.env.CRIBL_APP_ID || pkg.name);
  const uploaded = await uploadArchive(token, archiveName, readFileSync(archivePath));
  const source = uploaded?.source;
  if (!source) fail('Upload succeeded but Cribl did not return a source name.');

  if (installed) {
    try {
      const upgraded = await cribl(token, 'PATCH', `/apps/${encodeURIComponent(installed.id)}`, { source });
      const item = firstItem(upgraded) ?? installed;
      console.log(`Upgraded ${item.id} to ${item.version ?? pkg.version}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/up to date/i.test(message)) throw error;
      console.log(`${installed.id} is already at ${pkg.version}. Nothing to upgrade.`);
    }
    return;
  }

  const appId = (process.env.CRIBL_APP_ID || pkg.name).toLowerCase();
  const installedNow = await cribl(token, 'POST', '/apps', { source, id: appId });
  const item = firstItem(installedNow);
  console.log(`Installed ${item?.id ?? appId} at ${item?.version ?? pkg.version}.`);
}

function loadLocalEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`Set ${name} in .cribl.local.env. Copy .cribl.local.env.example and add an API credential from Cribl.Cloud.`);
  }
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function login(id, secret, tokenAudience) {
  const response = await fetch('https://login.cribl.cloud/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
      audience: tokenAudience,
    }),
  });
  const body = await readJson(response);
  if (!response.ok || !body?.access_token) {
    const detail = body?.error_description || body?.message || body?.error;
    fail(`Cribl login failed (${response.status})${detail ? `: ${detail}` : ''}. Check the client ID and secret in .cribl.local.env.`);
  }
  return body.access_token;
}

async function findInstalledApp(token, preferredId) {
  const listed = await cribl(token, 'GET', '/apps?limit=200');
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const wanted = new Set([preferredId, preferredId.toLowerCase()].filter(Boolean));
  return items.find((item) => wanted.has(item.id) || wanted.has(String(item.id).toLowerCase()));
}

async function uploadArchive(token, filename, bytes) {
  return cribl(
    token,
    'PUT',
    `/apps?filename=${encodeURIComponent(filename)}`,
    bytes,
    { 'content-type': 'application/octet-stream' },
  );
}

async function cribl(token, method, apiPath, body, headers = {}) {
  const isJson = body && !Buffer.isBuffer(body);
  const response = await fetch(`${baseUrl}/api/v1${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(isJson ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: isJson ? JSON.stringify(body) : body,
  });
  const parsed = await readJson(response);
  if (!response.ok) {
    const message = parsed?.message || `Request failed (${response.status})`;
    throw new Error(`${method} ${apiPath} failed: ${message}`);
  }
  return parsed;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstItem(body) {
  return Array.isArray(body?.items) ? body.items[0] : undefined;
}
