// Test-only outbound guard. Install before importing any Firebase SDK module.
const assert = require('node:assert/strict'),
  net = require('node:net'),
  http2 = require('node:http2');
function install() {
  const ports = new Set([19099, 18080, 19199]),
    events = [],
    blocked = [];
  const check = (host, port, method) => {
    host = String(host || 'localhost').replace(/^\[|\]$/g, '');
    port = Number(port);
    const row = { method, host, port };
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !ports.has(port)) {
      blocked.push(row);
      throw new Error('Non-emulator network destination refused by test boundary.');
    }
    events.push(row);
  };
  const originalConnect = net.Socket.prototype.connect,
    originalHttp2 = http2.connect,
    originalFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (...args) {
    let value = args[0];
    if (Array.isArray(value)) value = value[0];
    if (value && typeof value === 'object') check(value.host, value.port, 'TCP');
    else check(typeof args[1] === 'string' ? args[1] : 'localhost', value, 'TCP');
    return originalConnect.apply(this, args);
  };
  http2.connect = function (authority, ...args) {
    const url = new URL(String(authority));
    check(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80), 'HTTP2');
    return originalHttp2.call(this, authority, ...args);
  };
  globalThis.fetch = async function (input, options) {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? String(input) : input.url,
    );
    check(
      url.hostname,
      url.port || (url.protocol === 'https:' ? 443 : 80),
      options?.method || input?.method || 'GET',
    );
    return originalFetch.call(this, input, options);
  };
  return {
    assertClean() {
      assert.deepEqual(blocked, []);
    },
    summary() {
      return {
        requests: events.length,
        blocked: blocked.length,
        destinations: [...new Set(events.map((row) => row.host + ':' + row.port))],
      };
    },
    restore() {
      net.Socket.prototype.connect = originalConnect;
      http2.connect = originalHttp2;
      globalThis.fetch = originalFetch;
    },
  };
}
module.exports = { install };
