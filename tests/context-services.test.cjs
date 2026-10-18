const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAdapter, deferred, flush } = require('./helpers/native-adapter-vm.cjs');
const granted = { granted: true, canAskAgain: true };
const denied = { granted: false, canAskAgain: false };
const ask = { granted: false, canAskAgain: true };

function fixture(options = {}) {
  const calls = [];
  const invoke =
    (name, fallback) =>
    async (...args) => {
      calls.push([name, ...args]);
      return Object.hasOwn(options, name)
        ? typeof options[name] === 'function'
          ? options[name](...args)
          : options[name]
        : fallback;
    };
  const loaded = loadAdapter('services.ts', {
    'expo-image-picker': {
      getPendingResultAsync: invoke('pending', null),
      launchImageLibraryAsync: invoke('library', { canceled: true, assets: null }),
    },
    'expo-contacts': {
      getPermissionsAsync: invoke('contactPermission', granted),
      requestPermissionsAsync: invoke('contactRequest', granted),
      Contact: { presentPicker: invoke('contactPicker', null) },
    },
    'expo-location': {
      getForegroundPermissionsAsync: invoke('locationPermission', granted),
      requestForegroundPermissionsAsync: invoke('locationRequest', granted),
      hasServicesEnabledAsync: invoke('servicesEnabled', true),
      getCurrentPositionAsync: invoke('current', {
        coords: { latitude: 5.4, longitude: 100.3, accuracy: 12 },
        timestamp: 12345,
      }),
      reverseGeocodeAsync: invoke('geocode', [
        { name: ' Cafe ', street: 'Cafe', city: 'Penang', country: 'Malaysia' },
      ]),
      Accuracy: { High: 4 },
    },
    'react-native': { Platform: { OS: options.platform ?? 'android' } },
  });
  return {
    ...loaded,
    calls,
    services: loaded.exports.createContextServices({ inspectSource: invoke('inspect', {}) }),
  };
}

test('photo cancellation returns no selection and performs no file or ledger action', async () => {
  const f = fixture();
  assert.equal(await f.services.pickPhoto(), null);
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ['pending', 'library'],
  );
  const settings = f.calls[1][1];
  assert.equal(settings.allowsMultipleSelection, false);
  assert.equal(settings.exif, false);
  assert.equal(settings.base64, false);
  assert.equal(settings.mediaTypes.join(','), 'images');
});

test('Android pending success or error is never implicitly attached to a different editor', async () => {
  for (const pending of [
    { canceled: false, assets: [{ uri: 'file:///old.jpg' }] },
    { code: 'interrupted', message: 'old error' },
  ]) {
    const f = fixture({ pending });
    await assert.rejects(f.services.pickPhoto(), /earlier photo selection/);
    assert.deepEqual(
      f.calls.map((x) => x[0]),
      ['pending'],
    );
  }
  const cancelled = fixture({ pending: { canceled: true, assets: null } });
  assert.equal(await cancelled.services.pickPhoto(), null);
});

test('photo selection validates exactly one asset before returning only its local URI', async () => {
  const f = fixture({
    library: {
      canceled: false,
      assets: [{ uri: 'content://picked/one', exif: { secret: 'ignored' }, assetId: 'ignored' }],
    },
  });
  const picked = await f.services.pickPhoto();
  assert.equal(JSON.stringify(picked), JSON.stringify({ uri: 'content://picked/one' }));
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ['pending', 'library', 'inspect'],
  );
  for (const assets of [null, [], [{ uri: 'file:///one' }, { uri: 'file:///two' }]]) {
    const invalid = fixture({ library: { canceled: false, assets } });
    await assert.rejects(invalid.services.pickPhoto(), /one supported photo/);
    assert.equal(
      invalid.calls.some((x) => x[0] === 'inspect'),
      false,
    );
  }
  const unavailable = fixture({
    library: { canceled: false, assets: [{ uri: 'file:///invalid' }] },
    inspect: () => {
      throw Error('Unsupported file');
    },
  });
  await assert.rejects(unavailable.services.pickPhoto(), /Unsupported file/);
});

test('contacts request permission on the explicit action and return only the selected trimmed name', async () => {
  let readName = 0;
  const f = fixture({
    contactPermission: ask,
    contactPicker: {
      async getFullName() {
        readName++;
        return '  Selected person  ';
      },
      getDetails() {
        throw Error('Must not enumerate details');
      },
    },
  });
  const person = await f.services.pickContactName();
  assert.equal(
    JSON.stringify(person),
    JSON.stringify({ name: 'Selected person', source: 'contacts' }),
  );
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ['contactPermission', 'contactRequest', 'contactPicker'],
  );
  assert.equal(readName, 1);
});

