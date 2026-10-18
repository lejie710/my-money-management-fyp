const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const model = require('../src/core/transactionContext');
const source = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../src/ui/useTransactionContext.ts'), 'utf8'),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const photo = {
  id: 'photo-test',
  ownerIncarnationId: 'wallet-test',
  fileName: 'photo-test.jpg',
  mimeType: 'image/jpeg',
  width: 10,
  height: 10,
  byteSize: 100,
};
const result = { deleted: 0, retained: 0, pending: false, message: '' };

// A small deterministic hook host exercises the actual hook's async decisions.
// It is not a renderer or evidence of native permissions, pixels, or React scheduling.
function harness(overrides = {}) {
  const slots = [],
    effects = [];
  let cursor = 0;
  const calls = { stage: 0, begin: 0, close: 0, cleanup: 0 };
  const options = {
    sessionKey: 'test/local/wallet-test/editor-1',
    ownerIncarnationId: 'wallet-test',
    initial: {},
    photos: {
      beginDraft() {
        calls.begin++;
        return { id: 'draft-test', ownerIncarnationId: 'wallet-test' };
      },
      async stage() {
        calls.stage++;
        return photo;
      },
      async closeDraft() {
        calls.close++;
        return result;
      },
      async queueCleanup() {
        calls.cleanup++;
        return result;
      },
    },
    services: {
      async pickPhoto() {
        return null;
      },
      async pickContactName() {
        return null;
      },
      async currentPlace() {
        throw Error('No fixture');
      },
      async placeAt() {
        throw Error('No fixture');
      },
    },
    ...overrides,
  };
  const react = {
    useState(initial) {
      const n = cursor++;
      if (!(n in slots)) slots[n] = { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[n].value,
        (value) => {
          slots[n].value = typeof value === 'function' ? value(slots[n].value) : value;
        },
      ];
    },
    useRef(initial) {
      const n = cursor++;
      if (!(n in slots)) slots[n] = { current: initial };
      return slots[n];
    },
    useEffect(callback, deps) {
      const n = cursor++;
      const previous = slots[n];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[n] = { deps, callback, cleanup: callback() };
        });
      }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    exports: module.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === '../core/transactionContext') return model;
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return {
    calls,
    options,
    render() {
      cursor = 0;
      const view = module.exports.useTransactionContext(options);
      while (effects.length) effects.shift()();
      return view;
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
    replayEffects() {
      for (const slot of slots)
        if (slot?.callback) {
          slot.cleanup?.();
          slot.cleanup = slot.callback();
        }
    },
  };
}

test('manual person/place edits win over late native results', async () => {
  const contact = deferred(),
    place = deferred();
  const h = harness({
    services: { pickContactName: () => contact.promise, currentPlace: () => place.promise },
  });
  let view = h.render();
  const pendingContact = view.pickPerson();
  view.setPersonName('Manual person');
  contact.resolve({ name: 'Late contact', source: 'contacts' });
  await pendingContact;
  view = h.render();
  assert.equal(view.person.name, 'Manual person');
  assert.equal(view.personCandidate, null);
  const pendingPlace = view.locatePlace();
  view.setPlaceLabel('Manual place');
  place.resolve({
    label: 'Late place',
    source: 'device',
    coordinate: { latitude: 1, longitude: 2 },
    capturedAtMs: 1,
    accuracyMeters: 1,
  });
  await pendingPlace;
  view = h.render();
  assert.equal(view.place.label, 'Manual place');
  assert.equal(view.placeCandidate, null);
  assert.equal(view.pending, null);
});

test('native candidates do not change saved draft fields until explicitly confirmed', async () => {
  const h = harness({
    services: {
      async pickContactName() {
        return { name: 'Selected person', source: 'contacts' };
      },
    },
  });
  await h.render().pickPerson();
  let view = h.render();
  assert.equal(view.person, null);
  assert.equal(view.personCandidate.name, 'Selected person');
  view.confirmPerson();
  view = h.render();
  assert.equal(view.person.name, 'Selected person');
  assert.equal(view.person.source, 'contacts');
  view.setPersonName('Edited person');
  assert.equal(h.render().person.source, 'manual');
});

