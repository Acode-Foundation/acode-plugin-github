import { GitHubAuthManager } from './authManager';
import { githubAuthConfig } from './config';
import { GitHubDeviceFlow } from './deviceFlow';
import { NativeHttpTransport } from './nativeHttp';
import { GitHubSessionStore } from './sessionStore';

export { githubAuthConfig };

export function createDefaultGitHubAuthManager(
  config = githubAuthConfig,
  { createGitHub, storage, store } = {},
) {
  const transport = new NativeHttpTransport();
  const deviceFlow = new GitHubDeviceFlow({
    clientId: config.clientId,
    transport,
  });
  const sessionStore =
    store ||
    new GitHubSessionStore({
      storage,
    });
  return new GitHubAuthManager({
    clientId: config.clientId,
    createGitHub,
    deviceFlow,
    store: sessionStore,
    transport,
  });
}
