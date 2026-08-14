const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('native HTTP transport uses isolated URL-encoded requests', async () => {
  const calls = [];
  const http = {
    sendRequest(url, options, success) {
      assert.equal(Object.isExtensible(options.headers), true);
      calls.push({ options, url });
      success({
        data: JSON.stringify({ device_code: 'device' }),
        headers: {},
        status: 200,
      });
    },
  };

  await withSourceModule(
    'githubAuth/nativeHttp.js',
    {},
    async ({ NativeHttpTransport }) => {
      const transport = new NativeHttpTransport(http);
      assert.deepEqual(
        await transport.postForm('https://github.com/login/device/code', {
          client_id: 'client',
        }),
        { device_code: 'device' },
      );
    },
  );

  assert.deepEqual(calls, [
    {
      options: {
        data: { client_id: 'client' },
        followRedirect: false,
        headers: { Accept: 'application/json' },
        method: 'post',
        responseType: 'text',
        serializer: 'urlencoded',
      },
      url: 'https://github.com/login/device/code',
    },
  ]);
  assert.equal('setDataSerializer' in http, false);
});

test('Device Flow and refresh resolve a bridge registered after construction', async () => {
  const cordova = { plugin: {} };
  const urls = [];
  await withSourceModule(
    'githubAuth/nativeHttp.js',
    { cordova },
    async ({ NativeHttpTransport }) => {
      const transport = new NativeHttpTransport();
      let followRedirect = true;
      cordova.plugin.http = {
        getFollowRedirect() {
          return followRedirect;
        },
        sendRequest(url, _options, success) {
          urls.push(url);
          success({ data: { access_token: 'native-token' }, status: 200 });
        },
        setFollowRedirect(value) {
          followRedirect = value;
        },
      };
      for (const url of [
        'https://github.com/login/device/code',
        'https://github.com/login/oauth/access_token',
      ]) {
        assert.deepEqual(await transport.postForm(url, {}), {
          access_token: 'native-token',
        });
      }
    },
  );
  assert.deepEqual(urls, [
    'https://github.com/login/device/code',
    'https://github.com/login/oauth/access_token',
  ]);
});

test('native authentication waits for a late Cordova HTTP bridge', async () => {
  const cordova = { plugin: {} };
  let waitCalls = 0;
  await withSourceModule(
    'githubAuth/nativeHttp.js',
    { cordova },
    async ({ NativeHttpTransport }) => {
      const transport = new NativeHttpTransport(undefined, {
        async sleep() {
          waitCalls += 1;
          cordova.plugin.http = {
            getFollowRedirect: () => true,
            sendRequest(_url, _options, success) {
              success({ data: '{"device_code":"ready"}', status: 200 });
            },
            setFollowRedirect() {},
          };
        },
      });
      assert.deepEqual(
        await transport.postForm(
          'https://github.com/login/device/code',
          {},
          { operation: 'device-code' },
        ),
        { device_code: 'ready' },
      );
    },
  );
  assert.equal(waitCalls, 1);
});

test('native HTTP restores the stock global redirect setting synchronously', async () => {
  const changes = [];
  let followRedirect = true;
  const http = {
    getFollowRedirect() {
      return followRedirect;
    },
    sendRequest(_url, _options, success) {
      assert.equal(followRedirect, false);
      success({ data: '{}', status: 200 });
      return 1;
    },
    setFollowRedirect(value) {
      changes.push(value);
      followRedirect = value;
    },
  };

  await withSourceModule(
    'githubAuth/nativeHttp.js',
    {},
    async ({ NativeHttpTransport }) => {
      await new NativeHttpTransport(http).postForm('https://github.com', {});
      assert.equal(followRedirect, true);

      http.sendRequest = () => {
        assert.equal(followRedirect, false);
        throw new Error('request creation failed');
      };
      await assert.rejects(
        new NativeHttpTransport(http).postForm('https://github.com', {}),
        (error) => {
          assert.equal(error.kind, 'internal');
          assert.equal(error.phase, 'request-create');
          return true;
        },
      );
      assert.equal(followRedirect, true);
    },
  );

  assert.deepEqual(changes, [false, true, false, true]);
});

