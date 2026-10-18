const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTsSource } = require('./helpers/hook-host.cjs');

test('older native builds report missing PDF modules before evaluating their throwing package roots', async () => {
  const probes = [];
  const { createExpoPdfAdapter } = loadTsSource(
    path.join(__dirname, '../src/exports/expoPdfAdapter.ts'),
    {
      'react-native': { Platform: { OS: 'android' } },
      expo: {
        requireOptionalNativeModule(name) {
          probes.push(name);
          return null;
        },
      },
      'expo-file-system': {
        Directory: class {
          constructor() {
            this.uri = 'file:///cache/pdf-exports/';
          }
        },
        Paths: { cache: { uri: 'file:///cache/' } },
      },
      '../attachments/photoManager': require('../src/attachments/photoManager'),
      '../core/transactionContext': require('../src/core/transactionContext'),
      '../core/exports': require('../src/core/exports'),
      './pdfController': require('../src/exports/pdfController'),
      './pdfBytes': require('../src/exports/pdfBytes'),
    },
  );
  const adapter = createExpoPdfAdapter();
  await assert.rejects(
    adapter.printHtml('<html></html>'),
    (error) => error.code === 'PRINT_UNAVAILABLE',
  );
  assert.equal(await adapter.sharingAvailable(), false);
  assert.deepEqual(probes, ['ExpoPrint', 'ExpoSharing']);
});

test('Android generation requires the repaired native capability, while accepted calls retain integer A4 options', async () => {
  for (const marker of [undefined, 0, 2, 1]) {
    const calls = [];
    const { createExpoPdfAdapter } = loadTsSource(
      path.join(__dirname, '../src/exports/expoPdfAdapter.ts'),
      {
        'react-native': { Platform: { OS: 'android' } },
        expo: {
          requireOptionalNativeModule() {
            return { ReliablePdfVersion: marker };
          },
        },
        'expo-file-system': {
          Directory: class {
            constructor() {
              this.uri = 'file:///cache/pdf-exports/';
            }
          },
          Paths: { cache: { uri: 'file:///cache/' } },
        },
        'expo-print': {
          async printToFileAsync(options) {
            calls.push(options);
            return { uri: 'file:///cache/Print/verified.pdf', numberOfPages: 2 };
          },
          async printAsync() {},
        },
        '../attachments/photoManager': require('../src/attachments/photoManager'),
        '../core/transactionContext': require('../src/core/transactionContext'),
        '../core/exports': require('../src/core/exports'),
        './pdfController': require('../src/exports/pdfController'),
        './pdfBytes': require('../src/exports/pdfBytes'),
      },
    );
    const adapter = createExpoPdfAdapter();
    if (marker !== 1) {
      await assert.rejects(
        adapter.printHtml('<html></html>'),
        (error) => error.code === 'PRINT_UNAVAILABLE',
      );
      assert.equal(calls.length, 0);
    } else {
      assert.equal((await adapter.printHtml('<html></html>')).numberOfPages, 2);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].width, 595);
      assert.equal(calls[0].height, 842);
      assert.equal(calls[0].base64, false);
    }
  }
});
