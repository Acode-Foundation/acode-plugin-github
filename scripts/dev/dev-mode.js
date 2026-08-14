const GITHUB_AUTH_ENV_KEYS = Object.freeze([
  'ACODE_GITHUB_CLIENT_ID',
  'ACODE_GITHUB_INSTALL_URL',
]);

function parseDevelopmentOptions(args = process.argv.slice(2)) {
  if (!Array.isArray(args)) {
    throw new TypeError('Development options must be an array.');
  }
  const releaseCount = args.filter(
    (argument) => argument === '--release',
  ).length;
  const unsupported = args.find((argument) => argument !== '--release');
  if (unsupported) {
    throw new Error(`Unsupported development option: ${unsupported}.`);
  }
  if (releaseCount > 1) {
    throw new Error('Development option --release may only be provided once.');
  }

  const release = releaseCount === 1;
  return Object.freeze({
    envFile: release ? '.env' : '.env.local',
    label: release ? 'Release watch' : 'Development watch',
    mode: release ? 'production' : 'development',
    release,
  });
}

function parseResolvedMode(args = process.argv.slice(2)) {
  if (
    args.length !== 1 ||
    !/^--mode=(?:development|production)$/.test(args[0])
  ) {
    throw new Error(
      'Webpack watch requires --mode=development or --mode=production.',
    );
  }
  return args[0].slice('--mode='.length);
}

function getShellOverrides(environment = process.env) {
  return GITHUB_AUTH_ENV_KEYS.filter((key) => Object.hasOwn(environment, key));
}

module.exports = {
  GITHUB_AUTH_ENV_KEYS,
  getShellOverrides,
  parseDevelopmentOptions,
  parseResolvedMode,
};
