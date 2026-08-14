const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const acorn = require('acorn');
const { minify } = require('terser');
const webpack = require('webpack');

const createWebpackConfig = require('../webpack.config');
const { validateBundleSource } = require('../scripts/dev/bundle-validation');
const { getIp } = require('../scripts/dev/get-network');
const { getWebpackProcess, main, printStartup } = require('../scripts/dev/dev');
const {
  parseDevelopmentOptions,
  parseResolvedMode,
} = require('../scripts/dev/dev-mode');
const {
  getWebpackWatchOptions,
  runWebpack,
} = require('../scripts/dev/run-webpack');
const {
  ActiveWatcherError,
  acquireWatchLock,
  getWatchLockPath,
  releaseMatchingWatchLock,
} = require('../scripts/dev/watch-lock');
const {
  protectWatchLock,
  runGuard,
} = require('../scripts/dev/watch-lock-guard');
const { minifyCss } = require('../scripts/dev/css-source-loader');
const rewriteEs5Regexps = require('../scripts/dev/es5-regexp-loader');
const preserveConstructors = require('../scripts/dev/preserve-constructors-loader');
const { terserOptions } = require('../scripts/dev/terser-options');
const packageJson = require('../package.json');

test('development options resolve explicit modes and reject ambiguity', () => {
  const development = parseDevelopmentOptions([]);
  const release = parseDevelopmentOptions(['--release']);

  assert.deepEqual(development, {
    envFile: '.env.local',
    label: 'Development watch',
    mode: 'development',
    release: false,
  });
  assert.deepEqual(release, {
    envFile: '.env',
    label: 'Release watch',
    mode: 'production',
    release: true,
  });
  assert.equal(parseResolvedMode(['--mode=development']), 'development');
  assert.equal(parseResolvedMode(['--mode=production']), 'production');
  assert.throws(
    () => parseDevelopmentOptions(['--release', '--release']),
    /only be provided once/,
  );
  assert.throws(
    () => parseDevelopmentOptions(['--unknown']),
    /Unsupported development option: --unknown/,
  );
  assert.throws(() => parseResolvedMode([]), /Webpack watch requires/);
});

test('resolved mode is passed to the Webpack watcher child', () => {
  const development = getWebpackProcess(parseDevelopmentOptions([]));
  const release = getWebpackProcess(parseDevelopmentOptions(['--release']));

  assert.equal(path.basename(development.modulePath), 'run-webpack.js');
  assert.deepEqual(development.args, ['--mode=development']);
  assert.deepEqual(release.args, ['--mode=production']);
  assert.deepEqual(getWebpackWatchOptions(release.args), {
    mode: 'production',
  });
  assert.deepEqual(development.options.stdio, [
    'inherit',
    'inherit',
    'inherit',
    'ipc',
  ]);
});

test('release watch has a canonical npm command and keeps its compatibility form', () => {
  assert.equal(
    packageJson.scripts['dev:release'],
    'node scripts/dev/dev.js --release',
  );
  assert.equal(packageJson.scripts.dev, 'node scripts/dev/dev.js');
});

test('startup diagnostics identify mode, env file, and redacted overrides', () => {
  const calls = [];
  const logger = {
    log: (message) => calls.push(['log', message]),
    warn: (message) => calls.push(['warn', message]),
  };
  printStartup(
    parseDevelopmentOptions(['--release']),
    {
      ACODE_GITHUB_CLIENT_ID: 'public-client-value',
      ACODE_GITHUB_INSTALL_URL: 'public-install-value',
    },
    logger,
  );

  assert.deepEqual(calls.slice(0, 3), [
    ['log', 'Release watch'],
    ['log', 'Bundle mode: production'],
    ['log', 'GitHub App configuration: .env'],
  ]);
  assert.match(calls.at(-1)[1], /ACODE_GITHUB_CLIENT_ID/);
  assert.match(calls.at(-1)[1], /ACODE_GITHUB_INSTALL_URL/);
  assert.equal(JSON.stringify(calls).includes('public-client-value'), false);
  assert.equal(JSON.stringify(calls).includes('public-install-value'), false);
});

