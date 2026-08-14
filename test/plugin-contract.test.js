const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

const baseline = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/phase-1-baseline.json'),
    'utf8',
  ),
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'),
);

test('plugin remains installable on Acode versions without native secrets', () => {
  assert.equal(Object.hasOwn(manifest, 'minVersionCode'), false);
});

test('plugin commands defer plaintext migration until a successful request', async () => {
  const harness = createPluginHarness();
  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin(harness.dependencies);
      assert.deepEqual(
        plugin.commands.map(({ name, description }) => [name, description]),
        baseline.commands,
      );

      await plugin.init();
      assert.equal(plugin.token, 'stored-token');
      assert.equal(harness.storedToken, 'stored-token');
      assert.equal(
        harness.encryptedValues.has('acode.plugin.github.github-session-v1'),
        false,
      );
      assert.deepEqual(
        harness.registeredCommands,
        baseline.commands.map(([id]) => id),
      );
      assert.equal(harness.fsExtensions, 1);

      await plugin.listRepositories();
      await waitFor(() => harness.storedToken === null);
      const migrated = harness.encryptedValues.get(
        'acode.plugin.github.github-session-v1',
      );
      assert.equal(migrated.includes('stored-token'), false);

      harness.promptResults.push('replacement-token');
      await plugin.updateToken();
      assert.equal(plugin.token, 'replacement-token');
      assert.deepEqual(harness.promptCalls.at(-1).slice(0, 3), [
        'Enter GitHub token',
        '',
        'password',
      ]);
      assert.deepEqual(harness.credentialWrites, []);
      assert.equal(harness.storedToken, null);
      const encrypted = harness.encryptedValues.get(
        'acode.plugin.github.github-session-v1',
      );
      assert.equal(encrypted.includes('replacement-token'), false);
      assert.equal(harness.fsExtensions, 2);

      await plugin.destroy();
      assert.deepEqual(
        harness.removedCommands,
        baseline.commands.map(([id]) => id),
      );
    },
  );
});

test('authentication lifecycle remains injectable and isolated', async () => {
  const harness = createPluginHarness();
  const authCalls = { cancel: 0, resume: 0 };
  const authManager = {
    cancelSignIn() {
      authCalls.cancel += 1;
    },
    resume() {
      authCalls.resume += 1;
    },
  };

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin({
        ...harness.dependencies,
        authManager,
      });
      await plugin.init();
      harness.dispatchDocumentEvent('resume');
      harness.dispatchDocumentEvent('visibilitychange');
      assert.equal(authCalls.resume, 2);
      await plugin.destroy();
      assert.equal(authCalls.cancel, 1);
      harness.dispatchDocumentEvent('resume');
      assert.equal(authCalls.resume, 2);
    },
  );
});

test('plugin page installs, opens from the GitHub command, and cleans up', async () => {
  const harness = createPluginHarness();
  const calls = {
    destroy: 0,
    firstUse: [],
    install: [],
    launcherDestroy: 0,
    launcherInstall: 0,
    open: [],
  };
  const pageController = {
    destroy() {
      calls.destroy += 1;
    },
    handleResume() {},
    install(page) {
      calls.install.push(page);
      return true;
    },
    installed: true,
    open(view) {
      calls.open.push(view);
      return true;
    },
    openAccount() {
      return true;
    },
    render() {},
    showFirstUse(firstInit) {
      calls.firstUse.push(firstInit);
      return false;
    },
  };
  const page = {};

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin({
        ...harness.dependencies,
        createGitHubLauncher: () => ({
          destroy() {
            calls.launcherDestroy += 1;
          },
          install() {
            calls.launcherInstall += 1;
            return true;
          },
        }),
        createGitHubPage: () => pageController,
      });
      await plugin.init(page, { firstInit: true });
      const command = plugin.commands.find(
        ({ name }) => name === 'github:open',
      );
      assert.equal(command.description, 'GitHub');
      assert.equal(await command.exec(), true);
      assert.deepEqual(calls.install, [page]);
      assert.deepEqual(calls.firstUse, [true]);
      assert.deepEqual(calls.open, [undefined]);
      assert.equal(calls.launcherInstall, 1);

      await plugin.destroy();
      assert.equal(calls.destroy, 1);
      assert.equal(calls.launcherDestroy, 1);
    },
  );
});

