const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Window } = require('happy-dom');

const { withSourceModule } = require('./helpers/load-source-module');

test('page installs without a sidebar and first install opens sign-in once', async () => {
  const harness = createHarness();
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage, safeGitHubUrl }) => {
      const originalLead = harness.page.lead;
      const originalLeadOnClick = originalLead.onclick;
      const originalOnHide = harness.page.onhide;
      const githubPage = new GitHubPage({
        config: harness.config,
        plugin: harness.plugin,
      });
      assert.equal(githubPage.install(harness.page), true);
      assert.equal(harness.page.lead, originalLead);
      assert.equal(harness.page.onhide, originalOnHide);
      assert.equal(harness.sidebarRequests, 0);
      assert.equal(await githubPage.showFirstUse(true), true);
      await settle();

      assert.equal(harness.page.showCalls, 1);
      assert.equal(harness.page.querySelectorAll('.g-si button').length, 2);
      for (const action of harness.page.querySelectorAll('.g-ha')) {
        assert.equal(action.hidden, true);
        assert.equal(action.classList.contains('hidden'), true);
      }
      assert.equal(harness.page.querySelector('.g-si.g-c'), null);
      assert.equal(
        harness.page.querySelector('.g-si h2').textContent,
        'Sign in to GitHub',
      );
      assert.notEqual(harness.page.querySelector('.g-si .g-logo'), null);
      assert.match(
        harness.page.querySelector('.g-si .g-auth-copy').textContent,
        /browse repositories and gists/i,
      );
      assert.equal(
        findButton(harness.page, 'Sign in with GitHub').textContent.trim(),
        'Sign in with GitHub',
      );
      assert.equal(
        findButton(harness.page, 'Sign in with GitHub').classList.contains(
          'primary',
        ),
        true,
      );
      findButton(harness.page, 'Use personal access token').click();
      await settle();
      assert.equal(harness.patPrompts, 1);
      assert.equal(safeGitHubUrl('https://github.com/login/device'), true);
      assert.equal(safeGitHubUrl('https://example.com/login'), false);

      harness.page.hide();
      assert.equal(await githubPage.showFirstUse(false), false);
      githubPage.destroy();
      assert.equal(harness.page.lead, originalLead);
      assert.equal(originalLead.onclick, originalLeadOnClick);
      assert.equal(
        harness.window.document.head.querySelector(
          'style[data-plugin="github-page"]',
        ),
        null,
      );
    },
  );
});

test('older Acode shows only the legacy PAT authentication action', async () => {
  const harness = createHarness();
  harness.plugin.authenticationMode = 'legacy';
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle();

      const actions = [...harness.page.querySelectorAll('.g-si button')];
      assert.equal(actions.length, 1);
      assert.equal(actions[0].textContent.trim(), 'Use personal access token');
      assert.equal(findButton(harness.page, 'Sign in with GitHub'), null);
      assert.match(
        harness.page.querySelector('.g-si .g-mu').textContent,
        /encrypted in the plugin's local storage/i,
      );
      actions[0].click();
      await settle();
      assert.equal(harness.patPrompts, 1);
      githubPage.destroy();
    },
  );
});

test('legacy PAT accounts omit GitHub App reconnect controls', async () => {
  const harness = createHarness({ signedIn: true });
  harness.plugin.authenticationMode = 'legacy';
  harness.setAccount({
    avatarUrl: null,
    id: 1,
    kind: 'pat',
    login: 'octocat',
  });
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open('account');
      await settle(3);

      assert.equal(findButton(harness.page, 'Reconnect or switch'), null);
      assert.notEqual(
        findButton(harness.page, 'Replace personal access token'),
        null,
      );
      assert.equal(findButton(harness.page, 'Add an installation'), null);
      githubPage.destroy();
    },
  );
});

test('a provisional PAT renders the workspace with placeholder identity', async () => {
  const harness = createHarness({ signedIn: true });
  harness.setAccount({
    avatarUrl: null,
    id: 'legacy-pat',
    kind: 'pat',
    login: 'GitHub',
    pendingMigration: true,
  });
  harness.plugin.startupError = Object.assign(new Error('startup network'), {
    kind: 'network',
  });

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open('account');
      await settle(3);

      assert.equal(harness.page.querySelector('.g-si'), null);
      assert.equal(harness.page.querySelector('.g-i h2').textContent, 'GitHub');
      assert.match(
        harness.page.querySelector('.g-i .g-mu').textContent,
        /finishing setup/i,
      );
      assert.notEqual(
        harness.page.querySelector('.g-i .icon.account_circle'),
        null,
      );
      assert.doesNotMatch(harness.page.textContent, /could not be reached/i);
      githubPage.destroy();
    },
  );
});

