// Bounded JSON parser with duplicate-member rejection, shared by mobile and backend.
function strictJson(text, maximum = 65536) {
  if (typeof text !== 'string' || !text.length || text.length > maximum)
    throw new Error('Invalid JSON.');
  let at = 0,
    nodes = 0;
  const fail = () => {
    throw new Error('Invalid JSON.');
  };
  const space = () => {
    while (/[\x20\t\r\n]/.test(text[at] || '\0')) at++;
  };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const code = text.charCodeAt(at++);
      if (code === 34) {
        try {
          return JSON.parse(text.slice(start, at));
        } catch {
          fail();
        }
      }
      if (code < 32) fail();
      if (code === 92) at++;
    }
    fail();
  };
  const value = (depth) => {
    if (depth > 24 || ++nodes > 20000) fail();
    space();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++;
      space();
      const result = {},
        seen = new Set();
      if (text[at] === '}') {
        at++;
        return result;
      }
      while (true) {
        space();
        if (text[at] !== '"') fail();
        const name = string();
        if (seen.has(name)) fail();
        seen.add(name);
        space();
        if (text[at++] !== ':') fail();
        Object.defineProperty(result, name, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        space();
        const next = text[at++];
        if (next === '}') return result;
        if (next !== ',') fail();
      }
    }
    if (text[at] === '[') {
      at++;
      space();
      const result = [];
      if (text[at] === ']') {
        at++;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        space();
        const next = text[at++];
        if (next === ']') return result;
        if (next !== ',') fail();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(at),
    );
    if (!match) fail();
    at += match[0].length;
    const result = JSON.parse(match[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) fail();
    return result;
  };
  const result = value(0);
  space();
  if (at !== text.length) fail();
  return result;
}
module.exports = { strictJson };
