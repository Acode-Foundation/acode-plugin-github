const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { projectRoot } = require('./paths');

const LOCK_VERSION = 1;

class ActiveWatcherError extends Error {
  constructor(record) {
    super(
      `A ${record.mode} watcher is already running for this project ` +
        `(PID ${record.pid}). Stop it with Ctrl+C before starting another watcher.`,
    );
    this.name = 'ActiveWatcherError';
    this.code = 'ACODE_GITHUB_WATCHER_ACTIVE';
    this.record = record;
  }
}

function getWatchLockPath(root = projectRoot, temporaryDirectory = tmpdir()) {
  let canonicalRoot = path.resolve(root);
  try {
    canonicalRoot = fs.realpathSync.native(canonicalRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const projectId = createHash('sha256')
    .update(canonicalRoot)
    .digest('hex')
    .slice(0, 16);
  return path.join(
    temporaryDirectory,
    `acode-plugin-github-watch-${projectId}.lock`,
  );
}

function acquireWatchLock({
  fsApi = fs,
  isProcessAlive = defaultIsProcessAlive,
  lockPath = getWatchLockPath(),
  mode,
  now = Date.now,
  pid = process.pid,
} = {}) {
  if (mode !== 'development' && mode !== 'production') {
    throw new TypeError(
      'A development or production watcher mode is required.',
    );
  }
  const record = {
    mode,
    pid,
    startedAt: Number(now()),
    version: LOCK_VERSION,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fsApi.openSync(lockPath, 'wx', 0o600);
      fsApi.writeFileSync(descriptor, JSON.stringify(record), 'utf8');
      fsApi.closeSync(descriptor);
      descriptor = undefined;
      return createLockHandle({ fsApi, lockPath, record });
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          fsApi.closeSync(descriptor);
        } catch (_closeError) {
          // The original lock error remains authoritative.
        }
        safeRemove(fsApi, lockPath);
      }
      if (error.code !== 'EEXIST') throw error;

      const active = readLockRecord(fsApi, lockPath);
      if (active && isProcessAlive(active.pid)) {
        throw new ActiveWatcherError(active);
      }
      safeRemove(fsApi, lockPath);
    }
  }

  throw new Error('Could not acquire the development watcher lock.');
}

function createLockHandle({ fsApi, lockPath, record }) {
  let released = false;
  return Object.freeze({
    path: lockPath,
    record,
    release() {
      if (released) return;
      released = true;
      releaseMatchingWatchLock({ fsApi, lockPath, record });
    },
  });
}

function releaseMatchingWatchLock({ fsApi = fs, lockPath, record }) {
  const current = readLockRecord(fsApi, lockPath);
  if (
    current?.pid !== record?.pid ||
    current.startedAt !== record.startedAt ||
    current.mode !== record.mode
  ) {
    return false;
  }
  safeRemove(fsApi, lockPath);
  return true;
}

function readLockRecord(fsApi, lockPath) {
  try {
    const record = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
    if (
      record?.version !== LOCK_VERSION ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      (record.mode !== 'development' && record.mode !== 'production') ||
      !Number.isFinite(record.startedAt)
    ) {
      return null;
    }
    return record;
  } catch (_error) {
    return null;
  }
}

function safeRemove(fsApi, lockPath) {
  try {
    fsApi.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

module.exports = {
  ActiveWatcherError,
  acquireWatchLock,
  defaultIsProcessAlive,
  getWatchLockPath,
  readLockRecord,
  releaseMatchingWatchLock,
};
