const { fork } = require('node:child_process');
const path = require('node:path');
const { getShellOverrides, parseDevelopmentOptions } = require('./dev-mode');
const { projectRoot } = require('./paths');
const { acquireWatchLock } = require('./watch-lock');
const { protectWatchLock } = require('./watch-lock-guard');

function getWebpackProcess(options) {
  return {
    args: [`--mode=${options.mode}`],
    modulePath: path.resolve(__dirname, './run-webpack.js'),
    options: childOptions(),
  };
}

function getServerProcess() {
  return {
    args: [],
    modulePath: path.resolve(__dirname, './start-server.js'),
    options: childOptions(),
  };
}

function childOptions() {
  return {
    cwd: projectRoot,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  };
}

function printStartup(options, environment = process.env, logger = console) {
  logger.log(options.label);
  logger.log(`Bundle mode: ${options.mode}`);
  logger.log(`GitHub App configuration: ${options.envFile}`);
  const overrides = getShellOverrides(environment);
  if (overrides.length > 0) {
    logger.warn(
      `Shell variables override ${options.envFile}: ${overrides.join(', ')}`,
    );
  }
}

function main(
  args = process.argv.slice(2),
  {
    acquireLock = acquireWatchLock,
    environment = process.env,
    forkProcess = fork,
    logger = console,
    protectLock = protectWatchLock,
    runtime = process,
  } = {},
) {
  const options = parseDevelopmentOptions(args);
  const lock = acquireLock({ mode: options.mode });
  let lockGuard;
  try {
    if (lock.path && lock.record) lockGuard = protectLock(lock);
  } catch (error) {
    lock.release();
    throw error;
  }
  printStartup(options, environment, logger);

  let server;
  let stopping = false;
  let lockReleased = false;
  const activeChildren = new Map();

  const releaseLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    lock.release();
    lockGuard?.release();
  };
  const finishIfStopped = () => {
    if (activeChildren.size === 0) releaseLock();
  };
  const stop = (signal, exitCode) => {
    if (!stopping) {
      stopping = true;
      runtime.exitCode = exitCode;
      for (const child of activeChildren.keys()) {
        if (!child.killed) child.kill(signal);
      }
    }
    finishIfStopped();
  };
  const fail = (message, exitCode = 1) => {
    if (!stopping) logger.error(message);
    stop('SIGTERM', exitCode || 1);
  };
  const registerChild = (child, name) => {
    activeChildren.set(child, name);
    child.once('error', (error) => {
      fail(`${name} failed: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      activeChildren.delete(child);
      if (!stopping) {
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        fail(`${name} exited unexpectedly with ${reason}.`, code);
      }
      finishIfStopped();
    });
    return child;
  };
  const startServer = () => {
    if (server || stopping) return;
    logger.log(`${options.label} archive ready; starting plugin server.`);
    const processOptions = getServerProcess();
    try {
      server = registerChild(
        forkProcess(
          processOptions.modulePath,
          processOptions.args,
          processOptions.options,
        ),
        'Plugin server',
      );
    } catch (error) {
      fail(`Plugin server failed to start: ${error.message}`);
    }
  };

  runtime.once('SIGINT', () => stop('SIGINT', 130));
  runtime.once('SIGTERM', () => stop('SIGTERM', 143));
  runtime.once('SIGHUP', () => stop('SIGTERM', 129));
  runtime.once('exit', releaseLock);

  let webpack;
  try {
    const processOptions = getWebpackProcess(options);
    webpack = registerChild(
      forkProcess(
        processOptions.modulePath,
        processOptions.args,
        processOptions.options,
      ),
      'Webpack watcher',
    );
  } catch (error) {
    releaseLock();
    throw error;
  }

  webpack.on('message', (message) => {
    if (message?.type !== 'compilation') return;
    if (message.mode !== options.mode) {
      fail('Webpack watcher reported an unexpected build mode.');
      return;
    }
    if (message.status === 'success') startServer();
    if (message.status === 'fatal') fail('Webpack watcher failed.');
  });

  return Object.freeze({
    lock,
    options,
    shutdown: () => stop('SIGTERM', 0),
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  getServerProcess,
  getWebpackProcess,
  main,
  printStartup,
};
