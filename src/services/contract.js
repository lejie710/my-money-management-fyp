const { validateHostedProviders } = require('../companion/providerContract');
const HOSTED_PROVIDER_HEADER = 'x-mymoney-hosted-provider';
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const project = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value);
const uid = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  !/[\x00-\x1f\x7f]/.test(value);
const fail = () => {
  throw new Error('Hosted service configuration is invalid.');
};
function validateServiceConfiguration(value) {
  if (
    !exact(value, ['version', 'mode', 'origin', 'projectId']) ||
    value.version !== 1 ||
    !project(value.projectId) ||
    !['hosted', 'emulator'].includes(value.mode) ||
    typeof value.origin !== 'string'
  )
    fail();
  let parsed;
  try {
    parsed = new URL(value.origin);
  } catch {
    fail();
  }
  if (
    parsed.origin !== value.origin ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  )
    fail();
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
  if (value.mode === 'hosted') {
    if (parsed.protocol !== 'https:' || loopback || value.projectId.startsWith('demo-')) fail();
  } else if (
    parsed.protocol !== 'http:' ||
    !loopback ||
    !value.projectId.startsWith('demo-') ||
    !parsed.port
  )
    fail();
  return Object.freeze({ ...value });
}
function validateServiceMetadata(value, expected) {
  if (
    !exact(value, ['version', 'serviceId', 'projectId', 'uid', 'providers']) ||
    value.version !== 1 ||
    typeof value.serviceId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.serviceId) ||
    !project(value.projectId) ||
    !uid(value.uid) ||
    value.projectId !== expected.projectId ||
    value.uid !== expected.uid
  )
    fail();
  return Object.freeze({
    version: 1,
    serviceId: value.serviceId,
    projectId: value.projectId,
    uid: value.uid,
    providers: validateHostedProviders(value.providers),
  });
}
function hostedProviderBinding(metadata, capability) {
  if (!['assistant', 'ocr', 'forecast'].includes(capability) || !metadata.providers[capability])
    fail();
  return JSON.stringify([
    1,
    metadata.serviceId,
    metadata.projectId,
    metadata.uid,
    capability,
    metadata.providers[capability],
  ]);
}
module.exports = {
  HOSTED_PROVIDER_HEADER,
  validateServiceConfiguration,
  validateServiceMetadata,
  hostedProviderBinding,
  validProjectId: project,
  validOwnerUid: uid,
};
