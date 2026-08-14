import { GitHubAuthError } from './errors';

export function parseTokenResponse(value, now) {
  if (
    !value ||
    typeof value !== 'object' ||
    !isNonEmptyString(value.access_token) ||
    (value.token_type !== undefined &&
      String(value.token_type).toLowerCase() !== 'bearer')
  ) {
    throw new GitHubAuthError('malformed-response');
  }

  const accessExpiresAt = expirationFromSeconds(value.expires_in, now);
  const hasRefreshToken = value.refresh_token !== undefined;
  const hasRefreshExpiry = value.refresh_token_expires_in !== undefined;
  if (hasRefreshToken !== hasRefreshExpiry) {
    throw new GitHubAuthError('malformed-response');
  }

  let refreshToken = null;
  let refreshExpiresAt = null;
  if (hasRefreshToken) {
    if (!isNonEmptyString(value.refresh_token)) {
      throw new GitHubAuthError('malformed-response');
    }
    refreshToken = value.refresh_token;
    refreshExpiresAt = expirationFromSeconds(
      value.refresh_token_expires_in,
      now,
      true,
    );
  }

  return {
    accessExpiresAt,
    accessToken: value.access_token,
    refreshExpiresAt,
    refreshToken,
  };
}

function expirationFromSeconds(seconds, now, required = false) {
  if (seconds === undefined && !required) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new GitHubAuthError('malformed-response');
  }
  return now + seconds * 1_000;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