test('GitHub setup intents refresh repository access once and clean up', async () => {
  const harness = createPluginHarness();
  const calls = { open: [], refresh: 0 };
  let finishRefresh;
  const refreshPending = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const pageController = {
    destroy() {},
    handleResume(repositoryAccessChanged) {
      if (!repositoryAccessChanged) return;
      calls.refresh += 1;
      return refreshPending;
    },
    install() {
      return true;
    },
    installed: true,
    open(view) {
      calls.open.push(view);
      return true;
    },
    showFirstUse() {
      return false;
    },
  };

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin({
        ...harness.dependencies,
        createGitHubLauncher: () => ({ destroy() {}, install() {} }),
        createGitHubPage: () => pageController,
      });
      await plugin.init();
      const first = setupEvent();
      const second = setupEvent('complete?installation_id=2');
      const pending = [
        ...harness.dispatchIntent(first),
        ...harness.dispatchIntent(second),
      ];
      await Promise.resolve();
      assert.deepEqual(calls.open, ['repositories']);
      assert.equal(calls.refresh, 1);
      assert.equal(first.defaultPrevented, 1);
      assert.equal(first.propagationStopped, 1);

      finishRefresh();
      await Promise.all(pending);
      harness.dispatchIntent({
        action: 'setup',
        module: 'other',
        value: 'complete',
      });
      harness.dispatchIntent(setupEvent('other'));
      assert.equal(calls.refresh, 1);

      await plugin.destroy();
      harness.dispatchIntent(setupEvent());
      assert.equal(calls.refresh, 1);
    },
  );
});

test('a protected action waits for sign-in and resumes exactly once', async () => {
  const harness = createPluginHarness();
  let account = null;
  let listener;
  let token = '';
  const accountController = {
    cancelSignIn() {},
    async getAccessToken() {
      if (!token) {
        const error = new Error('sign in');
        error.kind = 'invalid-token';
        throw error;
      }
      return token;
    },
    async getAccount() {
      return account;
    },
    async initialize() {
      return null;
    },
    resume() {},
    secure: true,
    subscribe(callback) {
      listener = callback;
      return () => {};
    },
  };

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin({
        ...harness.dependencies,
        accountController,
      });
      await plugin.init();
      let completions = 0;
      const pending = plugin.getToken().then((value) => {
        completions += 1;
        return value;
      });
      await Promise.resolve();
      assert.equal(completions, 0);

      token = 'connected-token';
      account = { id: 1, kind: 'github-app', login: 'octocat' };
      listener(account);
      assert.equal(await pending, 'connected-token');
      listener(account);
      await Promise.resolve();
      assert.equal(completions, 1);
      await plugin.destroy();
    },
  );
});

test('repository listing, branches, creation, and folder URLs are characterized', async () => {
  const harness = createPluginHarness();
  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin(harness.dependencies);
      await plugin.init();
      const repositories = await plugin.listRepositories();
      assert.deepEqual(
        repositories.map(({ value }) => value),
        ['octocat/example'],
      );
      assert.match(repositories[0].text, /private/);
      await waitFor(() => harness.storedToken === null);
      assert.deepEqual(await plugin.listRepositories(), repositories);
      assert.equal(harness.calls.listRepos, 2);

      const branches = await plugin.listBranches('octocat', 'example');
      assert.deepEqual(
        branches.map(({ value }) => value),
        ['..', 'main', 'release', plugin.NEW],
      );
      assert.deepEqual(
        await plugin.listBranches('octocat', 'example'),
        branches,
      );
      assert.equal(harness.calls.listBranches, 1);

      await plugin.openRepoAsFolder('octocat', 'example', 'main');
      assert.deepEqual(harness.openedFolders[0], {
        options: { name: 'octocat/example/main', saveState: false },
        url: 'gh://repo/octocat/example@main/',
      });

      harness.multiPromptResults.push({ branch: 'feature', from: 'main' });
      await plugin.openRepoAsFolder('octocat', 'example', plugin.NEW);
      assert.deepEqual(harness.calls.createBranch, [['main', 'feature']]);
      assert.equal(
        harness.openedFolders[1].url,
        'gh://repo/octocat/example@feature/',
      );
      await plugin.destroy();
    },
  );
});

