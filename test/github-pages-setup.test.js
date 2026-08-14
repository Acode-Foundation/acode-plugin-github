const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { Window } = require('happy-dom');

const projectRoot = path.resolve(__dirname, '..');
const setupRoot = path.join(projectRoot, 'docs/setup');

test('GitHub Pages setup return is accessible and dependency-free', () => {
  const html = fs.readFileSync(path.join(setupRoot, 'index.html'), 'utf8');

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /data-open-acode/);
  assert.match(html, />\s*Return to Acode\s*</);
  assert.match(html, /https:\/\/acode\.app\/plugin\/acode\.plugin\.github/);
  assert.doesNotMatch(html, /<script(?![^>]+src="\.\/setup\.mjs")/);
  assert.doesNotMatch(html, /analytics|installation_id|setup_action/i);
});

test('automatic and manual returns use only the fixed Acode deep link', async () => {
  const moduleUrl = pathToFileURL(path.join(setupRoot, 'setup.mjs')).href;
  const { ACODE_SETUP_URL, initializeSetupReturn } = await import(moduleUrl);
  const window = new Window({
    url: 'https://example.test/setup/?installation_id=spoofed&setup_action=install',
  });
  window.document.body.innerHTML = '<a data-open-acode>Return to Acode</a>';
  const navigations = [];
  const scheduled = [];
  const cleanup = initializeSetupReturn({
    clearSchedule() {},
    document: window.document,
    navigate: (url) => navigations.push(url),
    schedule: (callback) => {
      scheduled.push(callback);
      return 1;
    },
  });

  assert.equal(scheduled.length, 1);
  scheduled[0]();
  window.document.querySelector('[data-open-acode]').click();
  assert.deepEqual(navigations, [ACODE_SETUP_URL, ACODE_SETUP_URL]);
  assert.equal(ACODE_SETUP_URL, 'acode://github/setup/complete');

  cleanup();
  window.document.querySelector('[data-open-acode]').click();
  assert.equal(navigations.length, 2);
});

test('plugin packaging excludes GitHub Pages assets', () => {
  const packSource = fs.readFileSync(
    path.join(projectRoot, 'scripts/dev/pack-zip.js'),
    'utf8',
  );

  assert.doesNotMatch(packSource, /docs[\\/]setup/);
  assert.match(
    packSource,
    /addFolder\(zip, '', path\.join\(rootDir, 'dist'\)\)/,
  );
});
