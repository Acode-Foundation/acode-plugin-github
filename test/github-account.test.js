const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('legacy PAT restoration performs no startup network request', async () => {
  const values = new Map([['github-token', 'legacy-token']]);
  const calls = [];
  const authManager = createAuthManager(calls);

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        legacyStore: createStore(values),
      });
      const account = await controller.initialize();

      assert.deepEqual(account, {
        avatarUrl: null,
        id: 'legacy-pat',
        kind: 'pat',
        login: 'GitHub',
        pendingMigration: true,
      });
      assert.equal(await controller.getAccessToken(), 'legacy-token');
      assert.deepEqual(calls, [['get-account']]);
      assert.equal(values.get('github-token'), 'legacy-token');
    },
  );
});

test('first successful request finalizes and encrypts a legacy PAT', async () => {
  const values = new Map([['github-token', 'legacy-token']]);
  const calls = [];
  const authManager = createAuthManager(calls);

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        createGitHub: (token) => ({ token }),
        legacyStore: createStore(values),
      });
      await controller.initialize();

      assert.equal(
        await controller.run((client) => `loaded:${client.token}`),
        'loaded:legacy-token',
      );
      await settle();

      assert.deepEqual(calls, [['get-account'], ['save-pat', 'legacy-token']]);
      assert.equal(values.has('github-token'), false);
      assert.equal((await controller.getAccount()).login, 'octocat');
    },
  );
});

test('concurrent successful requests share one legacy migration', async () => {
  const values = new Map([['github-token', 'legacy-token']]);
  const calls = [];
  const migration = deferred();
  const authManager = createAuthManager(calls);
  authManager.usePersonalAccessToken = (token) => {
    calls.push(['save-pat', token]);
    return migration.promise;
  };

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        createGitHub: (token) => ({ token }),
        legacyStore: createStore(values),
      });
      await controller.initialize();

      assert.deepEqual(
        await Promise.all([
          controller.run((client) => client.token),
          controller.run((client) => client.token),
        ]),
        ['legacy-token', 'legacy-token'],
      );
      assert.deepEqual(calls, [['get-account'], ['save-pat', 'legacy-token']]);

      migration.resolve({
        avatarUrl: null,
        id: 1,
        kind: 'pat',
        login: 'octocat',
      });
      await settle();
      assert.equal(values.has('github-token'), false);
    },
  );
});

test('provisional PAT writes remain serialized and are never replayed', async () => {
  const values = new Map([['github-token', 'legacy-token']]);
  const migration = deferred();
  const firstWrite = deferred();
  const authManager = createAuthManager([]);
  authManager.usePersonalAccessToken = () => migration.promise;

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        createGitHub: () => ({}),
        legacyStore: createStore(values),
      });
      await controller.initialize();
      const starts = [];
      const first = controller.run(
        async () => {
          starts.push('first');
          await firstWrite.promise;
          return 'first result';
        },
        { write: true },
      );
      const second = controller.run(
        () => {
          starts.push('second');
          return 'second result';
        },
        { write: true },
      );
      await settle();
      assert.deepEqual(starts, ['first']);

      firstWrite.resolve();
      assert.deepEqual(await Promise.all([first, second]), [
        'first result',
        'second result',
      ]);
      assert.deepEqual(starts, ['first', 'second']);
      migration.resolve({
        avatarUrl: null,
        id: 1,
        kind: 'pat',
        login: 'octocat',
      });
      await settle();
    },
  );
});

test('migration failures preserve successful results and retry later', async () => {
  for (const kind of ['network', 'storage']) {
    const values = new Map([['github-token', 'legacy-token']]);
    const calls = [];
    const authManager = createAuthManager(calls);
    let attempts = 0;
    authManager.usePersonalAccessToken = async (token) => {
      calls.push(['save-pat', token]);
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error(kind), { kind });
      return {
        avatarUrl: null,
        id: 1,
        kind: 'pat',
        login: 'octocat',
      };
    };

    await withSourceModule(
      'githubAccount.js',
      { localStorage: createStore(values) },
      async ({ GitHubAccountController }) => {
        const controller = new GitHubAccountController({
          authManager,
          createGitHub: (token) => ({ token }),
          legacyStore: createStore(values),
        });
        await controller.initialize();

        assert.equal(
          await controller.run(() => 'first result'),
          'first result',
        );
        await settle();
        assert.equal(values.get('github-token'), 'legacy-token');
        assert.equal((await controller.getAccount()).pendingMigration, true);

        assert.equal(
          await controller.run(() => 'retry result'),
          'retry result',
        );
        await settle();
        assert.equal(values.has('github-token'), false);
        assert.equal(attempts, 2);
      },
    );
  }
});

