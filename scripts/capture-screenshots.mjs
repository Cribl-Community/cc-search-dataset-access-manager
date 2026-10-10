import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/tmp/shot-tools/package.json');
const puppeteer = require('puppeteer-core');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'docs/screenshots');
const baseUrl = process.env.SCREENSHOT_URL ?? 'http://127.0.0.1:5174';

function installDemoData() {
window.CRIBL_API_URL = 'https://demo.northwind.example/api/v1';
window.CRIBL_BASE_PATH = '/app-ui/search-dataset-access-manager';
window.getCriblUser = async () => ({
  id: 'sam.okonkwo',
  username: 'sam.okonkwo',
  email: 'sam.okonkwo@northwind.example',
  firstName: 'Sam',
  lastName: 'Okonkwo',
  initials: 'SO',
});

const members = [
  { id: 'maya.chen', first: 'Maya', last: 'Chen', email: 'maya.chen@northwind.example', disabled: false },
  { id: 'jordan.hale', first: 'Jordan', last: 'Hale', email: 'jordan.hale@northwind.example', disabled: false },
  { id: 'priya.shah', first: 'Priya', last: 'Shah', email: 'priya.shah@northwind.example', disabled: false },
  { id: 'alex.rivera', first: 'Alex', last: 'Rivera', email: 'alex.rivera@northwind.example', disabled: true },
];
const teams = [
  { id: 'security-operations', name: 'Security Operations', description: 'Reviews security detections and investigations' },
  { id: 'platform-engineering', name: 'Platform Engineering', description: 'Maintains shared platform datasets' },
  { id: 'finance-analytics', name: 'Finance Analytics', description: 'Reads finance and billing datasets' },
];
const datasets = [
  { id: 'cloud_audit', description: 'Cloud audit events', type: 'cribl_lake' },
  { id: 'firewall_logs', description: 'Perimeter firewall logs', type: 's3' },
  { id: 'app_transactions', description: 'Application transaction events', type: 'http' },
  { id: 'identity_signins', description: 'Workforce sign-in activity', type: 'azure_blob' },
  { id: 'billing_usage', description: 'Product usage and billing records', type: 'cribl_lake' },
];
const access = {
  'maya.chen': [
    { type: 'datasets', id: 'cloud_audit', policy: 'DatasetRead' },
    { type: 'datasets', id: 'firewall_logs', policy: 'DatasetRead' },
    { type: 'datasets', id: 'firewall_logs', policy: 'DatasetMaintain' },
    { type: 'datasets', id: 'identity_signins', policy: 'DatasetRead' },
  ],
  'security-operations': [
    { type: 'datasets', id: 'cloud_audit', policy: 'DatasetRead' },
    { type: 'datasets', id: 'cloud_audit', policy: 'DatasetMaintain' },
    { type: 'datasets', id: 'firewall_logs', policy: 'DatasetRead' },
    { type: 'datasets', id: 'identity_signins', policy: 'DatasetAdmin' },
  ],
};
const audit = {
  events: [
    { id: 'evt-1', at: '2026-10-09T15:24:00.000Z', actorId: 'sam.okonkwo', actorName: 'Sam Okonkwo', audience: 'members', subjectId: 'jordan.hale', subjectName: 'Jordan Hale', datasetId: 'app_transactions', add: ['DatasetRead'], remove: [], result: 'success', lake: 'sent' },
    { id: 'evt-2', at: '2026-10-09T15:24:00.000Z', actorId: 'sam.okonkwo', actorName: 'Sam Okonkwo', audience: 'members', subjectId: 'jordan.hale', subjectName: 'Jordan Hale', datasetId: 'billing_usage', add: [], remove: ['DatasetRead'], result: 'success', lake: 'sent' },
    { id: 'evt-3', at: '2026-10-08T18:05:00.000Z', actorId: 'sam.okonkwo', actorName: 'Sam Okonkwo', audience: 'teams', subjectId: 'platform-engineering', subjectName: 'Platform Engineering', datasetId: 'cloud_audit', add: ['DatasetMaintain'], remove: [], result: 'success', lake: 'sent' },
  ],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

window.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
  const path = url.pathname;
  const offset = Number(url.searchParams.get('offset') || '0');
  if (offset > 0) return json({ items: [], totalCount: 0 });
  if (path.endsWith('/products/search/users') || path.endsWith('/system/users')) return json({ items: members, totalCount: members.length });
  if (path.endsWith('/system/teams')) return json({ items: teams, totalCount: teams.length });
  if (path.endsWith('/search/datasets')) return json({ items: datasets, totalCount: datasets.length });
  const memberAcl = path.match(/\/users\/([^/]+)\/acl$/);
  const teamAcl = path.match(/\/teams\/([^/]+)\/acl$/);
  const subject = decodeURIComponent((memberAcl || teamAcl)?.[1] || '');
  if (subject) return json({ items: access[subject] || [], totalCount: (access[subject] || []).length });
  if (path.endsWith('/kvstore/scan')) {
    return json({ items: [
      { key: 'audit/events', value: JSON.stringify(audit) },
      { key: 'audit/lake', value: JSON.stringify({ enabled: true, ingestUrl: 'https://lake.northwind.example:10080/datasets/access_audit' }) },
    ] });
  }
  if (path.endsWith('/kvstore/setup/completed')) return json(true);
  if (path.endsWith('/kvstore/keys')) return json({ items: [] });
  if (path.includes('/kvstore/')) return new Response('', { status: 404 });
  return json({ items: [] });
};
}