test('repositories and gists load lazily with local search and tab state', async () => {
  const harness = createHarness({ signedIn: true });
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle(4);

      assert.equal(harness.calls.repositories, 1);
      assert.equal(harness.calls.gists, 0);
      assert.notEqual(findButton(harness.page, 'alpha'), null);
      assert.notEqual(findButton(harness.page, 'beta'), null);

      const searchAction = harness.page.querySelector(
        '[data-action="github-search"]',
      );
      assert.equal(searchAction.getAttribute('aria-label'), 'Search GitHub');
      assert.equal(searchAction.hidden, false);
      assert.equal(searchAction.classList.contains('hidden'), false);
      searchAction.click();
      const search = harness.page.querySelector(
        '[data-action="github-search-input"]',
      );
      search.value = 'acode';
      search.dispatchEvent(new harness.window.Event('input'));
      assert.equal(findButton(harness.page, 'alpha'), null);
      assert.notEqual(findButton(harness.page, 'beta'), null);
      assert.equal(harness.calls.repositories, 1);

      findButton(harness.page, 'beta').click();
      await settle(4);
      assert.equal(searchAction.hidden, true);
      assert.equal(searchAction.classList.contains('hidden'), true);
      assert.equal(harness.page.querySelector('[role="search"]'), null);
      harness.page.lead.click();
      assert.equal(searchAction.hidden, false);
      harness.page.querySelector('[data-action="github-search"]').click();
      assert.equal(
        harness.page.querySelector('[data-action="github-search-input"]').value,
        'acode',
      );
      harness.page.querySelector('[data-action="github-close-search"]').click();
      assert.notEqual(findButton(harness.page, 'alpha'), null);

      const repositoryTab = findButton(harness.page, 'Repositories');
      repositoryTab.dispatchEvent(
        new harness.window.KeyboardEvent('keydown', {
          bubbles: true,
          key: 'ArrowRight',
        }),
      );
      await settle(4);
      assert.equal(harness.calls.gists, 1);
      assert.notEqual(findButton(harness.page, 'Notes'), null);
      assert.equal(searchAction.hidden, true);
      assert.equal(searchAction.classList.contains('hidden'), true);
      assert.equal(
        harness.page
          .querySelector('#github-tab-gists')
          .getAttribute('aria-selected'),
        'true',
      );
      harness.page.querySelector('[aria-label="Refresh GitHub"]').click();
      await settle(4);
      assert.equal(harness.calls.gists, 2);
      assert.equal(harness.calls.repositories, 1);
      githubPage.destroy();
    },
  );
});

test('drill-down opens branches and gist files, then hides the page', async () => {
  const harness = createHarness({ signedIn: true });
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle(4);

      findButton(harness.page, 'alpha').click();
      await settle(4);
      assert.equal(harness.page.querySelector('.g-w').dataset.route, 'detail');
      assert.equal(harness.page.querySelector('.g-d .g-h').tagName, 'SECTION');
      const branches = [...harness.page.querySelectorAll('.g-d .g-rt')].map(
        (node) => node.textContent,
      );
      assert.deepEqual(branches, [
        'main',
        'dependabot/npm_and_yarn/plugin-transform-runtime-8.0.1',
      ]);
      assert.notEqual(harness.page.querySelector('.g-d .g-bl'), null);
      assert.equal(harness.page.querySelector('.g-m .g-bl'), null);
      assert.equal(
        harness.page.querySelectorAll('.g-d .icon.share').length,
        branches.length,
      );
      assert.equal(harness.page.querySelector('.g-d .g-bl .text'), null);
      assert.equal(harness.page.querySelector('.g-d .g-bl .value'), null);
      harness.page.lead.click();
      assert.equal(harness.page.querySelector('.g-w').dataset.route, 'root');
      findButton(harness.page, 'alpha').click();
      await settle(4);
      findButton(harness.page.querySelector('.g-d'), 'main').click();
      await settle();
      assert.deepEqual(harness.openedFolders, [['octocat', 'alpha', 'main']]);
      assert.equal(harness.page.hideCalls, 1);

      await githubPage.open('gists');
      await settle(4);
      findButton(harness.page, 'Notes').click();
      await settle(4);
      assert.notEqual(
        harness.page.querySelector('.g-d .icon.document-text'),
        null,
      );
      assert.equal(harness.page.querySelector('.g-d .g-bl'), null);
      findButton(harness.page.querySelector('.g-d'), 'notes.md').click();
      assert.deepEqual(harness.openedFiles, [['gist-1', 'notes.md']]);
      assert.equal(harness.page.hideCalls, 2);
      githubPage.destroy();
    },
  );
});

