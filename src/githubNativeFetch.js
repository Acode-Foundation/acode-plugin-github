import { bytesToArrayBuffer, utf8ToBytes } from './encoding';
import { resolveNativeHttp, sendNativeRequest } from './githubAuth/nativeHttp';
import { createGitHubService } from './githubService';

const API_ORIGIN = 'https://api.github.com';
const METHODS = /^(?:GET|POST|PUT|PATCH|DELETE)$/;

export function createNativeGitHubFetch(http = resolveNativeHttp()) {
  if (typeof http?.sendRequest !== 'function') {
    return globalThis.cordova ? unavailableFetch : undefined;
  }

  return (input, init = {}) => {
    return new Promise((resolve, reject) => {
      const url = validateUrl(String(input));
      const method = String(init.method || 'GET').toUpperCase();
      if (!METHODS.test(method)) throw transportError('method');
      const signal = init.signal;
      if (signal?.aborted) throw abortError();
      const data = init.body;
      if (data !== undefined && data !== null && typeof data !== 'string') {
        throw transportError('body');
      }
      if (method === 'DELETE' && data != null) throw transportError('body');

      let requestId;
      const finish = (callback, value) => {
        signal?.removeEventListener('abort', abort);
        callback(value);
      };
      const receive = (response) => {
        const status = Number(response?.status);
        if ([301, 302, 303, 307, 308].includes(status)) {
          finish(reject, transportError('redirect', status));
          return;
        }
        if (!Number.isInteger(status) || status < 100) {
          finish(reject, transportError('network'));
          return;
        }
        finish(resolve, toResponse(response, url.href));
      };
      const abort = () => {
        if (requestId !== undefined && typeof http.abort === 'function') {
          http.abort(
            requestId,
            () => {},
            () => {},
          );
        }
        finish(reject, abortError());
      };

      signal?.addEventListener('abort', abort, { once: true });
      const options = {
        followRedirect: false,
        headers: headersToObject(init.headers),
        method: method.toLowerCase(),
        responseType: 'text',
      };
      if (data != null) {
        options.data = data;
        options.serializer = 'utf8';
      }

      try {
        requestId = sendNativeRequest(
          http,
          url.href,
          options,
          receive,
          receive,
        );
        if (signal?.aborted) abort();
      } catch (error) {
        finish(reject, transportError(error?.kind || 'internal'));
      }
    });
  };
}

export function createGitHubServiceFactory({
  fetch = globalThis.fetch,
  http,
} = {}) {
  return (token) => {
    const nativeFetch = createNativeGitHubFetch(http);
    return createGitHubService(token, {
      fetch: nativeFetch || fetch,
      transport: nativeFetch ? 'native' : 'web',
    });
  };
}

function unavailableFetch() {
  throw transportError('network');
}

function validateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw transportError('host');
  }
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) {
    throw transportError('host');
  }
  return url;
}

function headersToObject(value) {
  const result = {};
  for (const [name, headerValue] of normalizeHeaders(value)) {
    result[name] = headerValue;
  }
  return result;
}

function toResponse(response, url) {
  const status = Number(response.status);
  const empty = status === 204 || status === 205 || status === 304;
  return new NativeResponse(empty ? null : String(response.data ?? ''), {
    headers: response.headers,
    status,
    statusText: response.statusText,
    url,
  });
}

function abortError() {
  const error = new Error('The request was aborted.');
  error.name = 'AbortError';
  return error;
}

function transportError(kind, status) {
  const error = new Error('GitHub transport failed.');
  error.kind = kind;
  error.status = status;
  return error;
}

class NativeHeaders {
  #entries;

  constructor(value) {
    this.#entries = normalizeHeaders(value);
  }

  get(name) {
    const normalizedName = String(name).toLowerCase();
    const entry = this.#entries.find(([key]) => key === normalizedName);
    return entry ? entry[1] : null;
  }

  [Symbol.iterator]() {
    return this.#entries[Symbol.iterator]();
  }
}

class NativeResponse {
  constructor(body, { headers, status, statusText, url }) {
    this.body = body;
    this.bodyUsed = false;
    this.headers = new NativeHeaders(headers);
    this.ok = status >= 200 && status < 300;
    this.redirected = false;
    this.status = status;
    this.statusText = typeof statusText === 'string' ? statusText : '';
    this.type = 'basic';
    this.url = url;
  }

  async text() {
    this.bodyUsed = true;
    return this.body === null ? '' : this.body;
  }

  async arrayBuffer() {
    this.bodyUsed = true;
    return bytesToArrayBuffer(utf8ToBytes(this.body === null ? '' : this.body));
  }

  async json() {
    return JSON.parse(await this.text());
  }
}

function normalizeHeaders(value) {
  if (!value) return [];

  const entries = [];
  const append = (name, headerValue) => {
    const normalizedName = String(name).toLowerCase();
    const normalizedValue = String(headerValue);
    const existing = entries.find(([key]) => key === normalizedName);
    if (existing) {
      existing[1] = `${existing[1]}, ${normalizedValue}`;
    } else {
      entries.push([normalizedName, normalizedValue]);
    }
  };

  if (typeof value.forEach === 'function') {
    value.forEach((headerValue, name) => {
      append(name, headerValue);
    });
    return entries;
  }
  if (typeof value[Symbol.iterator] === 'function') {
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length >= 2) append(entry[0], entry[1]);
    }
    return entries;
  }
  for (const name of Object.keys(value)) append(name, value[name]);
  return entries;
}