test('network discovery accepts cross-platform interface names', () => {
  const address = getIp({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  });

  assert.equal(address, '192.168.1.20');
});

test('network discovery supports numeric address families', () => {
  const address = getIp({
    eth0: [{ address: '10.0.0.8', family: 4, internal: false }],
  });

  assert.equal(address, '10.0.0.8');
});

test('network discovery falls back to localhost', () => {
  assert.equal(getIp({}), '127.0.0.1');
});

test('watch locks reject active processes and recover stale records', (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'github-watch-lock-'),
  );
  context.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const lockPath = getWatchLockPath('/project/plugin', directory);
  const first = acquireWatchLock({
    lockPath,
    mode: 'development',
    now: () => 100,
    pid: 123,
  });

  assert.throws(
    () =>
      acquireWatchLock({
        isProcessAlive: (pid) => pid === 123,
        lockPath,
        mode: 'production',
        now: () => 200,
        pid: 456,
      }),
    (error) => {
      assert.equal(error instanceof ActiveWatcherError, true);
      assert.match(error.message, /development watcher/);
      assert.match(error.message, /PID 123/);
      return true;
    },
  );
  first.release();
  assert.equal(fs.existsSync(lockPath), false);

  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      mode: 'development',
      pid: 999,
      startedAt: 50,
      version: 1,
    }),
    'utf8',
  );
  const stale = acquireWatchLock({
    isProcessAlive: () => false,
    lockPath,
    mode: 'production',
    now: () => 250,
    pid: 789,
  });
  stale.release();
  assert.equal(fs.existsSync(lockPath), false);

  fs.writeFileSync(lockPath, '{malformed', 'utf8');
  const recovered = acquireWatchLock({
    isProcessAlive: () => false,
    lockPath,
    mode: 'production',
    now: () => 300,
    pid: 789,
  });
  assert.equal(recovered.record.mode, 'production');
  recovered.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('watch lock guard releases the exact owner after parent shutdown', () => {
  const child = new FakeGuardChild();
  const lock = {
    path: '/temporary/watcher.lock',
    record: {
      mode: 'production',
      pid: 123,
      startedAt: 456,
      version: 1,
    },
  };
  const guard = protectWatchLock(lock, {
    forkProcess(modulePath, args, options) {
      assert.equal(path.basename(modulePath), 'watch-lock-guard.js');
      assert.deepEqual(JSON.parse(args[0]), {
        lockPath: lock.path,
        record: lock.record,
      });
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      return child;
    },
  });

  assert.equal(child.unrefCalls, 1);
  assert.equal(child.channelUnrefCalls, 1);
  guard.release();
  guard.release();
  assert.deepEqual(child.messages, [{ type: 'release' }]);

  const runtime = new EventEmitter();
  runtime.connected = true;
  const releases = [];
  runGuard(JSON.stringify({ lockPath: lock.path, record: lock.record }), {
    release: (value) => releases.push(value),
    runtime,
  });
  runtime.emit('disconnect');
  runtime.emit('message', { type: 'release' });
  assert.deepEqual(releases, [{ lockPath: lock.path, record: lock.record }]);
  assert.equal(runtime.exitCode, 0);
});

