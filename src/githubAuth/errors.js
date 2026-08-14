const ERROR_MESSAGES = {
  cancelled: 'GitHub sign-in was cancelled.',
  configuration: 'GitHub sign-in is not configured.',
  denied: 'GitHub sign-in was denied.',
  expired: 'GitHub sign-in expired.',
  'invalid-session': 'The saved GitHub session is invalid.',
  'invalid-token': 'GitHub rejected the credential.',
  internal: 'Acode could not start the GitHub authentication request.',
  'malformed-response': 'GitHub returned an invalid authentication response.',
  network: 'GitHub authentication could not be reached.',
  'refresh-revoked': 'The GitHub session must be reconnected.',
  storage: 'The GitHub session could not be saved in local storage.',
  unavailable: 'GitHub authentication is unavailable.',
};

export class GitHubAuthError extends Error {
  constructor(kind, { nativeCode, operation, phase, transport } = {}) {
    super(ERROR_MESSAGES[kind] || ERROR_MESSAGES.network);
    this.name = 'GitHubAuthError';
    this.kind = kind;
    this.code = `github-auth/${kind}`;
    if (AUTH_OPERATIONS.has(operation)) this.operation = operation;
    if (AUTH_TRANSPORTS.has(transport)) this.transport = transport;
    if (AUTH_PHASES.has(phase)) this.phase = phase;
    if (Number.isInteger(nativeCode) && nativeCode >= -8 && nativeCode <= -1) {
      this.nativeCode = nativeCode;
    }
  }
}

const AUTH_OPERATIONS = new Set([
  'device-code',
  'device-token',
  'token-refresh',
]);
const AUTH_TRANSPORTS = new Set(['native', 'web']);
const AUTH_PHASES = new Set([
  'redirect-disable',
  'redirect-read',
  'redirect-restore',
  'request-create',
]);

export function isAuthenticationError(error) {
  return (
    error?.kind === 'authentication' ||
    error?.code === 'github/authentication' ||
    error?.status === 401
  );
}
