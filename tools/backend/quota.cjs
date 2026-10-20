// Durable counters and request-id retirement. No filesystem is opened on import.
const { createHash } = require('node:crypto');
const { ServiceError } = require('./bounded.cjs');
function createQuotaStore(
  database,
  {
    clock = Date.now,
    ownerPerMinute = 6,
    ownerPerDay = 60,
    globalPerMinute = 30,
    globalPerDay = 600,
    ownerConcurrency = 1,
    globalConcurrency = 4,
    maxOwners = 10000,
  } = {},
) {
  const options = [
    ownerPerMinute,
    ownerPerDay,
    globalPerMinute,
    globalPerDay,
    ownerConcurrency,
    globalConcurrency,
    maxOwners,
  ];
  if (
    !database ||
    options.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 100000) ||
    typeof clock !== 'function'
  )
    throw new Error('Invalid quota configuration.');
  database.exec(
    'CREATE TABLE IF NOT EXISTS quota_counters (owner TEXT NOT NULL, kind TEXT NOT NULL, bucket INTEGER NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(owner,kind,bucket)); CREATE TABLE IF NOT EXISTS request_ids (owner TEXT NOT NULL, id TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(owner,id));',
  );
  const active = new Map();
  let total = 0;
  const hash = (owner) =>
    createHash('sha256')
      .update(JSON.stringify([owner.projectId, owner.uid]))
      .digest('hex');
  const stamp = () => {
    const n = clock();
    if (!Number.isSafeInteger(n) || n < 0) throw new ServiceError('UNAVAILABLE', 503);
    return n;
  };
  function reserve(owner, id) {
    const at = stamp(),
      key = hash(owner),
      minute = Math.floor(at / 60000),
      day = Math.floor(at / 86400000);
    if (total >= globalConcurrency || (active.get(key) || 0) >= ownerConcurrency)
      throw new ServiceError('BUSY', 429);
    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          'DELETE FROM quota_counters WHERE (kind = ? AND bucket < ?) OR (kind = ? AND bucket < ?)',
        )
        .run('minute', minute - 1, 'day', day - 1);
      database.prepare('DELETE FROM request_ids WHERE expires <= ?').run(at);
      if (database.prepare('SELECT 1 FROM request_ids WHERE owner=? AND id=?').get(key, id))
        throw new ServiceError('DUPLICATE_REQUEST', 409);
      if (
        database.prepare('SELECT COUNT(DISTINCT owner) AS count FROM quota_counters').get().count >=
          maxOwners &&
        !database.prepare('SELECT 1 FROM quota_counters WHERE owner=? LIMIT 1').get(key)
      )
        throw new ServiceError('RATE_LIMITED', 429);
      const limits = [
        [key, 'minute', minute, ownerPerMinute],
        [key, 'day', day, ownerPerDay],
        ['*', 'minute', minute, globalPerMinute],
        ['*', 'day', day, globalPerDay],
      ];
      for (const [subject, kind, bucket, limit] of limits) {
        const row = database
          .prepare('SELECT used FROM quota_counters WHERE owner=? AND kind=? AND bucket=?')
          .get(subject, kind, bucket);
        if ((row?.used || 0) >= limit) throw new ServiceError('RATE_LIMITED', 429);
      }
      for (const [subject, kind, bucket] of limits)
        database
          .prepare(
            'INSERT INTO quota_counters(owner,kind,bucket,used) VALUES(?,?,?,1) ON CONFLICT(owner,kind,bucket) DO UPDATE SET used=used+1',
          )
          .run(subject, kind, bucket);
      database
        .prepare('INSERT INTO request_ids(owner,id,expires) VALUES(?,?,?)')
        .run(key, id, at + 86400000);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    active.set(key, (active.get(key) || 0) + 1);
    total++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      total--;
      const count = active.get(key) - 1;
      if (count) active.set(key, count);
      else active.delete(key);
    };
  }
  function retire(owner, id) {
    const at = stamp(),
      key = hash(owner);
    database.prepare('DELETE FROM request_ids WHERE expires <= ?').run(at);
    if (
      database.prepare('SELECT COUNT(*) AS count FROM request_ids').get().count >= 20000 &&
      !database.prepare('SELECT 1 FROM request_ids WHERE owner=? AND id=?').get(key, id)
    )
      throw new ServiceError('RATE_LIMITED', 429);
    database
      .prepare('INSERT OR IGNORE INTO request_ids(owner,id,expires) VALUES(?,?,?)')
      .run(key, id, at + 86400000);
  }
  return {
    reserve,
    retire,
    ownerKey: hash,
    get activeCount() {
      return total;
    },
  };
}
module.exports = { createQuotaStore };
