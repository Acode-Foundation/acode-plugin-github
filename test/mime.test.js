const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('compact MIME lookup covers editor and binary resource families', async () => {
  await withSourceModule('mime.js', {}, async ({ lookupMimeType }) => {
    const cases = {
      'archive.zip': 'application/zip',
      'icon.svg': 'image/svg+xml',
      'index.js': 'text/javascript',
      'notes.md': 'text/markdown',
      'photo.JPG': 'image/jpeg',
      'recording.mp3': 'audio/mpeg',
      'release.yml': 'text/yaml',
      'source.ts': 'text/plain',
      'video.mp4': 'video/mp4',
    };
    for (const [filename, type] of Object.entries(cases)) {
      assert.equal(lookupMimeType(filename), type);
    }
    assert.equal(lookupMimeType('unknown.acode-extension'), false);
  });
});