test('native HTTP identifies redirect compatibility failures safely', async () => {
  const cases = [
    {
      expected: 'redirect-read',
      http: {
        getFollowRedirect() {
          throw new Error('private redirect state');
        },
        sendRequest() {},
        setFollowRedirect() {},
      },
    },
    {
      expected: 'redirect-read',
      http: {
        getFollowRedirect: () => undefined,
        sendRequest() {},
        setFollowRedirect() {},
      },
    },
    {
      expected: 'redirect-disable',
      http: {
        getFollowRedirect: () => true,
        sendRequest() {},
        setFollowRedirect() {
          throw new Error('private setter state');
        },
      },
    },
  ];

  await withSourceModule(
    'githubAuth/nativeHttp.js',
    {},
    async ({ NativeHttpTransport }) => {
      for (const { expected, http } of cases) {
        await assert.rejects(
          new NativeHttpTransport(http).postForm(
            'https://github.com',
            {},
            { operation: 'device-code' },
          ),
          (error) => {
            assert.equal(error.kind, 'internal');
            assert.equal(error.operation, 'device-code');
            assert.equal(error.phase, expected);
            assert.equal(JSON.stringify(error).includes('private'), false);
            return true;
          },
        );
      }
    },
  );
});

test('native HTTP transport normalizes unavailable, malformed, and network failures', async () => {
  await withSourceModule(
    'githubAuth/nativeHttp.js',
    {},
    async ({ NativeHttpTransport }) => {
      await assert.rejects(
        new NativeHttpTransport().postForm('https://github.com', {}),
        hasKind('unavailable'),
      );

      globalThis.cordova = { plugin: {} };
      await assert.rejects(
        new NativeHttpTransport(undefined, {
          bridgeWaitMs: 0,
        }).postForm('https://github.com', {}, { operation: 'device-code' }),
        (error) => {
          assert.equal(error.kind, 'network');
          assert.equal(error.operation, 'device-code');
          assert.equal(error.transport, 'native');
          return true;
        },
      );
      delete globalThis.cordova;

      const malformed = new NativeHttpTransport({
        sendRequest(_url, _options, success) {
          success({ data: 'not-json', status: 200 });
        },
      });
      await assert.rejects(
        malformed.postForm('https://github.com', {}),
        hasKind('malformed-response'),
      );

      const network = new NativeHttpTransport({
        sendRequest(_url, _options, _success, failure) {
          failure({ data: 'secret-token', status: 503 });
        },
      });
      await assert.rejects(
        network.postForm(
          'https://github.com',
          {},
          { operation: 'device-token' },
        ),
        (error) => {
          assert.equal(error.kind, 'network');
          assert.equal(error.nativeCode, undefined);
          assert.equal(error.operation, 'device-token');
          assert.equal(error.transport, 'web');
          assert.equal(JSON.stringify(error).includes('secret-token'), false);
          assert.equal(error.stack.includes('secret-token'), false);
          return true;
        },
      );

      const oauthFailure = new NativeHttpTransport({
        sendRequest(_url, _options, _success, failure) {
          failure({
            data: JSON.stringify({ error: 'access_denied' }),
            status: 400,
          });
        },
      });
      assert.deepEqual(await oauthFailure.postForm('https://github.com', {}), {
        error: 'access_denied',
      });

      const nativeFailure = new NativeHttpTransport({
        sendRequest(_url, _options, _success, failure) {
          failure({ data: 'private failure details', status: -2 });
        },
      });
      await assert.rejects(
        nativeFailure.postForm(
          'https://github.com',
          {},
          { operation: 'device-code' },
        ),
        (error) => {
          assert.equal(error.kind, 'network');
          assert.equal(error.nativeCode, -2);
          assert.equal(error.operation, 'device-code');
          assert.equal(JSON.stringify(error).includes('private'), false);
          return true;
        },
      );
    },
  );
});

test('native HTTP transport aborts the active Cordova request on cancellation', async () => {
  const aborted = [];
  const http = {
    abort(requestId, success) {
      aborted.push(requestId);
      success();
    },
    sendRequest() {
      return 42;
    },
  };

  await withSourceModule(
    'githubAuth/nativeHttp.js',
    {},
    async ({ NativeHttpTransport }) => {
      const controller = new AbortController();
      const request = new NativeHttpTransport(http).postForm(
        'https://github.com',
        {},
        { signal: controller.signal },
      );
      controller.abort();
      await assert.rejects(request, hasKind('cancelled'));
    },
  );

  assert.deepEqual(aborted, [42]);
});

