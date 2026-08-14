import { createGitHubService } from '../githubService';
import { ACCESS_TOKEN_URL } from './deviceFlow';
import { GitHubAuthError, isAuthenticationError } from './errors';
import { GITHUB_SESSION_VERSION } from './sessionStore';
import { parseTokenResponse } from './tokenResponse';

export const REFRESH_GRANT_TYPE = 'refresh_token';
export const REFRESH_WINDOW_MS = 5 * 60 * 1_000;

export class GitHubAuthManager {
  #clientId;
  #createGitHub;
  #deviceFlow;
  #epoch = 0;
  #loadState;
  #now;
  #refreshState;
  #session;
  #store;
  #storeQueue = Promise.resolve();
  #transport;

  constructor({
    clientId,
    createGitHub = createGitHubService,
    deviceFlow,
    now = Date.now,
    store,
    transport,
  }) {
    this.#clientId = clientId;
    this.#createGitHub = createGitHub;
    this.#deviceFlow = deviceFlow;
    this.#now = now;
    this.#store = store;
    this.#transport = transport;
  }

  cancelSignIn() {
    this.#deviceFlow?.cancel();
  }

  resume() {
    this.#deviceFlow?.resume();
  }

  async getAccount() {
    const session = await this.#getSession();
    return session ? publicAccount(session) : null;
  }

  async getAccessToken() {
    let session = await this.#getSession();
    if (!session) throw new GitHubAuthError('invalid-token');
    if (
      session.kind === 'github-app' &&
      session.accessExpiresAt !== null &&
      session.accessExpiresAt <= this.#now() + REFRESH_WINDOW_MS
    ) {
      session = await this.#refresh();
    }
    return session.accessToken;
  }

  async signInWithGitHub(options) {
    const epoch = this.#beginReplacement();
    const tokens = await this.#deviceFlow.authorize(options);
    this.#assertCurrent(epoch);
    const account = await this.#validateToken(tokens.accessToken);
    this.#assertCurrent(epoch);
    const session = createSession('github-app', tokens, account);
    await this.#commitSession(session, epoch);
    return publicAccount(session);
  }