test('photo cancel preserves prior selection and removal invalidates a late picker result', async () => {
  const picker = deferred();
  const h = harness({
    initial: { context: { notes: '', photo, withPerson: null, location: null } },
    services: { pickPhoto: () => picker.promise },
  });
  const pending = h.render().pickPhoto();
  h.render().removePhoto();
  picker.resolve({ uri: 'file:///late.jpg' });
  await pending;
  assert.equal(h.render().photoEdit.kind, 'remove');
  const cancel = harness({
    initial: { context: { notes: '', photo, withPerson: null, location: null } },
  });
  await cancel.render().pickPhoto();
  assert.equal(cancel.render().photoEdit.kind, 'keep');
});

test('text validation occurs before file copy and failed saves reuse a pinned staged photo', async () => {
  const h = harness({
    services: {
      async pickPhoto() {
        return { uri: 'file:///selected.jpg' };
      },
    },
  });
  await h.render().pickPhoto();
  h.render().setNotes('x'.repeat(2001));
  await assert.rejects(h.render().preparePatch());
  assert.equal(h.calls.stage, 0);
  h.render().setNotes('Receipt note');
  const first = await h.render().preparePatch();
  assert.equal(first.patch.photo.id, photo.id);
  await first.complete(false);
  assert.equal(h.calls.close, 0);
  const retry = await h.render().preparePatch();
  assert.equal(retry.patch.photo.id, photo.id);
  assert.equal(h.calls.stage, 1);
  await retry.complete(true);
  assert.equal(h.calls.close, 1);
  assert.equal(retry.isCurrent(), false);
});

test('unmount during copy invalidates the prepared patch and releases its owned session', async () => {
  const copy = deferred();
  let closed = 0;
  const h = harness({
    photos: {
      beginDraft: () => ({ id: 'draft', ownerIncarnationId: 'wallet-test' }),
      stage: () => copy.promise,
      async closeDraft() {
        closed++;
        return result;
      },
    },
    services: {
      async pickPhoto() {
        return { uri: 'file:///selected.jpg' };
      },
    },
  });
  await h.render().pickPhoto();
  const pending = h.render().preparePatch();
  h.unmount();
  copy.resolve(photo);
  await assert.rejects(pending, /editor changed/);
  assert.equal(closed, 1);
});

test('a successful new selection with the same URI is copied again, while cancel and ordinary Save retry preserve the verified stage', async () => {
  let selection = { uri: 'content://picker/same-provider-uri' };
  const h = harness({
    services: {
      async pickPhoto() {
        return selection;
      },
    },
  });
  await h.render().pickPhoto();
  const first = await h.render().preparePatch();
  await first.complete(false);
  assert.equal(h.calls.stage, 1);
  selection = null;
  await h.render().pickPhoto();
  const cancelledRetry = await h.render().preparePatch();
  await cancelledRetry.complete(false);
  assert.equal(h.calls.stage, 1);
  selection = { uri: 'content://picker/same-provider-uri' };
  await h.render().pickPhoto();
  const reselected = await h.render().preparePatch();
  assert.equal(h.calls.stage, 2);
  await reselected.complete(true);
  assert.equal(h.calls.close, 1);
});

test('only a confirmed deletion queues the prior saved photo for cleanup', async () => {
  const h = harness({
    initial: { context: { notes: '', photo, withPerson: null, location: null } },
  });
  await h.render().prepareDeletion().complete(false);
  assert.equal(h.calls.cleanup, 0);
  await h.render().prepareDeletion().complete(true);
  assert.equal(h.calls.cleanup, 1);
});

test('Strict Mode effect replay allocates no photo draft until submission and commits exactly one stage', async () => {
  const h = harness({
    services: {
      async pickPhoto() {
        return { uri: 'file:///selected.jpg' };
      },
    },
  });
  h.render();
  h.replayEffects();
  assert.equal(h.calls.begin, 0);
  await h.render().pickPhoto();
  const prepared = await h.render().preparePatch();
  assert.equal(h.calls.begin, 1);
  assert.equal(h.calls.stage, 1);
  await prepared.complete(true);
  h.unmount();
  assert.equal(h.calls.close, 1);
});

test('a retired editor completion cannot unlock a newer session preparation', async () => {
  const h = harness();
  const old = await h.render().preparePatch();
  h.options.sessionKey = 'test/local/wallet-test/editor-2';
  const current = await h.render().preparePatch();
  assert.equal(old.isCurrent(), false);
  await old.complete(false);
  assert.equal(h.render().preparing, true);
  assert.equal(current.isCurrent(), true);
  await current.complete(false);
  assert.equal(h.render().preparing, false);
});