test('native title-bar controls handle back, refresh, and account actions', async () => {
  const harness = createHarness({ signedIn: true });
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const originalLead = harness.page.lead;
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle(4);

      const refresh = harness.page.querySelector(
        '[data-action="github-refresh"]',
      );
      const search = harness.page.querySelector(
        '[data-action="github-search"]',
      );
      const account = harness.page.querySelector(
        '[data-action="github-account"]',
      );
      assert.equal(search.tagName, 'BUTTON');
      assert.equal(search.type, 'button');
      assert.equal(search.getAttribute('aria-label'), 'Search GitHub');
      assert.equal(refresh.tagName, 'BUTTON');
      assert.equal(refresh.type, 'button');
      assert.equal(refresh.getAttribute('aria-label'), 'Refresh GitHub');
      assert.equal(account.tagName, 'BUTTON');
      assert.equal(account.type, 'button');
      assert.equal(account.getAttribute('aria-label'), 'GitHub account');
      for (const action of [search, refresh, account]) {
        assert.notEqual(action.dataset.action, undefined);
      }
      assert.equal(search.hidden, false);
      assert.equal(refresh.hidden, false);
      assert.equal(account.hidden, false);

      refresh.click();
      await settle(4);
      assert.equal(harness.calls.repositories, 2);
      account.click();
      await settle(3);
      assert.equal(harness.page.dataset.title, 'GitHub account');
      assert.equal(harness.page.querySelector('.g-w').dataset.route, 'account');
      assert.equal(search.hidden, true);
      assert.equal(search.classList.contains('hidden'), true);
      originalLead.click();
      assert.equal(harness.page.dataset.title, 'GitHub');
      assert.equal(harness.page.querySelector('.g-w').dataset.route, 'root');
      assert.equal(search.hidden, false);
      assert.equal(harness.page.hideCalls, 0);
      originalLead.click();
      assert.equal(harness.page.hideCalls, 1);
      githubPage.destroy();
    },
  );
});

test('account avatar keeps a visible fallback until the image loads', async () => {
  const harness = createHarness({
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    signedIn: true,
  });
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle(4);

      const account = harness.page.querySelector(
        '[data-action="github-account"]',
      );
      assert.notEqual(account.querySelector('.icon.account_circle.g-hv'), null);
      assert.equal(account.querySelector('img'), null);

      const image = harness.createdImages.at(-1);
      image.dispatchEvent(new harness.window.Event('load'));
      assert.equal(account.querySelector('img.g-hv'), image);
      assert.equal(account.querySelector('.icon.account_circle'), null);
      githubPage.destroy();
    },
  );
});

test('phone titles follow details while wide layouts retain the GitHub title', async () => {
  for (const [wide, expectedTitle] of [
    [false, 'alpha'],
    [true, 'GitHub'],
  ]) {
    const harness = createHarness({ signedIn: true, wide });
    await withSourceModule(
      'githubPage.js',
      harness.globals,
      async ({ GitHubPage }) => {
        const githubPage = installPage(harness, GitHubPage);
        await githubPage.open();
        await settle(4);
        findButton(harness.page, 'alpha').click();
        await settle(4);
        assert.equal(harness.page.dataset.title, expectedTitle);
        githubPage.destroy();
      },
    );
  }
});

test('successful refresh and back navigation clear stale account errors', async () => {
  const harness = createHarness({ signedIn: true });
  harness.plugin.signInWithGitHub = async () => {
    throw new Error('internal detail must stay private');
  };
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open('account');
      await settle(3);
      findButton(harness.page, 'Reconnect or switch').click();
      await settle(4);
      assert.match(
        harness.page.textContent,
        /Acode could not process GitHub data/,
      );
      assert.equal(
        harness.page.textContent.includes('internal detail must stay private'),
        false,
      );

      harness.page.querySelector('[data-action="github-refresh"]').click();
      await settle(4);
      assert.equal(
        harness.page.textContent.includes(
          'Acode could not process GitHub data',
        ),
        false,
      );

      findButton(harness.page, 'Reconnect or switch').click();
      await settle(4);
      harness.page.lead.click();
      assert.equal(
        harness.page.textContent.includes(
          'Acode could not process GitHub data',
        ),
        false,
      );
      githubPage.destroy();
    },
  );
});

test('repository failures stay scoped while gists and account remain usable', async () => {
  const error = Object.assign(new Error('secret response'), {
    kind: 'network',
    operation: 'installations',
    status: 503,
    transport: 'native',
  });
  const harness = createHarness({ signedIn: true });
  harness.plugin.getRepositories = async () => {
    harness.calls.repositories += 1;
    throw error;
  };

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle(4);
      assert.match(
        harness.page.textContent,
        /Diagnostic: installations\/native\/network\/503/,
      );
      assert.equal(harness.page.textContent.includes('secret response'), false);

      findButton(harness.page, 'Gists').click();
      await settle(4);
      assert.notEqual(findButton(harness.page, 'Notes'), null);
      await githubPage.openAccount();
      await settle(3);
      assert.match(harness.page.textContent, /octocat/);
      assert.notEqual(findButton(harness.page, 'Reconnect or switch'), null);
      githubPage.destroy();
    },
  );
});

test('zero installations offers repository access without blocking gists', async () => {
  const harness = createHarness({ signedIn: true });
  harness.plugin.getInstallations = async () => [];
  harness.plugin.getRepositories = async () => [];
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle(4);
      assert.notEqual(
        findButton(harness.page, 'Choose repositories on GitHub'),
        null,
      );
      assert.equal(
        harness.page.querySelector('[data-action="github-search"]').hidden,
        true,
      );
      findButton(harness.page, 'Gists').click();
      await settle(4);
      assert.notEqual(findButton(harness.page, 'Notes'), null);
      githubPage.destroy();
    },
  );
});

