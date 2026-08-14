const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('GitHub App and PAT sign-in validate identity before encrypted persistence', async () => {
  const store = createStore();
  const deviceFlow = {
    async authorize(options) {
      assert.equal(options.marker, 'device-options');
      return tokenSet('app-access', 'app-refresh');
    },
    cancel() {},
    resume() {},
  };
  const validated = [];

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory(validated),
        deviceFlow,
        now: () => 1_000,
        store,
        transport: createTransport([]),
      });

      assert.deepEqual(
        await manager.signInWithGitHub({ marker: 'device-options' }),
        account('github-app'),
      );
      assert.equal(store.saved.at(-1).accessToken, 'app-access');
      assert.equal(store.saved.at(-1).refreshToken, 'app-refresh');
      assert.deepEqual(await manager.getAccount(), account('github-app'));

      assert.deepEqual(
        await manager.usePersonalAccessToken('personal-access'),
        account('pat'),
      );
      assert.deepEqual(store.saved.at(-1), {
        accessExpiresAt: null,
        accessToken: 'personal-access',
        accountId: 1,
        avatarUrl: 'https://avatars.example/octocat',
        kind: 'pat',
        login: 'octocat',
        refreshExpiresAt: null,
        refreshToken: null,
        version: 1,
      });
    },
  );

  assert.deepEqual(validated, ['app-access', 'personal-access']);
});

test('saved sessions recover after restart without exposing credentials', async () => {
  const store = createStore(githubAppSession());

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        now: () => 1_000,
        store,
        transport: createTransport([]),
      });
      assert.deepEqual(await manager.getAccount(), account('github-app'));
      assert.equal(await manager.getAccessToken(), 'old-access');
    },
  );

  assert.equal(store.loadCalls, 1);
});

test('expiring sessions share one refresh and atomically rotate all values', async () => {
  const now = 1_000_000;
  const store = createStore(
    githubAppSession({
      accessExpiresAt: now + 4 * 60 * 1_000,
      refreshExpiresAt: now + 10_000_000,
    }),
  );
  const transport = createTransport([
    tokenResponse('new-access', 'new-refresh'),
  ]);
  const validated = [];

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory(validated),
        deviceFlow: emptyDeviceFlow(),
        now: () => now,
        store,
        transport,
      });
      assert.deepEqual(
        await Promise.all([
          manager.getAccessToken(),
          manager.getAccessToken(),
          manager.getAccessToken(),
        ]),
        ['new-access', 'new-access', 'new-access'],
      );
    },
  );

  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0].data, {
    client_id: 'client',
    grant_type: 'refresh_token',
    refresh_token: 'old-refresh',
  });
  assert.deepEqual(validated, ['new-access']);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].accessToken, 'new-access');
  assert.equal(store.saved[0].refreshToken, 'new-refresh');
  assert.equal(store.saved[0].accessExpiresAt, now + 3_600_000);
  assert.equal(store.saved[0].refreshExpiresAt, now + 7_200_000);
});

test('rotated sessions replace memory only after complete persistence', async () => {
  const now = 1_000_000;
  let finishSave;
  let saveStarted;
  const saving = new Promise((resolve) => {
    saveStarted = resolve;
  });
  const store = createStore(githubAppSession({ accessExpiresAt: now + 1_000 }));
  store.save = async (session) => {
    store.saved.push(structuredClone(session));
    saveStarted();
    await new Promise((resolve) => {
      finishSave = resolve;
    });
    store.value = structuredClone(session);
  };

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        now: () => now,
        store,
        transport: createTransport([
          tokenResponse('rotated-access', 'rotated-refresh'),
        ]),
      });
      const refresh = manager.getAccessToken();
      await saving;
      assert.deepEqual(await manager.getAccount(), account('github-app'));
      assert.equal(store.value.accessToken, 'old-access');
      finishSave();
      assert.equal(await refresh, 'rotated-access');
      assert.equal(store.value.accessToken, 'rotated-access');
    },
  );
});