test('GitHub App repository discovery combines installations and accepts none', async () => {
  const harness = createPluginHarness();
  const repositoryCalls = [];
  const account = { id: 1, kind: 'github-app', login: 'octocat' };
  const client = {
    async listInstallationRepositories(installationId) {
      repositoryCalls.push(installationId);
      if (installationId === 10) {
        return [
          { id: 1, name: 'alpha', owner: { login: 'octocat' } },
          { id: 3, name: 'shared', owner: { login: 'acode' } },
        ];
      }
      return [
        { id: 2, name: 'beta', owner: { login: 'acode' } },
        { id: 3, name: 'shared', owner: { login: 'acode' } },
      ];
    },
    async listInstallations() {
      return [{ id: 10 }, { id: 20 }];
    },
  };

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin({
        ...harness.dependencies,
        accountController: githubAppAccountController(account, client),
      });
      const repositories = await plugin.getRepositories();
      assert.deepEqual(repositoryCalls, [10, 20]);
      assert.deepEqual(
        repositories.map(({ id }) => id),
        [2, 3, 1],
      );
      assert.equal(repositories.find(({ id }) => id === 3).installation.id, 10);
      await plugin.getRepositories();
      assert.deepEqual(repositoryCalls, [10, 20]);

      let repositoryListCalls = 0;
      const emptyClient = {
        async listInstallationRepositories() {
          repositoryListCalls += 1;
          return [];
        },
        async listInstallations() {
          return [];
        },
      };
      const emptyPlugin = new AcodePlugin({
        ...harness.dependencies,
        accountController: githubAppAccountController(account, emptyClient),
      });
      assert.deepEqual(await emptyPlugin.getRepositories(), []);
      assert.equal(repositoryListCalls, 0);
    },
  );
});

test('an older account request cannot repopulate the repository index', async () => {
  const harness = createPluginHarness();
  const accountARepositories = deferred();
  const calls = { accountA: 0, accountB: 0 };
  const accountA = { id: 1, kind: 'pat', login: 'account-a' };
  const accountB = { id: 2, kind: 'pat', login: 'account-b' };
  let account = accountA;
  let listener;
  const clients = {
    1: {
      async listRepositories() {
        calls.accountA += 1;
        return accountARepositories.promise;
      },
    },
    2: {
      async listBranches() {
        return [{ name: 'main' }, { name: 'trunk' }];
      },
      async listRepositories() {
        calls.accountB += 1;
        return [indexedRepository('trunk')];
      },
    },
  };
  const accountController = {
    cancelSignIn() {},
    async getAccessToken() {
      return `token-${account.id}`;
    },
    async getAccount() {
      return account;
    },
    async initialize() {
      return account;
    },
    async run(operation) {
      return operation(clients[account.id]);
    },
    secure: true,
    subscribe(callback) {
      listener = callback;
      return () => {};
    },
  };

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin({
        ...harness.dependencies,
        accountController,
      });
      const stale = plugin.getRepositories();
      await waitFor(() => calls.accountA === 1);
      account = accountB;
      listener(accountB);
      assert.deepEqual(
        (await plugin.getRepositories()).map(
          ({ default_branch }) => default_branch,
        ),
        ['trunk'],
      );

      accountARepositories.resolve([indexedRepository('main')]);
      assert.deepEqual(await stale, []);
      assert.deepEqual(
        (await plugin.getBranches('octocat', 'shared')).map(({ name }) => name),
        ['trunk', 'main'],
      );
    },
  );
});