test('watch lock cleanup never removes a replacement owner', (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'github-watch-owner-'),
  );
  context.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const lockPath = path.join(directory, 'watch.lock');
  const current = {
    mode: 'development',
    pid: 456,
    startedAt: 200,
    version: 1,
  };
  fs.writeFileSync(lockPath, JSON.stringify(current));

  assert.equal(
    releaseMatchingWatchLock({
      lockPath,
      record: { ...current, pid: 123 },
    }),
    false,
  );
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(releaseMatchingWatchLock({ lockPath, record: current }), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('active watcher lock prevents child processes from starting', () => {
  let forks = 0;
  assert.throws(
    () =>
      main([], {
        acquireLock() {
          throw new ActiveWatcherError({ mode: 'development', pid: 123 });
        },
        forkProcess() {
          forks += 1;
        },
      }),
    /already running/,
  );
  assert.equal(forks, 0);
});

test('Webpack watch reports structured compilation results and closes cleanly', async () => {
  const messages = [];
  const output = [];
  const runtime = new EventEmitter();
  runtime.send = (message) => messages.push(message);
  let compile;
  let closeCalls = 0;

  const watcher = runWebpack(['--mode=production'], {
    configFactory: (_env, options) => ({ selectedMode: options.mode }),
    createCompiler(config) {
      assert.deepEqual(config, { selectedMode: 'production' });
      return {
        watch(_options, callback) {
          compile = callback;
          return {
            close(done) {
              closeCalls += 1;
              done();
            },
          };
        },
      };
    },
    logger: {
      error: (value) => output.push(String(value)),
      log: (value) => output.push(String(value)),
    },
    runtime,
  });

  compile(null, compilationStats(false));
  compile(null, compilationStats(true));
  assert.deepEqual(messages, [
    { mode: 'production', status: 'success', type: 'compilation' },
    { mode: 'production', status: 'errors', type: 'compilation' },
  ]);
  assert.deepEqual(output, ['compiled successfully', 'compiled with errors']);
  runtime.emit('SIGTERM');
  assert.equal(closeCalls, 1);
  assert.equal(runtime.exitCode, 143);
  watcher.close();
  assert.equal(closeCalls, 1);
});

test('fatal Webpack watch errors close with a nonzero result', async () => {
  const messages = [];
  const runtime = new EventEmitter();
  runtime.send = (message) => messages.push(message);
  let compile;
  let closeCalls = 0;
  runWebpack(['--mode=development'], {
    configFactory: () => ({}),
    createCompiler: () => ({
      watch(_options, callback) {
        compile = callback;
        return {
          close(done) {
            closeCalls += 1;
            done();
          },
        };
      },
    }),
    logger: { error() {}, log() {} },
    runtime,
  });

  compile(new Error('fatal compilation'));
  await Promise.resolve();
  assert.deepEqual(messages, [
    { mode: 'development', status: 'fatal', type: 'compilation' },
  ]);
  assert.equal(closeCalls, 1);
  assert.equal(runtime.exitCode, 1);
});

test('development supervisor starts once and propagates child failures', async () => {
  const runtime = new EventEmitter();
  const children = [];
  const logs = [];
  let releases = 0;
  const supervisor = main(['--release'], {
    acquireLock: () => ({ release: () => (releases += 1) }),
    environment: {},
    forkProcess(modulePath, args) {
      const child = new FakeChild(modulePath, args);
      children.push(child);
      return child;
    },
    logger: {
      error: (message) => logs.push(['error', message]),
      log: (message) => logs.push(['log', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    runtime,
  });

  assert.equal(supervisor.options.mode, 'production');
  assert.deepEqual(children[0].args, ['--mode=production']);
  children[0].emit('message', {
    mode: 'production',
    status: 'errors',
    type: 'compilation',
  });
  assert.equal(children.length, 1);
  children[0].emit('message', {
    mode: 'production',
    status: 'success',
    type: 'compilation',
  });
  children[0].emit('message', {
    mode: 'production',
    status: 'success',
    type: 'compilation',
  });
  assert.equal(children.length, 2);

  children[1].emit('exit', 2, null);
  await Promise.resolve();
  assert.equal(runtime.exitCode, 2);
  assert.equal(children[0].killed, true);
  assert.equal(children[0].signal, 'SIGTERM');
  assert.equal(releases, 1);
  assert.match(logs.at(-1)[1], /Plugin server exited unexpectedly/);
});

test('development supervisor releases its lock after Ctrl+C shutdown', async () => {
  const runtime = new EventEmitter();
  const child = new FakeChild('run-webpack.js', ['--mode=development']);
  let releases = 0;
  main([], {
    acquireLock: () => ({ release: () => (releases += 1) }),
    environment: {},
    forkProcess: () => child,
    logger: { error() {}, log() {}, warn() {} },
    runtime,
  });

  runtime.emit('SIGINT');
  assert.equal(child.killed, true);
  assert.equal(child.signal, 'SIGINT');
  assert.equal(runtime.exitCode, 130);
  assert.equal(releases, 0);
  await Promise.resolve();
  assert.equal(releases, 1);
});

test('embedded CSS loader preserves rules while removing build-only whitespace', () => {
  assert.equal(
    minifyCss(
      '/* comment */\n.github[data-state="open"] { color: red !important; opacity: 0.5; }\n',
    ),
    '.github[data-state=open]{color:red!important;opacity:.5}',
  );
});

test('production minification preserves dependency constructors', async () => {
  const source = preserveConstructors(`
    const NullObject = (() => {
      const C = function () { };
      C.prototype = Object.create(null);
      return C;
    })();
    function Collection() { return {}; }
    globalThis.constructorSmoke = [new NullObject(), new Collection()];
  `);
  const result = await minify(source, terserOptions);

  const context = {};
  vm.runInNewContext(result.code, context);
  assert.equal(context.constructorSmoke.length, 2);
});

test('production minification preserves booleans at Cordova API boundaries', async () => {
  const result = await minify(
    `
      globalThis.http.setFollowRedirect(false);
      globalThis.http.sendRequest({ followRedirect: false });
    `,
    terserOptions,
  );
  const values = [];
  const context = {
    http: {
      sendRequest(options) {
        values.push(options.followRedirect);
      },
      setFollowRedirect(value) {
        values.push(value);
      },
    },
  };
  vm.runInNewContext(result.code, context);
  assert.deepEqual(values, [false, false]);
  assert.equal(
    values.every((value) => typeof value === 'boolean'),
    true,
  );
});

test('constructor preservation fails clearly after dependency changes', () => {
  assert.throws(
    () => preserveConstructors('const C = () => {};'),
    /NullObject constructor changed/,
  );
});

test('Octokit regular expressions remain parseable by legacy WebViews', () => {
  const transformed = rewriteEs5Regexps.call(
    { resourcePath: 'octokit-test.js' },
    `
      value.replace(/(?:^\\W+)|(?:(?<!\\W)\\W+$)/g, "");
      headers.accept.match(/(?<![\\w-])[\\w-]+(?=-preview)/g) || [];
      authorization.replace(/(?<! ) .*$/, " [REDACTED]");
    `,
  );
  assert.doesNotMatch(transformed, /\(\?</);
  assert.match(transformed, /preview\.replace/);
  assert.match(transformed, /\[\^ \]/);
});

test('bundle validation rejects orphaned Webpack runtime references', () => {
  assert.equal(validateBundleSource('console.log("standalone");'), true);
  assert.equal(
    validateBundleSource(`
      function __webpack_require__(id) { return id; }
      __webpack_require__.cjs = function (body) { return body(); };
    `),
    true,
  );
  assert.throws(
    () =>
      validateBundleSource(
        '__webpack_require__.cjs = function (body) { return body(); };',
      ),
    (error) => error.code === 'INVALID_WEBPACK_RUNTIME',
  );
  assert.throws(
    () => validateBundleSource('const loader = __webpack_require__;'),
    (error) => error.code === 'INVALID_WEBPACK_RUNTIME',
  );
});

test('production bundle evaluates with a complete Webpack runtime', async (context) => {
  const outputPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'github-production-bundle-'),
  );
  context.after(() => fs.rmSync(outputPath, { force: true, recursive: true }));
  const config = createTestProductionConfig(outputPath);

  assert.equal(config.optimization.concatenateModules, false);
  await compileWebpack(config);
  const source = fs.readFileSync(path.join(outputPath, 'main.js'), 'utf8');
  assert.equal(validateBundleSource(source), true);
  assert.doesNotThrow(() => acorn.parse(source, { ecmaVersion: 5 }));
  assert.doesNotThrow(() =>
    vm.runInNewContext(source, createPluginBundleContext(), {
      timeout: 5_000,
    }),
  );

  const compatibilitySource = fs.readFileSync(
    path.join(outputPath, 'compatibility.js'),
    'utf8',
  );
  assert.doesNotThrow(() =>
    acorn.parse(compatibilitySource, { ecmaVersion: 5 }),
  );
  const compatibilityContext = createPluginBundleContext();
  vm.runInNewContext(compatibilitySource, compatibilityContext, {
    timeout: 5_000,
  });
  const nativeCalls = [];
  const result = await compatibilityContext.runGitHubCompatibilityProbe({
    sendRequest(url, options, success) {
      nativeCalls.push({ options, url });
      success({
        data: '{"id":1,"login":"octocat"}',
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    },
  });
  assert.equal(result.restored.accessToken, 'compatibility-token');
  assert.equal(result.record.includes('compatibility-token'), false);
  assert.equal(result.user.login, 'octocat');
  assert.equal(
    nativeCalls[0].options.headers.authorization,
    'Bearer native-token',
  );
});

function compilationStats(hasErrors) {
  return {
    hasErrors: () => hasErrors,
    toString: () =>
      hasErrors ? 'compiled with errors' : 'compiled successfully',
  };
}

class FakeChild extends EventEmitter {
  constructor(modulePath, args) {
    super();
    this.args = args;
    this.killed = false;
    this.modulePath = modulePath;
    this.signal = null;
  }

  kill(signal) {
    this.killed = true;
    this.signal = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

class FakeGuardChild extends EventEmitter {
  constructor() {
    super();
    this.channelUnrefCalls = 0;
    this.connected = true;
    this.messages = [];
    this.unrefCalls = 0;
    this.channel = {
      unref: () => {
        this.channelUnrefCalls += 1;
      },
    };
  }

  send(message, callback) {
    this.messages.push(message);
    callback();
  }

  unref() {
    this.unrefCalls += 1;
  }
}

function createTestProductionConfig(outputPath) {
  const keys = ['ACODE_GITHUB_CLIENT_ID', 'ACODE_GITHUB_INSTALL_URL'];
  const previous = new Map(
    keys.map((key) => [
      key,
      { exists: Object.hasOwn(process.env, key), value: process.env[key] },
    ]),
  );
  process.env.ACODE_GITHUB_CLIENT_ID = 'Iv1.production-bundle-test';
  process.env.ACODE_GITHUB_INSTALL_URL =
    'https://github.com/apps/production-bundle-test/installations/new';

  let config;
  try {
    [config] = createWebpackConfig({}, { mode: 'development' });
  } finally {
    for (const [key, state] of previous) {
      if (state.exists) process.env[key] = state.value;
      else delete process.env[key];
    }
  }

  config.mode = 'production';
  config.entry = {
    ...config.entry,
    compatibility: './scripts/dev/compatibility-entry.js',
  };
  config.output = { ...config.output, path: outputPath };
  config.plugins = config.plugins.slice(0, 1);
  return config;
}

function compileWebpack(config) {
  return new Promise((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => {
      const compilationError =
        error ||
        (stats?.hasErrors()
          ? new Error(stats.toString({ all: false, errors: true }))
          : null);
      compiler.close((closeError) => {
        if (compilationError || closeError) {
          reject(compilationError || closeError);
        } else {
          resolve();
        }
      });
    });
  });
}

function createPluginBundleContext() {
  const acode = {
    require(name) {
      if (name === 'fs' || name === 'fsOperation') {
        return { extend() {}, remove() {} };
      }
      if (name === 'url') {
        return { join: (...parts) => parts.join('/') };
      }
      if (name === 'prompt') return () => {};
      return {};
    },
  };
  return {
    AbortController,
    Blob,
    Buffer,
    BigInt: undefined,
    DOMException: undefined,
    FormData,
    Headers: undefined,
    Promise,
    Request,
    Response: undefined,
    TextDecoder: undefined,
    TextEncoder: undefined,
    URL,
    URLSearchParams,
    Uint8Array,
    acode,
    clearTimeout,
    console,
    setTimeout,
    window: {},
  };
}
