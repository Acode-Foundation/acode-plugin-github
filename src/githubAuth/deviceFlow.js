import { GitHubAuthError } from './errors';
import { parseTokenResponse } from './tokenResponse';

export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 5;

export class GitHubDeviceFlow {
  #activeController;
  #clientId;
  #now;
  #resumeWaiters = new Set();
  #sleep;
  #transport;

  constructor({ clientId, now = Date.now, sleep = delay, transport }) {
    this.#clientId = clientId;
    this.#now = now;
    this.#sleep = sleep;
    this.#transport = transport;
  }

  cancel() {
    this.#activeController?.abort();
  }

  resume() {
    for (const resume of this.#resumeWaiters) resume();
    this.#resumeWaiters.clear();
  }

  async authorize({ onCode, onState, signal } = {}) {
    if (!this.#clientId) throw new GitHubAuthError('configuration');
    this.cancel();

    const controller = new AbortController();
    this.#activeController = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    try {
      const code = await this.#requestCode(controller.signal);
      this.#throwIfCancelled(controller.signal);
      const expiresAt = this.#now() + code.expiresIn * 1_000;
      await onCode?.({
        expiresAt,
        interval: code.interval,
        userCode: code.userCode,
        verificationUri: code.verificationUri,
      });

      let interval = code.interval * 1_000;
      let nextPollAt = this.#now() + interval;
      while (this.#now() < expiresAt) {
        await this.#waitUntil(nextPollAt, controller.signal);
        this.#throwIfCancelled(controller.signal);
        if (this.#now() >= expiresAt) break;

        let response;
        try {
          response = await this.#transport.postForm(
            ACCESS_TOKEN_URL,
            {
              client_id: this.#clientId,
              device_code: code.deviceCode,
              grant_type: DEVICE_GRANT_TYPE,
            },
            { operation: 'device-token', signal: controller.signal },
          );
        } catch (error) {
          if (error.kind !== 'network') throw error;
          await onState?.('offline');
          nextPollAt = this.#now() + interval;
          continue;
        }
        this.#throwIfCancelled(controller.signal);

        if (response.access_token) {
          return parseTokenResponse(response, this.#now());
        }
        if (response.error === 'authorization_pending') {
          await onState?.('pending');
        } else if (response.error === 'slow_down') {
          interval += SLOW_DOWN_SECONDS * 1_000;
          await onState?.('slow-down');
        } else if (
          response.error === 'expired_token' ||
          response.error === 'bad_verification_code'
        ) {
          throw new GitHubAuthError('expired');
        } else if (response.error === 'access_denied') {
          throw new GitHubAuthError('denied');
        } else if (response.error === 'incorrect_client_credentials') {
          throw new GitHubAuthError('configuration');
        } else {
          throw new GitHubAuthError('malformed-response');
        }
        nextPollAt = this.#now() + interval;
      }

      throw new GitHubAuthError('expired');
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.#activeController === controller) {
        this.#activeController = undefined;
      }
    }
  }

  async #requestCode(signal) {
    let response;
    try {
      response = await this.#transport.postForm(
        DEVICE_CODE_URL,
        { client_id: this.#clientId },
        { operation: 'device-code', signal },
      );
    } catch (error) {
      if (error instanceof GitHubAuthError) throw error;
      throw new GitHubAuthError('network');
    }

    if (response.error === 'incorrect_client_credentials') {
      throw new GitHubAuthError('configuration');
    }
    const expiresIn = numberOrInvalid(response.expires_in);
    const interval =
      response.interval === undefined
        ? DEFAULT_INTERVAL_SECONDS
        : numberOrInvalid(response.interval);
    if (
      !isNonEmptyString(response.device_code) ||
      !isNonEmptyString(response.user_code) ||
      !isHttpsUrl(response.verification_uri) ||
      !expiresIn ||
      !interval
    ) {
      throw new GitHubAuthError('malformed-response');
    }
    return {
      deviceCode: response.device_code,
      expiresIn,
      interval,
      userCode: response.user_code,
      verificationUri: response.verification_uri,
    };
  }

  async #waitUntil(deadline, signal) {
    while (this.#now() < deadline) {
      this.#throwIfCancelled(signal);
      let resume;
      const resumed = new Promise((resolve) => {
        resume = resolve;
        this.#resumeWaiters.add(resolve);
      });
      try {
        await Promise.race([
          this.#sleep(deadline - this.#now(), signal),
          resumed,
        ]);
      } finally {
        this.#resumeWaiters.delete(resume);
      }
    }
  }

  #throwIfCancelled(signal) {
    if (signal.aborted) throw new GitHubAuthError('cancelled');
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new GitHubAuthError('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function numberOrInvalid(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname === '/login/device'
    );
  } catch (_error) {
    return false;
  }
}