test('same-identity credential generations reload account-scoped data', async () => {
  const harness = createPluginHarness();

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      for (const kind of ['pat', 'github-app']) {
        const account = { id: 1, kind, login: 'octocat' };
        let generation = 1;
        let listener;
        const calls = { gists: 0, installations: 0, repositories: 0 };
        const client = {
          async listGists() {
            calls.gists += 1;
            return [{ id: `gist-${generation}` }];
          },
          async listInstallationRepositories() {
            calls.repositories += 1;
            return [repository(`repo-${generation}`, 'octocat', generation)];
          },
          async listInstallations() {
            calls.installations += 1;
            return [{ id: generation }];
          },
          async listRepositories() {
            calls.repositories += 1;
            return [repository(`repo-${generation}`, 'octocat', generation)];
          },
        };
        const accountController = {
          cancelSignIn() {},
          async getAccessToken() {
            return `token-${generation}`;
          },
          async getAccount() {
            return account;
          },
          async run(operation) {
            return operation(client);
          },
          secure: true,
          subscribe(callback) {
            listener = callback;
            return () => {};
          },
        };
        const plugin = new AcodePlugin({
          ...harness.dependencies,
          accountController,
        });

        assert.deepEqual(
          (await plugin.getRepositories()).map(({ name }) => name),
          ['repo-1'],
        );
        assert.deepEqual(
          (await plugin.getGists()).map(({ id }) => id),
          ['gist-1'],
        );
        generation = 2;
        listener(account);
        assert.deepEqual(
          (await plugin.getRepositories()).map(({ name }) => name),
          ['repo-2'],
        );
        assert.deepEqual(
          (await plugin.getGists()).map(({ id }) => id),
          ['gist-2'],
        );
        assert.deepEqual(calls, {
          gists: 2,
          installations: kind === 'github-app' ? 2 : 0,
          repositories: 2,
        });
      }
    },
  );
});

test('account changes make every stale palette provider return no items', async () => {
  const harness = createPluginHarness();
  const accountA = { id: 1, kind: 'pat', login: 'account-a' };
  const accountB = { id: 2, kind: 'pat', login: 'account-b' };
  let account = accountA;
  let listener;
  const repositories = deferred();
  const branches = deferred();
  const gists = deferred();
  const gist = deferred();
  const started = new Set();
  const clients = {
    1: {
      listRepositories() {
        started.add('repositories');
        return repositories.promise;
      },
      listBranches() {
        started.add('branches');
        return branches.promise;
      },
      listGists() {
        started.add('gists');
        return gists.promise;
      },
      getGist() {
        started.add('gist');
        return gist.promise;
      },
    },
    2: {},
  };
  const accountController = {
    cancelSignIn() {},
    async getAccessToken() {
      return `token-${account.id}`;
    },
    async getAccount() {
      return account;
    },
    async run(operation) {
      return operation(clients[account.id]);
    },
    secure: true,
    subscribe(callback) {
      listener = callback;
      return () => {};
    },
  };

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin({
        ...harness.dependencies,
        accountController,
      });
      const pending = [
        plugin.listRepositories(),
        plugin.listBranches('account-a', 'repo'),
        plugin.listGists(),
        plugin.listGistFiles('gist-1'),
      ];
      await waitFor(() => started.size === 4);

      account = accountB;
      listener(accountB);
      repositories.resolve([repository('repo', 'account-a', 1)]);
      branches.resolve([{ name: 'main' }]);
      gists.resolve([{ files: {}, id: 'gist-1' }]);
      gist.resolve({ files: { 'old.md': { filename: 'old.md' } } });

      assert.deepEqual(await Promise.all(pending), [[], [], [], []]);
    },
  );
});

