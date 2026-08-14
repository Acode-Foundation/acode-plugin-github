import { GitHubAuthError, isAuthenticationError } from './githubAuth/errors';
import { createGitHubService } from './githubService';

const LEGACY_TOKEN_KEY = 'github-token';
const LEGACY_ACCOUNT = Object.freeze({
  avatarUrl: null,
  id: 'legacy-pat',
  kind: 'pat',
  login: 'GitHub',
  pendingMigration: true,
});

export class GitHubAccountController {
  #account;
  #authManager;
  #credentialEpoch = 0;
  #credentialBarrier = Promise.resolve();
  #createGitHub;
  #legacyMigration;
  #legacyStore;
  #legacyToken = '';
  #listeners = new Set();
  #writeQueue = Promise.resolve();
  #available;

  constructor({
    authManager,
    createGitHub = createGitHubService,
    legacyStore = localStorage,
  } = {}) {
    this.#authManager = authManager;
    this.#createGitHub = createGitHub;
    this.#legacyStore = legacyStore;
    this.#available =
      typeof authManager?.getAccount === 'function' &&
      typeof authManager?.getAccessToken === 'function' &&
      typeof authManager?.usePersonalAccessToken === 'function';
  }

  get secure() {
    return this.mode === 'modern' || this.mode === 'browser';
  }

  get mode() {
    return this.#authManager?.mode || 'modern';
  }

  get legacyToken() {
    return this.#legacyStore?.getItem?.(LEGACY_TOKEN_KEY) || '';
  }

  async initialize() {
    if (!this.#available) throw new GitHubAuthError('unavailable');

    try {
      this.#account = await this.#authManager.getAccount();
    } catch (error) {
      if (error?.kind === 'invalid-session') {
        this.#account = null;
      } else {
        throw error;
      }
    }

    // An encrypted session is authoritative. A legacy token is adopted only
    // when there is no usable encrypted account, avoiding a network request
    // while Cordova is still completing cold-start initialization.
    if (this.#account) {
      this.#removeLegacyToken();
    } else {
      this.#legacyToken = this.legacyToken.trim();
      if (this.#legacyToken) this.#account = LEGACY_ACCOUNT;
    }
    this.#setAccount(this.#account);
    return this.#account;
  }

  async getAccount() {
    if (!this.#available) throw new GitHubAuthError('unavailable');
    if (this.#account !== undefined) return this.#account;
    const account = await this.#authManager.getAccount();
    this.#account = account;
    this.#setAccount(account, false);
    return account;
  }

  async getAccessToken() {
    if (!this.#available) throw new GitHubAuthError('unavailable');
    if (this.#legacyToken) return this.#legacyToken;
    return this.#authManager.getAccessToken();
  }

  async run(operation, { write = false } = {}) {
    if (!this.#available) throw new GitHubAuthError('unavailable');
    if (!write) return this.#runOperation(operation, false);

    const epoch = this.#credentialEpoch;
    const credentialBarrier = this.#credentialBarrier;
    const execute = async () => {
      await credentialBarrier;
      if (epoch !== this.#credentialEpoch) {
        throw new GitHubAuthError('cancelled');
      }
      return this.#runOperation(operation, true);
    };
    const queued = this.#writeQueue.catch(() => {}).then(execute);
    this.#writeQueue = queued.catch(() => {});
    return queued;
  }

  async signInWithGitHub(options) {
    if (
      !this.secure ||
      typeof this.#authManager.signInWithGitHub !== 'function'
    ) {
      throw new GitHubAuthError('unavailable');
    }
    return this.#replaceCredentials(() =>
      this.#authManager.signInWithGitHub(options),
    );
  }

  async usePersonalAccessToken(token) {
    if (!this.#available) throw new GitHubAuthError('unavailable');
    return this.#replaceCredentials(() =>
      this.#authManager.usePersonalAccessToken(token),
    );
  }

  async signOut() {
    if (!this.#available) throw new GitHubAuthError('unavailable');
    this.#credentialEpoch += 1;
    this.#credentialBarrier = Promise.resolve();
    this.#authManager.cancelSignIn?.();
    this.#legacyToken = '';
    this.#account = null;
    let cleanupError;
    try {
      this.#removeLegacyToken();
    } catch (error) {
      cleanupError = error;
    }
    this.#setAccount(null);

    try {
      await this.#authManager.signOut();
    } catch (error) {
      cleanupError ||= error;
    }
    if (cleanupError) throw cleanupError;
  }

  cancelSignIn() {
    this.#authManager?.cancelSignIn?.();
  }

  resume() {
    this.#authManager?.resume?.();
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setAccount(account, notify = true) {
    if (!notify) return;
    for (const listener of this.#listeners) listener(account);
  }

  async #runLegacyOperation(operation, token) {
    let result;
    try {
      result = await operation(this.#createGitHub(token));
    } catch (error) {
      if (isAuthenticationError(error)) {
        this.#credentialEpoch += 1;
        this.#legacyToken = '';
        this.#account = null;
        this.#setAccount(null);
        throw new GitHubAuthError('invalid-token');
      }
      throw error;
    }
    this.#finalizeLegacyToken(token);
    return result;
  }

  #runOperation(operation, write) {
    if (this.#legacyToken) {
      return this.#runLegacyOperation(operation, this.#legacyToken);
    }
    return this.#authManager.runWithToken(
      (token) => operation(this.#createGitHub(token)),
      { retryOnUnauthorized: !write },
    );
  }

  async #replaceCredentials(replace) {
    const epoch = ++this.#credentialEpoch;
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    this.#credentialBarrier = barrier;
    try {
      const account = await replace();
      if (epoch !== this.#credentialEpoch) {
        throw new GitHubAuthError('cancelled');
      }
      this.#legacyToken = '';
      this.#removeLegacyToken();
      this.#account = account;
      this.#setAccount(account);
      return account;
    } finally {
      release();
      if (this.#credentialBarrier === barrier) {
        this.#credentialBarrier = Promise.resolve();
      }
    }
  }

  #finalizeLegacyToken(token) {
    if (this.#legacyMigration || token !== this.#legacyToken) return;
    const epoch = this.#credentialEpoch;
    const migration = this.#authManager
      .usePersonalAccessToken(token)
      .then((account) => {
        if (
          this.#legacyMigration !== migration ||
          epoch !== this.#credentialEpoch ||
          token !== this.#legacyToken
        ) {
          return;
        }
        this.#removeLegacyToken();
        this.#legacyToken = '';
        this.#account = account;
        this.#setAccount(account);
      })
      .catch((error) => {
        if (
          this.#legacyMigration !== migration ||
          epoch !== this.#credentialEpoch ||
          token !== this.#legacyToken ||
          error?.kind !== 'invalid-token'
        ) {
          return;
        }
        this.#credentialEpoch += 1;
        this.#legacyToken = '';
        this.#account = null;
        this.#setAccount(null);
      })
      .finally(() => {
        if (this.#legacyMigration === migration) {
          this.#legacyMigration = undefined;
        }
      });
    this.#legacyMigration = migration;
  }

  #removeLegacyToken() {
    try {
      this.#legacyStore?.removeItem?.(LEGACY_TOKEN_KEY);
    } catch (_error) {
      throw new GitHubAuthError('storage');
    }
  }
}

export function accountKey(account) {
  return account ? `${account.kind}:${account.id}` : 'signed-out';
}
