const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('browser path extension lookup matches Node POSIX behavior', async () => {
  await withSourceModule('pathBrowser.js', {}, ({ extname }) => {
    const filenames = [
      '',
      '.',
      '..',
      '...',
      '.gitignore',
      '..config',
      'file',
      'file.',
      'file.js',
      'archive.tar.gz',
      'folder/file.md',
      'folder/.env',
      'folder/..config',
      'folder/',
    ];

    for (const filename of filenames) {
      assert.equal(extname(filename), path.posix.extname(filename), filename);
    }
    assert.throws(() => extname(null), /Path must be a string/);
  });
});