test('transient refresh failures retain the encrypted session', async () => {
  const now = 1_000_000;
  const store = createStore(githubAppSession({ accessExpiresAt: now + 1_000 }));
  const failure = new Error('network included old-refresh');
  const transport = createTransport([failure]);

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        now: () => now,
        store,
        transport,
      });
      await assert.rejects(manager.getAccessToken(), (error) => {
        assert.equal(error.kind, 'network');
        assert.equal(error.message.includes('old-refresh'), false);
        return true;
      });
      assert.deepEqual(await manager.getAccount(), account('github-app'));
    },
  );

  assert.equal(store.clearCalls, 0);
  assert.equal(store.value.accessToken, 'old-access');
});

test('invalid or expired refresh credentials clear only the confirmed session', async () => {
  const now = 1_000_000;
  const cases = [
    {
      response: { error: 'bad_refresh_token' },
      session: githubAppSession({ accessExpiresAt: now + 1_000 }),
    },
    {
      response: undefined,
      session: githubAppSession({
        accessExpiresAt: now + 1_000,
        refreshExpiresAt: now,
      }),
    },
  ];

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      for (const { response, session } of cases) {
        const store = createStore(session);
        const transport = createTransport(response ? [response] : []);
        const manager = new GitHubAuthManager({
          clientId: 'client',
          createGitHub: createIdentityFactory([]),
          deviceFlow: emptyDeviceFlow(),
          now: () => now,
          store,
          transport,
        });
        await assert.rejects(
          manager.getAccessToken(),
          hasKind('refresh-revoked'),
        );
        assert.equal(store.clearCalls, 1);
        assert.equal(store.value, null);
      }
    },
  );
});

test('401 refreshes and retries once, while writes can opt out of retry', async () => {
  const now = 1_000_000;

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const store = createStore(githubAppSession());
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        now: () => now,
        store,
        transport: createTransport([
          tokenResponse('after-401', 'refresh-after-401'),
        ]),
      });
      const attempts = [];
      const value = await manager.runWithToken(async (token) => {
        attempts.push(token);
        if (attempts.length === 1) throw authenticationError();
        return 'success';
      });
      assert.equal(value, 'success');
      assert.deepEqual(attempts, ['old-access', 'after-401']);

      const writeStore = createStore(githubAppSession());
      const writeTransport = createTransport([
        tokenResponse('write-refresh', 'write-refresh-token'),
      ]);
      const writeManager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        now: () => now,
        store: writeStore,
        transport: writeTransport,
      });
      await assert.rejects(
        writeManager.runWithToken(
          async () => {
            throw authenticationError();
          },
          { retryOnUnauthorized: false },
        ),
        hasKind('invalid-token'),
      );
      assert.equal(writeTransport.calls.length, 1);
      assert.equal(writeStore.clearCalls, 0);
      assert.equal(writeStore.value.accessToken, 'write-refresh');
    },
  );
});

test('a second 401 or a revoked PAT clears the confirmed credential', async () => {
  const now = 1_000_000;

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const appStore = createStore(githubAppSession());
      const appManager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        now: () => now,
        store: appStore,
        transport: createTransport([
          tokenResponse('after-401', 'refresh-after-401'),
        ]),
      });
      let attempts = 0;
      await assert.rejects(
        appManager.runWithToken(async () => {
          attempts += 1;
          throw authenticationError();
        }),
        hasKind('refresh-revoked'),
      );
      assert.equal(attempts, 2);
      assert.equal(appStore.clearCalls, 1);

      const patStore = createStore(patSession());
      const patManager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        now: () => now,
        store: patStore,
        transport: createTransport([]),
      });
      await assert.rejects(
        patManager.runWithToken(async () => {
          throw authenticationError();
        }),
        hasKind('invalid-token'),
      );
      assert.equal(patStore.clearCalls, 1);
    },
  );
});

test('invalid new credentials are rejected without persistence or token leakage', async () => {
  const store = createStore();

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: () => ({
          async getAuthenticatedUser() {
            throw authenticationError('invalid secret-personal-token');
          },
        }),
        deviceFlow: emptyDeviceFlow(),
        store,
        transport: createTransport([]),
      });
      await assert.rejects(
        manager.usePersonalAccessToken('secret-personal-token'),
        (error) => {
          assert.equal(error.kind, 'invalid-token');
          assert.equal(
            JSON.stringify(error).includes('secret-personal-token'),
            false,
          );
          assert.equal(error.stack.includes('secret-personal-token'), false);
          return true;
        },
      );
    },
  );

  assert.equal(store.saved.length, 0);
});

