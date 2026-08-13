import GitHub from './GitHubAPI/GitHub';
import plugin from '../plugin.json';
import githubFs from './githubFs';
import createSidebar from './sidebar';

const prompt = acode.require('prompt');
const confirm = acode.require('confirm');
const palette = acode.require('palette') || acode.require('pallete');
const helpers = acode.require('helpers');
const multiPrompt = acode.require('multiPrompt');
const openFolder = acode.require('openFolder');
const EditorFile = acode.require('EditorFile');
const appSettings = acode.require('settings');
const toast = acode.require('toast');
const fsOperation = acode.require('fsOperation');

function isChineseLocale() {
  const langs = [];
  try {
    if (Array.isArray(navigator.languages)) langs.push(...navigator.languages);
    if (navigator.language) langs.push(navigator.language);
  } catch (_) {}
  return langs.some((lang) => /^zh(?:-|$)/i.test(String(lang || '')));
}

function t(en, zh) {
  return isChineseLocale() ? zh : en;
}

if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(this);
    });
  };
}

class AcodePlugin {
  token = '';
  NEW = `${helpers.uuid()}_NEW`;
  #fsInitialized = false;
  #repos = [];
  #gists = [];
  #sidebar = null;
  #tokenPromise = null;

  async init() {
    this.commands.forEach(command => {
      editorManager.editor.commands.addCommand(command);
    });

    this.token = localStorage.getItem('github-token');
    await this.initFs();

    // Register sidebar
    try {
      this.#sidebar = createSidebar(this);
      this.#sidebar?.register();
    } catch (e) {
      console.warn('GitHub sidebar registration failed:', e);
    }

    tutorial(plugin.id, (hide) => {
      const commands = editorManager.editor.commands.byName;
      const openCommandPalette = commands.openCommandPalette || commands.openCommandPallete;
      const message = t(
        "GitHub plugin is installed successfully. You can use the sidebar panel or open command palette and search 'open repository' to open a GitHub repository.",
        'GitHub 插件安装成功。您可以使用侧边栏面板，或打开命令面板搜索「open repository」来打开 GitHub 仓库。'
      );
      let key = 'Ctrl+Shift+P';
      if (openCommandPalette) {
        key = openCommandPalette.bindKey.win;
      }

      if (!key) {
        const onclick = async () => {
          const EditorFile = acode.require('EditorFile');
          const fileInfo = await fsOperation(KEYBINDING_FILE).stat();
          new EditorFile(fileInfo.name, { uri: KEYBINDING_FILE, render: true });
          hide();
        };
        return <p>{message} {t(
          "Shortcut to open command palette is not set,",
          '打开命令面板的快捷键尚未设置，'
        )} <span className='link' onclick={onclick}>{t('Click here', '点击这里')}</span> {t(
          "set shortcut or use '...' icon in quick tools.",
          "设置快捷键，或使用快捷工具栏中的 '...' 图标。"
        )}</p>
      }

      return <p>{message} {t(
        `To open command palette use combination ${key} or use '...' icon in quick tools.`,
        `打开命令面板使用组合键 ${key}，或使用快捷工具栏中的 '...' 图标。`
      )}</p>;
    });
  }

