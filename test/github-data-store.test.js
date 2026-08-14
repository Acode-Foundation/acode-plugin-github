const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('data cache is account-scoped, deduplicates loads, and expires after TTL', async () => {
  let now = 1_000;
  let loads = 0;

  await withSourceModule(
    'githubDataStore.js',
    {},
    async ({ GitHubDataStore }) => {
      const store = new GitHubDataStore({ now: () => now, ttl: 100 });
      store.setAccount({ id: 1, kind: 'pat' });
      const load = async () => ++loads;

      assert.deepEqual(
        await Promise.all([store.get('repos', load), store.get('repos', load)]),
        [1, 1],
      );
      assert.equal(await store.get('repos', load), 1);
      now = 1_101;
      assert.equal(await store.get('repos', load), 2);

      store.setAccount({ id: 2, kind: 'github-app' });
      assert.equal(await store.get('repos', load), 3);
    },
  );
});

test('targeted invalidation removes only matching account entries', async () => {
  await withSourceModule(
    'githubDataStore.js',
    {},
    async ({ GitHubDataStore }) => {
      const store = new GitHubDataStore();
      store.setAccount({ id: 1, kind: 'pat' });
      let repoLoads = 0;
      let gistLoads = 0;
      const repos = () => ++repoLoads;
      const gists = () => ++gistLoads;

      await store.get('branches:a/repo', repos);
      await store.get('gists', gists);
      store.invalidate('branches:');

      assert.equal(await store.get('branches:a/repo', repos), 2);
      assert.equal(await store.get('gists', gists), 1);
    },
  );
});

test('credential generation scopes same-identity cache entries', async () => {
  await withSourceModule(
    'githubDataStore.js',
    {},
    async ({ GitHubDataStore }) => {
      const account = { id: 1, kind: 'pat' };
      const store = new GitHubDataStore();
      let loads = 0;
      const load = async () => ++loads;

      store.setAccount(account, 1);
      assert.equal(await store.get('repositories', load), 1);
      store.setAccount(account, 2);
      assert.equal(await store.get('repositories', load), 2);
    },
  );
});

test('forced refreshes still share an in-flight request', async () => {
  await withSourceModule(
    'githubDataStore.js',
    {},
    async ({ GitHubDataStore }) => {
      let resolve;
      let calls = 0;
      const store = new GitHubDataStore();
      const load = () => {
        calls += 1;
        return new Promise((resolveValue) => {
          resolve = resolveValue;
        });
      };

      const first = store.get('installations', load, { force: true });
      const second = store.get('installations', load, { force: true });
      await Promise.resolve();
      assert.equal(calls, 1);
      resolve(['installation']);
      assert.deepEqual(await Promise.all([first, second]), [
        ['installation'],
        ['installation'],
      ]);
    },
  );
});

test('invalidating an in-flight load permanently prevents stale cache writes', async () => {
  await withSourceModule(
    'githubDataStore.js',
    {},
    async ({ GitHubDataStore }) => {
      const first = deferred();
      const store = new GitHubDataStore();
      let loads = 0;
      const load = () => {
        loads += 1;
        return loads === 1 ? first.promise : Promise.resolve('fresh');
      };

      const staleLoad = store.get('repositories', load);
      await Promise.resolve();
      store.invalidate('repositories');
      assert.equal(await store.get('repositories', load), 'fresh');
      first.resolve('stale');
      assert.equal(await staleLoad, 'stale');
      assert.equal(await store.get('repositories', load), 'fresh');
      assert.equal(loads, 2);
    },
  );
});

test('an older rejected load cannot delete a newer cache entry', async () => {
  await withSourceModule(
    'githubDataStore.js',
    {},
    async ({ GitHubDataStore }) => {
      const first = deferred();
      const store = new GitHubDataStore();
      let loads = 0;
      const load = () => {
        loads += 1;
        return loads === 1 ? first.promise : Promise.resolve('replacement');
      };

      const staleLoad = store.get('gists', load);
      await Promise.resolve();
      store.clear();
      assert.equal(await store.get('gists', load), 'replacement');
      first.reject(new Error('stale failure'));
      await assert.rejects(staleLoad, /stale failure/);
      assert.equal(await store.get('gists', load), 'replacement');
      assert.equal(loads, 2);
    },
  );
});

test('repository discovery deduplicates installations by repository ID', async () => {
  await withSourceModule(
    'githubDataStore.js',
    {},
    async ({ deduplicateRepositories }) => {
      const repository = {
        id: 10,
        name: 'plugin',
        owner: { login: 'acode' },
      };
      assert.deepEqual(
        deduplicateRepositories([
          repository,
          { ...repository, installation: { id: 2 } },
          { id: 11, name: 'editor', owner: { login: 'acode' } },
        ]).map(({ id }) => id),
        [11, 10],
      );
    },
  );
});

test('the default branch is ordered before other branches', async () => {
  await withSourceModule(
    'githubDataStore.js',
    {},
    async ({ orderBranches }) => {
      assert.deepEqual(
        orderBranches(
          [{ name: 'release' }, { name: 'main' }, { name: 'develop' }],
          'main',
        ).map(({ name }) => name),
        ['main', 'develop', 'release'],
      );
    },
  );
});

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}