test('failed encrypted storage never falls back to a plaintext PAT', async () => {
  const values = new Map([['github-token', 'legacy-token']]);
  const authManager = createAuthManager([]);
  authManager.getAccount = async () => {
    const error = new Error('encrypted storage failed');
    error.kind = 'storage';
    throw error;
  };

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        legacyStore: createStore(values),
      });

      await assert.rejects(controller.initialize(), hasKind('storage'));
      assert.equal(controller.secure, true);
      assert.equal(values.get('github-token'), 'legacy-token');
    },
  );
});

test('an existing encrypted session is authoritative over a legacy PAT', async () => {
  const values = new Map([['github-token', 'legacy-token']]);
  const calls = [];
  const authManager = createAuthManager(calls);
  await authManager.usePersonalAccessToken('encrypted-token');
  calls.length = 0;

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        legacyStore: createStore(values),
      });
      assert.equal((await controller.initialize()).kind, 'pat');
    },
  );

  assert.deepEqual(calls, [['get-account']]);
  assert.equal(values.has('github-token'), false);
});

test('deferred sign-out hides the account and removes plaintext immediately', async () => {
  const values = new Map([['github-token', 'legacy-token']]);
  const clearing = deferred();
  const authManager = createAuthManager([]);
  authManager.cancelSignIn = () => {};
  authManager.signOut = () => clearing.promise;
  authManager.runWithToken = async () => {
    throw Object.assign(new Error('signed out'), { kind: 'invalid-token' });
  };

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        createGitHub: (token) => ({ token }),
        legacyStore: createStore(values),
      });
      const changes = [];
      controller.subscribe((account) => changes.push(account));
      await controller.initialize();

      const signOut = controller.signOut();
      assert.equal(await controller.getAccount(), null);
      assert.equal(values.has('github-token'), false);
      assert.equal(changes.at(-1), null);
      await assert.rejects(
        controller.run((client) => client.token),
        hasKind('invalid-token'),
      );

      clearing.resolve();
      await signOut;
      assert.equal(await controller.getAccount(), null);
    },
  );
});

test('persistent sign-out failure cannot restore the in-memory account', async () => {
  const authManager = createAuthManager([]);
  authManager.cancelSignIn = () => {};
  authManager.signOut = async () => {
    throw Object.assign(new Error('vault unavailable'), { kind: 'storage' });
  };

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(new Map()) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        legacyStore: createStore(new Map()),
      });
      await controller.usePersonalAccessToken('token');

      await assert.rejects(controller.signOut(), hasKind('storage'));
      assert.equal(await controller.getAccount(), null);
    },
  );
});

test('a confirmed invalid provisional PAT opens account recovery', async () => {
  const values = new Map([['github-token', 'legacy-token']]);
  const authManager = createAuthManager([]);

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        createGitHub: () => ({}),
        legacyStore: createStore(values),
      });
      const accounts = [];
      controller.subscribe((account) => accounts.push(account));
      await controller.initialize();

      await assert.rejects(
        controller.run(() => {
          throw Object.assign(new Error('unauthorized'), { status: 401 });
        }),
        hasKind('invalid-token'),
      );

      assert.equal(await controller.getAccount(), null);
      assert.equal(values.get('github-token'), 'legacy-token');
      assert.equal(accounts.at(-1), null);
    },
  );
});

test('request runner permits one read retry but never a write retry', async () => {
  const calls = [];
  const authManager = createAuthManager(calls);
  authManager.getAccount = async () => ({
    id: 1,
    kind: 'pat',
    login: 'octocat',
  });

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(new Map()) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        createGitHub: (token) => ({ token }),
        legacyStore: createStore(new Map()),
      });

      assert.equal(await controller.run((client) => client.token), 'token');
      assert.equal(
        await controller.run((client) => client.token, { write: true }),
        'token',
      );
      assert.deepEqual(calls.slice(-2), [
        ['run', true],
        ['run', false],
      ]);
    },
  );
});