test('older Acode migrates its PAT after its first successful request', async () => {
  const harness = createPluginHarness();
  harness.globals.BuildInfo = { versionCode: 972 };
  harness.globals.cordova = {};

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin(harness.dependencies);
      await plugin.init();
      assert.equal(plugin.authenticationMode, 'legacy');
      assert.equal(plugin.token, 'stored-token');
      assert.equal(harness.storedToken, 'stored-token');
      await plugin.listRepositories();
      await waitFor(() => harness.storedToken === null);
      assert.equal(harness.storedToken, null);
      assert.equal(
        harness.encryptedValues.has('acode.plugin.github.github-session-v1'),
        true,
      );
      await plugin.destroy();
    },
  );
});

test('modern Acode defers PAT migration without a native secret context', async () => {
  const harness = createPluginHarness();
  harness.globals.BuildInfo = { versionCode: 973 };
  harness.globals.cordova = {};

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin(harness.dependencies);
      await plugin.init();
      assert.equal(plugin.authenticationMode, 'modern');
      assert.equal(harness.storedToken, 'stored-token');
      await plugin.listRepositories();
      await waitFor(() => harness.storedToken === null);
      assert.equal(harness.storedToken, null);
      assert.equal(
        harness.encryptedValues.has('acode.plugin.github.github-session-v1'),
        true,
      );
      await plugin.destroy();
    },
  );
});

test('modern Acode ignores native secret context during PAT migration', async () => {
  const harness = createPluginHarness();
  const calls = [];
  const ctx = {
    async getSecret() {
      calls.push('get');
      throw new Error('must not be called');
    },
    async setSecret() {
      calls.push('set');
      throw new Error('must not be called');
    },
  };
  harness.globals.BuildInfo = { versionCode: 973 };
  harness.globals.cordova = {};

  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin(harness.dependencies);
      await plugin.init(undefined, { ctx });
      assert.equal(plugin.authenticationMode, 'modern');
      assert.equal(harness.storedToken, 'stored-token');
      await plugin.listRepositories();
      await waitFor(() => harness.storedToken === null);
      assert.equal(harness.storedToken, null);
      assert.deepEqual(calls, []);
      const saved = harness.encryptedValues.get(
        'acode.plugin.github.github-session-v1',
      );
      assert.equal(saved.includes('stored-token'), false);
      await plugin.destroy();
    },
  );
});

test('gist listing, opening, creation, addition, and deletion are characterized', async () => {
  const harness = createPluginHarness();
  await withSourceModule(
    'main.js',
    harness.globals,
    async ({ AcodePlugin }) => {
      const plugin = new AcodePlugin(harness.dependencies);
      await plugin.init();
      const gists = await plugin.listGists(false);
      assert.deepEqual(
        gists.map(({ value }) => value),
        ['gist-1'],
      );
      assert.match(gists[0].text, /Example gist/);

      const files = await plugin.listGistFiles('gist-1', false);
      assert.deepEqual(files, [{ text: 'notes.md', value: 'notes.md' }]);

      harness.paletteSelections.push('notes.md');
      await plugin.openGistFile('gist-1');
      assert.deepEqual(harness.openedFiles.at(-1), {
        name: 'notes.md',
        options: { render: true, uri: 'gh://gist/gist-1/notes.md' },
      });

      harness.multiPromptResults.push({
        description: 'New gist',
        name: 'new.md',
        public: false,
      });
      await plugin.openGistFile(plugin.NEW);
      assert.deepEqual(harness.calls.createGist, [
        {
          description: 'New gist',
          files: { 'new.md': { content: '# New gist' } },
          public: false,
        },
      ]);
      assert.equal(
        harness.openedFiles.at(-1).options.uri,
        'gh://gist/gist-2/new.md',
      );

      harness.paletteSelections.push(plugin.NEW);
      harness.promptResults.push('added.md');
      await plugin.openGistFile('gist-1');
      assert.deepEqual(harness.calls.updateGist.at(-1), {
        id: 'gist-1',
        value: { files: { 'added.md': { content: '# New gist file' } } },
      });
      assert.equal(
        harness.openedFiles.at(-1).options.uri,
        'gh://gist/gist-1/added.md',
      );

      harness.paletteSelections.push('gist-1', 'notes.md');
      await plugin.deleteGistFile();
      assert.deepEqual(harness.calls.updateGist.at(-1), {
        id: 'gist-1',
        value: { files: { 'notes.md': null } },
      });
      assert.deepEqual(
        (await plugin.listGistFiles('gist-1', false)).map(({ value }) => value),
        ['added.md'],
      );

      harness.paletteSelections.push('gist-1');
      await plugin.deleteGist();
      assert.deepEqual(harness.calls.deleteGist, ['gist-1']);
      assert.equal(
        (await plugin.listGists(false)).some(({ value }) => value === 'gist-1'),
        false,
      );
      await plugin.destroy();
    },
  );
});

