import GitHub from './GitHubAPI/GitHub';
import { lookup } from 'mime-types';
import Repository from './GitHubAPI/Repository';
import Gist from './GitHubAPI/Gist';

const Url = acode.require('url');
const fsOperation = acode.require('fs') || acode.require('fsOperation');
const helpers = acode.require('helpers');
const prompt = acode.require('prompt');
const encodings = acode.require('encodings');

const test = (url) => /^gh:/.test(url);
const REGISTRY_KEY = '__acodeGithubFsTests__';

function _isZh() {
  try {
    const langs = [].concat(navigator.languages || [], navigator.language || []);
    return langs.some((l) => /^zh(?:-|$)/i.test(String(l || '')));
  } catch (_) { return false; }
}
function _t(en, zh) { return _isZh() ? zh : en; }

function getRegistry() {
  if (!window[REGISTRY_KEY]) {
    window[REGISTRY_KEY] = [];
  }
  return window[REGISTRY_KEY];
}

function removeAllGithubFsHandlers() {
  const registry = getRegistry();
  registry.forEach((registeredTest) => {
    try { fsOperation.remove(registeredTest); } catch (_) {}
  });
  registry.length = 0;
}

githubFs.remove = () => {
  removeAllGithubFsHandlers();
};

/**
 * 
 * @param {string} user 
 * @param {'repo' | 'gist'} type 
 * @param {string} repo 
 * @param {string} path 
 * @param {string} branch 
 * @returns 
 */
githubFs.constructUrl = (type, user, repo, path, branch) => {
  if (type === 'gist') {
    // user is gist id
    // repo is filename
    return `gh://gist/${user}/${repo}`;
  }
  let url = `gh://${type}/${user}/${repo}`;
  if (branch) {
    url += `@${branch}`;
  }
  if (path) {
    url = Url.join(url, path);
  }
  return url;
};