test('device flow is accessible in-page and copies its code', async () => {
  const harness = createHarness();
  let rejectSignIn;
  harness.plugin.signInWithGitHub = ({ onCode }) => {
    onCode({
      expiresAt: Date.now() + 60_000,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
    });
    return new Promise((_resolve, reject) => {
      rejectSignIn = reject;
    });
  };
  harness.plugin.cancelSignIn = () => {
    const error = new Error('cancelled');
    error.kind = 'cancelled';
    rejectSignIn(error);
  };

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      findButton(harness.page, 'Sign in with GitHub').click();
      await settle();
      assert.equal(harness.activeCountdowns, 1);
      assert.match(harness.page.textContent, /ABCD-EFGH/);
      assert.equal(
        harness.page.querySelector('.g-dv h2').textContent,
        'Finish signing in',
      );
      assert.notEqual(harness.page.querySelector('.g-dv .g-logo'), null);
      assert.equal(
        findButton(harness.page, 'Cancel').classList.contains('text'),
        true,
      );

      findButton(harness.page, 'Copy code and open GitHub').click();
      await settle();
      assert.deepEqual(harness.copied, ['ABCD-EFGH']);
      assert.deepEqual(harness.opened, ['https://github.com/login/device']);
      findButton(harness.page, 'Cancel').click();
      await settle(3);
      assert.equal(harness.activeCountdowns, 0);
      githubPage.destroy();
    },
  );
});

test('successful device authorization clears its countdown interval', async () => {
  const harness = createHarness();
  harness.plugin.signInWithGitHub = async ({ onCode }) => {
    onCode({
      expiresAt: Date.now() + 60_000,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
    });
    harness.setAccount({
      avatarUrl: null,
      id: 1,
      kind: 'github-app',
      login: 'octocat',
    });
  };

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      findButton(harness.page, 'Sign in with GitHub').click();
      await settle(4);
      assert.equal(harness.activeCountdowns, 0);
      githubPage.destroy();
    },
  );
});

test('authentication failures show only redacted native diagnostics', async () => {
  const harness = createHarness();
  harness.plugin.signInWithGitHub = async ({ onCode }) => {
    onCode({
      expiresAt: Date.now() + 60_000,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
    });
    throw Object.assign(new Error('TLS details and private request data'), {
      kind: 'network',
      nativeCode: -2,
      operation: 'device-code',
      transport: 'native',
    });
  };

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      findButton(harness.page, 'Sign in with GitHub').click();
      await settle(3);
      assert.match(
        harness.page.textContent,
        /Diagnostic: device-code\/native\/network\/-2/,
      );
      assert.equal(harness.page.textContent.includes('private request'), false);
      assert.equal(harness.activeCountdowns, 0);
      githubPage.destroy();
    },
  );
});

test('authentication setup failures identify only their safe bridge stage', async () => {
  const harness = createHarness();
  harness.plugin.signInWithGitHub = async () => {
    throw Object.assign(new Error('private native exception'), {
      kind: 'internal',
      operation: 'device-code',
      phase: 'request-create',
      transport: 'native',
    });
  };

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      findButton(harness.page, 'Sign in with GitHub').click();
      await settle(3);
      assert.match(
        harness.page.textContent,
        /Diagnostic: device-code\/native\/internal\/request-create/,
      );
      assert.equal(harness.page.textContent.includes('private native'), false);
      githubPage.destroy();
    },
  );
});

test('account content uses native sections and destructive actions use Acode menus', async () => {
  const harness = createHarness({ signedIn: true });
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.openAccount();
      await settle(4);

      const labels = [...harness.page.querySelectorAll('.g-d .g-sl')]
        .map((node) => node.textContent)
        .sort();
      assert.deepEqual(labels, ['Account', 'Repository access', 'Session']);
      assert.notEqual(findButton(harness.page, 'Reconnect or switch'), null);
      assert.notEqual(
        findButton(harness.page, 'Use personal access token'),
        null,
      );
      assert.notEqual(
        findButton(harness.page, 'Sign out on this device'),
        null,
      );

      await githubPage.open('gists');
      await settle(4);
      const more = harness.page.querySelector(
        '[aria-label="More actions for Notes"]',
      );
      more.click();
      const menu = harness.menus.at(-1);
      assert.equal(menu.showCalls, 1);
      assert.deepEqual(menu.items, [['Delete gist', '0']]);
      menu.select('0');
      await settle(4);
      assert.deepEqual(harness.deletedGists, ['gist-1']);
      assert.equal(harness.page.querySelector('.github-overflow'), null);
      githubPage.destroy();
    },
  );
});

test('installation resume uses the shared repository-access refresh', async () => {
  const harness = createHarness({ signedIn: true });
  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.openAccount();
      await settle(4);

      findButton(harness.page, 'Add an installation').click();
      assert.deepEqual(harness.opened, [harness.config.installUrl]);
      githubPage.handleResume();
      assert.equal(harness.calls.repositoryAccessRefresh, 1);

      await githubPage.handleResume(true);
      githubPage.handleResume();
      assert.equal(harness.calls.repositoryAccessRefresh, 1);
      githubPage.destroy();
    },
  );
});