function createPluginHarness() {
  const registeredCommands = [];
  const removedCommands = [];
  const credentialWrites = [];
  const promptResults = [];
  const promptCalls = [];
  const multiPromptResults = [];
  const paletteSelections = [];
  const openedFiles = [];
  const openedFolders = [];
  const documentListeners = new Map();
  const intentHandlers = new Set();
  const calls = {
    createBranch: [],
    createGist: [],
    deleteGist: [],
    listBranches: 0,
    listRepos: 0,
    updateGist: [],
  };
  let fsExtensions = 0;
  const settings = {
    update() {},
    value: { 'acode.plugin.github': { askCommitMessage: true } },
  };
  const gistFiles = {
    'notes.md': { content: '# Notes', filename: 'notes.md', size: 7 },
  };
  let gistDeleted = false;
  let storedToken = 'stored-token';
  const localValues = new Map();
  const createGitHub = () => ({
    async createBranch(_owner, _repo, from, branch) {
      calls.createBranch.push([from, branch]);
    },
    async createGist(value) {
      calls.createGist.push(value);
      return {
        description: value.description,
        files: { 'new.md': { filename: 'new.md' } },
        id: 'gist-2',
        owner: { login: 'octocat' },
      };
    },
    async deleteGist(id) {
      calls.deleteGist.push(id);
      gistDeleted = true;
    },
    async getAuthenticatedUser() {
      return { avatar_url: null, id: 1, login: 'octocat' };
    },
    async getGist() {
      return { files: gistFiles };
    },
    async listBranches() {
      calls.listBranches += 1;
      return [{ name: 'main' }, { name: 'release' }];
    },
    async listGists() {
      if (gistDeleted) return [];
      return [
        {
          description: 'Example gist',
          files: gistFiles,
          id: 'gist-1',
          owner: { login: 'octocat' },
        },
      ];
    },
    async listRepositories() {
      calls.listRepos += 1;
      return [
        {
          name: 'example',
          owner: { login: 'octocat' },
          visibility: 'private',
        },
      ];
    },
    async updateGist(id, value) {
      calls.updateGist.push({ id, value });
      for (const [filename, file] of Object.entries(value.files || {})) {
        if (file === null) {
          delete gistFiles[filename];
        } else {
          gistFiles[filename] = {
            content: file.content,
            filename,
            size: file.content.length,
          };
        }
      }
    },
  });
  const acode = {
    require(name) {
      const modules = {
        EditorFile: class EditorFile {
          constructor(filename, options) {
            openedFiles.push({ name: filename, options });
          }
        },
        confirm: async () => true,
        encodings: {},
        fs: {
          extend() {
            fsExtensions += 1;
          },
          remove() {},
        },
        fsOperation: () => ({
          stat: async () => ({ name: 'keybindings.json' }),
        }),
        helpers: {
          error(error) {
            throw error;
          },
          removeTitleLoader() {},
          showTitleLoader() {},
          uuid: () => 'phase-one',
        },
        intent: {
          addHandler(handler) {
            intentHandlers.add(handler);
          },
          removeHandler(handler) {
            intentHandlers.delete(handler);
          },
        },
        multiPrompt: async () => multiPromptResults.shift(),
        openFolder: (url, options) => openedFolders.push({ options, url }),
        palette: (_items, select) => select(paletteSelections.shift()),
        prompt: async (...parameters) => {
          promptCalls.push(parameters);
          return promptResults.shift();
        },
        settings,
        toast: null,
        url: { join: joinUrl },
      };
      if (!(name in modules)) return undefined;
      return modules[name];
    },
    setPluginInit() {},
    setPluginUnmount() {},
  };
  const credentialStore = {
    getItem(key) {
      return key === 'github-token'
        ? storedToken
        : localValues.get(key) || null;
    },
    setItem(key, value) {
      if (key === 'github-token') {
        credentialWrites.push([key, value]);
        storedToken = value;
      } else {
        localValues.set(key, value);
      }
    },
    removeItem(key) {
      if (key === 'github-token') storedToken = null;
      else localValues.delete(key);
    },
  };
  const window = {
    toast() {},
  };
  const document = {
    addEventListener(name, listener) {
      if (!documentListeners.has(name)) documentListeners.set(name, new Set());
      documentListeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      documentListeners.get(name)?.delete(listener);
    },
  };

  return {
    calls,
    credentialWrites,
    dependencies: { createGitHub, credentialStore },
    encryptedValues: localValues,
    dispatchDocumentEvent(name) {
      for (const listener of documentListeners.get(name) || []) listener();
    },
    dispatchIntent(event) {
      return [...intentHandlers]
        .map((handler) => handler(event))
        .filter((result) => result?.then);
    },
    get fsExtensions() {
      return fsExtensions;
    },
    globals: {
      KEYBINDING_FILE: 'keybindings.json',
      acode,
      document,
      editorManager: {
        editor: {
          commands: {
            addCommand(command) {
              registeredCommands.push(command.name);
            },
            byName: {},
            removeCommand(name) {
              removedCommands.push(name);
            },
          },
        },
      },
      localStorage: credentialStore,
      strings: {
        'create new branch': 'Create new branch',
        'new branch': 'New branch',
        'use branch': 'Use branch',
        cancelled: 'Cancelled',
        warning: 'Warning',
      },
      window,
    },
    multiPromptResults,
    openedFiles,
    openedFolders,
    paletteSelections,
    promptResults,
    promptCalls,
    registeredCommands,
    removedCommands,
    get storedToken() {
      return storedToken;
    },
  };
}