export default function githubFs(token, settings) {
  // Ensure only one active gh:// handler even after plugin hot-reloads.
  removeAllGithubFsHandlers();
  getRegistry().push(test);

  fsOperation.extend(test, (url) => {
    const { user, type, repo, path, gist } = parseUrl(url);
    if (type === 'repo') {
      return readRepo(user, repo, path);
    }

    if (type === 'gist') {
      return readGist(gist, path);
    }

    throw new Error('Invalid github url');
  });

  /**
   * Parse url to get type, user, repo and path
   * @param {string} url 
   */
  function parseUrl(url) {
    url = url.replace(/^gh:\/\//, '');
    const [type, user, repo, ...path] = url.split('/');

    // gist doesn't have user
    if (type === 'gist') {
      return {
        /**@type {string} */
        gist: user,
        /**@type {string} */
        path: repo,
        type: 'gist',
      }
    }

    return {
      /**@type {string} */
      user,
      /**@type {'repo'|'gist'} */
      type,
      /**@type {string} */
      repo,
      /**@type {string} */
      path: path.join('/'),
    };
  }

  /**
   * Get commit message from user
   * @param {string} message 
   * @returns 
   */
  async function getCommitMessage(message) {
    if (settings.askCommitMessage) {
      const res = await prompt(_t('Commit message', '提交信息'), message, 'text');
      if (!res) {
        const error = new Error(_t('Commit aborted', '提交已取消'));
        error.code = 0;
        error.toString = () => error.message;
        throw error;
      }
      return res;
    }
    return message;
  }

  /**
   * 
   * @param {string} user 
   * @param {string} repoAtBranch 
   * @param {string} path 
   * @returns 
   */
  function readRepo(user, repoAtBranch, path) {
    /**@type {GitHub} */
    let gh;
    /**@type {Repository} */
    let repo;
    const [repoName, branch] = repoAtBranch.split('@');
    let sha = '';
    const getSha = async () => {
      if (!sha && path) {
        const res = await repo.getSha(branch, path);
        sha = res.data.sha;
      }
    };

    const init = async () => {
      if (gh) return;
      gh = new GitHub({ token: await token() });
      repo = gh.getRepo(user, repoName);
    }

    return {
      async lsDir() {
        await init();
        const res = await repo.getSha(branch, path);
        const { data } = res;

        return data.map(({ name: filename, path, type }) => {
          return {
            name: filename,
            isDirectory: type === 'dir',
            isFile: type === 'file',
            url: githubFs.constructUrl('repo', user, repoName, path, branch),
          }
        });
      },
      async readFile(encoding) {
        if (!path) throw new Error('Cannot read root directory')
        await init();
        await getSha();
        let { data } = await repo.getBlob(sha, 'blob');
        data = await data.arrayBuffer();

        if (encoding) {
          if (encodings?.decode) {
            const decoded = await encodings.decode(data, encoding);
            if (decoded) return decoded;
          }

          /**@deprecated just for backward compatibility */
          return helpers.decodeText(data, encoding);
        }

        return data;
      },
      async writeFile(data, encoding) {
        if (!path) throw new Error('Cannot write to root directory')
        const commitMessage = await getCommitMessage(`update ${path}`);
        if (!commitMessage) return;

        let encode = true;

        if (encoding) {
          if (data instanceof ArrayBuffer && encodings?.decode) {
            data = await encodings.decode(data, encoding);
          }

          if (encoding && encodings?.encode) {
            data = await encodings.encode(data, encoding);
          }

          if (data instanceof ArrayBuffer && encodings?.decode) {
            data = await encodings.decode(data, encoding);
          }
        } else if (data instanceof ArrayBuffer) {
          // convert to base64
          data = await bufferToBase64(data);
          encode = false;
        }

        await init();
        await repo.writeFile(branch, path, data, commitMessage, { encode });
      },
      async createFile(name, data = '') {
        await init();
        const newPath = path === '' ? name : Url.join(path, name);
        // check if file exists
        let sha;
        let encode = true;
        try {
          sha = await repo.getSha(branch, newPath);
        } catch (e) {
          // file doesn't exist
        }

        if (sha) {
          throw new Error('File already exists');
        }

        if (data instanceof ArrayBuffer) {
          // convert to base64
          data = await bufferToBase64(data);
          encode = false;
        }

        const commitMessage = await getCommitMessage(`create ${newPath}`);
        if (!commitMessage) return;
        await repo.writeFile(branch, newPath, data, commitMessage, { encode });
        return githubFs.constructUrl('repo', user, repoName, newPath, branch);
      },
      async createDirectory(dirname) {
        await init();
        let newPath = path === '' ? dirname : Url.join(path, dirname);
        // check if file exists
        let sha;
        try {
          sha = await repo.getSha(branch, newPath);
        } catch (e) {
          // file doesn't exist
        }

        if (sha) {
          throw new Error('Directory already exists');
        }

        const createPath = Url.join(newPath, '.gitkeep');
        const commitMessage = await getCommitMessage(`create ${newPath}`);
        if (!commitMessage) return;
        await repo.writeFile(branch, createPath, '', commitMessage);
        return githubFs.constructUrl('repo', user, repoName, newPath, branch);
      },
      async copyTo(dest) {
        throw new Error('Not supported');
      },
      async delete() {
        if (!path) throw new Error('Cannot delete root');
        await init();
        await getSha();
        const commitMessage = await getCommitMessage(`delete ${path}`);
        if (!commitMessage) return;
        await repo.deleteFile(branch, path, commitMessage, sha);
      },
      async moveTo(dest) {
        throw new Error('Not supported');
        // if (!path) throw new Error('Cannot move root');
        // await init();
        // const { path: destPath } = parseUrl(dest);
        // const newName = Url.join(destPath, Url.basename(path));
        // const res = await move(newName);
        // return res;
      },
      async renameTo(name) {
        throw new Error('Not supported');
        // if (!path) throw new Error('Cannot rename root');
        // await init();
        // const newName = Url.join(Url.dirname(path), name);
        // const res = await move(newName);
        // return res;
      },
      async exists() {
        if (!path) return true;
        await init();
        try {
          await repo.getSha(branch, path);
          return true;
        } catch (e) {
          return false;
        }
      },
      async stat() {
        if (!path) {
          return {
            length: 0,
            name: `github/${user}/${repoName}`,
            isDirectory: true,
            isFile: false,
          }
        }
        await init();
        await getSha();
        const content = await repo.getBlob(sha);
        return {
          length: content.data.length,
          name: path.split('/').pop(),
          isDirectory: path.endsWith('/'),
          isFile: !path.endsWith('/'),
          type: lookup(path),
        };
      },
    }
  }

  function readGist(gistId, path) {
    /**@type {string} */
    let file;
    /**@type {GitHub} */
    let gh;
    /**@type {Gist} */
    let gist;
    const getFile = async () => {
      if (!file) {
        const { data } = await gist.read();
        file = data.files[path];
      }
      return file;
    }
    const init = async () => {
      if (gh) return;
      gh = new GitHub({ token: await token() });
      gist = gh.getGist(gistId);
    }

    return {
      async lsDir() {
        throw new Error('Not supported');
      },
      async readFile() {
        await init();
        const { content: data } = await getFile();
        return data;
      },
      async writeFile(data, encoding) {
        await init();

        encoding = settings.value.defaultFileEncoding || 'utf-8';

        if (encoding) {
          if (data instanceof ArrayBuffer && encodings?.decode) {
            data = await encodings.decode(data, encoding);
          }

          if (encoding && encodings?.encode) {
            data = await encodings.encode(data, encoding);
          }

          if (data instanceof ArrayBuffer && encodings?.decode) {
            data = await encodings.decode(data, encoding);
          }
        }

        await gist.update({
          files: {
            [path]: {
              content: data,
            }
          }
        });
      },
      async createFile(name, data) {
        throw new Error('Not supported');
      },
      async createDirectory() {
        throw new Error('Not supported');
      },
      async copyTo() {
        throw new Error('Not supported');
      },
      async delete() {
        throw new Error('Not supported');
      },
      async moveTo() {
        throw new Error('Not supported');
      },
      async renameTo() {
        throw new Error('Not supported');
      },
      async exists() {
        await init();
        return !!await getFile();
      },
      async stat() {
        await init();
        await getFile();
        return {
          length: file.size,
          name: path,
          isDirectory: false,
          isFile: true,
          type: lookup(path),
        };
      },
    }
  }
}

async function bufferToBase64(buffer) {
  const blob = new Blob([buffer]);
  const reader = new FileReader();

  reader.readAsDataURL(blob);
  return new Promise((resolve, reject) => {
    reader.onloadend = () => {
      // strip off the data: url prefix
      const content = reader.result.slice(reader.result.indexOf(',') + 1);
      resolve(content);
    };

    reader.onerror = reject;
  });
}
