import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Link,
  Modal,
  PasswordField,
  Radio,
  RadioGroup,
  Text,
  TextArea,
  TextField,
} from '@capra/core';
import { DIRECT_ACCESS_DOCS, RAW_HTTP_DOCS, lakeProxyDetails } from './lake-setup';

export type SetupValues = {
  enabled: boolean;
  ingestUrl: string;
  token: string;
};

type SetupWizardProps = {
  isOpen: boolean;
  initialValues: SetupValues;
  tokenSaved: boolean;
  onClose: () => void;
  onComplete: (values: SetupValues) => Promise<void>;
  onSkip: () => Promise<void>;
};

export function SetupWizard({
  isOpen,
  initialValues,
  tokenSaved,
  onClose,
  onComplete,
  onSkip,
}: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [enabled, setEnabled] = useState(initialValues.enabled);
  const [ingestUrl, setIngestUrl] = useState(initialValues.ingestUrl);
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const proxy = useMemo(() => lakeProxyDetails(ingestUrl), [ingestUrl]);

  async function copyProxyConfig() {
    if (!proxy.json) return;
    try {
      await navigator.clipboard.writeText(proxy.json);
      setCopied(true);
    } catch {
      setError('Copy was blocked by the browser. Select the configuration text and copy it manually.');
    }
  }

  async function finish() {
    setPending(true);
    setError('');
    try {
      await onComplete({ enabled, ingestUrl, token });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Setup could not be saved.');
    } finally {
      setPending(false);
    }
  }

  async function skip() {
    setPending(true);
    setError('');
    try {
      await onSkip();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Setup could not be skipped.');
    } finally {
      setPending(false);
    }
  }

  const steps = enabled ? ['App access', 'Lake shipping', 'Review'] : ['App access', 'Review'];
  const lakeStep = enabled ? 1 : -1;
  const reviewStep = steps.length - 1;
  const lakeReady = !enabled || (
    Boolean(ingestUrl.trim())
    && (Boolean(token.trim()) || tokenSaved)
    && !proxy.problem
  );

  return (
    <Modal
      isOpen={isOpen}
      onIsOpenChange={(open) => { if (!open) onClose(); }}
      title="Set up Dataset Access Manager"
      size="lg"
      footer={null}
    >
      <div className="setup-flow">
        <div className="setup-steps" data-count={steps.length} aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((label, index) => (
            <div className="setup-step" data-active={index === step} data-complete={index < step} key={label}>
              <Text variant={index === step ? 'body-sm-semibold' : 'body-sm-normal'}>
                {index + 1}. {label}
              </Text>
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="section-copy">
            <Text as="h2" variant="heading-sm">Confirm access and choose optional Lake shipping</Text>
            <Text>
              The app reads members, teams, Search datasets, and direct dataset permissions. It posts permission changes only after a user reviews and confirms them.
            </Text>
            <Text color="subtle">
              An organization administrator must install and share the app. Users also need the Search permissions required to view and update the datasets they manage.
            </Text>
            <Text as="h3" variant="heading-xs">Lake shipping</Text>
            <Text color="subtle">
              This is optional. Access history stays in the app and in the export file either way.
            </Text>
            <RadioGroup
              aria-label="Choose whether to send access history to Lake"
              layout="vertical"
              value={enabled ? 'lake' : 'off'}
              onChange={(event) => setEnabled(event.currentTarget.value === 'lake')}
            >
              <Radio value="off">Do not send events to Lake</Radio>
              <Radio value="lake">Also send a copy of each new change to Lake</Radio>
            </RadioGroup>
            <Text>
              To turn this on, create the endpoint and token first.{' '}
              <Link href={DIRECT_ACCESS_DOCS} isExternal>Direct Access instructions</Link>
              {' '}or{' '}
              <Link href={RAW_HTTP_DOCS} isExternal>Lakehouse Raw HTTP instructions</Link>
              . Choosing Lake shipping adds a step for the URL, token, and External API Access entry.
            </Text>
          </div>
        )}

        {step === lakeStep && (
          <div className="section-copy">
            <Text as="h2" variant="heading-sm">Configure Lake shipping</Text>
            <Text>
              Use the URL and token from the{' '}
              <Link href={DIRECT_ACCESS_DOCS} isExternal>Direct Access instructions</Link>
              {' '}or{' '}
              <Link href={RAW_HTTP_DOCS} isExternal>Lakehouse Raw HTTP instructions</Link>
              .
            </Text>
            <TextField
              label="Ingest URL"
              value={ingestUrl}
              onChange={(value) => {
                setIngestUrl(value);
                setCopied(false);
              }}
              placeholder="https://host:10080/datasets/dataset_id"
              helperText="The hostname and port are derived from this URL. Direct Access URLs include /datasets/ and the dataset id."
            />
            <PasswordField
              label="Auth token"
              value={token}
              onChange={setToken}
              helperText={tokenSaved ? 'A token is already saved. Leave this blank to keep it.' : 'The token is encrypted in this app installation and is not included in the package.'}
            />

            {proxy.problem && <Alert appearance="warning" title="External access entry unavailable">{proxy.problem}</Alert>}
            {proxy.json && (
              <div className="section-copy">
                <Text as="h3" variant="heading-xs">External API Access</Text>
                <TextArea
                  aria-label="External API Access configuration"
                  value={proxy.json}
                  readOnly
                  rows={13}
                />
                <div className="header-actions">
                  <Button variant="secondary" onClick={() => { void copyProxyConfig(); }}>
                    {copied ? 'Copied' : 'Copy configuration'}
                  </Button>
                </div>
                <Text>
                  Copy this configuration. Then open Apps, select this app, open Settings, and select External API Access. Append the copied object to the array already shown, and save. Do not replace the existing array.
                </Text>
              </div>
            )}
          </div>
        )}

        {step === reviewStep && (
          <div className="section-copy">
            <Text as="h2" variant="heading-sm">Review setup</Text>
            <Text>
              Dataset access management is ready when the app is shared with users who have the necessary Search permissions.
            </Text>
            {enabled ? (
              <Alert appearance={lakeReady ? 'success' : 'warning'} title={lakeReady ? 'Lake shipping is ready' : 'Lake shipping needs attention'}>
                {lakeReady
                  ? `New access events will be sent to ${ingestUrl.trim()}.`
                  : 'Go back and provide the ingest URL and auth token.'}
              </Alert>
            ) : (
              <Alert appearance="info" title="Lake shipping is off">
                Access history remains available in the app and export. You can enable Lake later.
              </Alert>
            )}
            <Text color="subtle">
              Settings and history are shared by users of this app installation. They are not included when the app package is installed in another organization.
            </Text>
          </div>
        )}

        {error && <Alert appearance="danger" title="Setup could not be completed">{error}</Alert>}

        <div className="setup-actions">
          <div>
            {step > 0 && <Button variant="secondary" onClick={() => setStep((current) => current - 1)} disabled={pending}>Previous</Button>}
          </div>
          <div className="header-actions">
            {step === 0 && <Button variant="tertiary" onClick={() => { void skip(); }} disabled={pending}>Skip for now</Button>}
            <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
            {step < reviewStep ? (
              <Button variant="primary" onClick={() => setStep((current) => current + 1)} disabled={pending || (step === lakeStep && !lakeReady)}>
                Next
              </Button>
            ) : (
              <Button variant="primary" onClick={() => { void finish(); }} disabled={pending || (enabled && !lakeReady)} pending={pending}>
                Save setup
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