test('account changes permanently invalidate older resource requests', async () => {
  const harness = createHarness({ signedIn: true });
  const accountA = deferred();
  const accountAInstallations = deferred();
  let installationLoads = 0;
  let repositoryLoads = 0;
  harness.plugin.getRepositories = async () => {
    repositoryLoads += 1;
    if (repositoryLoads === 1) return accountA.promise;
    return [repository('account-b-repository', 'account-b', 2)];
  };
  harness.plugin.getInstallations = async () => {
    installationLoads += 1;
    if (installationLoads === 1) return accountAInstallations.promise;
    return [{ account: { login: 'account-b' }, id: 2 }];
  };

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle();

      harness.setAccount({
        avatarUrl: null,
        id: 2,
        kind: 'github-app',
        login: 'account-b',
      });
      await githubPage.accountChanged();
      await settle(3);
      assert.notEqual(findButton(harness.page, 'account-b-repository'), null);
      await githubPage.openAccount();
      await settle(3);
      assert.match(harness.page.textContent, /account-b/);

      accountA.resolve([repository('account-a-repository', 'account-a', 1)]);
      accountAInstallations.resolve([
        { account: { login: 'account-a' }, id: 1 },
      ]);
      await settle(3);
      assert.equal(findButton(harness.page, 'account-a-repository'), null);
      assert.equal(harness.page.textContent.includes('account-a'), false);
      githubPage.destroy();
    },
  );
});

test('account changes invalidate stale gist page loads', async () => {
  const harness = createHarness({ signedIn: true });
  const accountA = deferred();
  let loads = 0;
  harness.plugin.getGists = async () => {
    loads += 1;
    if (loads === 1) return accountA.promise;
    return [{ description: 'Account B gist', files: {}, id: 'gist-b' }];
  };

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open('gists');
      await settle();

      harness.setAccount({
        avatarUrl: null,
        id: 2,
        kind: 'github-app',
        login: 'account-b',
      });
      await githubPage.accountChanged();
      await settle(3);
      assert.notEqual(findButton(harness.page, 'Account B gist'), null);

      accountA.resolve([
        { description: 'Account A gist', files: {}, id: 'gist-a' },
      ]);
      await settle(3);
      assert.equal(findButton(harness.page, 'Account A gist'), null);
      assert.notEqual(findButton(harness.page, 'Account B gist'), null);
      githubPage.destroy();
    },
  );
});

test('account changes invalidate stale repository and gist detail loads', async () => {
  for (const kind of ['repository', 'gist']) {
    const harness = createHarness({ signedIn: true });
    const accountA = deferred();
    if (kind === 'repository') {
      harness.plugin.getBranches = () => accountA.promise;
    } else {
      harness.plugin.getGistFiles = () => accountA.promise;
    }

    await withSourceModule(
      'githubPage.js',
      harness.globals,
      async ({ GitHubPage }) => {
        const githubPage = installPage(harness, GitHubPage);
        await githubPage.open(kind === 'repository' ? 'repositories' : 'gists');
        await settle(4);
        findButton(
          harness.page,
          kind === 'repository' ? 'alpha' : 'Notes',
        ).click();
        await settle();

        harness.setAccount({
          avatarUrl: null,
          id: 2,
          kind: 'github-app',
          login: 'account-b',
        });
        await githubPage.accountChanged();
        accountA.resolve([
          kind === 'repository'
            ? { name: 'account-a-stale-branch' }
            : 'account-a-stale-file.md',
        ]);
        await settle(4);
        assert.equal(
          harness.page.textContent.includes('account-a-stale'),
          false,
        );
        githubPage.destroy();
      },
    );
  }
});

test('overlapping refreshes commit only the newest resource request', async () => {
  const harness = createHarness({ signedIn: true });
  const first = deferred();
  const second = deferred();

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle(4);
      let refreshLoads = 0;
      harness.plugin.getRepositories = async () => {
        refreshLoads += 1;
        return refreshLoads === 1 ? first.promise : second.promise;
      };

      const refresh = harness.page.querySelector(
        '[data-action="github-refresh"]',
      );
      refresh.click();
      await settle();
      refresh.click();
      await settle();
      second.resolve([repository('newest-repository', 'octocat', 3)]);
      await settle(3);
      assert.notEqual(findButton(harness.page, 'newest-repository'), null);

      first.resolve([repository('stale-repository', 'octocat', 4)]);
      await settle(3);
      assert.equal(findButton(harness.page, 'stale-repository'), null);
      assert.notEqual(findButton(harness.page, 'newest-repository'), null);
      githubPage.destroy();
    },
  );
});

