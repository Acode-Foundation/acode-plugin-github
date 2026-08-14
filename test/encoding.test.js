const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('portable encoding round-trips Unicode without Web Encoding APIs', async () => {
  await withSourceModule(
    'encoding.js',
    { TextDecoder: undefined, TextEncoder: undefined },
    async ({
      bytesToArrayBuffer,
      bytesToHex,
      bytesToUtf8,
      hexToBytes,
      utf8ToBytes,
    }) => {
      const value = 'Acode · GitHub · नमस्ते · 🚀';
      const bytes = utf8ToBytes(value);
      assert.equal(bytesToUtf8(bytes), value);
      assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes);
      assert.deepEqual(new Uint8Array(bytesToArrayBuffer(bytes)), bytes);
      assert.throws(() => hexToBytes('not-hex'), /hexadecimal/);
    },
  );
});
