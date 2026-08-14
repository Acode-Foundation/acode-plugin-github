import { GitHubAuthError } from './errors';

const BRIDGE_WAIT_MS = 1_000;
const BRIDGE_POLL_MS = 50;

export class NativeHttpTransport {
  #bridgeWaitMs;
  #http;
  #sleep;

  constructor(
    http,
    { bridgeWaitMs = BRIDGE_WAIT_MS, sleep = waitForDelay } = {},
  ) {
    this.#http = http;
    this.#bridgeWaitMs = bridgeWaitMs;
    this.#sleep = sleep;
  }

  async postForm(url, data, { operation, signal } = {}) {
    const transport = globalThis.cordova ? 'native' : 'web';
    const diagnostic = { operation, transport };
    let http = resolveNativeHttp(this.#http);
    if (
      typeof http?.sendRequest !== 'function' &&
      globalThis.cordova &&
      !this.#http &&
      this.#bridgeWaitMs > 0
    ) {
      http = await this.#waitForHttp(signal);
    }
    if (typeof http?.sendRequest !== 'function') {
      throw new GitHubAuthError(
        globalThis.cordova ? 'network' : 'unavailable',
        diagnostic,
      );
    }
    if (signal?.aborted) throw new GitHubAuthError('cancelled', diagnostic);

    const response = await new Promise((resolve, reject) => {
      let requestId;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const succeed = (value) => {
        cleanup();
        resolve(value);
      };
      const fail = (failure) => {
        cleanup();
        if (
          Number.isInteger(failure?.status) &&
          failure.status >= 400 &&
          failure.status < 500
        ) {
          resolve(failure);
          return;
        }
        reject(
          new GitHubAuthError('network', {
            ...diagnostic,
            nativeCode: failure?.status,
          }),
        );
      };
      const abort = () => {
        if (requestId !== undefined && typeof http.abort === 'function') {
          http.abort(
            requestId,
            () => {},
            () => {},
          );
        }
        cleanup();
        reject(new GitHubAuthError('cancelled', diagnostic));
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        requestId = sendNativeRequest(
          http,
          url,
          {
            data,
            followRedirect: false,
            // The stock HTTP wrapper merges global headers into this object.
            // Keep it mutable and request-local so that merge never throws.
            headers: { Accept: 'application/json' },
            method: 'post',
            responseType: 'text',
            serializer: 'urlencoded',
          },
          succeed,
          fail,
        );
      } catch (error) {
        cleanup();
        reject(
          new GitHubAuthError(
            error instanceof GitHubAuthError ? error.kind : 'internal',
            { ...diagnostic, phase: error?.phase },
          ),
        );
      }
    });

    return parseResponse(response);
  }

  async #waitForHttp(signal) {
    let http = resolveNativeHttp(this.#http);
    const deadline = Date.now() + this.#bridgeWaitMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new GitHubAuthError('cancelled');
      await this.#sleep(
        Math.min(BRIDGE_POLL_MS, Math.max(0, deadline - Date.now())),
        signal,
      );
      http = resolveNativeHttp();
      if (typeof http?.sendRequest === 'function') return http;
    }
    return http;
  }
}

export function resolveNativeHttp(http) {
  return http || globalThis.cordova?.plugin?.http;
}

export function sendNativeRequest(http, url, options, success, failure) {
  const controlsRedirects =
    typeof http?.getFollowRedirect === 'function' &&
    typeof http?.setFollowRedirect === 'function';
  if (!controlsRedirects) {
    if (globalThis.cordova) throw new GitHubAuthError('network');
    return http.sendRequest(url, options, success, failure);
  }

  let previous;
  try {
    previous = http.getFollowRedirect();
  } catch (_error) {
    throw new GitHubAuthError('internal', { phase: 'redirect-read' });
  }
  if (typeof previous !== 'boolean') {
    throw new GitHubAuthError('internal', { phase: 'redirect-read' });
  }
  try {
    http.setFollowRedirect(false);
  } catch (_error) {
    throw new GitHubAuthError('internal', { phase: 'redirect-disable' });
  }

  let requestError;
  let requestId;
  try {
    requestId = http.sendRequest(url, options, success, failure);
  } catch (_error) {
    requestError = new GitHubAuthError('internal', {
      phase: 'request-create',
    });
  }
  try {
    http.setFollowRedirect(previous);
  } catch (_error) {
    if (!requestError) {
      throw new GitHubAuthError('internal', { phase: 'redirect-restore' });
    }
  }
  if (requestError) throw requestError;
  return requestId;
}

function parseResponse(response) {
  if (typeof response?.data === 'object' && response.data !== null) {
    return response.data;
  }
  if (typeof response?.data !== 'string') {
    throw new GitHubAuthError('malformed-response');
  }

  try {
    const data = JSON.parse(response.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new GitHubAuthError('malformed-response');
    }
    return data;
  } catch (error) {
    if (error instanceof GitHubAuthError) throw error;
    throw new GitHubAuthError('malformed-response');
  }
}

function waitForDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new GitHubAuthError('cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
