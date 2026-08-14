const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getGitHubAuthBuildConfig,
  loadBuildEnvironment,
} = require('../scripts/dev/github-auth-config');

test('GitHub App settings are required for every build', () => {
  assert.throws(() => getGitHubAuthBuildConfig({}), /ACODE_GITHUB_CLIENT_ID/);
  assert.throws(
    () =>
      getGitHubAuthBuildConfig({
        ACODE_GITHUB_CLIENT_ID: 'Iv1.example',
      }),
    /ACODE_GITHUB_INSTALL_URL/,
  );
});

test('GitHub App settings are accepted through environment overrides', () => {
  assert.deepEqual(
    getGitHubAuthBuildConfig({
      ACODE_GITHUB_CLIENT_ID: '  Iv1.example  ',
      ACODE_GITHUB_INSTALL_URL:
        '  https://github.com/apps/acode-github-development/installations/new  ',
    }),
    {
      clientId: 'Iv1.example',
      installUrl:
        'https://github.com/apps/acode-github-development/installations/new',
    },
  );
});

test('builds fail closed when the GitHub installation URL is invalid', () => {
  assert.throws(
    () =>
      getGitHubAuthBuildConfig({
        ACODE_GITHUB_CLIENT_ID: 'Iv1.example',
        ACODE_GITHUB_INSTALL_URL: 'http://example.com/app',
      }),
    /ACODE_GITHUB_INSTALL_URL/,
  );
});

test('development and production load only their assigned env file', () => {
  const files = {
    development: '/project/.env.local',
    production: '/project/.env',
  };
  const contents = new Map([
    [
      files.production,
      'ACODE_GITHUB_CLIENT_ID=base\nACODE_GITHUB_INSTALL_URL=https://github.com/apps/base/installations/new\n',
    ],
    [
      files.development,
      'ACODE_GITHUB_CLIENT_ID=local\nACODE_GITHUB_INSTALL_URL=https://github.com/apps/local/installations/new\n',
    ],
  ]);
  const reads = [];
  const readFile = (file) => {
    reads.push(file);
    return contents.get(file);
  };

  const development = loadBuildEnvironment(
    'development',
    {},
    {
      files,
      readFile,
    },
  );
  const production = loadBuildEnvironment(
    'production',
    {},
    {
      files,
      readFile,
    },
  );

  assert.deepEqual(development, {
    ACODE_GITHUB_CLIENT_ID: 'local',
    ACODE_GITHUB_INSTALL_URL: 'https://github.com/apps/local/installations/new',
  });
  assert.deepEqual(production, {
    ACODE_GITHUB_CLIENT_ID: 'base',
    ACODE_GITHUB_INSTALL_URL: 'https://github.com/apps/base/installations/new',
  });
  assert.deepEqual(reads, [files.development, files.production]);
});

test('shell variables override only the mode-selected env file', () => {
  const files = {
    development: '/project/.env.local',
    production: '/project/.env',
  };
  const reads = [];
  const environment = loadBuildEnvironment(
    'production',
    { ACODE_GITHUB_CLIENT_ID: 'shell' },
    {
      files,
      readFile(file) {
        reads.push(file);
        return 'ACODE_GITHUB_CLIENT_ID=base\nACODE_GITHUB_INSTALL_URL=https://github.com/apps/base/installations/new\n';
      },
    },
  );

  assert.deepEqual(environment, {
    ACODE_GITHUB_CLIENT_ID: 'shell',
    ACODE_GITHUB_INSTALL_URL: 'https://github.com/apps/base/installations/new',
  });
  assert.deepEqual(reads, [files.production]);
});

test('missing files and unsupported build modes fail closed', () => {
  const files = {
    development: '/project/.env.local',
    production: '/project/.env',
  };
  const missingFile = () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };

  assert.deepEqual(
    loadBuildEnvironment(
      'development',
      { FROM_SHELL: 'yes' },
      {
        files,
        readFile: missingFile,
      },
    ),
    { FROM_SHELL: 'yes' },
  );
  assert.throws(
    () => loadBuildEnvironment('staging', {}, { files }),
    /Unsupported GitHub App build mode: staging/,
  );
});