test('workspace stylesheet stays scoped to Acode primitives and theme tokens', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'githubPage.css'),
    'utf8',
  );
  assert.match(css, /\.github-page/);
  assert.match(css, /\.g-w \.g-ls/);
  assert.match(css, /var\(--(?:active|border|primary|secondary)-/);
  assert.match(css, /min-height: 44px/);
  assert.match(
    css,
    /\.g-a\s*{[^}]*gap: 10px;[^}]*padding: 10px 16px;[^}]*border-radius: 8px;/s,
  );
  assert.match(
    css,
    /\.g-si,\s*\.g-dv\s*{[^}]*padding: 40px 24px;[^}]*background: var\(--g5\);/s,
  );
  assert.match(css, /\.g-logo\s*{[^}]*width: 72px;[^}]*height: 72px;/s);
  assert.doesNotMatch(css, /github-launcher-icon/);
  assert.match(
    css,
    /\.github-page\s*{[^}]*color: var\(--g2\);[^}]*background: var\(--g5\);/s,
  );
  assert.match(
    css,
    /\.g-c,[^{]+{[^}]*color: var\(--g6\);[^}]*background: var\(--popup-background-color\);/s,
  );
  assert.match(css, /\.g-o\s*{[^}]*color: var\(--g6\);/s);
  assert.match(
    css,
    /\.g-o\s*{[^}]*min-height: 64px;[^}]*gap: 12px;[^}]*padding: 10px 16px;/s,
  );
  assert.match(css, /\.g-rc\s*{[^}]*flex-direction: column;/s);
  assert.match(
    css,
    /\.g-w \.g-bl \.g-rt\s*{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;[^}]*-webkit-line-clamp: 2;/s,
  );
  assert.match(css, /\.g-m,[^{]+{[^}]*overflow: hidden auto;/s);
  assert.match(css, /\.g-b\s*{[^}]*flex-shrink: 0;/s);
  assert.doesNotMatch(css, /\b(?:position|z-index)\s*:/);
  assert.doesNotMatch(
    css,
    /#[\da-f]{3,8}\b|rgba?\(|hsla?\(|:\s*(?:black|white)\b/i,
  );
  assert.doesNotMatch(css, /\.github-overflow|\.github-button/);
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'githubPage.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /className: ['"](?:container|value)['"]/);
});

test('branch layout overrides Acode list flex and action overflow', () => {
  const window = new Window();
  const acodeStyle = window.document.createElement('style');
  acodeStyle.textContent = `
    .list > .list-item .container .text { flex: 1.2; position: absolute; }
    .list > .list-item .container .value { flex: 0.8; position: absolute; }
    .list > .list-item [data-action] { overflow: auto !important; }
  `;
  const pluginStyle = window.document.createElement('style');
  pluginStyle.textContent = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'githubPage.css'),
    'utf8',
  );
  window.document.head.append(acodeStyle, pluginStyle);

  const page = window.document.createElement('section');
  page.className = 'github-page';
  page.innerHTML = `
    <div class="g-w">
      <div class="g-m"></div>
      <div class="g-d">
        <div class="list g-ls g-bl">
          <div class="list-item g-it">
            <button class="g-o" data-action="open">
              <span class="icon share"></span>
              <span class="g-rc">
              <span class="g-rh">
                  <span class="g-rt">averylongunbrokenbranchnamethatcannotfit</span>
                  <span class="g-b">Default</span>
                </span>
              <span class="g-rm">Primary branch</span>
              </span>
              <span class="icon arrow_forward_ios"></span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  window.document.body.append(page);

  const row = page.querySelector('.g-o');
  const titleLine = page.querySelector('.g-rh');
  const metadata = page.querySelector('.g-rm');
  const title = page.querySelector('.g-rt');
  const content = page.querySelector('.g-rc');
  assert.equal(window.getComputedStyle(row).overflow, 'hidden');
  assert.notEqual(window.getComputedStyle(titleLine).position, 'absolute');
  assert.notEqual(window.getComputedStyle(metadata).position, 'absolute');
  assert.equal(metadata.classList.contains('value'), false);
  assert.equal(titleLine.classList.contains('text'), false);
  assert.equal(content.classList.contains('container'), false);
  assert.equal(window.getComputedStyle(title).overflowWrap, 'anywhere');
  assert.equal(
    window.getComputedStyle(page.querySelector('.g-m')).overflow,
    'hidden auto',
  );
  assert.equal(
    window.getComputedStyle(page.querySelector('.g-d')).overflow,
    'hidden auto',
  );
});

test('repository detail heading does not inherit Acode page-header layout', async () => {
  const harness = createHarness({ signedIn: true });
  const acodeStyle = harness.window.document.createElement('style');
  acodeStyle.textContent = `
    wc-page header { position: sticky; width: 100%; }
  `;
  harness.window.document.head.append(acodeStyle);

  await withSourceModule(
    'githubPage.js',
    harness.globals,
    async ({ GitHubPage }) => {
      const githubPage = installPage(harness, GitHubPage);
      await githubPage.open();
      await settle(4);
      findButton(harness.page, 'alpha').click();
      await settle(4);

      const nativeHeader = harness.page.querySelector(':scope > header');
      const detailHeading = harness.page.querySelector('.g-d .g-h');
      assert.equal(
        harness.window.getComputedStyle(nativeHeader).position,
        'sticky',
      );
      assert.notEqual(
        harness.window.getComputedStyle(detailHeading).position,
        'sticky',
      );
      assert.equal(detailHeading.tagName, 'SECTION');
      assert.notEqual(detailHeading, nativeHeader);
      githubPage.destroy();
    },
  );
});

test('workspace surfaces resolve light, dark, and custom Acode themes', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'githubPage.css'),
    'utf8',
  );
  const themes = [
    [
      'rgb(255, 255, 255)',
      'rgb(25, 25, 25)',
      'rgb(248, 248, 248)',
      'rgb(35, 35, 35)',
    ],
    [
      'rgb(20, 20, 20)',
      'rgb(240, 240, 240)',
      'rgb(32, 32, 32)',
      'rgb(232, 232, 232)',
    ],
    [
      'rgb(30, 25, 55)',
      'rgb(244, 230, 255)',
      'rgb(45, 35, 75)',
      'rgb(255, 240, 210)',
    ],
  ];

  for (const [surface, textColor, popup, popupText] of themes) {
    const window = new Window();
    const style = window.document.createElement('style');
    style.textContent = css;
    window.document.head.append(style);
    const root = window.document.documentElement.style;
    root.setProperty('--secondary-color', surface);
    root.setProperty('--secondary-text-color', textColor);
    root.setProperty('--popup-background-color', popup);
    root.setProperty('--popup-text-color', popupText);
    root.setProperty('--active-color', textColor);
    root.setProperty('--active-icon-color', surface);
    root.setProperty('--button-background-color', textColor);
    root.setProperty('--button-text-color', surface);

    const page = window.document.createElement('section');
    page.className = 'github-page';
    const card = window.document.createElement('section');
    card.className = 'g-c';
    const row = window.document.createElement('button');
    row.className = 'g-o';
    const metadata = window.document.createElement('span');
    metadata.className = 'g-mu';
    const action = window.document.createElement('button');
    action.className = 'g-a';
    card.append(row, metadata);
    page.append(card, action);
    window.document.body.append(page);

    assert.equal(window.getComputedStyle(page).color, textColor);
    assert.equal(window.getComputedStyle(page).background, surface);
    assert.equal(window.getComputedStyle(card).color, popupText);
    assert.equal(window.getComputedStyle(card).background, popup);
    assert.equal(window.getComputedStyle(row).color, popupText);
    assert.equal(window.getComputedStyle(action).color, textColor);
    assert.equal(window.getComputedStyle(action).background, surface);
  }
});

test('workspace uses only Acode-supported icon classes', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'githubPage.js'),
    'utf8',
  );
  const unsupportedTokens = [
    'call_split',
    'insert_drive_file',
    'sync',
    'delete_sweep',
    'open_in_new',
    'hourglass_empty',
    'chevron_right',
  ];
  const supported = [
    'share',
    'notes',
    'document-text',
    'input',
    'cached',
    'delete_outline',
    'launchopen_in_new',
    'historyrestore',
    'arrow_forward_ios',
  ];

  for (const icon of unsupportedTokens)
    assert.doesNotMatch(source, new RegExp(`\\b${icon}\\b`));
  for (const icon of ['description', 'login'])
    assert.doesNotMatch(source, new RegExp(`['"]${icon}['"]`));
  for (const icon of supported)
    assert.match(source, new RegExp(`\\b${icon}\\b`));
});

