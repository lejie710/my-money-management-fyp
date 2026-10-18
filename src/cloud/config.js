const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateCloudConfiguration(value) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['mode', 'firebase', 'emulators'].includes(key)) ||
    !['hosted', 'emulator'].includes(value.mode) ||
    !object(value.firebase)
  )
    throw new Error('Choose hosted or emulator Firebase configuration.');
  const allowed = ['apiKey', 'projectId', 'appId', 'authDomain', 'storageBucket'];
  if (Object.keys(value.firebase).some((key) => !allowed.includes(key)))
    throw new Error('Firebase configuration contains unsupported fields.');
  const config = {};
  for (const key of allowed) {
    const text = value.firebase[key];
    if (
      typeof text !== 'string' ||
      !text ||
      text.length > 240 ||
      text.trim() !== text ||
      /[\u0000-\u0020\u007f]/.test(text)
    )
      throw new Error('Complete the Firebase client configuration.');
    config[key] = text;
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId))
    throw new Error('Choose a valid Firebase project ID.');
  if (
    !/^[A-Za-z0-9._-]+$/.test(config.storageBucket) ||
    !/^[A-Za-z0-9.-]+$/.test(config.authDomain)
  )
    throw new Error('Firebase host and bucket configuration are invalid.');
  if (value.mode === 'hosted' && config.projectId.startsWith('demo-'))
    throw new Error('Demo project IDs are reserved for emulator verification.');
  let emulators = null;
  if (value.mode === 'emulator') {
    if (!config.projectId.startsWith('demo-'))
      throw new Error('Local cloud verification requires a demo- project ID.');
    if (
      !object(value.emulators) ||
      Object.keys(value.emulators).sort().join(',') !== 'auth,firestore,storage'
    )
      throw new Error('Configure all three loopback emulators together.');
    emulators = {};
    for (const key of ['auth', 'firestore', 'storage']) {
      const port = value.emulators[key];
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error('Choose valid loopback emulator ports.');
      emulators[key] = port;
    }
    if (new Set(Object.values(emulators)).size !== 3)
      throw new Error('Emulator ports must be distinct.');
  } else if (value.emulators !== undefined && value.emulators !== null)
    throw new Error('Hosted Firebase cannot use emulator endpoints.');
  return Object.freeze({
    mode: value.mode,
    firebase: Object.freeze(config),
    emulators: emulators ? Object.freeze(emulators) : null,
  });
}
module.exports = { validateCloudConfiguration };
