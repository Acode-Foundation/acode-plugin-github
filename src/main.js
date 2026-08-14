import plugin from '../plugin.json';
import { accountKey, GitHubAccountController } from './githubAccount';
import { githubAuthConfig } from './githubAuth/config';
import { createConfiguredGitHubAuthManager } from './githubAuth/runtime';
import {
  deduplicateRepositories,
  GitHubDataStore,
  orderBranches,
} from './githubDataStore';
import githubFs from './githubFs';
import { GitHubLauncher } from './githubLauncher';
import { createGitHubServiceFactory } from './githubNativeFetch';
import { GitHubPage } from './githubPage';

const prompt = acode.require('prompt');
const confirm = acode.require('confirm');
const palette = acode.require('palette') || acode.require('pallete');
const helpers = acode.require('helpers');
const multiPrompt = acode.require('multiPrompt');
const openFolder = acode.require('openFolder');
const EditorFile = acode.require('EditorFile');
const appSettings = acode.require('settings');

if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(this);
    });
  };
}

export class AcodePlugin {
  token = '';
  NEW = `${helpers.uuid()}_NEW`;
  #fsInitialized = false;
  #account;
  #accountGeneration = 0;
  #accountRequest;
  #createGitHub;
  #createGitHubLauncher;
  #createGitHubPage;
  #currentAccountKey;
  #data;
  #authManager;
  #githubLauncher;
  #repositoryIndex = new Map();
  #resumeAuth;
  #githubPage;
  #startupError;
  #unsubscribeAccount;

