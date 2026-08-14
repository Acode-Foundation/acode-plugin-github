const fs = require('node:fs');
const path = require('node:path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');
const {
  getGitHubAuthBuildConfig,
  loadBuildEnvironment,
} = require('./scripts/dev/github-auth-config');
const { packZip } = require('./scripts/dev/pack-zip');
const { terserOptions } = require('./scripts/dev/terser-options');

const BROWSER_TARGETS = 'cover 100%, not android < 5';
const CONTENT_TYPE_MODULE = require.resolve('content-type');
const ES5_REGEXP_MODULES = [
  require.resolve('@octokit/endpoint'),
  require.resolve('@octokit/request-error'),
];

module.exports = (_env, options) => {
  const { mode = 'development' } = options;
  const githubAuth = getGitHubAuthBuildConfig(loadBuildEnvironment(mode));

  if (mode === 'production') {
    fs.rmSync(path.resolve(__dirname, 'dist'), {
      recursive: true,
      force: true,
    });
  }

  const rules = [
    {
      enforce: 'pre',
      include: ES5_REGEXP_MODULES,
      loader: path.resolve(__dirname, 'scripts/dev/es5-regexp-loader.js'),
    },
    {
      enforce: 'pre',
      include: CONTENT_TYPE_MODULE,
      loader: path.resolve(
        __dirname,
        'scripts/dev/preserve-constructors-loader.js',
      ),
    },
    {
      test: /\.m?js$/,
      include: CONTENT_TYPE_MODULE,
      use: {
        loader: 'babel-loader',
        options: {
          babelrc: false,
          configFile: false,
          presets: [
            [
              '@babel/preset-env',
              { modules: 'commonjs', targets: BROWSER_TARGETS },
            ],
          ],
        },
      },
    },
    {
      test: /\.m?js$/,
      exclude: (resource) =>
        resource === CONTENT_TYPE_MODULE ||
        /node_modules[\\/]core-js/.test(resource),
      use: {
        loader: 'babel-loader',
        options: {
          babelrc: false,
          configFile: path.resolve(__dirname, '.babelrc'),
        },
      },
    },
    {
      test: /\.css$/,
      use: path.resolve(__dirname, 'scripts/dev/css-source-loader.js'),
    },
  ];

  const main = {
    mode,
    target: ['web', 'es5'],
    entry: {
      main: './src/main.js',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      chunkFilename: '[name].js',
    },
    optimization: {
      // Webpack 5.109 can omit its require runtime when a concatenated entry
      // contains a wrapped CommonJS module such as content-type.
      concatenateModules: false,
      minimizer: [
        new TerserPlugin({
          extractComments: false,
          terserOptions,
        }),
      ],
    },
    module: {
      rules,
    },
    resolve: {
      alias: {
        'json-with-bigint$': path.resolve(
          __dirname,
          'src/jsonCompatibility.js',
        ),
      },
      fallback: {
        path: path.resolve(__dirname, 'src/pathBrowser.js'),
      },
    },
    plugins: [
      new webpack.DefinePlugin({
        'process.env.ACODE_GITHUB_CLIENT_ID': JSON.stringify(
          githubAuth.clientId,
        ),
        'process.env.ACODE_GITHUB_INSTALL_URL': JSON.stringify(
          githubAuth.installUrl,
        ),
      }),
      {
        apply: (compiler) => {
          compiler.hooks.afterEmit.tapPromise('pack-zip', async () => {
            const outputFile = await packZip();
            console.log(`${path.basename(outputFile)} written.`);
          });
        },
      },
    ],
  };

  return [main];
};