test('encrypted local sessions persist across restarts without plaintext', async () => {
  const values = new Map();
  const storage = createMemoryStorage(values);

  await withSourceModule(
    'githubAuth/sessionStore.js',
    { TextDecoder: undefined, TextEncoder: undefined },
    async ({ GITHUB_SESSION_STORAGE_KEY, GitHubSessionStore }) => {
      const session = githubAppSession();
      const store = new GitHubSessionStore({ storage });
      await store.save(session);
      const firstRecord = values.get(GITHUB_SESSION_STORAGE_KEY);
      const envelope = JSON.parse(firstRecord);
      assert.deepEqual(Object.keys(envelope).sort(), [
        'algorithm',
        'ciphertext',
        'version',
      ]);
      assert.equal(envelope.algorithm, 'AES-256-SIV');

      assert.deepEqual(
        await new GitHubSessionStore({ storage }).load(),
        session,
      );
      const serialized = JSON.stringify([...values]);
      for (const secret of [
        'access-token',
        'refresh-token',
        'octocat',
        'Authorization',
      ]) {
        assert.equal(serialized.includes(secret), false);
      }

      await store.save(session);
      assert.equal(values.get(GITHUB_SESSION_STORAGE_KEY), firstRecord);
      await store.clear();
      assert.equal(await store.load(), null);
    },
  );
});

test('failed replacement leaves the previous encrypted session readable', async () => {
  const values = new Map();
  let failSessionWrite = false;
  const storage = createMemoryStorage(values, {
    setItem(key) {
      if (failSessionWrite && key.includes('github-session-v1')) {
        throw new Error('quota exceeded');
      }
    },
  });

  await withSourceModule(
    'githubAuth/sessionStore.js',
    {},
    async ({ GitHubSessionStore }) => {
      const store = new GitHubSessionStore({ storage });
      const original = githubAppSession();
      await store.save(original);
      failSessionWrite = true;
      await assert.rejects(
        store.save({ ...original, login: 'hubot' }),
        hasKind('storage'),
      );
      failSessionWrite = false;
      assert.deepEqual(await store.load(), original);
    },
  );
});

test('tampering, malformed envelopes, and wrong keys discard sessions', async () => {
  const values = new Map();
  const storage = createMemoryStorage(values);

  await withSourceModule(
    'githubAuth/sessionStore.js',
    {},
    async ({ GITHUB_SESSION_STORAGE_KEY, GitHubSessionStore }) => {
      const store = new GitHubSessionStore({ storage });
      await store.save(githubAppSession());
      const record = JSON.parse(values.get(GITHUB_SESSION_STORAGE_KEY));
      const lastByte = record.ciphertext.slice(-2);
      record.ciphertext = `${record.ciphertext.slice(0, -2)}${lastByte === '00' ? '01' : '00'}`;
      values.set(GITHUB_SESSION_STORAGE_KEY, JSON.stringify(record));
      await assert.rejects(store.load(), hasKind('invalid-session'));
      assert.equal(values.has(GITHUB_SESSION_STORAGE_KEY), false);

      await store.save(githubAppSession());
      await assert.rejects(
        new GitHubSessionStore({
          key: new Uint8Array(64).fill(7),
          storage,
        }).load(),
        hasKind('invalid-session'),
      );
      assert.equal(values.has(GITHUB_SESSION_STORAGE_KEY), false);

      values.set(GITHUB_SESSION_STORAGE_KEY, '{"version":1}');
      await assert.rejects(store.load(), (error) => {
        assert.equal(error.kind, 'invalid-session');
        assert.equal(error.message.includes('ciphertext'), false);
        return true;
      });
      assert.equal(values.has(GITHUB_SESSION_STORAGE_KEY), false);
    },
  );
});

test('session storage validates records and reports localStorage failures', async () => {
  await withSourceModule(
    'githubAuth/sessionStore.js',
    {},
    async ({ GitHubSessionStore }) => {
      await assert.rejects(
        new GitHubSessionStore({ storage: null }).load(),
        hasKind('storage'),
      );
      await assert.rejects(
        new GitHubSessionStore({
          storage: createMemoryStorage(new Map()),
        }).save({ ...githubAppSession(), accessToken: '' }),
        hasKind('invalid-session'),
      );
      const failing = createMemoryStorage(new Map(), {
        getItem() {
          throw new Error('blocked');
        },
      });
      await assert.rejects(
        new GitHubSessionStore({ storage: failing }).load(),
        hasKind('storage'),
      );
    },
  );
});

function githubAppSession() {
  return {
    accessExpiresAt: 2_000_000,
    accessToken: 'access-token',
    accountId: 1,
    avatarUrl: 'https://avatars.example/octocat',
    kind: 'github-app',
    login: 'octocat',
    refreshExpiresAt: 3_000_000,
    refreshToken: 'refresh-token',
    version: 1,
  };
}

function hasKind(kind) {
  return (error) => error.kind === kind;
}

function createMemoryStorage(values, hooks = {}) {
  return {
    getItem(key) {
      hooks.getItem?.(key);
      return values.get(key) ?? null;
    },
    removeItem(key) {
      hooks.removeItem?.(key);
      values.delete(key);
    },
    setItem(key, value) {
      hooks.setItem?.(key, value);
      values.set(key, value);
    },
  };
}