function installPage(harness, GitHubPage) {
  const githubPage = new GitHubPage({
    config: harness.config,
    plugin: harness.plugin,
  });
  githubPage.install(harness.page);
  return githubPage;
}

function createHarness({
  avatarUrl = null,
  signedIn = false,
  wide = false,
} = {}) {
  const window = new Window({ url: 'https://acode.local' });
  const createdImages = [];
  const createElement = window.document.createElement.bind(window.document);
  window.document.createElement = (tagName, options) => {
    const node = createElement(tagName, options);
    if (tagName === 'img') createdImages.push(node);
    return node;
  };
  const copied = [];
  const opened = [];
  const openedFiles = [];
  const openedFolders = [];
  const deletedGists = [];
  const menus = [];
  let patPrompts = 0;
  let accountGeneration = 0;
  let nextTimer = 1;
  const countdowns = new Set();
  const calls = {
    gists: 0,
    installations: 0,
    repositories: 0,
    repositoryAccessRefresh: 0,
  };
  const actionIds = new Map();
  let sidebarRequests = 0;
  let account = signedIn
    ? {
        avatarUrl,
        id: 1,
        kind: 'github-app',
        login: 'octocat',
      }
    : null;
  const page = createPage(window);
  const plugin = {
    NEW: 'NEW',
    cancelSignIn() {},
    clearCache() {},
    async getAccount() {
      return account;
    },
    async getBranches() {
      return [
        { name: 'main' },
        { name: 'dependabot/npm_and_yarn/plugin-transform-runtime-8.0.1' },
      ];
    },
    async getGistFiles() {
      return ['notes.md'];
    },
    async getGists() {
      calls.gists += 1;
      return [
        {
          description: 'Notes',
          files: { 'notes.md': { filename: 'notes.md' } },
          id: 'gist-1',
        },
      ];
    },
    async getInstallations() {
      calls.installations += 1;
      return [
        {
          account: { login: 'octocat' },
          html_url: 'https://github.com/settings/installations/1',
          id: 1,
        },
      ];
    },
    async getRepositories() {
      calls.repositories += 1;
      return [
        {
          default_branch: 'main',
          id: 1,
          name: 'alpha',
          owner: { login: 'octocat' },
          visibility: 'private',
        },
        {
          default_branch: 'trunk',
          id: 2,
          name: 'beta',
          owner: { login: 'acode' },
          visibility: 'public',
        },
      ];
    },
    async deleteGistById(id) {
      deletedGists.push(id);
      return true;
    },
    openGistFileEntry(id, filename) {
      openedFiles.push([id, filename]);
    },
    async openRepoAsFolder(owner, repository, branch) {
      openedFolders.push([owner, repository, branch]);
    },
    async promptForPersonalAccessToken() {
      patPrompts += 1;
      return false;
    },
    refreshRepositoryAccess() {
      calls.repositoryAccessRefresh += 1;
    },
    startupError: null,
    get accountGeneration() {
      return accountGeneration;
    },
  };
  const harness = {
    calls,
    config: {
      installUrl: 'https://github.com/apps/acode/installations/new',
    },
    copied,
    createdImages,
    globals: {
      CSS: { escape: (value) => value },
      acode: {
        async confirm() {
          return true;
        },
        require(name) {
          if (name === 'sidebarApps') sidebarRequests += 1;
          if (name === 'contextMenu') return createContextMenu;
          if (name === 'actionStack') {
            return {
              has(id) {
                return actionIds.has(id);
              },
              push(value) {
                actionIds.set(value.id, value);
              },
              remove(id) {
                actionIds.delete(id);
              },
            };
          }
          return undefined;
        },
      },
      cordova: {
        plugins: {
          clipboard: {
            copy(value) {
              copied.push(value);
            },
          },
        },
      },
      document: window.document,
      innerHeight: 800,
      innerWidth: wide ? 900 : 390,
      localStorage: window.localStorage,
      matchMedia() {
        return {
          addEventListener() {},
          matches: wide,
          removeEventListener() {},
        };
      },
      navigator: window.navigator,
      requestAnimationFrame(callback) {
        callback();
      },
      clearInterval(timer) {
        countdowns.delete(timer);
      },
      setInterval() {
        const timer = nextTimer;
        nextTimer += 1;
        countdowns.add(timer);
        return timer;
      },
      system: {
        openInBrowser(url) {
          opened.push(url);
        },
      },
    },
    opened,
    deletedGists,
    openedFiles,
    openedFolders,
    menus,
    page,
    plugin,
    get patPrompts() {
      return patPrompts;
    },
    get activeCountdowns() {
      return countdowns.size;
    },
    setAccount(value) {
      account = value;
      accountGeneration += 1;
    },
    get sidebarRequests() {
      return sidebarRequests;
    },
    window,
  };
  return harness;

  function createContextMenu(options) {
    const menu = window.document.createElement('ul');
    menu.items = options.items;
    menu.showCalls = 0;
    menu.show = () => {
      menu.showCalls += 1;
      window.document.body.append(menu);
    };
    menu.hide = () => {
      options.onhide?.();
      menu.remove();
    };
    menu.select = (value) => {
      menu.hide();
      options.onselect?.(value);
    };
    menus.push(menu);
    return menu;
  }
}

