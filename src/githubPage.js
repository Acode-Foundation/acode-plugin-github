import styles from './githubPage.css';

const INTERNAL_VIEW_ID = 'acode.plugin.github:page-view';
const SEARCH_VIEW_ID = 'acode.plugin.github:page-search';

export class GitHubPage {
  #account;
  #accountGeneration = 0;
  #activeMenu;
  #actionError;
  #actionStack;
  #activeTab = 'repositories';
  #awaitingInstallation = false;
  #config;
  #contextMenu;
  #countdownTimer;
  #deviceFlow;
  #detail;
  #headerAccount;
  #headerRefresh;
  #headerSearch;
  #gistRequest;
  #installations = state();
  #installationRequest;
  #installed = false;
  #lastFocus;
  #master;
  #onHide;
  #originalLead;
  #originalLeadOnClick;
  #page;
  #plugin;
  #query = { gists: '', repositories: '' };
  #renderRequest;
  #repositoryRequest;
  #resources = { gists: state(), repositories: state() };
  #root;
  #route = { kind: 'root' };
  #searchOpen = false;
  #searchOverlay;
  #scroll = { gists: 0, repositories: 0 };
  #style;
  #tabs;
  #visible = false;

  constructor({ config, onHide = () => {}, plugin }) {
    this.#config = config;
    this.#onHide = onHide;
    this.#plugin = plugin;
    try {
      this.#actionStack = acode.require('actionStack');
    } catch (_error) {
      this.#actionStack = undefined;
    }
    try {
      this.#contextMenu = acode.require('contextMenu');
    } catch (_error) {
      this.#contextMenu = undefined;
    }
  }

  get installed() {
    return this.#installed;
  }

  install(page) {
    if (
      !page?.body ||
      typeof page.show !== 'function' ||
      typeof page.on !== 'function' ||
      typeof page.off !== 'function'
    ) {
      return false;
    }
    this.#page = page;
    this.#accountGeneration = this.#plugin.accountGeneration || 0;
    this.#page.classList.add('github-page');
    this.#page.settitle?.('GitHub');
    this.#installStyles();
    this.#installHeader();
    this.#root = el('div', { className: 'g-w main' });
    this.#page.body.replaceChildren(this.#root);
    this.#renderShell();

    this.#page.on('hide', this.#handlePageHide);
    this.#installed = true;
    return true;
  }

