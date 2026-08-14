import { accountKey } from './githubAccount';

export const CACHE_TTL_MS = 5 * 60 * 1_000;

export class GitHubDataStore {
  #scope = 'signed-out:0';
  #entries = new Map();
  #now;
  #ttl;

  constructor({ now = Date.now, ttl = CACHE_TTL_MS } = {}) {
    this.#now = now;
    this.#ttl = ttl;
  }

  setAccount(account, generation = 0) {
    const next = `${accountKey(account)}:${generation}`;
    if (next === this.#scope) return;
    this.#scope = next;
    this.clear();
  }

  async get(key, load, { force = false } = {}) {
    const scopedKey = `${this.#scope}:${key}`;
    const entry = this.#entries.get(scopedKey);
    if (entry?.promise) return entry.promise;
    if (!force && entry) {
      if (entry.expiresAt > this.#now()) return entry.value;
    }

    const pending = {};
    pending.promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (this.#entries.get(scopedKey) === pending) {
          this.#entries.set(scopedKey, {
            expiresAt: this.#now() + this.#ttl,
            value,
          });
        }
        return value;
      })
      .catch((error) => {
        if (this.#entries.get(scopedKey) === pending) {
          this.#entries.delete(scopedKey);
        }
        throw error;
      });
    this.#entries.set(scopedKey, pending);
    return pending.promise;
  }

  invalidate(prefix) {
    const scopedPrefix = `${this.#scope}:${prefix}`;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(scopedPrefix)) this.#entries.delete(key);
    }
  }

  clear() {
    this.#entries.clear();
  }
}

export function deduplicateRepositories(repositories) {
  const unique = new Map();
  for (const repository of repositories) {
    const key =
      repository.id ??
      `${repository.owner?.login || ''}/${repository.name || ''}`.toLowerCase();
    if (!unique.has(key)) unique.set(key, repository);
  }
  return [...unique.values()].sort((left, right) => {
    const leftName = `${left.owner?.login || ''}/${left.name || ''}`;
    const rightName = `${right.owner?.login || ''}/${right.name || ''}`;
    return leftName.localeCompare(rightName);
  });
}

export function orderBranches(branches, defaultBranch) {
  if (!defaultBranch) return branches;
  return [...branches].sort((left, right) => {
    if (left.name === defaultBranch) return -1;
    if (right.name === defaultBranch) return 1;
    return left.name.localeCompare(right.name);
  });
}
