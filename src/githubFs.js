import { createGitHubService } from './githubService';
import { lookupMimeType } from './mime';

const Url = acode.require('url');
const fsOperation = acode.require('fs') || acode.require('fsOperation');
const helpers = acode.require('helpers');
const prompt = acode.require('prompt');
const encodings = acode.require('encodings');

const test = (url) => /^gh:/.test(url);

githubFs.remove = () => {
  fsOperation.remove(test);
};

githubFs.constructUrl = (type, user, repo, path, branch) => {
  if (type === 'gist') {
    return `gh://gist/${user}/${repo}`;
  }
  let url = `gh://${type}/${user}/${repo}`;
  if (branch) url += `@${encodeURIComponent(branch)}`;
  if (path) url = Url.join(url, path);
  return url;
};

export default function githubFs(
  token,
  settings,
  { createGitHub = createGitHubService, runGitHub } = {},
) {
  let github;
  let githubToken;

  fsOperation.extend(test, (url) => {
    const { gist, path, repo, type, user } = parseUrl(url);
    if (type === 'repo') return readRepo(user, repo, path);
    if (type === 'gist') return readGist(gist, path);
    throw new Error('Invalid github url');
  });

  async function getGitHub() {
    const currentToken = await token();
    if (!github || githubToken !== currentToken) {
      github = createGitHub(currentToken);
      githubToken = currentToken;
    }
    return github;
  }

  async function withGitHub(operation, { write = false } = {}) {
    if (runGitHub) return runGitHub(operation, { write });
    return operation(await getGitHub());
  }

  function parseUrl(url) {
    const [type, user, repo, ...path] = url.replace(/^gh:\/\//, '').split('/');
    if (type === 'gist') {
      return { gist: user, path: repo, type };
    }
    return { path: path.join('/'), repo, type, user };
  }

  async function getCommitMessage(message) {
    if (!settings.askCommitMessage) return message;
    const result = await prompt('Commit message', message, 'text');
    if (result) return result;

    const error = new Error('Commit aborted');
    error.code = 0;
    error.toString = () => error.message;
    throw error;
  }

  function readRepo(owner, repoAtBranch, path) {
    const separator = repoAtBranch.indexOf('@');
    const repo =
      separator === -1 ? repoAtBranch : repoAtBranch.slice(0, separator);
    let branch;
    if (separator !== -1) {
      try {
        branch = decodeURIComponent(repoAtBranch.slice(separator + 1));
      } catch (_error) {
        throw new Error('Invalid GitHub URL: malformed repository ref');
      }
    }
    if (!repo || (separator !== -1 && !branch)) {
      throw new Error('Invalid GitHub URL: missing repository or ref');
    }
    let metadata;

    async function getMetadata() {
      if (!metadata && path) {
        metadata = await withGitHub((client) =>
          client.getContent(owner, repo, path, branch),
        );
      }
      return metadata;
    }

    function invalidateMetadata() {
      metadata = undefined;
    }

    return {
      async lsDir() {
        const data = await withGitHub((client) =>
          client.getContent(owner, repo, path, branch),
        );
        if (!Array.isArray(data)) throw new Error('Not a directory');
        return data.map(({ name, path: childPath, type }) => ({
          isDirectory: type === 'dir',
          isFile: type === 'file',
          name,
          url: githubFs.constructUrl('repo', owner, repo, childPath, branch),
        }));
      },

      async readFile(encoding) {
        if (!path) throw new Error('Cannot read root directory');
        const content = await getMetadata();
        if (Array.isArray(content) || content.type === 'dir') {
          throw new Error('Cannot read a directory');
        }
        const { sha } = content;
        const data = await withGitHub((client) =>
          client.getBlob(owner, repo, sha),
        );
        if (!encoding) return data;
        if (encodings?.decode) {
          const decoded = await encodings.decode(data, encoding);
          if (decoded) return decoded;
        }
        return helpers.decodeText(data, encoding);
      },

      async writeFile(data, encoding) {
        if (!path) throw new Error('Cannot write to root directory');
        const message = await getCommitMessage(`update ${path}`);
        const transformed = await prepareContent(data, encoding);
        await withGitHub(
          (client) =>
            client.writeFile({
              branch,
              content: transformed.content,
              encode: transformed.encode,
              message,
              owner,
              path,
              repo,
            }),
          { write: true },
        );
        invalidateMetadata();
      },

      async createFile(name, data = '') {
        const newPath = path ? Url.join(path, name) : name;
        const transformed = await prepareContent(data);
        const message = await getCommitMessage(`create ${newPath}`);
        try {
          await withGitHub(
            (client) =>
              client.createFile({
                branch,
                content: transformed.content,
                encode: transformed.encode,
                message,
                owner,
                path: newPath,
                repo,
              }),
            { write: true },
          );
        } catch (error) {
          if (error.kind === 'conflict') throw new Error('File already exists');
          throw error;
        }
        return githubFs.constructUrl('repo', owner, repo, newPath, branch);
      },

      async createDirectory(dirname) {
        const newPath = path ? Url.join(path, dirname) : dirname;
        const message = await getCommitMessage(`create ${newPath}`);
        try {
          await withGitHub(
            (client) =>
              client.createFile({
                branch,
                content: '',
                message,
                owner,
                path: Url.join(newPath, '.gitkeep'),
                repo,
              }),
            { write: true },
          );
        } catch (error) {
          if (error.kind === 'conflict') {
            throw new Error('Directory already exists');
          }
          throw error;
        }
        return githubFs.constructUrl('repo', owner, repo, newPath, branch);
      },

      async copyTo() {
        throw new Error('Not supported');
      },

      async delete() {
        if (!path) throw new Error('Cannot delete root');
        const message = await getCommitMessage(`delete ${path}`);
        await withGitHub(
          (client) =>
            client.deleteFile({
              branch,
              message,
              owner,
              path,
              repo,
            }),
          { write: true },
        );
        invalidateMetadata();
      },

      async moveTo() {
        throw new Error('Not supported');
      },

      async renameTo() {
        throw new Error('Not supported');
      },

      async exists() {
        if (!path) return true;
        try {
          await getMetadata();
          return true;
        } catch (error) {
          if (error.kind === 'not-found') return false;
          throw error;
        }
      },

      async stat() {
        if (!path) {
          return {
            isDirectory: true,
            isFile: false,
            length: 0,
            name: `github/${owner}/${repo}`,
          };
        }
        const content = await getMetadata();
        const isDirectory = Array.isArray(content) || content.type === 'dir';
        if (isDirectory) {
          return {
            isDirectory: true,
            isFile: false,
            length: 0,
            name: path.split('/').pop(),
          };
        }
        return {
          isDirectory: false,
          isFile: content.type === 'file',
          length: content.size ?? 0,
          name: path.split('/').pop(),
          type: lookupMimeType(path),
        };
      },
    };
  }

  function readGist(gistId, path) {
    let file;

    async function getFile() {
      if (!file) {
        const gist = await withGitHub((client) => client.getGist(gistId));
        file = gist.files[path];
      }
      return file;
    }

    return {
      async lsDir() {
        throw new Error('Not supported');
      },

      async readFile() {
        return (await getFile()).content;
      },

      async writeFile(data, encoding) {
        const selectedEncoding =
          encoding || settings.defaultFileEncoding || 'utf-8';
        const transformed = await prepareContent(data, selectedEncoding);
        await withGitHub(
          (client) =>
            client.updateGist(gistId, {
              files: { [path]: { content: transformed.content } },
            }),
          { write: true },
        );
        file = undefined;
      },

      async createFile() {
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
        return Boolean(await getFile());
      },

      async stat() {
        const content = await getFile();
        return {
          isDirectory: false,
          isFile: true,
          length: content.size,
          name: path,
          type: lookupMimeType(path),
        };
      },
    };
  }
}

async function prepareContent(data, encoding) {
  let encode = true;
  if (encoding) {
    if (data instanceof ArrayBuffer && encodings?.decode) {
      data = await encodings.decode(data, encoding);
    }
    if (encodings?.encode) data = await encodings.encode(data, encoding);
    if (data instanceof ArrayBuffer && encodings?.decode) {
      data = await encodings.decode(data, encoding);
    }
  } else if (data instanceof ArrayBuffer) {
    data = await bufferToBase64(data);
    encode = false;
  }
  return { content: data, encode };
}

async function bufferToBase64(buffer) {
  const blob = new Blob([buffer]);
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  return new Promise((resolve, reject) => {
    reader.onloadend = () => {
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = reject;
  });
}
