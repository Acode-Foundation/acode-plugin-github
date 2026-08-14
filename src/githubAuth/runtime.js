import { githubAuthConfig } from './config';
import { GitHubAuthError } from './errors';
import { createDefaultGitHubAuthManager } from './index';
import { GitHubSessionStore } from './sessionStore';

export const MODERN_AUTH_VERSION_CODE = 973;

export function createConfiguredGitHubAuthManager({
  createGitHub,
  credentialStore = globalThis.localStorage,
} = {}) {
  return new GitHubAuthenticationRuntime({ createGitHub, credentialStore });
}

export class GitHubAuthenticationRuntime {
  #createGitHub;
  #credentialStore;
  #manager;
  #mode = 'pending';

  constructor({ createGitHub, credentialStore } = {}) {
    this.#createGitHub = createGitHub;
    this.#credentialStore = credentialStore;
  }

  get mode() {
    return this.#mode;
  }

  configure({
    host = globalThis,
    versionCode = host.BuildInfo?.versionCode ?? host.localStorage?.versionCode,
  } = {}) {
    this.#mode = selectAuthenticationMode({
      cordova: host.cordova,
      versionCode,
    });
    const encryptedStore = new GitHubSessionStore({
      storage: this.#credentialStore,
    });
    const store =
      this.#mode === 'legacy'
        ? new PersonalAccessTokenSessionStore(encryptedStore)
        : encryptedStore;
    this.#manager = createDefaultGitHubAuthManager(githubAuthConfig, {
      createGitHub: this.#createGitHub,
      store,
    });
    return this.#mode;
  }

  cancelSignIn() {
    return this.#delegate().cancelSignIn?.();
  }

  resume() {
    return this.#delegate().resume?.();
  }

  getAccount() {
    return this.#delegate().getAccount();
  }

  getAccessToken() {
    return this.#delegate().getAccessToken();
  }

  runWithToken(operation, options) {
    return this.#delegate().runWithToken(operation, options);
  }

  signInWithGitHub(options) {
    if (this.#mode === 'legacy') {
      return Promise.reject(new GitHubAuthError('unavailable'));
    }
    return this.#delegate().signInWithGitHub(options);
  }

  usePersonalAccessToken(token) {
    return this.#delegate().usePersonalAccessToken(token);
  }

  signOut() {
    return this.#delegate().signOut();
  }

  #delegate() {
    if (!this.#manager) throw new GitHubAuthError('unavailable');
    return this.#manager;
  }
}

export function selectAuthenticationMode({ cordova, versionCode }) {
  if (!cordova) return 'browser';
  const parsedVersion = Number.parseInt(versionCode, 10);
  return Number.isFinite(parsedVersion) &&
    parsedVersion < MODERN_AUTH_VERSION_CODE
    ? 'legacy'
    : 'modern';
}

class PersonalAccessTokenSessionStore {
  #store;

  constructor(store) {
    this.#store = store;
  }

  async load() {
    const session = await this.#store.load();
    return session?.kind === 'pat' ? session : null;
  }

  save(session) {
    if (session?.kind !== 'pat') {
      return Promise.reject(new GitHubAuthError('unavailable'));
    }
    return this.#store.save(session);
  }

  clear() {
    return this.#store.clear();
  }
}
