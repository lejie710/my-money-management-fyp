const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadAdapter(name, imports, extras = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/attachments', name), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const timers = new Map();
  let timerId = 0;
  vm.runInNewContext(compiled, {
    exports: module.exports,
    require(name) {
      if (!Object.hasOwn(imports, name))
        throw Error(`Unexpected native adapter dependency: ${name}`);
      return imports[name];
    },
    setTimeout(callback) {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    ...extras,
  });
  return {
    exports: module.exports,
    timers,
    fireTimers() {
      for (const [id, callback] of timers) {
        timers.delete(id);
        callback();
      }
    },
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
module.exports = { loadAdapter, deferred, flush };
