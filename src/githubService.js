import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { utf8ToBytes } from './encoding';

export const GITHUB_ACCEPT = 'application/vnd.github+json';
export const GITHUB_API_VERSION = '2026-03-10';

const ERROR_MESSAGES = {
  authentication: 'GitHub authentication failed.',
  conflict: 'The GitHub resource changed before the operation completed.',
  internal: 'Acode could not process the GitHub response.',
  network: 'GitHub could not be reached.',
  'not-found': 'The requested GitHub resource was not found.',
  permission: 'GitHub denied permission for this operation.',
  'rate-limit': 'GitHub rate limit exceeded.',
  validation: 'GitHub rejected the request.',
};

const silentLog = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const PaginatingOctokit = Octokit.plugin(paginateRest);

export class GitHubError extends Error {
  constructor(
    kind,
    {
      operation,
      recoveryUrl,
      requiredPermissions,
      retryAt,
      status,
      transport,
    } = {},
  ) {
    super(ERROR_MESSAGES[kind] || ERROR_MESSAGES.network);
    this.name = 'GitHubError';
    this.kind = kind;
    this.code = `github/${kind}`;
    this.status = status;
    this.operation = operation;
    this.transport = transport;
    this.retryAt = retryAt;
    this.recoveryUrl = recoveryUrl;
    this.requiredPermissions = requiredPermissions;
  }
}

export function normalizeGitHubError(error, diagnostic = {}) {
  if (error instanceof GitHubError) {
    if (error.operation || !diagnostic.operation) return error;
    return new GitHubError(error.kind, {
      operation: diagnostic.operation,
      recoveryUrl: error.recoveryUrl,
      requiredPermissions: error.requiredPermissions,
      retryAt: error.retryAt,
      status: error.status,
      transport: diagnostic.transport,
    });
  }

  const status = error?.status ?? error?.response?.status;
  const headers = error?.response?.headers || {};
  const apiMessage = String(error?.response?.data?.message || '');
  const rateLimitRemaining = getHeader(headers, 'x-ratelimit-remaining');
  const retryAt = getRetryAt(headers);
  const recoveryUrl = getSsoRecoveryUrl(headers);
  const requiredPermissions = getHeader(
    headers,
    'x-accepted-github-permissions',
  );
  const transportKind = error?.kind || error?.cause?.kind;
  let kind = transportKind === 'network' ? 'network' : 'internal';

  if (status === 401) {
    kind = 'authentication';
  } else if (
    status === 429 ||
    (status === 403 &&
      (rateLimitRemaining === '0' || /rate limit/i.test(apiMessage)))
  ) {
    kind = 'rate-limit';
  } else if (status === 403) {
    kind = 'permission';
  } else if (status === 404) {
    kind = 'not-found';
  } else if (status === 409) {
    kind = 'conflict';
  } else if (status === 400 || status === 422) {
    kind = 'validation';
  } else if (status >= 500) {
    kind =
      diagnostic.transport === 'native' && transportKind !== 'network'
        ? 'internal'
        : 'network';
  }

  return new GitHubError(kind, {
    operation: diagnostic.operation,
    recoveryUrl,
    requiredPermissions,
    retryAt,
    status,
    transport: diagnostic.transport,
  });
}

export class GitHubService {
  #octokit;
  #transport;

