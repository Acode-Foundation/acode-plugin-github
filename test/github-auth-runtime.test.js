const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('authentication mode depends on Acode version rather than secret APIs', async () => {
  await withSourceModule(
    'githubAuth/runtime.js',
    {},
    async ({ selectAuthenticationMode }) => {
      assert.equal(
        selectAuthenticationMode({ cordova: {}, versionCode: 973 }),
        'modern',
      );
      assert.equal(
        selectAuthenticationMode({ cordova: {}, versionCode: 972 }),
        'legacy',
      );
      assert.equal(
        selectAuthenticationMode({ cordova: {}, versionCode: undefined }),
        'modern',
      );
      assert.equal(
        selectAuthenticationMode({ cordova: undefined, versionCode: 972 }),
        'browser',
      );
    },
  );
});

test('modern and browser modes work without Acode secret context', async () => {
  for (const [host, expectedMode] of [
    [{ BuildInfo: { versionCode: 973 }, cordova: {} }, 'modern'],
    [{ BuildInfo: { versionCode: 973 } }, 'browser'],
  ]) {
    const values = new Map();
    const storage = createStorage(values);
    await withSourceModule(
      'githubAuth/runtime.js',
      {},
      async ({ createConfiguredGitHubAuthManager }) => {
        const runtime = createConfiguredGitHubAuthManager({
          createGitHub: () => ({
            async getAuthenticatedUser() {
              return { avatar_url: null, id: 1, login: 'octocat' };
            },
          }),
          credentialStore: storage,
        });
        assert.equal(runtime.configure({ host }), expectedMode);
        assert.equal(
          (await runtime.usePersonalAccessToken('modern-pat')).login,
          'octocat',
        );
        assert.equal((await runtime.getAccount()).kind, 'pat');
        assert.equal(JSON.stringify([...values]).includes('modern-pat'), false);
      },
    );
  }
});

test('older Acode accepts only encrypted personal access token sessions', async () => {
  const values = new Map();
  const storage = createStorage(values);
  await withSourceModule(
    'githubAuth/runtime.js',
    {},
    async ({ createConfiguredGitHubAuthManager }) => {
      const runtime = createConfiguredGitHubAuthManager({
        createGitHub: () => ({
          async getAuthenticatedUser() {
            return { avatar_url: null, id: 1, login: 'octocat' };
          },
        }),
        credentialStore: storage,
      });
      runtime.configure({
        host: { BuildInfo: { versionCode: 972 }, cordova: {} },
      });
      await assert.rejects(runtime.signInWithGitHub(), hasKind('unavailable'));
      await runtime.usePersonalAccessToken('legacy-pat');
      assert.equal(await runtime.getAccessToken(), 'legacy-pat');
      assert.equal(JSON.stringify([...values]).includes('legacy-pat'), false);

      const restarted = createConfiguredGitHubAuthManager({
        createGitHub: () => ({}),
        credentialStore: storage,
      });
      restarted.configure({
        host: { BuildInfo: { versionCode: 972 }, cordova: {} },
      });
      assert.equal((await restarted.getAccount()).kind, 'pat');
    },
  );
});

test('authentication source has no native-secret or browser-crypto storage path', () => {
  const authRoot = path.join(__dirname, '..', 'src', 'githubAuth');
  const source = ['index.js', 'runtime.js', 'sessionStore.js']
    .map((name) => fs.readFileSync(path.join(authRoot, name), 'utf8'))
    .join('\n');
  for (const forbidden of [
    'credentialVault',
    'getSecret',
    'setSecret',
    'indexedDB',
    'crypto.subtle',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

function createStorage(values) {
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function hasKind(kind) {
  return (error) => error.kind === kind;
}