function setupEvent(value = 'complete') {
  return {
    action: 'setup',
    defaultPrevented: 0,
    module: 'github',
    preventDefault() {
      this.defaultPrevented += 1;
    },
    propagationStopped: 0,
    stopPropagation() {
      this.propagationStopped += 1;
    },
    value,
  };
}

function joinUrl(first, ...rest) {
  const trailingSlash = rest.at(-1) === '/';
  const value = [
    first.replace(/\/+$/, ''),
    ...rest.map((part) => part.replace(/^\/+|\/+$/g, '')),
  ]
    .filter(Boolean)
    .join('/');
  return trailingSlash ? `${value}/` : value;
}

function githubAppAccountController(account, client) {
  return {
    cancelSignIn() {},
    async getAccessToken() {
      return 'token';
    },
    async getAccount() {
      return account;
    },
    async initialize() {
      return account;
    },
    async run(operation) {
      return operation(client);
    },
    secure: true,
    subscribe() {
      return () => {};
    },
  };
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

function indexedRepository(defaultBranch) {
  return {
    default_branch: defaultBranch,
    id: 1,
    name: 'shared',
    owner: { login: 'octocat' },
  };
}

function repository(name, owner, id) {
  return {
    default_branch: 'main',
    id,
    name,
    owner: { login: owner },
    visibility: 'private',
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached');
}