test('failed PAT replacement leaves the previous account and session active', async () => {
  const store = createStore(patSession());

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: (token) => ({
          async getAuthenticatedUser() {
            if (token === 'replacement') throw authenticationError();
            return {
              avatar_url: 'https://avatars.example/octocat',
              id: 1,
              login: 'octocat',
            };
          },
        }),
        deviceFlow: emptyDeviceFlow(),
        store,
        transport: createTransport([]),
      });

      assert.deepEqual(await manager.getAccount(), account('pat'));
      await assert.rejects(
        manager.usePersonalAccessToken('replacement'),
        hasKind('invalid-token'),
      );
      assert.deepEqual(await manager.getAccount(), account('pat'));
      assert.equal(await manager.getAccessToken(), 'personal-access');
    },
  );

  assert.equal(store.saved.length, 0);
  assert.equal(store.value.accessToken, 'personal-access');
});

test('sign-out during vault loading cannot restore the loaded session', async () => {
  const loading = deferred();
  const store = createStore(githubAppSession());
  store.load = async () => {
    store.loadCalls += 1;
    return loading.promise;
  };

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        store,
        transport: createTransport([]),
      });
      const accountLoad = manager.getAccount();
      await Promise.resolve();
      await manager.signOut();
      loading.resolve(githubAppSession());
      assert.equal(await accountLoad, null);
      assert.equal(await manager.getAccount(), null);
    },
  );

  assert.equal(store.clearCalls, 1);
  assert.equal(store.value, null);
});

test('sign-out during refresh leaves memory and the vault signed out', async () => {
  const now = 1_000_000;
  const response = deferred();
  const store = createStore(githubAppSession({ accessExpiresAt: now + 1_000 }));
  const transport = deferredTransport(response);

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        now: () => now,
        store,
        transport,
      });
      const refresh = manager.getAccessToken();
      await waitFor(() => transport.calls.length === 1);
      await manager.signOut();
      response.resolve(tokenResponse('stale-access', 'stale-refresh'));
      await assert.rejects(refresh, hasKind('cancelled'));
      assert.equal(await manager.getAccount(), null);
    },
  );

  assert.equal(store.clearCalls, 1);
  assert.equal(store.value, null);
});

test('sign-out queues vault clearing after an active credential write', async () => {
  const saving = deferred();
  const saveStarted = deferred();
  const store = createStore(patSession());
  store.save = async (session) => {
    store.saved.push(structuredClone(session));
    saveStarted.resolve();
    await saving.promise;
    store.value = structuredClone(session);
  };

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      const manager = new GitHubAuthManager({
        clientId: 'client',
        createGitHub: createIdentityFactory([]),
        deviceFlow: emptyDeviceFlow(),
        store,
        transport: createTransport([]),
      });
      await manager.getAccount();
      const replacement = assert.rejects(
        manager.usePersonalAccessToken('replacement-pat'),
        hasKind('cancelled'),
      );
      await saveStarted.promise;
      const signOut = manager.signOut();
      assert.equal(await manager.getAccount(), null);
      saving.resolve();
      await signOut;
      await replacement;
      assert.equal(await manager.getAccount(), null);
    },
  );

  assert.equal(store.clearCalls, 1);
  assert.equal(store.value, null);
});

test('credential replacement during refresh wins over stale success and failure', async () => {
  const now = 1_000_000;

  await withSourceModule(
    'githubAuth/authManager.js',
    {},
    async ({ GitHubAuthManager }) => {
      for (const staleResponse of [
        tokenResponse('stale-access', 'stale-refresh'),
        { error: 'bad_refresh_token' },
      ]) {
        const response = deferred();
        const store = createStore(
          githubAppSession({ accessExpiresAt: now + 1_000 }),
        );
        const transport = deferredTransport(response);
        const manager = new GitHubAuthManager({
          clientId: 'client',
          createGitHub: createIdentityFactory([]),
          deviceFlow: emptyDeviceFlow(),
          now: () => now,
          store,
          transport,
        });

        const refresh = manager.getAccessToken();
        await waitFor(() => transport.calls.length === 1);
        await manager.usePersonalAccessToken('replacement-pat');
        response.resolve(staleResponse);
        await assert.rejects(refresh, hasKind('cancelled'));
        assert.equal(await manager.getAccessToken(), 'replacement-pat');
        assert.equal((await manager.getAccount()).kind, 'pat');
        assert.equal(store.value.accessToken, 'replacement-pat');
        assert.equal(store.clearCalls, 0);
      }
    },
  );
});