  constructor(
    token,
    {
      OctokitClass = PaginatingOctokit,
      baseUrl = 'https://api.github.com',
      fetch,
      transport = fetch ? 'web' : 'web',
    } = {},
  ) {
    const request = fetch ? { fetch } : undefined;
    this.#transport = transport;
    this.#octokit = new OctokitClass({ baseUrl, log: silentLog, request });
    this.#octokit.hook.before('request', (options) => {
      options.headers = {
        ...options.headers,
        accept: GITHUB_ACCEPT,
        authorization: `Bearer ${token}`,
        'x-github-api-version': GITHUB_API_VERSION,
      };
    });
  }

  async getAuthenticatedUser() {
    const response = await this.#request('GET /user');
    return response.data;
  }

  async listRepositories() {
    return this.#paginate('GET /user/repos', {
      per_page: 100,
      sort: 'updated',
      type: 'all',
    });
  }

  async listInstallations() {
    return this.#paginate('GET /user/installations', { per_page: 100 });
  }

  async listInstallationRepositories(installationId) {
    return this.#paginate(
      'GET /user/installations/{installation_id}/repositories',
      { installation_id: installationId, per_page: 100 },
    );
  }

  async listBranches(owner, repo) {
    return this.#paginate('GET /repos/{owner}/{repo}/branches', {
      owner,
      per_page: 100,
      repo,
    });
  }

  async createBranch(owner, repo, from, branch) {
    const source = await this.#request(
      'GET /repos/{owner}/{repo}/git/ref/{ref}',
      { owner, ref: `heads/${from}`, repo },
    );
    const response = await this.#request(
      'POST /repos/{owner}/{repo}/git/refs',
      {
        owner,
        ref: `refs/heads/${branch}`,
        repo,
        sha: source.data.object.sha,
      },
    );
    return response.data;
  }

  async getContent(owner, repo, path, ref) {
    const response = await this.#getContent(owner, repo, path, ref);
    return response.data;
  }

  async getBlob(owner, repo, sha) {
    const response = await this.#request(
      'GET /repos/{owner}/{repo}/git/blobs/{file_sha}',
      { owner, repo, file_sha: sha },
    );
    if (response.data.encoding !== 'base64') {
      throw new GitHubError('validation', { status: response.status });
    }
    return base64ToArrayBuffer(response.data.content);
  }

  async writeFile({
    branch,
    content,
    encode = true,
    message,
    owner,
    path,
    repo,
  }) {
    let sha;
    try {
      const current = await this.#getContent(owner, repo, path, branch);
      if (Array.isArray(current.data)) {
        throw new GitHubError('validation', { status: current.status });
      }
      sha = current.data.sha;
    } catch (error) {
      if (error.kind !== 'not-found') throw error;
    }

    return this.#putFile({
      branch,
      content,
      encode,
      message,
      owner,
      path,
      repo,
      sha,
    });
  }

  async createFile({
    branch,
    content,
    encode = true,
    message,
    owner,
    path,
    repo,
  }) {
    try {
      await this.#getContent(owner, repo, path, branch);
      throw new GitHubError('conflict');
    } catch (error) {
      if (error.kind !== 'not-found') throw error;
    }

    return this.#putFile({
      branch,
      content,
      encode,
      message,
      owner,
      path,
      repo,
    });
  }

  async deleteFile({ branch, message, owner, path, repo }) {
    const current = await this.#getContent(owner, repo, path, branch);
    if (Array.isArray(current.data)) {
      throw new GitHubError('validation', { status: current.status });
    }
    const reference = await this.#request(
      'GET /repos/{owner}/{repo}/git/ref/{ref}',
      { owner, ref: `heads/${branch}`, repo },
      'contents',
    );
    const commitSha = this.#contentSha(reference.data?.object?.sha);
    const commit = await this.#request(
      'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
      { commit_sha: commitSha, owner, repo },
      'contents',
    );
    const tree = await this.#request(
      'POST /repos/{owner}/{repo}/git/trees',
      {
        base_tree: this.#contentSha(commit.data?.tree?.sha),
        owner,
        repo,
        tree: [{ mode: '100644', path, sha: null, type: 'blob' }],
      },
      'contents',
    );
    const nextCommit = await this.#request(
      'POST /repos/{owner}/{repo}/git/commits',
      {
        message,
        owner,
        parents: [commitSha],
        repo,
        tree: this.#contentSha(tree.data?.sha),
      },
      'contents',
    );
    const response = await this.#request(
      'PATCH /repos/{owner}/{repo}/git/refs/{ref}',
      {
        force: false,
        owner,
        ref: `heads/${branch}`,
        repo,
        sha: this.#contentSha(nextCommit.data?.sha),
      },
      'contents',
    );
    return response.data;
  }

  async listGists() {
    return this.#paginate('GET /gists', { per_page: 100 });
  }

  async getGist(id) {
    const response = await this.#request('GET /gists/{gist_id}', {
      gist_id: id,
    });
    return response.data;
  }

  async createGist(value) {
    const response = await this.#request('POST /gists', value);
    return response.data;
  }

  async updateGist(id, value) {
    const response = await this.#request('PATCH /gists/{gist_id}', {
      gist_id: id,
      ...value,
    });
    return response.data;
  }

  async deleteGist(id) {
    await this.#request('DELETE /gists/{gist_id}', { gist_id: id });
  }

  async #call(route, operation, family = operationFamily(route)) {
    try {
      return await operation();
    } catch (error) {
      throw normalizeGitHubError(error, {
        operation: family,
        transport: this.#transport,
      });
    }
  }

  async #getContent(owner, repo, path, ref) {
    return this.#request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      path,
      ref,
      repo,
    });
  }

  #contentSha(value) {
    if (typeof value === 'string' && value) return value;
    throw new GitHubError('internal', {
      operation: 'contents',
      transport: this.#transport,
    });
  }

  async #paginate(route, parameters) {
    return this.#call(route, async () => {
      const values = await this.#octokit.paginate(route, parameters);
      if (!Array.isArray(values)) throw new GitHubError('internal');
      return values;
    });
  }

  async #putFile({ branch, content, encode, message, owner, path, repo, sha }) {
    const response = await this.#request(
      'PUT /repos/{owner}/{repo}/contents/{path}',
      {
        branch,
        content: encode ? textToBase64(content) : content,
        message,
        owner,
        path,
        repo,
        sha,
      },
    );
    return response.data;
  }

  async #request(route, parameters, family) {
    return this.#call(
      route,
      () => this.#octokit.request(route, parameters),
      family,
    );
  }
}

function operationFamily(route) {
  if (route.includes('/installations')) return 'installations';
  if (route.includes('/gists')) return 'gists';
  if (route.includes('/branches') || route.includes('/git/ref')) {
    return 'branches';
  }
  if (route.includes('/contents') || route.includes('/blobs')) {
    return 'contents';
  }
  if (route === 'GET /user') return 'identity';
  if (route.includes('/repos')) return 'repositories';
  return 'github';
}

export function createGitHubService(token, options) {
  return new GitHubService(token, options);
}

function textToBase64(value) {
  return bytesToBase64(utf8ToBytes(value));
}

function bytesToBase64(bytes) {
  let value = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(value);
}

function base64ToArrayBuffer(value) {
  const decoded = atob(value.replace(/\s/g, ''));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}

function getHeader(headers, name) {
  if (typeof headers.get === 'function') return headers.get(name);
  const match = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  return match ? String(headers[match]) : undefined;
}

function getRetryAt(headers) {
  const retryAfter = Number(getHeader(headers, 'retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Date.now() + retryAfter * 1_000;
  }

  const reset = Number(getHeader(headers, 'x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? reset * 1_000 : undefined;
}

function getSsoRecoveryUrl(headers) {
  const value = getHeader(headers, 'x-github-sso');
  const match = value?.match(/(?:^|;)\s*url=([^;\s]+)/i);
  if (!match) return undefined;
  try {
    const url = new URL(match[1]);
    return url.protocol === 'https:' && url.hostname === 'github.com'
      ? url.href
      : undefined;
  } catch (_error) {
    return undefined;
  }
}
