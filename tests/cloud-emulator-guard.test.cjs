const test = require('node:test'),
  assert = require('node:assert/strict'),
  net = require('node:net'),
  http2 = require('node:http2');
const { install } = require('../tools/firebase-backup/emulatorOnly.cjs');
test('emulator test boundary rejects public fetch, raw sockets and HTTP2 before transport dispatch', async () => {
  const guard = install();
  try {
    await assert.rejects(fetch('https://example.invalid'), /Non-emulator/);
    const socket = new net.Socket();
    assert.throws(() => socket.connect(443, 'example.invalid'), /Non-emulator/);
    socket.destroy();
    assert.throws(() => http2.connect('https://example.invalid'), /Non-emulator/);
    assert.equal(guard.summary().blocked, 3);
    assert.equal(guard.summary().requests, 0);
  } finally {
    guard.restore();
  }
});