test('factory-assembled auth validates identity with the injected GitHub client', async () => {
  let injectedCalls = 0;
  let webFetchCalls = 0;
  const stored = new Map();

  await withSourceModule(
    'githubAuth/index.js',
    {
      cordova: {},
      fetch: async () => {
        webFetchCalls += 1;
        throw new Error('Web Fetch must not be used');
      },
    },
    async ({ createDefaultGitHubAuthManager }) => {
      const manager = createDefaultGitHubAuthManager(
        { clientId: 'client' },
        {
          createGitHub: (token) => ({
            async getAuthenticatedUser() {
              injectedCalls += 1;
              assert.equal(token, 'native-pat');
              return { avatar_url: null, id: 7, login: 'native-user' };
            },
          }),
          storage: {
            getItem(key) {
              return stored.get(key) ?? null;
            },
            removeItem(key) {
              stored.delete(key);
            },
            setItem(key, value) {
              stored.set(key, value);
            },
          },
        },
      );

      assert.equal(
        (await manager.usePersonalAccessToken('native-pat')).login,
        'native-user',
      );
    },
  );

  assert.equal(injectedCalls, 1);
  assert.equal(webFetchCalls, 0);
});

function createStore(initial = null) {
  return {
    clearCalls: 0,
    loadCalls: 0,
    saved: [],
    value: initial && structuredClone(initial),
    async clear() {
      this.clearCalls += 1;
      this.value = null;
    },
    async load() {
      this.loadCalls += 1;
      return this.value && structuredClone(this.value);
    },
    async save(session) {
      const value = structuredClone(session);
      this.saved.push(value);
      this.value = value;
    },
  };
}

function createTransport(entries) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async postForm(url, data) {
      calls.push({ data, url });
      const response = entries[index++];
      if (response instanceof Error) throw response;
      if (!response) throw new Error('Unexpected refresh request');
      return response;
    },
  };
}

function deferredTransport(response) {
  const calls = [];
  return {
    calls,
    async postForm(url, data) {
      calls.push({ data, url });
      return response.promise;
    },
  };
}

function createIdentityFactory(tokens) {
  return (token) => ({
    async getAuthenticatedUser() {
      tokens.push(token);
      return {
        avatar_url: 'https://avatars.example/octocat',
        id: 1,
        login: 'octocat',
      };
    },
  });
}

function emptyDeviceFlow() {
  return { cancel() {}, resume() {} };
}

function tokenSet(accessToken, refreshToken) {
  return {
    accessExpiresAt: 3_601_000,
    accessToken,
    refreshExpiresAt: 7_201_000,
    refreshToken,
  };
}

function tokenResponse(accessToken, refreshToken) {
  return {
    access_token: accessToken,
    expires_in: 3_600,
    refresh_token: refreshToken,
    refresh_token_expires_in: 7_200,
    token_type: 'bearer',
  };
}

function githubAppSession(overrides = {}) {
  return {
    accessExpiresAt: 20_000_000,
    accessToken: 'old-access',
    accountId: 1,
    avatarUrl: 'https://avatars.example/octocat',
    kind: 'github-app',
    login: 'octocat',
    refreshExpiresAt: 30_000_000,
    refreshToken: 'old-refresh',
    version: 1,
    ...overrides,
  };
}

function patSession() {
  return {
    accessExpiresAt: null,
    accessToken: 'personal-access',
    accountId: 1,
    avatarUrl: 'https://avatars.example/octocat',
    kind: 'pat',
    login: 'octocat',
    refreshExpiresAt: null,
    refreshToken: null,
    version: 1,
  };
}

function account(kind) {
  return {
    avatarUrl: 'https://avatars.example/octocat',
    id: 1,
    kind,
    login: 'octocat',
  };
}

function authenticationError(message = 'Bad credentials') {
  const error = new Error(message);
  error.kind = 'authentication';
  error.status = 401;
  return error;
}

function hasKind(kind) {
  return (error) => error.kind === kind;
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached');
}