  async initFs() {
    if (this.#fsInitialized) return;
    githubFs.remove();
    githubFs(this.getToken.bind(this), this.settings);
    this.#fsInitialized = true;
  }

  async getToken() {
    if (this.token) return this.token;
    // Guard against concurrent calls triggering multiple prompts
    if (!this.#tokenPromise) {
      this.#tokenPromise = this.updateToken().finally(() => {
        this.#tokenPromise = null;
      });
    }
    await this.#tokenPromise;
    return this.token;
  }

  async destroy() {
    this.#sidebar?.unregister();
    this.#sidebar = null;
    githubFs.remove();
    this.commands.forEach(command => {
      editorManager.editor.commands.removeCommand(command.name);
    });
  }

  clearCache() {
    this.#repos = [];
    this.#gists = [];
  }

  async openRepo() {
    await this.initFs();
    this.token = await this.getToken();

    const repos = await this.listRepositories();
    if (!repos.length) {
      toast(t('No repositories found', '未找到仓库'));
      return;
    }

    palette(
      () => repos,
      this.selectBranch.bind(this),
      t('Type to search repository', '输入以搜索仓库'),
    );
  }

  async selectBranch(repo) {
    const [user, repoName] = repo.split('/');

    toast(t('Loading branches...', '正在查找分支...'));
    const branches = await this.listBranches(user, repoName);
    if (!branches || !branches.length) {
      toast(t('No branches found', '未找到分支'));
      return;
    }

    palette(
      () => branches,
      (branch) => this.openRepoAsFolder(user, repoName, branch)
        .catch(helpers.error),
      t('Type to search branch', '输入以搜索分支'),
    );
  }

  async deleteGist() {
    await this.initFs();
    const gist = await new Promise((resolve) => {
      palette(
        this.listGists.bind(this, false),
        resolve,
        t('Type to search gist', '输入以搜索 Gist'),
      );
    });
    const confirmation = await confirm(strings['warning'], t('Delete this gist?', '删除此 Gist？'));
    if (!confirmation) return;

    const gh = await this.#GitHub();
    const gistApi = gh.getGist(gist);
    await gistApi.delete();
    this.#gists = this.#gists.filter(g => g.id !== gist);
    window.toast(t('Gist deleted', 'Gist 已删除'));
  }

  async deleteGistFile() {
    await this.initFs();
    const gist = await new Promise((resolve) => {
      palette(
        this.listGists.bind(this, false),
        resolve,
        t('Type to search gist', '输入以搜索 Gist'),
      );
    });

    const file = await new Promise((resolve) => {
      palette(
        this.listGistFiles.bind(this, gist, false),
        resolve,
        t('Type to search gist file', '输入以搜索 Gist 文件'),
      );
    });

    const confirmation = await confirm(strings['warning'], t('Delete this file?', '删除此文件？'));
    if (!confirmation) return;

    const gh = await this.#GitHub();
    const gistApi = gh.getGist(gist);
    await gistApi.update({
      files: {
        [file]: null,
      },
    });
    const cachedGist = this.#getGist(gist);
    if (cachedGist) cachedGist.files = cachedGist.files.filter(f => f.filename !== file);
    window.toast(t('File deleted', '文件已删除'));
  }

  async openRepoAsFolder(user, repoName, branch) {
    const cachedRepo = this.#getRepo(user, repoName);
    if (branch === this.NEW) {
      const { from, branch: newBranch } = await multiPrompt(
        strings['create new branch'],
        [{
          id: 'from',
          placeholder: strings['use branch'],
          hints: (setHints) => {
            setHints(cachedRepo.branches);
          },
          type: 'text',
        },
        {
          id: 'branch',
          placeholder: strings['new branch'],
          type: 'text',
          match: /^[a-z\-_0-9]+$/i,
        }],
      );
      branch = newBranch;
      const gh = await this.#GitHub();
      const repo = gh.getRepo(user, repoName);
      await repo.createBranch(from, newBranch);
    }

    if (branch === '..') {
      this.openRepo();
      return;
    }

    const url = githubFs.constructUrl('repo', user, repoName, '/', branch);
    openFolder(url, {
      name: `${user}/${repoName}/${branch}`,
      listFiles: false,
      saveState: false,
    });
    toast(t(
      `Repo opened: ${user}/${repoName}/${branch}. Check the file browser sidebar to browse files.`,
      `仓库已打开：${user}/${repoName}/${branch}。请在文件浏览器侧边栏中查看文件。`
    ));
  }

  async openGist() {
    await this.initFs();
    this.token = await this.getToken();

    palette(
      this.listGists.bind(this),
      this.openGistFile.bind(this),
      t('Type to search gist', '输入以搜索 Gist'),
    );
  }

  async openGistFile(gist) {
    let url;
    let thisFilename;
    if (gist === this.NEW) {
      const { description, name, public: isPublic } = await multiPrompt(
        t('New gist', '新建 Gist'),
        [{
          id: 'description',
          placeholder: t('Description', '描述'),
          type: 'text',
        },
        {
          id: 'name',
          placeholder: t('File name*', '文件名*'),
          type: 'text',
          required: true,
        },
        [
          t('Visibility', '可见性'),
          {
            id: 'public',
            name: 'visibility',
            value: true,
            placeholder: t('Public', '公开'),
            type: 'radio',
          },
          {
            id: 'private',
            name: 'visibility',
            value: false,
            placeholder: t('Private', '私有'),
            type: 'radio',
          }
        ]],
      ).catch(() => {
        window.toast(strings['cancelled']);
      });

      helpers.showTitleLoader();
      const gh = await this.#GitHub();
      const gist = gh.getGist();
      const { data } = await gist.create({
        description,
        public: isPublic,
        files: {
          [name]: {
            content: '# New gist',
          },
        },
      });
      this.#gists.push(this.#formatGist(data));
      thisFilename = name;
      url = githubFs.constructUrl('gist', data.id, name);
      helpers.removeTitleLoader();
    } else {
      await new Promise((resolve) => {
        palette(
          this.listGistFiles.bind(this, gist),
          async (file) => {
            if (file === this.NEW) {
              const filename = await prompt(t('Enter file name', '输入文件名'), '', 'text', {
                required: true,
                placeholder: t('filename', '文件名'),
              });
              if (!filename) {
                window.toast(strings['cancelled']);
              }
              helpers.showTitleLoader();
              const gh = await this.#GitHub();
              await gh.getGist(gist).update({
                files: {
                  [filename]: {
                    content: '# New gist file',
                  },
                },
              });
              const cachedGist = this.#getGist(gist);
              cachedGist.files?.push({
                text: filename,
                value: filename,
              });
              helpers.removeTitleLoader();
              thisFilename = filename;
              url = githubFs.constructUrl('gist', gist, filename);
              resolve();
              return;
            }

            url = githubFs.constructUrl('gist', gist, file);
            thisFilename = file;
            resolve();
          },
          t('Type to search gist file', '输入以搜索 Gist 文件'),
        );
      });
    }

    new EditorFile(thisFilename, {
      uri: url,
      render: true,
    });

  }

  async updateToken() {
    const result = await prompt(
      t(
        'Enter GitHub token (minimum: classic `repo` + `gist`, or fine-grained Metadata:Read, Contents:Read/Write, Gists:Read/Write)',
        '输入 GitHub 令牌（最低权限：Classic 需 repo + gist；Fine-grained 需 Metadata:Read、Contents:Read/Write、Gists:Read/Write）'
      ),
      '',
      'text',
      {
      required: true,
      placeholder: t('token', '令牌'),
      }
    );

    if (result) {
      const normalizedToken = String(result)
        .trim()
        .replace(/^Bearer\s+/i, '')
        .replace(/^token\s+/i, '');

      if (!/^[A-Za-z0-9_]+$/.test(normalizedToken)) {
        toast(t(
          'Invalid token format: only letters, numbers, underscore are allowed',
          '令牌格式无效：仅允许字母、数字、下划线'
        ));
        return;
      }

      // [Copilot+Greptile review] Persist to localStorage only after
      // validation succeeds; rollback this.token on failure so an invalid
      // token never stays cached across app restarts.
      const oldToken = this.token;
      this.token = normalizedToken;
      this.#fsInitialized = false;
      await this.initFs();

      try {
        const gh = await this.#GitHub();
        await gh.getUser().getProfile();
        // Validation passed — now persist
        localStorage.setItem('github-token', this.token);
      } catch (error) {
        // Rollback to previous token
        this.token = oldToken;
        this.#fsInitialized = false;
        await this.initFs();
        const msg = error && (error.message || String(error)) || t('Unknown token error', '未知令牌错误');
        toast(t('Token validation failed: ', '令牌校验失败：') + msg);
        throw error;
      }
    }
  }

  async listRepositories() {
    if (this.#repos.length) {
      return [...this.#repos];
    }
    const gh = await this.#GitHub();
    const user = gh.getUser();
    const repos = await user.listRepos();
    const { data } = repos;

    const list = data.map((repo) => {
      const { name, owner, visibility } = repo;
      return {
        text: `<div style="display: flex; flex-direction: column;">
        <strong data-str=${owner.login} style="font-size: 1rem;">${name}</strong>
        <span style="font-size: 0.8rem; opacity: 0.8;">${visibility}</span>
      <div>`,
        value: `${owner.login}/${name}`,
      }
    });
    this.#repos = [...list];
    return list;
  }

  async listBranches(user, repoName) {
    let list = [];
    const cachedRepo = this.#getRepo(user, repoName);
    if (cachedRepo && cachedRepo.branches) {
      list = [...cachedRepo.branches];
    } else {
      const gh = await this.#GitHub();
      const repo = gh.getRepo(user, repoName);
      const branches = await repo.listBranches();
      const { data } = branches;

      list = data.map((branch) => {
        return {
          text: branch.name,
          value: branch.name,
        }
      });

      if (cachedRepo) {
        cachedRepo.branches = [...list];
      }
    }

    list.push({
      text: t('New branch', '新建分支'),
      value: this.NEW,
    });

    list.unshift({
      text: '..',
      value: '..',
    });

    return list;
  }

  async listGists(showAddNew = true) {
    let list = [];
    if (this.#gists.length) {
      list = [...this.#gists];
    } else {
      const gh = await this.#GitHub();
      const user = gh.getUser();
      const gists = await user.listGists();
      const { data } = gists;

      list = data.map(this.#formatGist);

      this.#gists = [...list];
    }

    if (showAddNew) {
      list.push({
        text: this.#highlightedText(t('New gist', '新建 Gist')),
        value: this.NEW,
      });
    }

    return list;
  }

  async listGistFiles(gistId, showAddNew = true) {
    let list = [];
    const cachedGist = this.#getGist(gistId);
    if (cachedGist && cachedGist.files) {
      list = [...cachedGist.files];
    } else {
      const gh = await this.#GitHub();
      const gist = gh.getGist(gistId);
      const { data: { files, owner } } = await gist.read();

      list = Object.values(files).map(({ filename }) => {
        return {
          text: filename,
          value: filename,
        }
      });

      if (cachedGist) {
        cachedGist.files = [...list];
      }
    }

    if (showAddNew) {
      list.push({
        text: this.#highlightedText(t('New file', '新建文件')),
        value: this.NEW,
      });
    }

    return list;
  }

  #highlightedText(text) {
    return `<span style='text-transform: uppercase; color: var(--popup-active-color)'>${text}</span>`;
  }

  #formatGist(gist) {
    const { description, owner, files } = gist;
    const file = Object.values(files)[0];
    return {
      text: `<div style="display: flex; flex-direction: column;">
    <strong data-str=${owner.login} style="font-size: 1rem;">${description || file.filename}</strong>
  <div>`,
      value: gist.id,
    }
  }

  #getRepo(user, repoName) {
    return this.#repos.find(repo => repo.value === `${user}/${repoName}`);
  }

  #getGist(gistId) {
    return this.#gists.find(gist => gist.value === gistId);
  }

  async #GitHub() {
    return new GitHub({ token: await this.getToken() });
  }

  get commands() {
    return [
      {
        name: 'github:repository:selectrepo',
        description: t('Open repository', '\u6253\u5f00\u4ed3\u5e93'),
        exec: this.openRepo.bind(this),
      },
      {
        name: 'github:gist:opengist',
        description: t('Open gist', '\u6253\u5f00 Gist'),
        exec: this.openGist.bind(this),
      },
      {
        name: 'github:gist:deletegist',
        description: t('Delete gist', '\u5220\u9664 Gist'),
        exec: this.deleteGist.bind(this),
      },
      {
        name: 'github:gist:deletegistfile',
        description: t('Delete gist file', '\u5220\u9664 Gist \u6587\u4ef6'),
        exec: this.deleteGistFile.bind(this),
      },
      {
        name: 'github:updatetoken',
        description: t('Update github token', '\u66f4\u65b0 GitHub \u4ee4\u724c'),
        exec: this.updateToken.bind(this),
      },
      {
        name: 'github:clearcache',
        description: t('Clear github cache', '\u6e05\u9664 GitHub \u7f13\u5b58'),
        exec: this.clearCache.bind(this),
      }
    ]
  }

  get settings() {
    const settings = appSettings.value[plugin.id];
    if (!settings) {
      appSettings.value[plugin.id] = {
        askCommitMessage: true,
      };
      appSettings.update();
    }
    return appSettings.value[plugin.id];
  }

  get settingsJson() {
    const list = [
      {
        key: 'askCommitMessage',
        text: t('Ask for commit message', '提交时询问提交信息'),
        checkbox: this.settings.askCommitMessage,
      }
    ];

    return {
      list,
      cb: (key, value) => {
        this.settings[key] = value;
        appSettings.update();
      }
    }
  }
}

/**
 * Create a toast message
 * @param {string} id 
 * @param {string|HTMLElement|(hide: ()=>void)=>HTMLElement} message 
 * @returns 
 */
function tutorial(id, message) {
  if (!toast) return;
  if (localStorage.getItem(id) === 'true') return;
  localStorage.setItem(id, 'true');

  if (typeof message === 'function') {
    message = message(toast.hide);
  }

  toast(message, false, '#17c', '#fff');
}

if (window.acode) {
  // plugin setup
  const acodePlugin = new AcodePlugin();
  acode.setPluginInit(plugin.id, async (baseUrl, $page, { cacheFileUrl, cacheFile }) => {
    // pluginInit
    if (!baseUrl.endsWith('/')) {
      baseUrl += '/';
    }
    acodePlugin.baseUrl = baseUrl;
    await acodePlugin.init($page, cacheFile, cacheFileUrl);
  }, acodePlugin.settingsJson);
  acode.setPluginUnmount(plugin.id, () => {
    acodePlugin.destroy();
  });
}