  async open(view = this.#activeTab) {
    if (!this.#installed) return false;
    if (view === 'account') {
      this.#setRoute({ kind: 'account' });
    } else if (view === 'gists' || view === 'repositories') {
      this.#activeTab = view;
      if (this.#route.kind !== 'root') {
        this.#setRoute({ kind: 'root' });
      }
    }
    this.#visible = true;
    if (!this.#page.isConnected) this.#page.show();
    if (this.#route.kind !== 'root') this.#ensureInternalBack();
    await this.render();
    return true;
  }

  openAccount() {
    return this.open('account');
  }

  async showFirstUse(firstInit) {
    if (!firstInit) return false;
    try {
      if (await this.#plugin.getAccount()) return false;
    } catch (_error) {
      // The sign-in page presents the initialization error and remains usable.
    }
    return this.open();
  }

  async render() {
    if (!this.#installed) return;
    const request = { generation: this.#accountGeneration };
    this.#renderRequest = request;
    let accountError;
    let account;
    try {
      account = await this.#plugin.getAccount();
    } catch (error) {
      accountError = error;
    }
    if (!this.#isCurrent(request, this.#renderRequest)) return;
    this.#account = account;
    this.#renderHeader();
    if (!this.#account) {
      this.#setRoute({ kind: 'root' });
      this.#renderSignedOut(
        accountError || this.#actionError || this.#plugin.startupError,
      );
      return;
    }
    this.#renderShell();
    this.#renderMaster();
    this.#renderDetail();
    if (this.#visible) this.#loadActive();
  }

  handleResume(repositoryAccessChanged = false) {
    if (repositoryAccessChanged) {
      this.#awaitingInstallation = false;
      return this.#loadRepositories(true);
    }
    if (this.#awaitingInstallation) {
      this.#plugin.refreshRepositoryAccess();
      return;
    }
    if (this.#visible) this.render();
  }

  accountChanged(generation = this.#plugin.accountGeneration) {
    this.#accountGeneration = Number.isInteger(generation)
      ? generation
      : this.#accountGeneration + 1;
    this.#finishDeviceFlow();
    this.#actionError = undefined;
    this.#resetResources();
    this.#setRoute({ kind: 'root' });
    return this.render();
  }

  invalidate(dataset) {
    if (dataset) {
      this.#resources[dataset] = state();
      if (dataset === 'gists') this.#gistRequest = undefined;
      if (dataset === 'repositories') {
        this.#repositoryRequest = undefined;
        this.#installationRequest = undefined;
        this.#installations = state();
      }
    } else this.#resetResources();
    if (
      !dataset ||
      (dataset === 'gists' && this.#route.kind === 'gist') ||
      (dataset === 'repositories' && this.#route.kind === 'repository')
    ) {
      this.#setRoute({ kind: 'root' });
    }
    if (!this.#visible) return;
    this.#renderMaster();
    this.#renderDetail();
    this.#loadActive();
  }

  destroy() {
    this.#accountGeneration += 1;
    this.#renderRequest = undefined;
    this.#cancelResourceRequests();
    this.#finishDeviceFlow();
    this.#closeMenu();
    this.#hideSearch({ clear: true });
    this.#removeInternalBack();
    if (this.#page) {
      this.#page.off('hide', this.#handlePageHide);
      if (this.#originalLead) {
        this.#originalLead.onclick = this.#originalLeadOnClick;
      }
      this.#page.classList.remove('github-page');
      this.#page.body?.replaceChildren();
    }
    this.#headerAccount?.remove();
    this.#headerRefresh?.remove();
    this.#headerSearch?.remove();
    this.#style?.remove();
    this.#installed = false;
  }

  #installHeader() {
    this.#originalLead = this.#page.lead;
    this.#originalLeadOnClick = this.#originalLead.onclick;
    this.#originalLead.onclick = (event) => {
      if (this.#route.kind !== 'root') {
        this.#returnToRoot(true);
        return;
      }
      if (this.#originalLeadOnClick) {
        this.#originalLeadOnClick.call(this.#originalLead, event);
      } else {
        this.#page.hide();
      }
    };

    this.#headerSearch = iconButton('search', 'Search GitHub', () =>
      this.#showSearch(),
    );
    this.#headerSearch.classList.add('g-ha');
    this.#headerSearch.dataset.action = 'github-search';
    this.#headerRefresh = iconButton('refresh', 'Refresh GitHub', () =>
      this.#refreshActive(),
    );
    this.#headerRefresh.classList.add('g-ha');
    this.#headerRefresh.dataset.action = 'github-refresh';
    this.#headerAccount = iconButton('account_circle', 'GitHub account', () =>
      this.openAccount(),
    );
    this.#headerAccount.classList.add('g-ha');
    this.#headerAccount.dataset.action = 'github-account';
    this.#page.header.append(
      this.#headerSearch,
      this.#headerRefresh,
      this.#headerAccount,
    );
  }

  #handlePageHide = () => {
    this.#visible = false;
    this.#removeInternalBack();
    this.#closeMenu();
    this.#hideSearch({ clear: true });
    this.#route = { kind: 'root' };
    this.#updatePageTitle();
    this.#onHide();
  };

  #renderHeader() {
    if (!this.#headerAccount || !this.#headerRefresh || !this.#headerSearch)
      return;
    this.#updateHeaderActions();
    this.#headerAccount.classList.toggle(
      'active',
      this.#route.kind === 'account',
    );
    this.#headerAccount.setAttribute(
      'aria-pressed',
      String(this.#route.kind === 'account'),
    );
    this.#headerAccount.replaceChildren();
    if (this.#account) {
      this.#headerAccount.classList.remove('account_circle');
      const avatar = safeAvatar(this.#account.avatarUrl, 'g-hv');
      this.#headerAccount.append(
        avatar || el('span', { className: 'icon account_circle' }),
      );
      setHidden(this.#headerAccount, false);
      this.#updatePageTitle();
      return;
    }
    this.#headerAccount.classList.add('account_circle');
    setHidden(this.#headerAccount, true);
    this.#updatePageTitle();
  }

  #updatePageTitle() {
    if (!this.#page?.settitle) return;
    if (globalThis.innerWidth >= 720 || this.#route.kind === 'root') {
      this.#page.settitle('GitHub');
      return;
    }
    if (this.#route.kind === 'account') {
      this.#page.settitle('GitHub account');
      return;
    }
    if (this.#route.kind === 'repository') {
      this.#page.settitle(this.#route.repository.name || 'Repository');
      return;
    }
    if (this.#route.kind === 'gist') {
      this.#page.settitle(gistTitle(this.#route.gist));
    }
  }

  #showSearch() {
    if (!this.#account || this.#route.kind !== 'root') return;
    if (this.#searchOpen) {
      this.#searchOverlay?.querySelector('input')?.focus();
      return;
    }
    this.#searchOpen = true;
    const input = el('input', {
      ariaLabel: `Search GitHub ${this.#activeTab}`,
      placeholder: `Search ${this.#activeTab}`,
      type: 'search',
      value: this.#query[this.#activeTab],
    });
    input.dataset.action = 'github-search-input';
    input.addEventListener('input', () => {
      this.#query[this.#activeTab] = input.value;
      this.#renderResourceList();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.#hideSearch({ clear: true });
    });
    const close = iconButton('clearclose', 'Close search', () =>
      this.#hideSearch({ clear: true }),
    );
    close.dataset.action = 'github-close-search';
    this.#searchOverlay = el(
      'div',
      { className: 'g-s', id: 'search-bar', role: 'search' },
      [input, close],
    );
    this.#page.header.append(this.#searchOverlay);
    setHidden(this.#headerSearch, true);
    this.#actionStack?.push?.({
      action: () => this.#hideSearch({ clear: true }),
      id: SEARCH_VIEW_ID,
    });
    requestAnimationFrame(() => input.focus());
  }

  #hideSearch({ clear = false } = {}) {
    this.#actionStack?.remove?.(SEARCH_VIEW_ID);
    this.#searchOverlay?.remove();
    this.#searchOverlay = undefined;
    this.#searchOpen = false;
    if (clear) {
      this.#query[this.#activeTab] = '';
      this.#renderResourceList();
    }
    this.#updateHeaderActions();
  }

  #renderShell() {
    if (this.#root?.querySelector('.g-l')) return;
    this.#tabs = el('div', {
      className: 'options g-ts',
      role: 'tablist',
    });
    this.#tabs.append(
      this.#tabButton('repositories', 'Repositories'),
      this.#tabButton('gists', 'Gists'),
      el('span', {
        ariaHidden: true,
        className: 'tab-indicator',
      }),
    );
    this.#tabs.addEventListener('keydown', (event) => {
      const tabs = [...this.#tabs.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft')
        next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    });
    this.#master = el('section', {
      ariaLabel: 'GitHub resources',
      className: 'g-m',
    });
    this.#detail = el('section', {
      ariaLabel: 'GitHub details',
      className: 'g-d',
    });
    const layout = el('div', { className: 'g-l' }, [
      this.#master,
      this.#detail,
    ]);
    this.#root.replaceChildren(this.#tabs, layout);
  }

  #tabButton(tab, label) {
    const button = actionButton(label, () => this.#selectTab(tab), {
      className: 'g-t',
    });
    button.id = `github-tab-${tab}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'github-resource-list');
    return button;
  }

  #selectTab(tab) {
    if (tab === this.#activeTab) return;
    const reopenSearch = this.#searchOpen;
    if (reopenSearch) this.#hideSearch();
    this.#rememberScroll();
    this.#activeTab = tab;
    this.#setRoute({ kind: 'root' });
    this.#renderMaster();
    this.#renderDetail();
    this.#loadActive();
    if (reopenSearch) this.#showSearch();
  }

  #renderSignedOut(error) {
    this.#clearCountdown();
    this.#root.replaceChildren();
    const mode = this.#plugin.authenticationMode || 'modern';
    if (mode === 'legacy') {
      this.#root.append(
        el('section', { className: 'g-si' }, [
          el('span', {
            className: 'icon github g-logo',
            ariaHidden: true,
          }),
          el('h2', { text: 'Connect to GitHub' }),
          el('p', {
            className: 'g-auth-copy',
            text: 'Enter a personal access token to use GitHub on this version of Acode.',
          }),
          error ? this.#errorNotice(error) : null,
          actionButton(
            'Use personal access token',
            () => this.#startPatSignIn(),
            { className: 'primary', icon: 'key' },
          ),
          el('p', {
            className: 'g-mu',
            text: "This Acode version uses manual token sign-in. The token is encrypted in the plugin's local storage.",
          }),
        ]),
      );
      return;
    }
    const content = this.#deviceFlow
      ? this.#deviceFlowView()
      : el('section', { className: 'g-si' }, [
          el('span', {
            className: 'icon github g-logo',
            ariaHidden: true,
          }),
          el('h2', { text: 'Sign in to GitHub' }),
          el('p', {
            className: 'g-auth-copy',
            text: 'Connect your account to browse repositories and gists in Acode.',
          }),
          error ? this.#errorNotice(error) : null,
          actionButton('Sign in with GitHub', () => this.#startSignIn(), {
            className: 'primary',
            icon: 'input',
          }),
          actionButton(
            'Use personal access token',
            () => this.#startPatSignIn(),
            { className: 'text' },
          ),
        ]);
    this.#root.append(content);
  }

  #renderMaster() {
    if (!this.#account || !this.#master) return;
    this.#root.dataset.route = this.#route.kind === 'root' ? 'root' : 'detail';
    if (this.#route.kind === 'account') this.#root.dataset.route = 'account';
    this.#tabs.dataset.active = this.#activeTab;
    for (const tab of this.#tabs.querySelectorAll('[role="tab"]')) {
      const selected = tab.id === `github-tab-${this.#activeTab}`;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    this.#master.setAttribute(
      'aria-labelledby',
      `github-tab-${this.#activeTab}`,
    );
    this.#master.replaceChildren(el('div', { id: 'github-resource-list' }));
    this.#renderResourceList();
    requestAnimationFrame(() => {
      this.#master.scrollTop = this.#scroll[this.#activeTab];
    });
  }

  #renderResourceList() {
    this.#updateHeaderActions();
    const target = this.#master?.querySelector('#github-resource-list');
    if (!target) return;
    const resource = this.#resources[this.#activeTab];
    if (resource.status === 'idle' || resource.status === 'loading') {
      target.replaceChildren(skeletonList());
      return;
    }
    if (resource.error && !resource.items.length) {
      target.replaceChildren(
        this.#errorNotice(resource.error, () => this.#loadActive(true)),
      );
      return;
    }
    const query = this.#query[this.#activeTab].trim().toLowerCase();
    const items = resource.items.filter((item) =>
      this.#matchesResource(item, query),
    );
    const fragment = document.createDocumentFragment();
    if (resource.error) fragment.append(this.#errorNotice(resource.error));
    if (!items.length) {
      fragment.append(
        emptyState(
          query ? 'No matching results.' : `No ${this.#activeTab} found.`,
        ),
      );
    } else if (this.#activeTab === 'repositories') {
      for (const [owner, repositories] of groupBy(
        items,
        (repository) => repository.owner?.login || 'Other',
      )) {
        fragment.append(
          resourceSection(owner, this.#repositoryList(repositories)),
        );
      }
    } else {
      const list = el('div', { className: 'list g-ls' });
      for (const gist of items) list.append(this.#gistRow(gist));
      fragment.append(
        resourceSection(
          'Your gists',
          list,
          actionButton(
            'New gist',
            async () => {
              await this.#plugin.openGistFile(this.#plugin.NEW);
              this.#page.hide();
            },
            { icon: 'add' },
          ),
        ),
      );
    }
    if (
      this.#activeTab === 'repositories' &&
      this.#account.kind === 'github-app' &&
      this.#installations.status === 'ready' &&
      this.#installations.items.length === 0
    ) {
      fragment.append(
        emptyState(
          'No repository installation is connected. Gists are still available.',
          safeGitHubUrl(this.#config.installUrl)
            ? actionButton(
                'Choose repositories on GitHub',
                () => this.#openInstallation(this.#config.installUrl),
                { className: 'primary' },
              )
            : null,
        ),
      );
    }
    target.replaceChildren(fragment);
  }

  #updateHeaderActions() {
    const searchableItems = this.#resources[this.#activeTab]?.items.length || 0;
    setHidden(
      this.#headerSearch,
      !this.#account ||
        this.#route.kind !== 'root' ||
        this.#searchOpen ||
        searchableItems < 2,
    );
    setHidden(this.#headerRefresh, !this.#account);
  }

  #matchesResource(item, query) {
    if (!query) return true;
    if (this.#activeTab === 'repositories') {
      return `${item.owner?.login || ''}/${item.name || ''} ${item.description || ''}`
        .toLowerCase()
        .includes(query);
    }
    const filenames = Object.keys(item.files || {}).join(' ');
    return `${item.description || ''} ${filenames}`
      .toLowerCase()
      .includes(query);
  }

  #repositoryList(repositories) {
    const list = el('div', { className: 'list g-ls' });
    for (const repository of repositories) {
      const owner = repository.owner?.login || '';
      const key = `repository:${repository.id || `${owner}/${repository.name}`}`;
      list.append(
        resourceRow(
          repository.name,
          repository.description || 'No description',
          'folder',
          () => this.#selectRepository(repository, key),
          repository.visibility || (repository.private ? 'private' : 'public'),
          key,
        ),
      );
    }
    return list;
  }

  #gistRow(gist) {
    const title = gistTitle(gist);
    const fileCount = Object.keys(gist.files || {}).length;
    const key = `gist:${gist.id}`;
    const row = resourceRow(
      title,
      `${fileCount} file${fileCount === 1 ? '' : 's'}`,
      'notes',
      () => this.#selectGist(gist, key),
      gist.public === true ? 'public' : gist.public === false ? 'secret' : '',
      key,
    );
    row.append(
      this.#overflowButton(`More actions for ${title}`, [
        {
          label: 'Delete gist',
          run: async () => {
            if (await this.#plugin.deleteGistById(gist.id)) {
              await this.#loadGists(true);
              this.#setRoute({ kind: 'root' });
            }
          },
        },
      ]),
    );
    return row;
  }

  async #selectRepository(repository, focusKey) {
    const generation = this.#accountGeneration;
    const request = { generation };
    this.#rememberScroll();
    this.#lastFocus = focusKey;
    const owner = repository.owner?.login || '';
    const key = `${owner}/${repository.name}`;
    const route = {
      data: state('loading'),
      key,
      kind: 'repository',
      repository,
      request,
    };
    this.#setRoute(route);
    this.#renderMaster();
    this.#renderDetail();
    try {
      const branches = await this.#plugin.getBranches(owner, repository.name);
      if (!this.#isCurrentDetail(route, request)) return;
      route.data = state('ready', branches);
    } catch (error) {
      if (!this.#isCurrentDetail(route, request)) return;
      route.data = state('error', [], error);
    }
    this.#renderDetail();
  }

  async #selectGist(gist, focusKey) {
    const generation = this.#accountGeneration;
    const request = { generation };
    this.#rememberScroll();
    this.#lastFocus = focusKey;
    const route = {
      data: state('loading'),
      gist,
      key: gist.id,
      kind: 'gist',
      request,
    };
    this.#setRoute(route);
    this.#renderMaster();
    this.#renderDetail();
    try {
      const files = await this.#plugin.getGistFiles(gist.id);
      if (!this.#isCurrentDetail(route, request)) return;
      route.data = state('ready', files);
    } catch (error) {
      if (!this.#isCurrentDetail(route, request)) return;
      route.data = state('error', [], error);
    }
    this.#renderDetail();
  }

  #renderDetail() {
    if (!this.#detail || !this.#account) return;
    this.#root.dataset.route = this.#route.kind === 'root' ? 'root' : 'detail';
    if (this.#route.kind === 'account') {
      this.#root.dataset.route = 'account';
      this.#renderAccount();
      return;
    }
    if (this.#route.kind === 'repository') {
      this.#renderRepositoryDetail();
      return;
    }
    if (this.#route.kind === 'gist') {
      this.#renderGistDetail();
      return;
    }
    this.#detail.replaceChildren(
      emptyState(
        this.#activeTab === 'repositories'
          ? 'Select a repository to view its branches.'
          : 'Select a gist to view its files.',
      ),
    );
  }

  #renderRepositoryDetail() {
    const { repository, data } = this.#route;
    const owner = repository.owner?.login || '';
    const content = el('div', { className: 'g-dc' });
    content.append(
      detailHeader(
        repository.name,
        owner,
        repository.description || 'Choose a branch to open as a folder.',
        'folder',
        repository.visibility || (repository.private ? 'private' : 'public'),
      ),
    );
    let branchContent;
    if (data.status === 'loading') branchContent = skeletonList(4);
    else if (data.error) {
      branchContent = this.#errorNotice(data.error, () =>
        this.#selectRepository(repository, this.#lastFocus),
      );
    } else if (!data.items.length) {
      branchContent = emptyState('No branches found.');
    } else {
      const list = el('div', { className: 'list g-ls g-bl' });
      for (const branch of data.items) {
        list.append(
          resourceRow(
            branch.name,
            branch.name === repository.default_branch
              ? 'Primary branch'
              : 'Repository branch',
            'share',
            async () => {
              await this.#plugin.openRepoAsFolder(
                owner,
                repository.name,
                branch.name,
              );
              this.#page.hide();
            },
            branch.name === repository.default_branch ? 'default' : '',
          ),
        );
      }
      branchContent = list;
    }
    content.append(
      resourceSection(
        'Branches',
        branchContent,
        actionButton(
          'Create branch',
          async () => {
            await this.#plugin.openRepoAsFolder(
              owner,
              repository.name,
              this.#plugin.NEW,
            );
            this.#page.hide();
          },
          { icon: 'add' },
        ),
      ),
    );
    if (this.#actionError)
      content.prepend(this.#errorNotice(this.#actionError));
    this.#detail.replaceChildren(content);
    this.#focusDetail();
  }

  #renderGistDetail() {
    const route = this.#route;
    const { gist, data } = route;
    const title = gistTitle(gist);
    const content = el('div', { className: 'g-dc' });
    content.append(
      detailHeader(
        title,
        'Gist',
        'Choose a file to open it in the editor.',
        'notes',
        gist.public === true ? 'public' : gist.public === false ? 'secret' : '',
      ),
    );
    let fileContent;
    if (data.status === 'loading') fileContent = skeletonList(3);
    else if (data.error) {
      fileContent = this.#errorNotice(data.error, () =>
        this.#selectGist(gist, this.#lastFocus),
      );
    } else if (!data.items.length) {
      fileContent = emptyState('This gist has no files.');
    } else {
      const list = el('div', { className: 'list g-ls' });
      for (const filename of data.items) {
        const row = resourceRow(filename, 'Gist file', 'document-text', () => {
          this.#plugin.openGistFileEntry(gist.id, filename);
          this.#page.hide();
        });
        row.append(
          this.#overflowButton(`More actions for ${filename}`, [
            {
              label: 'Delete file',
              run: async () => {
                const generation = this.#accountGeneration;
                const request = { generation };
                route.request = request;
                if (await this.#plugin.deleteGistFileById(gist.id, filename)) {
                  const files = await this.#plugin.getGistFiles(gist.id, {
                    force: true,
                  });
                  if (!this.#isCurrentDetail(route, request)) return;
                  route.data = state('ready', files);
                  this.#renderGistDetail();
                }
              },
            },
          ]),
        );
        list.append(row);
      }
      fileContent = list;
    }
    content.append(
      resourceSection(
        'Files',
        fileContent,
        actionButton(
          'Add file',
          async () => {
            await this.#plugin.openGistFile(gist.id);
            this.#page.hide();
          },
          { icon: 'add' },
        ),
      ),
    );
    if (this.#actionError)
      content.prepend(this.#errorNotice(this.#actionError));
    this.#detail.replaceChildren(content);
    this.#focusDetail();
  }

  #renderAccount() {
    const account = this.#account;
    if (this.#deviceFlow) {
      this.#detail.replaceChildren(this.#deviceFlowView());
      this.#focusDetail();
      return;
    }
    const avatar = safeAvatar(account.avatarUrl, 'g-av');
    const identity = el('div', { className: 'g-i' }, [
      avatar || el('span', { className: 'icon account_circle g-av' }),
      el('div', { className: 'g-ap' }, [
        el('h2', { text: account.login }),
        el('p', {
          className: 'g-mu',
          text: account.pendingMigration
            ? 'Personal access token · Finishing setup'
            : account.kind === 'github-app'
              ? 'Signed in with GitHub'
              : 'Personal access token',
        }),
      ]),
    ]);
    const content = el('section', { className: 'g-ac' }, [identity]);
    if (this.#actionError) content.append(this.#errorNotice(this.#actionError));
    if (account.kind === 'github-app') {
      let accessContent;
      if (this.#installations.status === 'loading') {
        accessContent = skeletonList(2);
      } else if (this.#installations.error) {
        accessContent = this.#errorNotice(this.#installations.error, () =>
          this.#loadInstallations(),
        );
      } else {
        const accessList = el('div', {
          className: 'list g-ls',
        });
        for (const installation of this.#installations.items) {
          if (!safeGitHubUrl(installation.html_url)) continue;
          accessList.append(
            resourceRow(
              installation.account?.login || 'GitHub installation',
              'Manage selected repositories',
              'settings',
              () => this.#openInstallation(installation.html_url),
            ),
          );
        }
        if (safeGitHubUrl(this.#config.installUrl)) {
          accessList.append(
            resourceRow(
              'Add an installation',
              'Choose another account or organization',
              'add',
              () => this.#openInstallation(this.#config.installUrl),
            ),
          );
        }
        accessContent = accessList.children.length
          ? accessList
          : emptyState('No repository installation is connected.');
      }
      content.append(resourceSection('Repository access', accessContent));
    }
    const accountList = el('div', {
      className: 'list g-ls',
    });
    if (this.#plugin.authenticationMode !== 'legacy') {
      accountList.append(
        resourceRow(
          'Reconnect or switch',
          'Connect a different GitHub account',
          'cached',
          () => this.#startSignIn(),
        ),
      );
    }
    accountList.append(
      resourceRow(
        account.kind === 'pat'
          ? 'Replace personal access token'
          : 'Use personal access token',
        'Connect with an existing GitHub token',
        'key',
        () => this.#startPatSignIn(),
      ),
      resourceRow(
        'Clear GitHub cache',
        'Refresh repositories, branches, and gists',
        'delete_outline',
        () => this.#plugin.clearCache(),
      ),
    );
    content.append(resourceSection('Account', accountList));
    const signOutList = el('div', {
      className: 'list g-ls g-dn',
    });
    signOutList.append(
      resourceRow(
        'Sign out on this device',
        account.kind === 'github-app'
          ? 'Remove the encrypted session from this device'
          : 'Remove the personal access token from this device',
        'logout',
        async () => {
          const accepted = await globalThis.acode?.confirm?.(
            'GitHub',
            'Sign out on this device?',
          );
          if (accepted === false) return;
          await this.#runAction(() => this.#plugin.signOut());
        },
      ),
    );
    content.append(resourceSection('Session', signOutList));
    this.#detail.replaceChildren(content);
    if (this.#installations.status === 'idle') this.#loadInstallations();
    this.#focusDetail();
  }

  async #loadActive(force = false) {
    if (!this.#account) return;
    if (this.#activeTab === 'repositories') await this.#loadRepositories(force);
    else await this.#loadGists(force);
  }

  async #loadRepositories(force = false) {
    const current = this.#resources.repositories;
    if (!force && ['loading', 'ready'].includes(current.status)) return;
    const generation = this.#accountGeneration;
    const repositoryRequest = { generation };
    const installationRequest = { generation };
    this.#repositoryRequest = repositoryRequest;
    this.#installationRequest = installationRequest;
    this.#resources.repositories = state('loading', current.items);
    this.#renderResourceList();
    const [repositoryResult, installationResult] = await Promise.allSettled([
      this.#plugin.getRepositories({ force }),
      this.#plugin.getInstallations({ force }),
    ]);
    const repositoryError = settledError(repositoryResult);
    const installationError = settledError(installationResult);
    const repositories = settledValue(repositoryResult, current.items);
    const installations = settledValue(
      installationResult,
      this.#installations.items,
    );
    const repositoryCurrent = this.#isCurrent(
      repositoryRequest,
      this.#repositoryRequest,
    );
    const installationCurrent = this.#isCurrent(
      installationRequest,
      this.#installationRequest,
    );
    if (repositoryCurrent) {
      this.#resources.repositories = state(
        repositoryError ? 'error' : 'ready',
        repositories,
        repositoryError ||
          (installationCurrent ? installationError : undefined),
      );
    }
    if (installationCurrent) {
      this.#installations = state(
        installationError ? 'error' : 'ready',
        installations,
        installationError,
      );
      if (this.#account && this.#route.kind === 'account')
        this.#renderAccount();
    }
    if (repositoryCurrent || installationCurrent) this.#renderResourceList();
  }

  async #loadGists(force = false) {
    const current = this.#resources.gists;
    if (!force && ['loading', 'ready'].includes(current.status)) return;
    const request = { generation: this.#accountGeneration };
    this.#gistRequest = request;
    this.#resources.gists = state('loading', current.items);
    this.#renderResourceList();
    try {
      const gists = await this.#plugin.getGists({ force });
      if (!this.#isCurrent(request, this.#gistRequest)) return;
      this.#resources.gists = state('ready', gists);
    } catch (error) {
      if (!this.#isCurrent(request, this.#gistRequest)) return;
      this.#resources.gists = state('error', current.items, error);
    }
    this.#renderResourceList();
  }

  async #loadInstallations() {
    const request = { generation: this.#accountGeneration };
    this.#installationRequest = request;
    this.#installations = state('loading', this.#installations.items);
    if (this.#account && this.#route.kind === 'account') this.#renderAccount();
    try {
      const installations = await this.#plugin.getInstallations();
      if (!this.#isCurrent(request, this.#installationRequest)) return;
      this.#installations = state('ready', installations);
    } catch (error) {
      if (!this.#isCurrent(request, this.#installationRequest)) return;
      this.#installations = state('error', this.#installations.items, error);
    }
    if (this.#account && this.#route.kind === 'account') this.#renderAccount();
  }

  async #refreshActive() {
    if (!this.#account) return;
    this.#actionError = undefined;
    if (this.#route.kind === 'account') {
      await this.#loadRepositories(true);
      return;
    }
    if (this.#route.kind === 'repository') {
      const generation = this.#accountGeneration;
      const request = { generation };
      const route = this.#route;
      route.request = request;
      const { repository } = route;
      const owner = repository.owner?.login || '';
      route.data = state('loading', route.data.items);
      this.#renderRepositoryDetail();
      try {
        const branches = await this.#plugin.getBranches(
          owner,
          repository.name,
          { force: true },
        );
        if (!this.#isCurrentDetail(route, request)) return;
        route.data = state('ready', branches);
      } catch (error) {
        if (!this.#isCurrentDetail(route, request)) return;
        route.data = state('error', route.data.items, error);
      }
      this.#renderRepositoryDetail();
      return;
    }
    if (this.#route.kind === 'gist') {
      const generation = this.#accountGeneration;
      const request = { generation };
      const route = this.#route;
      route.request = request;
      route.data = state('loading', route.data.items);
      this.#renderGistDetail();
      try {
        const files = await this.#plugin.getGistFiles(route.gist.id, {
          force: true,
        });
        if (!this.#isCurrentDetail(route, request)) return;
        route.data = state('ready', files);
      } catch (error) {
        if (!this.#isCurrentDetail(route, request)) return;
        route.data = state('error', route.data.items, error);
      }
      this.#renderGistDetail();
      return;
    }
    await this.#loadActive(true);
  }

  async #startSignIn() {
    if (this.#plugin.authenticationMode === 'legacy') return;
    this.#actionError = undefined;
    this.#finishDeviceFlow();
    this.#deviceFlow = { status: 'requesting' };
    this.#account ? this.#renderAccount() : this.#renderSignedOut();
    try {
      await this.#plugin.signInWithGitHub({
        onCode: (code) => {
          this.#deviceFlow = { code, status: 'pending' };
          this.#account ? this.#renderAccount() : this.#renderSignedOut();
        },
        onState: (status) => {
          if (!this.#deviceFlow) return;
          this.#deviceFlow.status = status;
          this.#account ? this.#renderAccount() : this.#renderSignedOut();
        },
      });
      this.#finishDeviceFlow();
      this.#resetResources();
      await this.render();
    } catch (error) {
      this.#finishDeviceFlow();
      if (error?.kind !== 'cancelled') this.#actionError = error;
      await this.render();
    }
  }

  async #startPatSignIn() {
    await this.#runAction(async () => {
      if (await this.#plugin.promptForPersonalAccessToken()) {
        this.#resetResources();
        await this.render();
      }
    });
  }

  #deviceFlowView() {
    const stateValue = this.#deviceFlow;
    if (!stateValue?.code) {
      return el('section', { className: 'g-dv' }, [
        el('span', {
          className: 'icon historyrestore g-logo',
          ariaLabel: 'Requesting sign-in code',
        }),
        el('h2', { text: 'Connecting to GitHub' }),
        el('p', {
          className: 'g-auth-copy',
          text: 'Requesting a secure sign-in code…',
        }),
        actionButton('Cancel', () => this.#cancelSignIn(), {
          className: 'text',
        }),
      ]);
    }
    const countdown = el('span', { className: 'g-mu' });
    const view = el('section', { className: 'g-dv' }, [
      el('span', {
        className: 'icon github g-logo',
        ariaHidden: true,
      }),
      el('h2', { text: 'Finish signing in' }),
      el('p', {
        className: 'g-auth-copy',
        text: 'Enter this code on GitHub',
      }),
      el('strong', {
        className: 'g-code',
        text: stateValue.code.userCode,
      }),
      countdown,
      el('p', {
        className: 'g-mu',
        text: deviceStateText(stateValue.status),
      }),
      actionButton('Copy code and open GitHub', () => this.#copyAndOpenCode(), {
        className: 'primary',
        icon: 'launchopen_in_new',
      }),
      actionButton('Cancel', () => this.#cancelSignIn(), {
        className: 'text',
      }),
    ]);
    this.#startCountdown(stateValue.code.expiresAt, countdown);
    return view;
  }

  #cancelSignIn() {
    this.#plugin.cancelSignIn();
    this.#finishDeviceFlow();
    this.render();
  }

  async #copyAndOpenCode() {
    const code = this.#deviceFlow?.code;
    if (!code || !safeGitHubUrl(code.verificationUri, '/login/device')) return;
    await copyText(code.userCode);
    openExternal(code.verificationUri);
  }

  #overflowButton(label, actions) {
    const button = iconButton('more_vert', label, (event) => {
      event.stopPropagation();
      this.#closeMenu();
      if (typeof this.#contextMenu !== 'function') {
        const [action] = actions;
        if (action) this.#runAction(action.run);
        return;
      }
      const menu = this.#contextMenu({
        items: actions.map((action, index) => [action.label, String(index)]),
        onhide: () => {
          button.setAttribute('aria-expanded', 'false');
          if (this.#activeMenu === menu) this.#activeMenu = undefined;
        },
        onselect: (index) => {
          const action = actions[Number.parseInt(index, 10)];
          if (action) this.#runAction(action.run);
        },
      });
      const bounds = button.getBoundingClientRect();
      const viewportHeight = globalThis.innerHeight || 800;
      const viewportWidth = globalThis.innerWidth || 360;
      menu.style.top = `${Math.max(8, Math.min(bounds.top, viewportHeight - 70))}px`;
      menu.style.right = `${Math.max(8, viewportWidth - bounds.right)}px`;
      this.#activeMenu = menu;
      button.setAttribute('aria-expanded', 'true');
      menu.show();
    });
    button.dataset.action = 'github-overflow';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    return button;
  }

  #closeMenu = () => {
    this.#activeMenu?.hide?.();
    this.#activeMenu = undefined;
  };

  async #runAction(action) {
    this.#actionError = undefined;
    try {
      await action();
    } catch (error) {
      this.#actionError = error;
      if (!this.#account) this.#renderSignedOut(error);
      else if (this.#route.kind === 'account') this.#renderAccount();
      else this.#renderDetail();
    }
  }

  #errorNotice(error, retry) {
    const { action, message } = recoveryFor(error);
    const box = el('div', { className: 'g-er g-st' }, [
      el('div', { text: message }),
    ]);
    const diagnostic = diagnosticCode(error);
    if (diagnostic) {
      box.append(
        el('small', {
          className: 'g-dg',
          text: `Diagnostic: ${diagnostic}`,
        }),
      );
    }
    if (retry) box.append(actionButton('Retry', retry));
    if (action) box.append(actionButton(action.label, action.run));
    return box;
  }

  #openInstallation(url) {
    if (!safeGitHubUrl(url)) return;
    this.#awaitingInstallation = true;
    openExternal(url);
  }

  #setRoute(route) {
    if (route.kind !== 'root' && this.#searchOpen) {
      this.#hideSearch();
    }
    this.#route = route;
    if (route.kind === 'root') this.#removeInternalBack();
    else this.#ensureInternalBack();
    this.#renderHeader();
  }

  #ensureInternalBack() {
    if (!this.#visible || this.#actionStack?.has?.(INTERNAL_VIEW_ID)) return;
    this.#actionStack?.push?.({
      action: () => this.#returnToRoot(false),
      id: INTERNAL_VIEW_ID,
    });
  }

  #removeInternalBack() {
    this.#actionStack?.remove?.(INTERNAL_VIEW_ID);
  }

  #returnToRoot(removeAction) {
    if (removeAction) this.#removeInternalBack();
    this.#actionError = undefined;
    this.#route = { kind: 'root' };
    this.#renderHeader();
    this.#renderMaster();
    this.#renderDetail();
    requestAnimationFrame(() => {
      const selector = this.#lastFocus
        ? `[data-focus-key="${escapeSelector(this.#lastFocus)}"]`
        : '[role="tab"][aria-selected="true"]';
      this.#master?.querySelector(selector)?.focus();
    });
  }

  #rememberScroll() {
    if (this.#master) this.#scroll[this.#activeTab] = this.#master.scrollTop;
  }

  #focusDetail() {
    requestAnimationFrame(() => this.#detail?.querySelector('h2')?.focus());
  }

  #resetResources() {
    this.#cancelResourceRequests();
    this.#resources = { gists: state(), repositories: state() };
    this.#installations = state();
  }

  #cancelResourceRequests() {
    this.#gistRequest = undefined;
    this.#installationRequest = undefined;
    this.#repositoryRequest = undefined;
  }

  #isCurrent(request, current) {
    return (
      this.#installed &&
      request === current &&
      request.generation === this.#accountGeneration
    );
  }

  #isCurrentDetail(route, request) {
    return (
      this.#installed &&
      this.#route === route &&
      route.request === request &&
      request.generation === this.#accountGeneration
    );
  }

  #installStyles() {
    this.#style = document.createElement('style');
    this.#style.dataset.plugin = 'github-page';
    this.#style.textContent = styles;
    document.head.append(this.#style);
  }

  #startCountdown(expiresAt, target) {
    this.#clearCountdown();
    const update = () => {
      const remaining = Math.max(0, expiresAt - Date.now());
      const minutes = Math.floor(remaining / 60_000);
      const seconds = Math.floor((remaining % 60_000) / 1_000);
      target.textContent = `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
    };
    update();
    this.#countdownTimer = setInterval(update, 1_000);
  }

  #clearCountdown() {
    if (this.#countdownTimer) clearInterval(this.#countdownTimer);
    this.#countdownTimer = undefined;
  }

  #finishDeviceFlow() {
    this.#clearCountdown();
    this.#deviceFlow = undefined;
  }
}

function state(status = 'idle', items = [], error) {
  return { error, items, status };
}

function settledError(result) {
  return result.status === 'rejected' ? result.reason : undefined;
}

function settledValue(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function escapeSelector(value) {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(value)
    : String(value).replaceAll('"', '\\"');
}

function el(tagName, options = {}, children = []) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.id) node.id = options.id;
  if (options.type) node.type = options.type;
  if (options.value !== undefined) node.value = options.value;
  if (options.placeholder) node.placeholder = options.placeholder;
  if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel);
  if (options.ariaHidden) node.setAttribute('aria-hidden', 'true');
  if (options.role) node.setAttribute('role', options.role);
  const values = Array.isArray(children) ? children : [children];
  node.append(...values.filter(Boolean));
  return node;
}

function actionButton(label, action, options = {}) {
  const button = el('button', {
    className: ['g-a', options.className].filter(Boolean).join(' '),
    text: label,
    type: 'button',
  });
  if (options.icon)
    button.prepend(
      el('span', {
        ariaHidden: true,
        className: `icon ${options.icon}`,
      }),
    );
  button.addEventListener('click', action);
  return button;
}

function iconButton(icon, label, action) {
  const button = el('button', {
    className: `icon ${icon}`,
    type: 'button',
  });
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', action);
  return button;
}

function setHidden(node, hidden) {
  if (!node) return;
  node.hidden = hidden;
  node.classList.toggle('hidden', hidden);
  node.setAttribute('aria-hidden', String(hidden));
}

function resourceRow(title, meta, icon, action, badge, focusKey) {
  const wrap = el('div', { className: 'list-item g-it' });
  const button = el('button', {
    className: 'g-o',
    type: 'button',
  });
  button.addEventListener('click', action);
  button.dataset.action = 'open';
  if (focusKey) {
    button.dataset.focusKey = focusKey;
  }
  const titleLine = el('span', { className: 'g-rh' }, [
    el('span', { className: 'g-rt', text: title }),
    badge
      ? el('span', {
          className: 'g-b',
          text: badge,
        })
      : null,
  ]);
  button.append(
    el('span', { className: `icon ${icon}` }),
    el('span', { className: 'g-rc' }, [
      titleLine,
      meta
        ? el('span', {
            className: 'g-rm',
            text: meta,
          })
        : null,
    ]),
    el('span', { className: 'icon arrow_forward_ios', ariaHidden: true }),
  );
  wrap.append(button);
  return wrap;
}

function resourceSection(label, content, action) {
  const heading = el('div', { className: 'g-sh' }, [
    el('h2', { className: 'g-sl', text: label }),
    action,
  ]);
  return el('section', { className: 'g-sx' }, [
    heading,
    el('div', { className: 'g-c' }, [content]),
  ]);
}

function detailHeader(title, eyebrow, description, icon, badge) {
  const heading = el('h2', { text: title });
  heading.tabIndex = -1;
  return el('section', { className: 'g-h' }, [
    el('span', {
      ariaHidden: true,
      className: `icon ${icon} g-di`,
    }),
    el('div', { className: 'g-dp' }, [
      el('p', { className: 'g-e', text: eyebrow }),
      el('div', { className: 'g-dt' }, [
        heading,
        badge ? el('span', { className: 'g-b', text: badge }) : null,
      ]),
      el('p', { className: 'g-mu', text: description }),
    ]),
  ]);
}

function skeletonList(count = 6) {
  const list = el('div', {
    ariaLabel: 'Loading',
    className: 'g-skl',
    role: 'status',
  });
  for (let index = 0; index < count; index += 1) {
    list.append(el('div', { className: 'g-sk' }));
  }
  return list;
}

function emptyState(message, action) {
  return el('section', { className: 'g-st' }, [
    el('span', { className: 'icon info_outline', ariaHidden: true }),
    el('p', { text: message }),
    action,
  ]);
}

function gistTitle(gist) {
  const firstFile = Object.values(gist.files || {})[0];
  return gist.description || firstFile?.filename || 'Untitled gist';
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function safeAvatar(value, className) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !['avatars.githubusercontent.com', 'github.com'].includes(url.hostname)
    ) {
      return null;
    }
    const fallback = el('span', {
      className: `icon account_circle ${className}`,
    });
    const image = el('img', { className });
    image.addEventListener(
      'load',
      () => {
        fallback.replaceWith(image);
      },
      { once: true },
    );
    image.alt = '';
    image.src = url.href;
    return fallback;
  } catch (_error) {
    return null;
  }
}

export function safeGitHubUrl(value, pathname) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      (!pathname || url.pathname === pathname)
    );
  } catch (_error) {
    return false;
  }
}

function openExternal(url) {
  if (safeGitHubUrl(url)) globalThis.system?.openInBrowser?.(url);
}

async function copyText(value) {
  if (globalThis.cordova?.plugins?.clipboard?.copy) {
    globalThis.cordova.plugins.clipboard.copy(value);
    return;
  }
  await globalThis.navigator?.clipboard?.writeText?.(value);
}

function deviceStateText(stateValue) {
  const messages = {
    offline: 'Waiting for a connection. Polling will resume automatically.',
    pending: 'Waiting for authorization…',
    'slow-down': 'GitHub asked Acode to poll less frequently.',
  };
  return messages[stateValue] || messages.pending;
}

function recoveryFor(error) {
  if (error?.recoveryUrl && safeGitHubUrl(error.recoveryUrl)) {
    return {
      action: {
        label: 'Authorize SAML access',
        run: () => openExternal(error.recoveryUrl),
      },
      message: 'This token needs organization SAML authorization.',
    };
  }
  const messages = {
    authentication: 'GitHub authentication expired. Reconnect your account.',
    configuration: 'GitHub sign-in configuration is invalid.',
    conflict: 'The GitHub resource changed. Refresh and try again.',
    denied: 'GitHub sign-in was denied.',
    expired: 'The sign-in code expired. Start sign-in again.',
    'invalid-token': 'GitHub authentication expired. Reconnect your account.',
    internal: 'Acode could not start GitHub authentication. Retry this view.',
    'malformed-response': 'GitHub returned unexpected authentication data.',
    network: 'GitHub could not be reached. Check your connection and retry.',
    'not-found':
      'This resource is unavailable or is not included in the installation.',
    permission: 'GitHub denied permission for this action.',
    'rate-limit': "GitHub's rate limit was reached. Try again later.",
    'refresh-revoked': 'GitHub access was revoked. Sign in again to continue.',
    storage:
      'Acode could not save the GitHub session in local storage. Check available storage and retry.',
    unavailable: 'GitHub authentication is unavailable for this action.',
  };
  return {
    message:
      messages[error?.kind] ||
      'Acode could not process GitHub data. Retry this view.',
  };
}

function diagnosticCode(error) {
  if (
    !/^(?:branches|contents|device-code|device-token|gists|github|identity|installations|repositories|token-refresh)$/.test(
      error?.operation,
    ) ||
    !/^(?:native|web)$/.test(error?.transport) ||
    !/^(?:authentication|conflict|internal|network|not-found|permission|rate-limit|validation)$/.test(
      error?.kind,
    )
  ) {
    return '';
  }
  const status =
    Number.isInteger(error.status) && error.status >= 100 && error.status < 600
      ? error.status
      : Number.isInteger(error.nativeCode) &&
          error.nativeCode >= -8 &&
          error.nativeCode <= -1
        ? error.nativeCode
        : /^(?:redirect-disable|redirect-read|redirect-restore|request-create)$/.test(
              error.phase,
            )
          ? error.phase
          : 'none';
  return `${error.operation}/${error.transport}/${error.kind}/${status}`;
}
