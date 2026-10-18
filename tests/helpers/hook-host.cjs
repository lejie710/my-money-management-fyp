const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Deterministic state/effect host for actual hook source. It does not emulate
// native layout, React's concurrent renderer, or device event delivery.
function createHookHost() {
  const slots = [];
  let cursor = 0,
    dirty = false,
    effects = [];
  const same = (left, right) =>
    !!left &&
    left.length === right.length &&
    right.every((value, index) => Object.is(value, left[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[index].value,
        (next) => {
          const value = typeof next === 'function' ? next(slots[index].value) : next;
          if (!Object.is(value, slots[index].value)) {
            slots[index].value = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(callback, deps) {
      const index = cursor++,
        previous = slots[index];
      if (!same(previous?.deps, deps))
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, callback, cleanup: callback() };
        });
    },
    useMemo(factory, deps) {
      const index = cursor++,
        previous = slots[index];
      if (!same(previous?.deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback(callback, deps) {
      const index = cursor++,
        previous = slots[index];
      if (!same(previous?.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    createElement(type, props, ...children) {
      return { type, props: { ...props, children } };
    },
    Fragment: 'Fragment',
  };
  return {
    react,
    render(callback) {
      let output;
      for (let attempts = 0; attempts < 20; attempts++) {
        cursor = 0;
        dirty = false;
        effects = [];
        output = callback();
        while (effects.length) effects.shift()();
        if (!dirty) return output;
      }
      throw Error('Hook host did not settle');
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
    replayEffects() {
      const active = slots.filter((slot) => typeof slot?.cleanup === 'function');
      active.forEach((slot) => slot.cleanup());
      active.forEach((slot) => {
        slot.cleanup = slot.callback();
      });
    },
  };
}

function loadTsSource(file, imports) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    exports: module.exports,
    require(name) {
      if (!Object.hasOwn(imports, name)) throw Error(`Unexpected hook dependency: ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}
module.exports = { createHookHost, loadTsSource };
