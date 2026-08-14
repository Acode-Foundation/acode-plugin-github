const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { projectRoot } = require('./paths');

const BUILD_ENV_FILES = Object.freeze({
  development: path.join(projectRoot, '.env.local'),
  production: path.join(projectRoot, '.env'),
});

function loadBuildEnvironment(
  mode,
  environment = process.env,
  { files = BUILD_ENV_FILES, readFile = fs.readFileSync } = {},
) {
  const file = files[mode];
  if (!file) {
    throw new Error(`Unsupported GitHub App build mode: ${mode}.`);
  }

  let fileEnvironment = {};
  try {
    fileEnvironment = parseEnv(readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return { ...fileEnvironment, ...environment };
}

function getGitHubAuthBuildConfig(environment = process.env) {
  const config = {
    clientId: environment.ACODE_GITHUB_CLIENT_ID?.trim() || '',
    installUrl: environment.ACODE_GITHUB_INSTALL_URL?.trim() || '',
  };

  if (!config.clientId) {
    throw new Error('GitHub App auth requires ACODE_GITHUB_CLIENT_ID.');
  }
  if (!isGitHubUrl(config.installUrl)) {
    throw new Error(
      'GitHub App auth requires a valid ACODE_GITHUB_INSTALL_URL.',
    );
  }
  return config;
}

function isGitHubUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      /^\/apps\/[^/]+\/installations\/new\/?$/.test(url.pathname)
    );
  } catch (_error) {
    return false;
  }
}

module.exports = { getGitHubAuthBuildConfig, loadBuildEnvironment };
