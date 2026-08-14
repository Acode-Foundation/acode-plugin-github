const webpack = require('webpack');
const createWebpackConfig = require('../../webpack.config');
const { parseResolvedMode } = require('./dev-mode');

function getWebpackWatchOptions(args = process.argv.slice(2)) {
  return { mode: parseResolvedMode(args) };
}

function runWebpack(
  args = process.argv.slice(2),
  {
    configFactory = createWebpackConfig,
    createCompiler = (config) => webpack(config),
    logger = console,
    runtime = process,
  } = {},
) {
  const { mode } = getWebpackWatchOptions(args);
  const compiler = createCompiler(configFactory({}, { mode }));
  let closing = false;
  let watching;

  const send = (message) => runtime.send?.(message);
  const close = (exitCode = 0) => {
    if (closing) return;
    closing = true;
    if (!watching) {
      runtime.exitCode = exitCode;
      return;
    }
    watching.close((error) => {
      if (error) logger.error(error);
      runtime.exitCode = error ? 1 : exitCode;
    });
  };

  watching = compiler.watch({}, (error, stats) => {
    if (error || !stats) {
      logger.error(
        error || new Error('Webpack returned no compilation stats.'),
      );
      send({ mode, status: 'fatal', type: 'compilation' });
      queueMicrotask(() => close(1));
      return;
    }

    const output = stats.toString({ colors: Boolean(process.stdout.isTTY) });
    if (output) logger.log(output);
    send({
      mode,
      status: stats.hasErrors() ? 'errors' : 'success',
      type: 'compilation',
    });
  });

  runtime.once('SIGINT', () => close(130));
  runtime.once('SIGTERM', () => close(143));
  return { close, mode, watching };
}

if (require.main === module) {
  try {
    runWebpack();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { getWebpackWatchOptions, runWebpack };
