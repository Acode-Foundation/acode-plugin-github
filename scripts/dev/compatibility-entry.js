import {
  GITHUB_SESSION_STORAGE_KEY,
  GitHubSessionStore,
} from '../../src/githubAuth/sessionStore';
import { createGitHubServiceFactory } from '../../src/githubNativeFetch';

globalThis.runGitHubCompatibilityProbe = async (http) => {
  const values = {};
  const storage = {
    getItem(key) {
      return values[key] || null;
    },
    removeItem(key) {
      delete values[key];
    },
    setItem(key, value) {
      values[key] = value;
    },
  };
  const session = {
    accessExpiresAt: null,
    accessToken: 'compatibility-token',
    accountId: 1,
    avatarUrl: null,
    kind: 'pat',
    login: 'octocat',
    refreshExpiresAt: null,
    refreshToken: null,
    version: 1,
  };
  const sessionStore = new GitHubSessionStore({ storage });
  await sessionStore.save(session);
  const restored = await sessionStore.load();
  const client = createGitHubServiceFactory({ http })('native-token');
  const user = await client.getAuthenticatedUser();
  return {
    record: values[GITHUB_SESSION_STORAGE_KEY],
    restored,
    user,
  };
};