  constructor({
    accountController,
    authManager,
    createGitHub = createGitHubServiceFactory(),
    createGitHubLauncher = (options) => new GitHubLauncher(options),
    createGitHubPage = (options) => new GitHubPage(options),
    credentialStore = localStorage,
    dataStore = new GitHubDataStore(),
    intent,
  } = {}) {
    this.#authManager =
      authManager === undefined
        ? createConfiguredGitHubAuthManager({
            createGitHub,
            credentialStore,
          })
        : authManager;
    this.#createGitHub = createGitHub;
    this.#createGitHubLauncher = createGitHubLauncher;
    this.#createGitHubPage = createGitHubPage;
    this.#account =
      accountController ||
      new GitHubAccountController({
        authManager: this.#authManager,
        createGitHub,
        legacyStore: credentialStore,
      });
    this.#data = dataStore;
    this.#resumeAuth = () => this.#handleResume();
    this.#resumeAuth.intent = (event) => {
      if (
        event?.module !== 'github' ||
        event.action !== 'setup' ||
        String(event.value || '').split('?', 1)[0] !== 'complete'
      ) {
        return;
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      return this.refreshRepositoryAccess().catch(helpers.error);
    };
    this.#resumeAuth.module = intent;
    this.#unsubscribeAccount = this.#account.subscribe((account) => {
      this.#startupError = undefined;
      const generation = ++this.#accountGeneration;
      this.#currentAccountKey = accountKey(account);
      this.token = '';
      this.#data.setAccount(account, generation);
      this.#clearIndexes();
      this.#resolveAccountRequest(account);
      this.#githubPage?.accountChanged(generation);
    });
  }

  async init(page, { firstInit = false } = {}) {
    this.#authManager?.configure?.();
    this.commands.forEach((command) => {
      editorManager.editor.commands.addCommand(command);
    });

    let account;
    try {
      account = await this.#account.initialize();
      this.token = await this.#account.getAccessToken().catch(() => '');
    } catch (error) {
      this.#startupError = error;
      this.token = '';
    }
    this.#currentAccountKey = accountKey(account);
    this.#data.setAccount(account, this.#accountGeneration);
    this.#resumeAuth.module ||= acode.require('intent');
    this.#resumeAuth.module?.addHandler?.(this.#resumeAuth.intent);
    await this.initFs();
    this.#githubPage = this.#createGitHubPage({
      config: githubAuthConfig,
      onHide: () => this.#githubLauncher?.pageHidden(),
      plugin: this,
    });
    this.#githubPage.install(page);
    this.#githubLauncher = this.#createGitHubLauncher({
      open: () => this.openGitHub(),
    });
    this.#githubLauncher.install();
    if (this.#authManager || this.#githubPage.installed) {
      globalThis.document?.addEventListener('resume', this.#resumeAuth);
      globalThis.document?.addEventListener(
        'visibilitychange',
        this.#resumeAuth,
      );
    }

    await this.#githubPage.showFirstUse(firstInit);
  }

  async initFs() {
    if (this.#fsInitialized) return;
    githubFs.remove();
    githubFs(this.getToken.bind(this), this.settings, {
      createGitHub: this.#createGitHub,
      runGitHub: this.#runGitHub.bind(this),
    });
    this.#fsInitialized = true;
  }

  async getToken() {
    try {
      this.token = await this.#account.getAccessToken();
      return this.token;
    } catch (error) {
      if (error?.kind !== 'invalid-token') throw error;
    }

    if (
      this.secureCredentialsAvailable &&
      (await this.#githubPage?.openAccount())
    ) {
      await this.#waitForAccount();
    } else {
      await this.updateToken({ forcePrompt: true });
    }
    this.token = await this.#account.getAccessToken();
    return this.token;
  }

  async destroy() {
    githubFs.remove();
    this.#account.cancelSignIn();
    this.#rejectAccountRequest(new Error('GitHub sign-in was cancelled.'));
    this.#githubPage?.destroy();
    this.#githubLauncher?.destroy();
    this.#unsubscribeAccount?.();
    this.#resumeAuth.module?.removeHandler?.(this.#resumeAuth.intent);
    globalThis.document?.removeEventListener('resume', this.#resumeAuth);
    globalThis.document?.removeEventListener(
      'visibilitychange',
      this.#resumeAuth,
    );
    this.commands.forEach((command) => {
      editorManager.editor.commands.removeCommand(command.name);
    });
  }

  async openRepo() {
    await this.initFs();
    this.token = await this.getToken();
    palette(
      this.listRepositories.bind(this),
      this.selectBranch.bind(this),
      'Type to search repository',
    );
  }

  async selectBranch(repo) {
    const [user, repoName] = repo.split('/');
    palette(
      this.listBranches.bind(this, user, repoName),
      (branch) =>
        this.openRepoAsFolder(user, repoName, branch).catch(helpers.error),
      'Type to search branch',
    );
  }

  async deleteGist() {
    await this.initFs();
    const gist = await new Promise((resolve) => {
      palette(this.listGists.bind(this, false), resolve, 'Type to search gist');
    });
    await this.deleteGistById(gist);
  }

  async deleteGistById(gist) {
    const confirmation = await confirm(strings.warning, 'Delete this gist?');
    if (!confirmation) return false;
    await this.#runGitHub((client) => client.deleteGist(gist), { write: true });
    this.#data.invalidate('gists');
    window.toast('Gist deleted');
    this.#githubPage?.invalidate('gists');
    return true;
  }

  async deleteGistFile() {
    await this.initFs();
    const gist = await new Promise((resolve) => {
      palette(this.listGists.bind(this, false), resolve, 'Type to search gist');
    });

    const file = await new Promise((resolve) => {
      palette(
        this.listGistFiles.bind(this, gist, false),
        resolve,
        'Type to search file',
      );
    });

    await this.deleteGistFileById(gist, file);
  }

  async deleteGistFileById(gist, file) {
    const confirmation = await confirm(strings.warning, 'Delete this file?');
    if (!confirmation) return false;
    await this.#runGitHub(
      (client) =>
        client.updateGist(gist, {
          files: { [file]: null },
        }),
      { write: true },
    );
    this.#data.invalidate(`gist:${gist}`);
    this.#data.invalidate('gists');
    window.toast('File deleted');
    this.#githubPage?.invalidate('gists');
    return true;
  }

  async openRepoAsFolder(user, repoName, branch) {
    const cachedRepo = this.#getRepo(user, repoName);
    if (branch === this.NEW) {
      const { from, branch: newBranch } = await multiPrompt(
        strings['create new branch'],
        [
          {
            id: 'from',
            placeholder: strings['use branch'],
            hints: (setHints) => {
              setHints(cachedRepo.branches);
            },
            type: 'text',
          },
          {
            id: 'branch',
            placeholder: strings['new branch'],
            type: 'text',
            match: /^[a-z\-_0-9]+$/i,
          },
        ],
      );
      branch = newBranch;
      await this.#runGitHub(
        (client) => client.createBranch(user, repoName, from, newBranch),
        { write: true },
      );
      this.#data.invalidate(`branches:${user}/${repoName}`);
    }

    if (branch === '..') {
      this.openRepo();
      return;
    }

    const url = githubFs.constructUrl('repo', user, repoName, '/', branch);
    openFolder(url, {
      name: `${user}/${repoName}/${branch}`,
      saveState: false,
    });
  }

  async openGist() {
    await this.initFs();
    this.token = await this.getToken();

    palette(
      this.listGists.bind(this),
      this.openGistFile.bind(this),
      'Type to search gist',
    );
  }

  async openGistFile(gist) {
    let url;
    let thisFilename;
    if (gist === this.NEW) {
      const result = await multiPrompt('New gist', [
        {
          id: 'description',
          placeholder: 'Description',
          type: 'text',
        },
        {
          id: 'name',
          placeholder: 'File name*',
          type: 'text',
          required: true,
        },
        [
          'Visibility',
          {
            id: 'public',
            name: 'visibility',
            value: true,
            placeholder: 'Public',
            type: 'radio',
          },
          {
            id: 'private',
            name: 'visibility',
            value: false,
            placeholder: 'Private',
            type: 'radio',
          },
        ],
      ]).catch(() => {
        window.toast(strings.cancelled);
        return null;
      });
      if (!result) return;
      const { description, name, public: isPublic } = result;

      helpers.showTitleLoader();
      const data = await this.#runGitHub(
        (client) =>
          client.createGist({
            description,
            public: isPublic,
            files: {
              [name]: {
                content: '# New gist',
              },
            },
          }),
        { write: true },
      );
      this.#data.invalidate('gists');
      thisFilename = name;
      url = githubFs.constructUrl('gist', data.id, name);
      helpers.removeTitleLoader();
    } else {
      await new Promise((resolve) => {
        palette(
          this.listGistFiles.bind(this, gist),
          async (file) => {
            if (file === this.NEW) {
              const filename = await prompt('Enter file name', '', 'text', {
                required: true,
                placeholder: 'filename',
              });
              if (!filename) {
                window.toast(strings.cancelled);
              }
              helpers.showTitleLoader();
              await this.#runGitHub(
                (client) =>
                  client.updateGist(gist, {
                    files: {
                      [filename]: {
                        content: '# New gist file',
                      },
                    },
                  }),
                { write: true },
              );
              this.#data.invalidate(`gist:${gist}`);
              this.#data.invalidate('gists');
              helpers.removeTitleLoader();
              thisFilename = filename;
              url = githubFs.constructUrl('gist', gist, filename);
              resolve();
              return;
            }

            url = githubFs.constructUrl('gist', gist, file);
            thisFilename = file;
            resolve();
          },
          'Type to search gist file',
        );
      });
    }

    new EditorFile(thisFilename, {
      uri: url,
      render: true,
    });
  }

  async updateToken({ forcePrompt = false } = {}) {
    if (
      !forcePrompt &&
      this.secureCredentialsAvailable &&
      (await this.#githubPage?.openAccount())
    ) {
      return;
    }
    await this.promptForPersonalAccessToken();
  }

  async promptForPersonalAccessToken() {
    const result = await prompt('Enter GitHub token', '', 'password', {
      required: true,
      placeholder: 'token',
    });

    if (!result) return false;
    await this.usePersonalAccessToken(result);
    return true;
  }

  async listRepositories() {
    const data = await this.getRepositories();
    return data.map((repo) => {
      const { name, owner, visibility } = repo;
      return {
        text: `<div style="display: flex; flex-direction: column;">
        <strong data-str="${escapeHtml(owner.login)}" style="font-size: 1rem;">${escapeHtml(name)}</strong>
        <span style="font-size: 0.8rem; opacity: 0.8;">${escapeHtml(visibility || '')}</span>
      <div>`,
        value: `${owner.login}/${name}`,
      };
    });
  }

  async getRepositories({ force = false } = {}) {
    await this.getToken();
    const generation = this.#accountGeneration;
    const account = await this.#account.getAccount();
    if (generation !== this.#accountGeneration) return [];
    const requestedAccountKey = accountKey(account);
    this.#currentAccountKey ??= requestedAccountKey;
    this.#data.setAccount(account, generation);
    const repositories = await this.#data.get(
      'repositories',
      async () => {
        let repositories;
        if (account?.kind === 'github-app') {
          const installations = await this.getInstallations({ force });
          const lists = await Promise.all(
            installations.map(async (installation) => {
              const values = await this.#runGitHub((client) =>
                client.listInstallationRepositories(installation.id),
              );
              return values.map((repository) => ({
                ...repository,
                installation,
              }));
            }),
          );
          repositories = lists.flat();
        } else {
          repositories = await this.#runGitHub((client) =>
            client.listRepositories(),
          );
        }
        return deduplicateRepositories(repositories);
      },
      { force },
    );
    if (generation !== this.#accountGeneration) return [];
    if (requestedAccountKey === this.#currentAccountKey) {
      this.#repositoryIndex = new Map(
        repositories.map((repository) => [
          `${repository.owner.login}/${repository.name}`,
          repository,
        ]),
      );
    }
    return repositories;
  }

  async getInstallations({ force = false } = {}) {
    const generation = this.#accountGeneration;
    const account = await this.#account.getAccount();
    if (generation !== this.#accountGeneration) return [];
    if (account?.kind !== 'github-app') return [];
    const installations = await this.#data.get(
      'installations',
      () => this.#runGitHub((client) => client.listInstallations()),
      { force },
    );
    return generation === this.#accountGeneration ? installations : [];
  }

  async listBranches(user, repoName) {
    const generation = this.#accountGeneration;
    const data = await this.getBranches(user, repoName);
    if (generation !== this.#accountGeneration) return [];
    const list = data.map((branch) => ({
      text: branch.name,
      value: branch.name,
    }));

    list.push({
      text: 'New branch',
      value: this.NEW,
    });

    list.unshift({
      text: '..',
      value: '..',
    });

    return list;
  }

  async getBranches(user, repoName, { force = false } = {}) {
    const generation = this.#accountGeneration;
    const requestedAccountKey = this.#currentAccountKey;
    const branches = await this.#data.get(
      `branches:${user}/${repoName}`,
      () => this.#runGitHub((client) => client.listBranches(user, repoName)),
      { force },
    );
    if (generation !== this.#accountGeneration) return [];
    const repository =
      requestedAccountKey === this.#currentAccountKey
        ? this.#getRepo(user, repoName)
        : undefined;
    if (repository) {
      repository.branches = branches.map((branch) => ({
        text: branch.name,
        value: branch.name,
      }));
    }
    const defaultBranch = repository?.default_branch;
    return orderBranches(branches, defaultBranch);
  }

  async listGists(showAddNew = true) {
    const generation = this.#accountGeneration;
    const data = await this.getGists();
    if (generation !== this.#accountGeneration) return [];
    const list = data.map((gist) => this.#formatGist(gist));

    if (showAddNew) {
      list.push({
        text: this.#highlightedText('New gist'),
        value: this.NEW,
      });
    }

    return list;
  }

  async listGistFiles(gistId, showAddNew = true) {
    const generation = this.#accountGeneration;
    const files = await this.getGistFiles(gistId);
    if (generation !== this.#accountGeneration) return [];
    const list = files.map((filename) => ({
      text: filename,
      value: filename,
    }));

    if (showAddNew) {
      list.push({
        text: this.#highlightedText('New file'),
        value: this.NEW,
      });
    }

    return list;
  }

  async getGists({ force = false } = {}) {
    const generation = this.#accountGeneration;
    const gists = await this.#data.get(
      'gists',
      () => this.#runGitHub((client) => client.listGists()),
      { force },
    );
    return generation === this.#accountGeneration ? gists : [];
  }

  async getGistFiles(gistId, { force = false } = {}) {
    const generation = this.#accountGeneration;
    const gist = await this.#data.get(
      `gist:${gistId}`,
      () => this.#runGitHub((client) => client.getGist(gistId)),
      { force },
    );
    if (generation !== this.#accountGeneration) return [];
    return Object.values(gist.files || {}).map(({ filename }) => filename);
  }

  openGistFileEntry(gistId, filename) {
    const url = githubFs.constructUrl('gist', gistId, filename);
    new EditorFile(filename, { uri: url, render: true });
  }

  #highlightedText(text) {
    return `<span style='text-transform: uppercase; color: var(--popup-active-color)'>${text}</span>`;
  }

  #formatGist(gist) {
    const { description, owner, files } = gist;
    const file = Object.values(files)[0];
    const login = owner?.login || 'GitHub';
    return {
      text: `<div style="display: flex; flex-direction: column;">
    <strong data-str="${escapeHtml(login)}" style="font-size: 1rem;">${escapeHtml(description || file?.filename || 'Untitled gist')}</strong>
  <div>`,
      value: gist.id,
    };
  }

  #getRepo(user, repoName) {
    return this.#repositoryIndex.get(`${user}/${repoName}`);
  }

  async getAccount() {
    return this.#account.getAccount();
  }

  get secureCredentialsAvailable() {
    return this.#account.secure;
  }

  get authenticationMode() {
    return this.#account.mode;
  }

  get accountGeneration() {
    return this.#accountGeneration;
  }

  get startupError() {
    return this.#startupError;
  }

  async signInWithGitHub(options) {
    return this.#account.signInWithGitHub(options);
  }

  async usePersonalAccessToken(token) {
    const account = await this.#account.usePersonalAccessToken(token);
    this.token = await this.#account.getAccessToken();
    this.#fsInitialized = false;
    await this.initFs();
    return account;
  }

  async signOut() {
    await this.#account.signOut();
    this.token = '';
    this.#fsInitialized = false;
    this.clearCache();
    await this.initFs();
  }

  cancelSignIn() {
    this.#account.cancelSignIn();
    this.#rejectAccountRequest(new Error('GitHub sign-in was cancelled.'));
  }

  clearCache() {
    this.#data.clear();
    this.#clearIndexes();
    this.#githubPage?.invalidate();
  }

  refreshRepositoryAccess() {
    if (this.#resumeAuth.refresh) return this.#resumeAuth.refresh;
    this.#resumeAuth.refresh = (async () => {
      this.#data.invalidate('installations');
      this.#data.invalidate('repositories');
      this.#repositoryIndex.clear();
      await this.openGitHub('repositories');
      await this.#githubPage?.handleResume(true);
    })().finally(() => {
      this.#resumeAuth.refresh = undefined;
    });
    return this.#resumeAuth.refresh;
  }

  async refreshData() {
    this.clearCache();
    const [repositories, gists] = await Promise.allSettled([
      this.getRepositories({ force: true }),
      this.getGists({ force: true }),
    ]);
    return { gists, repositories };
  }

  async #runGitHub(operation, options) {
    await this.getToken();
    return this.#account.run(operation, options);
  }

  #clearIndexes() {
    this.#repositoryIndex.clear();
  }

  #handleResume() {
    this.#account.resume();
    this.#githubPage?.handleResume();
  }

  openGitHub(view) {
    return this.#githubPage?.open(view) || false;
  }

  #waitForAccount() {
    if (this.#accountRequest) return this.#accountRequest.promise;
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#accountRequest = { promise, reject, resolve };
    return promise;
  }

  #resolveAccountRequest(account) {
    if (!account || !this.#accountRequest) return;
    this.#accountRequest.resolve(account);
    this.#accountRequest = undefined;
  }

  #rejectAccountRequest(error) {
    if (!this.#accountRequest) return;
    this.#accountRequest.reject(error);
    this.#accountRequest = undefined;
  }

  get commands() {
    return [
      {
        name: 'github:open',
        description: 'GitHub',
        exec: this.openGitHub.bind(this),
      },
      {
        name: 'github:repository:selectrepo',
        description: 'Open repository',
        exec: this.openRepo.bind(this),
      },
      {
        name: 'github:gist:opengist',
        description: 'Open gist',
        exec: this.openGist.bind(this),
      },
      {
        name: 'github:gist:deletegist',
        description: 'Delete gist',
        exec: this.deleteGist.bind(this),
      },
      {
        name: 'github:gist:deletegistfile',
        description: 'Delete gist file',
        exec: this.deleteGistFile.bind(this),
      },
      {
        name: 'github:updatetoken',
        description: 'GitHub account',
        exec: this.updateToken.bind(this),
      },
      {
        name: 'github:clearcache',
        description: 'Clear github cache',
        exec: this.clearCache.bind(this),
      },
    ];
  }

  get settings() {
    const settings = appSettings.value[plugin.id];
    if (!settings) {
      appSettings.value[plugin.id] = {
        askCommitMessage: true,
      };
      appSettings.update();
    }
    return appSettings.value[plugin.id];
  }

  get settingsJson() {
    const list = [
      {
        key: 'askCommitMessage',
        text: 'Ask for commit message',
        checkbox: this.settings.askCommitMessage,
      },
    ];

    return {
      list,
      cb: (key, value) => {
        this.settings[key] = value;
        appSettings.update();
      },
    };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

if (window.acode) {
  const acodePlugin = new AcodePlugin();
  acode.setPluginInit(
    plugin.id,
    async (baseUrl, $page, { cacheFileUrl, cacheFile, firstInit }) => {
      if (!baseUrl.endsWith('/')) {
        baseUrl += '/';
      }
      acodePlugin.baseUrl = baseUrl;
      await acodePlugin.init($page, {
        cacheFile,
        cacheFileUrl,
        firstInit,
      });
    },
    acodePlugin.settingsJson,
  );
  acode.setPluginUnmount(plugin.id, () => {
    acodePlugin.destroy();
  });
}