function createPage(window) {
  const page = window.document.createElement('wc-page');
  const header = window.document.createElement('header');
  const pageEvents = new Map();
  let lead = window.document.createElement('span');
  lead.className = 'icon arrow_back';
  lead.dataset.action = 'go-back';
  const titleElement = window.document.createElement('span');
  titleElement.className = 'text';
  const tail = window.document.createElement('span');
  tail.className = 'tail';
  header.append(lead, titleElement, tail);
  const main = window.document.createElement('main');
  main.className = 'main';
  page.append(header, main);
  page.showCalls = 0;
  page.hideCalls = 0;
  page.header = header;
  page.body = main;
  page.settitle = (title) => {
    page.dataset.title = title;
    header.querySelector(':scope > .text').textContent = title;
  };
  page.on = (name, listener) => {
    if (!pageEvents.has(name)) pageEvents.set(name, new Set());
    pageEvents.get(name).add(listener);
  };
  page.off = (name, listener) => {
    pageEvents.get(name)?.delete(listener);
  };
  page.show = () => {
    page.showCalls += 1;
    window.document.body.append(page);
  };
  page.hide = () => {
    page.hideCalls += 1;
    page.onhide?.();
    page.remove();
    for (const listener of pageEvents.get('hide') || []) listener.call(page);
  };
  lead.onclick = () => page.hide();
  Object.defineProperty(page, 'lead', {
    get() {
      return lead;
    },
    set(value) {
      lead.replaceWith(value);
      lead = value;
    },
  });
  return page;
}

function findButton(container, text) {
  return (
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent.trim().includes(text),
    ) || null
  );
}

async function settle(count = 2) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}

function repository(name, owner, id) {
  return {
    default_branch: 'main',
    id,
    name,
    owner: { login: owner },
    visibility: 'private',
  };
}