test('contacts denied, picker cancelled, missing name and native failures are recoverable without enumeration', async () => {
  for (const permissions of [
    { contactPermission: denied },
    { contactPermission: ask, contactRequest: denied },
  ]) {
    const f = fixture(permissions);
    await assert.rejects(f.services.pickContactName(), /permission/);
    assert.equal(
      f.calls.some((x) => x[0] === 'contactPicker'),
      false,
    );
  }
  const cancelled = fixture();
  assert.equal(await cancelled.services.pickContactName(), null);
  for (const name of ['', '   ', 'x'.repeat(121), null]) {
    const f = fixture({
      contactPicker: {
        async getFullName() {
          return name;
        },
      },
    });
    await assert.rejects(f.services.pickContactName(), /usable name/);
  }
  const failed = fixture({
    contactPicker: {
      async getFullName() {
        throw Error('Selected contact disappeared');
      },
    },
  });
  await assert.rejects(failed.services.pickContactName(), /disappeared/);
});

test('current location requires foreground permission and service availability before requesting one fix', async () => {
  const f = fixture({ locationPermission: ask });
  const place = await f.services.currentPlace();
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ['locationPermission', 'locationRequest', 'servicesEnabled', 'current', 'geocode'],
  );
  assert.equal(place.label, 'Cafe, Penang, Malaysia');
  assert.equal(place.source, 'device');
  assert.equal(place.capturedAtMs, 12345);
  assert.equal(place.accuracyMeters, 12);
  assert.equal(f.timers.size, 0);
  for (const options of [{ locationPermission: denied }, { servicesEnabled: false }]) {
    const unavailable = fixture(options);
    await assert.rejects(unavailable.services.currentPlace(), /permission|services are disabled/);
    assert.equal(
      unavailable.calls.some((x) => x[0] === 'current' || x[0] === 'geocode'),
      false,
    );
  }
});

test('invalid coordinates/timestamps never reach geocoding, and map lookup does not request a GPS fix', async () => {
  for (const point of [
    null,
    {},
    { latitude: NaN, longitude: 1 },
    { latitude: 91, longitude: 1 },
    { latitude: 1, longitude: Infinity },
    { latitude: 1, longitude: -181 },
  ]) {
    const f = fixture();
    await assert.rejects(f.services.placeAt(point), /location is invalid/);
    assert.equal(f.calls.length, 0);
  }
  const invalidTime = fixture({
    current: { coords: { latitude: 1, longitude: 2 }, timestamp: NaN },
  });
  await assert.rejects(invalidTime.services.currentPlace(), /timestamp/);
  assert.equal(
    invalidTime.calls.some((x) => x[0] === 'geocode'),
    false,
  );
  const mapped = fixture({
    platform: 'ios',
    geocode: [{ formattedAddress: '  Selected address  ' }],
  });
  const place = await mapped.services.placeAt({ latitude: 1, longitude: 2 });
  assert.equal(place.label, 'Selected address');
  assert.equal(place.source, 'map');
  assert.equal(place.accuracyMeters, null);
  assert.deepEqual(
    mapped.calls.map((x) => x[0]),
    ['geocode'],
  );
});

test('failed, empty, oversized and timed-out address lookups return no fabricated label', async () => {
  for (const geocode of [
    [],
    [{ formattedAddress: 'x'.repeat(241) }],
    () => {
      throw Error('Geocoder unavailable');
    },
  ]) {
    const f = fixture({ geocode });
    assert.equal((await f.services.placeAt({ latitude: 1, longitude: 2 })).label, null);
  }
  const deferredLookup = deferred();
  const f = fixture({ geocode: () => deferredLookup.promise });
  const pending = f.services.placeAt({ latitude: 1, longitude: 2 });
  await flush();
  f.fireTimers();
  assert.equal((await pending).label, null);
  deferredLookup.resolve([{ formattedAddress: 'Late response' }]);
  await flush();
  assert.equal(f.timers.size, 0);
});

test('a timed-out GPS request rejects, with no subsequent reverse lookup when its native promise finishes late', async () => {
  const fix = deferred();
  const f = fixture({ current: () => fix.promise });
  const pending = f.services.currentPlace();
  await flush();
  f.fireTimers();
  await assert.rejects(pending, /not available in time/);
  fix.resolve({ coords: { latitude: 1, longitude: 2 }, timestamp: 1 });
  await flush();
  assert.equal(
    f.calls.some((x) => x[0] === 'geocode'),
    false,
  );
});

test('installed SDK58 contact name lookup is ID-filtered and SDK file APIs provide awaited copy and throwing metadata', () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, '../node_modules', name), 'utf8');
  const contact = read(
    'expo-contacts/android/src/main/java/expo/modules/contacts/next/domain/ContactRepository.kt',
  );
  const selected = contact.slice(
    contact.indexOf('getFieldFromContacts('),
    contact.indexOf('suspend fun getCount('),
  );
  assert.match(selected, /ContactsContract\.Contacts\.CONTENT_URI/);
  assert.match(selected, /selectionArgs = arrayOf\(contactId\.value\)/);
  const nativeFile = read(
    'expo-file-system/android/src/main/java/expo/modules/filesystem/FileSystemFile.kt',
  );
  assert.match(
    nativeFile.slice(nativeFile.indexOf('fun info(')),
    /validatePermission\(FilePermissionService\.Permission\.READ\)/,
  );
  const declarations = read('expo-file-system/src/internal/NativeFileSystem.types.ts');
  assert.match(declarations, /copy\(destination:[^;]+Promise<void>/);
});
