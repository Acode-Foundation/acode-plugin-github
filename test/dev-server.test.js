const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');

const { packZip } = require('../scripts/dev/pack-zip');
const { startServer } = require('../scripts/dev/start-server');

test('development server serves each completed archive without caching', async (context) => {
  const rootDir = await createPluginFixture();
  const cordovaRoot = path.join(rootDir, 'cordova');
  context.after(() =>
    fs.promises.rm(rootDir, { recursive: true, force: true }),
  );

  await packZip({ rootDir });
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    rootDir,
    cordovaRoot,
  });
  context.after(() => closeServer(server));

  const manifestResponse = await request(server, '/plugin.json');
  assert.equal(manifestResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(manifestResponse.body), { name: 'test' });
  assert.equal(
    manifestResponse.headers['cache-control'],
    'no-store, no-cache, must-revalidate',
  );

  const firstResponse = await request(server, '/dist.zip');
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(
    firstResponse.headers['cache-control'],
    'no-store, no-cache, must-revalidate',
  );
  assert.equal(firstResponse.headers['access-control-allow-origin'], '*');
  assert.equal(
    await readArchiveFile(firstResponse.body, 'main.js'),
    'version one',
  );
  assert.equal(
    await readArchiveFile(firstResponse.body, 'nested/module.js'),
    'nested',
  );
  assert.deepEqual(await readArchiveEntries(firstResponse.body), [
    'icon.png',
    'main.js',
    'nested/module.js',
    'plugin.json',
    'readme.md',
  ]);

  await fs.promises.writeFile(
    path.join(rootDir, 'dist/main.js'),
    'version two',
  );
  await packZip({ rootDir });

  const secondResponse = await request(server, '/dist.zip');
  assert.equal(secondResponse.statusCode, 200);
  assert.notDeepEqual(secondResponse.body, firstResponse.body);
  assert.equal(
    await readArchiveFile(secondResponse.body, 'main.js'),
    'version two',
  );

  const temporaryArchives = (await fs.promises.readdir(rootDir)).filter(
    (name) => name.endsWith('.tmp'),
  );
  assert.deepEqual(temporaryArchives, []);
});

test('development server handles preflight and missing Cordova assets', async (context) => {
  const rootDir = await createPluginFixture();
  context.after(() =>
    fs.promises.rm(rootDir, { recursive: true, force: true }),
  );

  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    rootDir,
    cordovaRoot: path.join(rootDir, 'missing-cordova'),
  });
  context.after(() => closeServer(server));

  const preflight = await request(server, '/dist.zip', { method: 'OPTIONS' });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');

  const cordova = await request(server, '/cordova.js');
  assert.equal(cordova.statusCode, 404);
  assert.match(cordova.body.toString(), /ERROR cannot get/);
});

test('invalid Webpack runtime cannot replace the last completed archive', async (context) => {
  const rootDir = await createPluginFixture();
  context.after(() =>
    fs.promises.rm(rootDir, { recursive: true, force: true }),
  );
  const outputFile = await packZip({ rootDir });
  const completedArchive = await fs.promises.readFile(outputFile);

  await fs.promises.writeFile(
    path.join(rootDir, 'dist/main.js'),
    '__webpack_require__.cjs = function () {};',
  );
  await assert.rejects(packZip({ rootDir }), (error) => {
    assert.equal(error.code, 'INVALID_WEBPACK_RUNTIME');
    assert.match(error.message, /without its Webpack runtime definition/);
    return true;
  });

  assert.deepEqual(await fs.promises.readFile(outputFile), completedArchive);
  assert.deepEqual(
    (await fs.promises.readdir(rootDir)).filter((name) =>
      name.endsWith('.tmp'),
    ),
    [],
  );
});

async function createPluginFixture() {
  const rootDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'acode-plugin-github-'),
  );
  await fs.promises.mkdir(path.join(rootDir, 'dist/nested'), {
    recursive: true,
  });
  await Promise.all([
    fs.promises.writeFile(path.join(rootDir, 'icon.png'), 'icon'),
    fs.promises.writeFile(path.join(rootDir, 'plugin.json'), '{"name":"test"}'),
    fs.promises.writeFile(path.join(rootDir, 'readme.md'), '# Test'),
    fs.promises.writeFile(
      path.join(rootDir, 'CONTRIBUTING.md'),
      '# Repository-only documentation',
    ),
    fs.promises.writeFile(path.join(rootDir, 'package.json'), '{}'),
    fs.promises.writeFile(path.join(rootDir, 'dist/main.js'), 'version one'),
    fs.promises.writeFile(
      path.join(rootDir, 'dist/nested/module.js'),
      'nested',
    ),
  ]);
  return rootDir;
}

function request(server, pathname, options = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method || 'GET',
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            statusCode: response.statusCode,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function readArchiveFile(archive, filename) {
  const zip = await JSZip.loadAsync(archive);
  return zip.file(filename).async('string');
}

async function readArchiveEntries(archive) {
  const zip = await JSZip.loadAsync(archive);
  return Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort();
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
