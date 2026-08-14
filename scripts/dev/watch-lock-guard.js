const { fork } = require('node:child_process');
const { releaseMatchingWatchLock } = require('./watch-lock');

function protectWatchLock(
  lock,
  { forkProcess = fork, modulePath = __filename } = {},
) {
  if (!lock?.path || !lock.record) {
    throw new TypeError('A watcher lock path and record are required.');
  }
  const child = forkProcess(
    modulePath,
    [JSON.stringify({ lockPath: lock.path, record: lock.record })],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    },
  );
  child.unref();
  child.channel?.unref();

  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      released = true;
      if (!child.connected) return;
      try {
        child.send({ type: 'release' }, () => {});
      } catch (_error) {
        // Parent disconnect cleanup remains the fallback.
      }
    },
  });
}

function runGuard(
  serialized = process.argv[2],
  { release = releaseMatchingWatchLock, runtime = process } = {},
) {
  const lock = parseGuardArgument(serialized);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    release(lock);
    runtime.exitCode = 0;
    if (runtime.connected && typeof runtime.disconnect === 'function') {
      runtime.disconnect();
    }
  };

  runtime.once('disconnect', finish);
  runtime.on('message', (message) => {
    if (message?.type === 'release') finish();
  });
  if (!runtime.connected) finish();
  return { finish, lock };
}

function parseGuardArgument(serialized) {
  const value = JSON.parse(serialized);
  if (
    typeof value?.lockPath !== 'string' ||
    !value.lockPath ||
    !Number.isInteger(value.record?.pid) ||
    typeof value.record?.startedAt !== 'number' ||
    (value.record?.mode !== 'development' &&
      value.record?.mode !== 'production')
  ) {
    throw new TypeError('Invalid watcher lock guard configuration.');
  }
  return value;
}

if (require.main === module) {
  try {
    runGuard();
  } catch (_error) {
    process.exitCode = 1;
  }
}

module.exports = { parseGuardArgument, protectWatchLock, runGuard };