  async usePersonalAccessToken(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      throw new GitHubAuthError('invalid-token');
    }
    const epoch = this.#beginReplacement();
    const token = accessToken.trim();
    const account = await this.#validateToken(token);
    this.#assertCurrent(epoch);
    const session = createSession(
      'pat',
      {
        accessExpiresAt: null,
        accessToken: token,
        refreshExpiresAt: null,
        refreshToken: null,
      },
      account,
    );
    await this.#commitSession(session, epoch);
    return publicAccount(session);
  }

  async runWithToken(operation, { retryOnUnauthorized = true } = {}) {
    const accessToken = await this.getAccessToken();
    const operationEpoch = this.#epoch;
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!isAuthenticationError(error)) throw error;
      if (operationEpoch !== this.#epoch) {
        throw new GitHubAuthError('invalid-token');
      }
      const failureEpoch = operationEpoch;
      const session = await this.#getSession();
      if (session?.kind !== 'github-app') {
        if (session?.kind === 'pat') {
          await this.#invalidateCurrentSession(failureEpoch);
        }
        throw new GitHubAuthError('invalid-token');
      }

      const refreshed = await this.#refresh(true);
      if (!retryOnUnauthorized) {
        throw new GitHubAuthError('invalid-token');
      }
      const retryEpoch = this.#epoch;
      try {
        return await operation(refreshed.accessToken);
      } catch (retryError) {
        if (!isAuthenticationError(retryError)) throw retryError;
        if (retryEpoch !== this.#epoch) {
          throw new GitHubAuthError('invalid-token');
        }
        await this.#invalidateCurrentSession(retryEpoch);
        throw new GitHubAuthError('refresh-revoked');
      }
    }
  }

  async signOut() {
    this.#epoch += 1;
    this.#deviceFlow?.cancel();
    this.#session = null;
    await this.#enqueueStore(() => this.#store.clear());
  }

  async #getSession() {
    if (this.#session !== undefined) return this.#session;
    const epoch = this.#epoch;
    if (this.#loadState?.epoch !== epoch) {
      const state = { epoch };
      state.promise = this.#store
        .load()
        .then((session) => {
          if (this.#epoch !== epoch) return this.#session ?? null;
          if (this.#session === undefined) this.#session = session;
          return this.#session;
        })
        .finally(() => {
          if (this.#loadState === state) this.#loadState = undefined;
        });
      this.#loadState = state;
    }
    return this.#loadState.promise;
  }

  async #refresh(force = false) {
    const session = await this.#getSession();
    const epoch = this.#epoch;
    if (session?.kind !== 'github-app') {
      throw new GitHubAuthError('invalid-token');
    }
    if (this.#refreshState?.epoch === epoch) return this.#refreshState.promise;
    if (
      !force &&
      (session.accessExpiresAt === null ||
        session.accessExpiresAt > this.#now() + REFRESH_WINDOW_MS)
    ) {
      return session;
    }

    const state = { epoch };
    state.promise = this.#performRefresh(session, epoch).finally(() => {
      if (this.#refreshState === state) this.#refreshState = undefined;
    });
    this.#refreshState = state;
    return state.promise;
  }

  async #performRefresh(session, epoch) {
    this.#assertCurrent(epoch);
    if (
      !session.refreshToken ||
      (session.refreshExpiresAt !== null &&
        session.refreshExpiresAt <= this.#now())
    ) {
      await this.#invalidateCurrentSession(epoch);
      throw new GitHubAuthError('refresh-revoked');
    }

    let response;
    try {
      response = await this.#transport.postForm(
        ACCESS_TOKEN_URL,
        {
          client_id: this.#clientId,
          grant_type: REFRESH_GRANT_TYPE,
          refresh_token: session.refreshToken,
        },
        { operation: 'token-refresh' },
      );
    } catch (error) {
      if (error instanceof GitHubAuthError) throw error;
      throw new GitHubAuthError('network');
    }
    this.#assertCurrent(epoch);

    if (response.error === 'bad_refresh_token') {
      await this.#invalidateCurrentSession(epoch);
      throw new GitHubAuthError('refresh-revoked');
    }
    if (response.error === 'incorrect_client_credentials') {
      throw new GitHubAuthError('configuration');
    }
    if (response.error) throw new GitHubAuthError('malformed-response');

    const tokens = parseTokenResponse(response, this.#now());
    let account;
    try {
      account = await this.#validateToken(tokens.accessToken);
    } catch (error) {
      if (error.kind === 'invalid-token') {
        await this.#invalidateCurrentSession(epoch);
        throw new GitHubAuthError('refresh-revoked');
      }
      throw error;
    }
    this.#assertCurrent(epoch);

    const rotated = createSession('github-app', tokens, account);
    await this.#commitSession(rotated, epoch);
    return rotated;
  }

  #beginReplacement() {
    this.#epoch += 1;
    this.#deviceFlow?.cancel();
    return this.#epoch;
  }

  #assertCurrent(epoch) {
    if (epoch !== this.#epoch) throw new GitHubAuthError('cancelled');
  }

  async #commitSession(session, epoch) {
    this.#assertCurrent(epoch);
    await this.#enqueueStore(async () => {
      this.#assertCurrent(epoch);
      await this.#store.save(session);
      if (epoch === this.#epoch) this.#session = session;
    });
    this.#assertCurrent(epoch);
  }

  async #invalidateCurrentSession(epoch) {
    this.#assertCurrent(epoch);
    await this.signOut();
  }

  #enqueueStore(operation) {
    const queued = this.#storeQueue.catch(() => {}).then(operation);
    this.#storeQueue = queued.catch(() => {});
    return queued;
  }

  async #validateToken(accessToken) {
    try {
      return await this.#createGitHub(accessToken).getAuthenticatedUser();
    } catch (error) {
      if (isAuthenticationError(error)) {
        throw new GitHubAuthError('invalid-token');
      }
      throw error;
    }
  }
}

function createSession(kind, tokens, account) {
  if (
    ((typeof account?.id !== 'number' || !Number.isFinite(account.id)) &&
      typeof account?.id !== 'string') ||
    typeof account?.login !== 'string' ||
    account.login.length === 0 ||
    (account.avatar_url !== null &&
      account.avatar_url !== undefined &&
      typeof account.avatar_url !== 'string')
  ) {
    throw new GitHubAuthError('malformed-response');
  }
  return {
    accessExpiresAt: tokens.accessExpiresAt,
    accessToken: tokens.accessToken,
    accountId: account.id,
    avatarUrl: account.avatar_url || null,
    kind,
    login: account.login,
    refreshExpiresAt: tokens.refreshExpiresAt,
    refreshToken: tokens.refreshToken,
    version: GITHUB_SESSION_VERSION,
  };
}

function publicAccount(session) {
  return {
    avatarUrl: session.avatarUrl,
    id: session.accountId,
    kind: session.kind,
    login: session.login,
  };
}