async function waitForText(page, text) {
  await page.waitForFunction((value) => document.body.innerText.includes(value), { timeout: 15000 }, text);
}

async function clickText(page, text) {
  const clicked = await page.evaluate((value) => {
    const row = [...document.querySelectorAll('[role="row"], button')].find((element) => element.textContent.includes(value));
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    row.click();
    return true;
  }, text);
  if (!clicked) throw new Error(`Could not click ${text}`);
}

async function shoot(page, name) {
  await page.evaluate(() => {
    document.querySelectorAll('[class*="overlaySpinner"]').forEach((element) => {
      element.style.display = 'none';
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.screenshot({ path: resolve(outDir, name), fullPage: false });
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  defaultViewport: { width: 1680, height: 1180, deviceScaleFactor: 2 },
  args: ['--hide-scrollbars', '--force-color-profile=srgb'],
});

try {
  await mkdir(outDir, { recursive: true });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluateOnNewDocument(installDemoData);
  page.on('pageerror', (error) => console.error('PAGE', error.message));

  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await waitForText(page, 'Maya Chen');
  await clickText(page, 'Maya Chen');
  await waitForText(page, 'Datasets for Maya Chen');
  await page.click('[aria-label="Read access for app_transactions"]');
  await page.click('[aria-label="Admin access for cloud_audit"]');
  await waitForText(page, 'Unsaved');
  await shoot(page, 'members-bulk-edit.png');

  await clickText(page, 'Save access');
  await waitForText(page, 'Update dataset access for Maya Chen');
  await shoot(page, 'save-confirmation.png');
  await page.keyboard.press('Escape');

  const history = await page.$('section.history');
  await history.screenshot({ path: resolve(outDir, 'access-history.png') });

  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await waitForText(page, 'Maya Chen');
  await clickText(page, 'Teams');
  await waitForText(page, 'Security Operations');
  await clickText(page, 'Security Operations');
  await waitForText(page, 'Datasets for Security Operations');
  await page.waitForFunction(() => {
    const box = document.querySelector('[aria-label="Admin access for identity_signins"]');
    return Boolean(box) && !box.hasAttribute('disabled') && box.getAttribute('aria-disabled') !== 'true';
  });
  await shoot(page, 'teams.png');
  console.log(`Screenshots written to ${outDir}`);
} finally {
  await browser.close();
}