test('account boundary serializes modern services and reads fresh write state', async () => {
  const firstPutStarted = deferred();
  const releaseFirstPut = deferred();
  let activePuts = 0;
  let clientCount = 0;
  let maxActivePuts = 0;
  let readCount = 0;
  const writtenShas = [];
  const authManager = createAuthManager([]);

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(new Map()) },
    async ({ GitHubAccountController }) => {
      const { GitHubService } = require('../src/githubService');
      class TestOctokit {
        hook = { before() {} };

        async request(route, parameters) {
          if (route.startsWith('GET ')) {
            readCount += 1;
            return { data: { sha: `sha-${readCount}`, type: 'file' } };
          }
          activePuts += 1;
          maxActivePuts = Math.max(maxActivePuts, activePuts);
          writtenShas.push(parameters.sha);
          if (writtenShas.length === 1) {
            firstPutStarted.resolve();
            await releaseFirstPut.promise;
          }
          activePuts -= 1;
          return { data: { content: { sha: `result-${readCount}` } } };
        }
      }

      const controller = new GitHubAccountController({
        authManager,
        createGitHub: () => {
          clientCount += 1;
          return new GitHubService('modern-token', {
            OctokitClass: TestOctokit,
          });
        },
        legacyStore: createStore(new Map()),
      });
      const values = {
        branch: 'main',
        owner: 'octocat',
        path: 'src/index.js',
        repo: 'example',
      };
      const write = (content) =>
        controller.run(
          (client) =>
            client.writeFile({ ...values, content, message: content }),
          { write: true },
        );

      const first = write('first');
      await firstPutStarted.promise;
      const second = write('second');
      await settle();
      assert.equal(clientCount, 1);
      assert.equal(maxActivePuts, 1);

      releaseFirstPut.resolve();
      await Promise.all([first, second]);
      assert.equal(clientCount, 2);
      assert.equal(maxActivePuts, 1);
      assert.deepEqual(writtenShas, ['sha-1', 'sha-2']);
    },
  );
});

test('credential replacement cancels queued old-session writes', async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let token = 'old-token';
  const authManager = createAuthManager([]);
  authManager.runWithToken = (operation) => operation(token);
  authManager.usePersonalAccessToken = async (replacement) => {
    token = replacement;
    return { avatarUrl: null, id: 1, kind: 'pat', login: 'octocat' };
  };

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(new Map()) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        createGitHub: (credential) => ({ credential }),
        legacyStore: createStore(new Map()),
      });
      const first = controller.run(
        async (client) => {
          firstStarted.resolve();
          await releaseFirst.promise;
          return client.credential;
        },
        { write: true },
      );
      await firstStarted.promise;
      const stale = controller.run((client) => client.credential, {
        write: true,
      });
      const staleRejection = assert.rejects(stale, hasKind('cancelled'));

      await controller.usePersonalAccessToken('replacement-token');
      const current = controller.run((client) => client.credential, {
        write: true,
      });
      releaseFirst.resolve();

      assert.equal(await first, 'old-token');
      await staleRejection;
      assert.equal(await current, 'replacement-token');
    },
  );
});

test('sign-out cancels queued writes and later credentials can write', async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let signedOut = false;
  let token = 'old-token';
  const authManager = createAuthManager([]);
  authManager.cancelSignIn = () => {};
  authManager.runWithToken = (operation) => {
    if (signedOut) {
      throw Object.assign(new Error('signed out'), { kind: 'invalid-token' });
    }
    return operation(token);
  };
  authManager.signOut = async () => {
    signedOut = true;
  };
  authManager.usePersonalAccessToken = async (replacement) => {
    signedOut = false;
    token = replacement;
    return { avatarUrl: null, id: 1, kind: 'pat', login: 'octocat' };
  };

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(new Map()) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        createGitHub: (credential) => ({ credential }),
        legacyStore: createStore(new Map()),
      });
      const first = controller.run(
        async (client) => {
          firstStarted.resolve();
          await releaseFirst.promise;
          return client.credential;
        },
        { write: true },
      );
      await firstStarted.promise;
      const stale = controller.run((client) => client.credential, {
        write: true,
      });
      const staleRejection = assert.rejects(stale, hasKind('cancelled'));

      await controller.signOut();
      await controller.usePersonalAccessToken('replacement-token');
      const current = controller.run((client) => client.credential, {
        write: true,
      });
      releaseFirst.resolve();

      assert.equal(await first, 'old-token');
      await staleRejection;
      assert.equal(await current, 'replacement-token');
    },
  );
});

test('replacing credentials notifies listeners even for the same account', async () => {
  const values = new Map();
  const authManager = createAuthManager([]);

  await withSourceModule(
    'githubAccount.js',
    { localStorage: createStore(values) },
    async ({ GitHubAccountController }) => {
      const controller = new GitHubAccountController({
        authManager,
        legacyStore: createStore(values),
      });
      const changes = [];
      controller.subscribe((account) => changes.push(account.login));

      await controller.usePersonalAccessToken('first-token');
      await controller.usePersonalAccessToken('replacement-token');

      assert.deepEqual(changes, ['octocat', 'octocat']);
    },
  );
});

function createAuthManager(calls) {
  let account = null;
  return {
    async getAccessToken() {
      return 'token';
    },
    async getAccount() {
      calls.push(['get-account']);
      return account;
    },
    async runWithToken(operation, options) {
      calls.push(['run', options.retryOnUnauthorized]);
      return operation('token');
    },
    async usePersonalAccessToken(token) {
      calls.push(['save-pat', token]);
      account = { avatarUrl: null, id: 1, kind: 'pat', login: 'octocat' };
      return account;
    },
  };
}

function createStore(values) {
  return {
    getItem(key) {
      return values.get(key) || null;
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

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}
