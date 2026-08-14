import { AES } from '@stablelib/aes';
import { SIV } from '@stablelib/siv';
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '../encoding';
import { GitHubAuthError } from './errors';

export const GITHUB_SESSION_VERSION = 1;
export const GITHUB_SESSION_STORAGE_KEY =
  'acode.plugin.github.github-session-v1';
const ENVELOPE_VERSION = 1;
const ALGORITHM = 'AES-256-SIV';
const ADDITIONAL_DATA = utf8ToBytes('acode.plugin.github/github-session/v1');

// This checked-in key only obfuscates persisted sessions. It is not a security
// boundary because every Acode plugin executes in the same WebView.
const DEFAULT_OBFUSCATION_KEY = hexToBytes(
  '22056d05cdc58d658fe6b6dc0b50594b5e5cd399d60d027a216e8761d185313d' +
    'b7f13c9e727a6cc68b68cb7a4bd06b21a9525b2729d2251b2f75466a472536e4',
);

export class GitHubSessionStore {
  #key;
  #storage;

  constructor({
    key = DEFAULT_OBFUSCATION_KEY,
    storage = globalThis.localStorage,
  } = {}) {
    this.#key = validateKey(key);
    this.#storage = storage;
  }

  async load() {
    let value;
    try {
      value = this.#storageApi().getItem(GITHUB_SESSION_STORAGE_KEY);
    } catch (_error) {
      throw new GitHubAuthError('storage');
    }
    if (!value) return null;

    try {
      const record = JSON.parse(value);
      if (!isEncryptedRecord(record)) throw new Error('invalid record');
      const cipher = new SIV(AES, this.#key);
      let plaintext;
      try {
        plaintext = cipher.open(
          [ADDITIONAL_DATA],
          hexToBytes(record.ciphertext),
        );
      } finally {
        cipher.clean();
      }
      if (!plaintext) throw new Error('invalid ciphertext');
      const session = JSON.parse(bytesToUtf8(plaintext));
      if (!isGitHubSession(session)) throw new Error('invalid session');
      return session;
    } catch (_error) {
      this.#discardCorruptSession();
      throw new GitHubAuthError('invalid-session');
    }
  }

  async save(session) {
    if (!isGitHubSession(session)) {
      throw new GitHubAuthError('invalid-session');
    }

    try {
      const cipher = new SIV(AES, this.#key);
      let ciphertext;
      try {
        ciphertext = cipher.seal(
          [ADDITIONAL_DATA],
          utf8ToBytes(JSON.stringify(session)),
        );
      } finally {
        cipher.clean();
      }
      const record = {
        algorithm: ALGORITHM,
        ciphertext: bytesToHex(ciphertext),
        version: ENVELOPE_VERSION,
      };
      this.#storageApi().setItem(
        GITHUB_SESSION_STORAGE_KEY,
        JSON.stringify(record),
      );
    } catch (error) {
      if (error instanceof GitHubAuthError) throw error;
      throw new GitHubAuthError('storage');
    }
  }

  async clear() {
    try {
      this.#storageApi().removeItem(GITHUB_SESSION_STORAGE_KEY);
    } catch (_error) {
      throw new GitHubAuthError('storage');
    }
  }

  #discardCorruptSession() {
    try {
      this.#storageApi().removeItem(GITHUB_SESSION_STORAGE_KEY);
    } catch (_error) {
      // The corrupt value remains unreadable and is never exposed.
    }
  }

  #storageApi() {
    if (
      typeof this.#storage?.getItem !== 'function' ||
      typeof this.#storage?.setItem !== 'function' ||
      typeof this.#storage?.removeItem !== 'function'
    ) {
      throw new GitHubAuthError('storage');
    }
    return this.#storage;
  }
}

export function isGitHubSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return false;
  }
  if (session.version !== GITHUB_SESSION_VERSION) return false;
  if (session.kind !== 'github-app' && session.kind !== 'pat') return false;
  if (!isNonEmptyString(session.accessToken)) return false;
  if (!isNullableTimestamp(session.accessExpiresAt)) return false;
  if (!isNullableTimestamp(session.refreshExpiresAt)) return false;
  if (
    session.refreshToken !== null &&
    !isNonEmptyString(session.refreshToken)
  ) {
    return false;
  }
  if (
    session.kind === 'pat' &&
    (session.accessExpiresAt !== null ||
      session.refreshExpiresAt !== null ||
      session.refreshToken !== null)
  ) {
    return false;
  }
  if (
    session.kind === 'github-app' &&
    (session.refreshToken === null) !== (session.refreshExpiresAt === null)
  ) {
    return false;
  }
  if (
    (typeof session.accountId !== 'number' ||
      !Number.isFinite(session.accountId)) &&
    typeof session.accountId !== 'string'
  ) {
    return false;
  }
  if (!isNonEmptyString(session.login)) return false;
  return session.avatarUrl === null || typeof session.avatarUrl === 'string';
}

function isEncryptedRecord(record) {
  return (
    record?.version === ENVELOPE_VERSION &&
    record.algorithm === ALGORITHM &&
    isHex(record.ciphertext, undefined, 32)
  );
}

function isHex(value, exactLength, minimumLength = 0) {
  return (
    typeof value === 'string' &&
    value.length >= minimumLength &&
    (exactLength === undefined || value.length === exactLength) &&
    value.length % 2 === 0 &&
    /^[\da-f]+$/iu.test(value)
  );
}

function validateKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 64) {
    throw new GitHubAuthError('configuration');
  }
  return new Uint8Array(key);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNullableTimestamp(value) {
  return value === null || (Number.isFinite(value) && value > 0);
}
