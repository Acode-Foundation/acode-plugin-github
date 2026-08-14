const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('GitHub filesystem preserves URL, traversal, and read contracts', async () => {
  const harness = createHarness();
  await withSourceModule(
    'githubFs.js',
    harness.globals,
    async ({ default: githubFs }) => {
      assert.equal(
        githubFs.constructUrl(
          'repo',
          'octocat',
          'example',
          'src/index.js',
          'main',
        ),
        'gh://repo/octocat/example@main/src/index.js',
      );
      assert.equal(
        githubFs.constructUrl('gist', 'abc123', 'notes.md'),
        'gh://gist/abc123/notes.md',
      );

      githubFs(
        harness.token,
        { askCommitMessage: false },
        harness.dependencies,
      );
      const directory = harness.open('gh://repo/octocat/example@main/src');
      assert.deepEqual(await directory.lsDir(), [
        {
          isDirectory: false,
          isFile: true,
          name: 'index.js',
          url: 'gh://repo/octocat/example@main/src/index.js',
        },
        {
          isDirectory: true,
          isFile: false,
          name: 'nested',
          url: 'gh://repo/octocat/example@main/src/nested',
        },
      ]);
      assert.deepEqual(await directory.stat(), {
        isDirectory: true,
        isFile: false,
        length: 0,
        name: 'src',
      });
      await assert.rejects(directory.readFile(), /Cannot read a directory/);

      const file = harness.open('gh://repo/octocat/example@main/src/index.js');
      assert.equal(await file.readFile('utf-8'), 'decoded:utf-8:hello');
      assert.deepEqual(
        Buffer.from(await file.readFile()),
        Buffer.from('hello'),
      );
      assert.equal(await file.exists(), true);
      assert.deepEqual(await file.stat(), {
        isDirectory: false,
        isFile: true,
        length: 5,
        name: 'index.js',
        type: 'text/javascript',
      });

      const root = harness.open('gh://repo/octocat/example@main');
      assert.equal(await root.exists(), true);
      await assert.rejects(root.readFile(), /Cannot read root directory/);
      await assert.rejects(
        root.writeFile('x'),
        /Cannot write to root directory/,
      );
      await assert.rejects(root.delete(), /Cannot delete root/);
    },
  );

  assert.deepEqual(harness.createdTokens, ['phase-one-token']);
});

test('repository refs with slash, at-sign, and percent round-trip through URLs', async () => {
  const harness = createHarness();
  await withSourceModule(
    'githubFs.js',
    harness.globals,
    async ({ default: githubFs }) => {
      githubFs(
        harness.token,
        { askCommitMessage: false },
        harness.dependencies,
      );

      for (const branch of [
        'feature/mobile',
        'release@candidate',
        'percent%candidate',
      ]) {
        const encoded = encodeURIComponent(branch);
        const folderUrl = githubFs.constructUrl(
          'repo',
          'octocat',
          'example',
          'src',
          branch,
        );
        assert.equal(folderUrl, `gh://repo/octocat/example@${encoded}/src`);
        const children = await harness.open(folderUrl).lsDir();
        assert.equal(
          children[0].url,
          `gh://repo/octocat/example@${encoded}/src/index.js`,
        );
        assert.equal(harness.repositoryCalls.getContent.at(-1).ref, branch);
      }

      assert.equal(
        githubFs.constructUrl('repo', 'octocat', 'example', 'src', 'main'),
        'gh://repo/octocat/example@main/src',
      );
      assert.throws(
        () => harness.open('gh://repo/octocat/example@bad%2/src'),
        /Invalid GitHub URL: malformed repository ref/,
      );
    },
  );
});

test('GitHub filesystem preserves writes, creates, deletes, and commit prompts', async () => {
  const harness = createHarness({ promptResult: 'User supplied message' });
  await withSourceModule(
    'githubFs.js',
    harness.globals,
    async ({ default: githubFs }) => {
      githubFs(harness.token, { askCommitMessage: true }, harness.dependencies);
      const file = harness.open('gh://repo/octocat/example@main/src/index.js');
      await file.writeFile('updated', 'utf-8');
      await file.writeFile(new TextEncoder().encode('binary').buffer);

      const directory = harness.open('gh://repo/octocat/example@main/src');
      assert.equal(
        await directory.createFile('created.txt', 'created'),
        'gh://repo/octocat/example@main/src/created.txt',
      );
      assert.equal(
        await directory.createFile(
          'binary.dat',
          new TextEncoder().encode('bytes').buffer,
        ),
        'gh://repo/octocat/example@main/src/binary.dat',
      );
      assert.equal(
        await directory.createDirectory('folder'),
        'gh://repo/octocat/example@main/src/folder',
      );
      await file.delete();
    },
  );

  assert.deepEqual(harness.promptMessages, [
    'update src/index.js',
    'update src/index.js',
    'create src/created.txt',
    'create src/binary.dat',
    'create src/folder',
    'delete src/index.js',
  ]);
  assert.deepEqual(harness.repositoryCalls.writeFile, [
    {
      branch: 'main',
      content: 'encoded:utf-8:updated',
      encode: true,
      message: 'User supplied message',
      owner: 'octocat',
      path: 'src/index.js',
      repo: 'example',
    },
    {
      branch: 'main',
      content: 'YmluYXJ5',
      encode: false,
      message: 'User supplied message',
      owner: 'octocat',
      path: 'src/index.js',
      repo: 'example',
    },
  ]);
  assert.deepEqual(harness.repositoryCalls.createFile, [
    {
      branch: 'main',
      content: 'created',
      encode: true,
      message: 'User supplied message',
      owner: 'octocat',
      path: 'src/created.txt',
      repo: 'example',
    },
    {
      branch: 'main',
      content: 'Ynl0ZXM=',
      encode: false,
      message: 'User supplied message',
      owner: 'octocat',
      path: 'src/binary.dat',
      repo: 'example',
    },
    {
      branch: 'main',
      content: '',
      message: 'User supplied message',
      owner: 'octocat',
      path: 'src/folder/.gitkeep',
      repo: 'example',
    },
  ]);
  assert.deepEqual(harness.repositoryCalls.deleteFile, [
    {
      branch: 'main',
      message: 'User supplied message',
      owner: 'octocat',
      path: 'src/index.js',
      repo: 'example',
    },
  ]);
});

test('GitHub filesystem records commit cancellation and writes gists', async () => {
  const cancelled = createHarness({ promptResult: '' });
  await withSourceModule(
    'githubFs.js',
    cancelled.globals,
    async ({ default: githubFs }) => {
      githubFs(
        cancelled.token,
        { askCommitMessage: true },
        cancelled.dependencies,
      );
      const file = cancelled.open(
        'gh://repo/octocat/example@main/src/index.js',
      );
      await assert.rejects(
        file.writeFile('updated'),
        (error) => error.code === 0 && error.message === 'Commit aborted',
      );
      assert.deepEqual(cancelled.repositoryCalls.writeFile, []);
    },
  );

  const gistHarness = createHarness();
  await withSourceModule(
    'githubFs.js',
    gistHarness.globals,
    async ({ default: githubFs }) => {
      githubFs(
        gistHarness.token,
        { askCommitMessage: false },
        gistHarness.dependencies,
      );
      const gist = gistHarness.open('gh://gist/abc123/notes.md');
      assert.equal(await gist.readFile(), '# Notes');
      assert.equal(await gist.exists(), true);
      assert.deepEqual(await gist.stat(), {
        isDirectory: false,
        isFile: true,
        length: 7,
        name: 'notes.md',
        type: 'text/markdown',
      });
      await gist.writeFile('updated');

      githubFs(
        gistHarness.token,
        { defaultFileEncoding: 'utf-8' },
        gistHarness.dependencies,
      );
      const compatibleGist = gistHarness.open('gh://gist/abc123/notes.md');
      await compatibleGist.writeFile('updated');
      assert.deepEqual(gistHarness.gistCalls.update, [
        {
          id: 'abc123',
          value: {
            files: { 'notes.md': { content: 'encoded:utf-8:updated' } },
          },
        },
        {
          id: 'abc123',
          value: {
            files: { 'notes.md': { content: 'encoded:utf-8:updated' } },
          },
        },
      ]);
    },
  );
});

function createHarness({ promptResult = 'unused' } = {}) {
  let providerFactory;
  const createdTokens = [];
  const promptMessages = [];
  const repositoryCalls = {
    createFile: [],
    deleteFile: [],
    getContent: [],
    writeFile: [],
  };
  const gistCalls = { update: [] };
  const missingPaths = new Set([
    'src/created.txt',
    'src/binary.dat',
    'src/folder',
  ]);
  const repository = {
    async createFile(value) {
      repositoryCalls.createFile.push(value);
    },
    async deleteFile(value) {
      repositoryCalls.deleteFile.push(value);
    },
    async getBlob() {
      return new TextEncoder().encode('hello').buffer;
    },
    async getContent(owner, repo, requestedPath, ref) {
      repositoryCalls.getContent.push({
        owner,
        path: requestedPath,
        ref,
        repo,
      });
      if (missingPaths.has(requestedPath)) {
        const error = new Error('Not found');
        error.kind = 'not-found';
        throw error;
      }
      if (requestedPath === 'src') {
        return [
          { name: 'index.js', path: 'src/index.js', type: 'file' },
          { name: 'nested', path: 'src/nested', type: 'dir' },
        ];
      }
      return { sha: 'file-sha', size: 5, type: 'file' };
    },
    async writeFile(value) {
      repositoryCalls.writeFile.push(value);
    },
  };
  const gistData = {
    files: {
      'notes.md': { content: '# Notes', filename: 'notes.md', size: 7 },
    },
  };
  const createGitHub = (token) => {
    createdTokens.push(token);
    return {
      ...repository,
      async getGist() {
        return gistData;
      },
      async updateGist(id, value) {
        gistCalls.update.push({ id, value });
      },
    };
  };
  const fileReader = class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`;
        this.onloadend();
      }, this.onerror);
    }
  };
  const acode = {
    require(name) {
      const modules = {
        encodings: {
          async decode(data, encoding) {
            return `decoded:${encoding}:${Buffer.from(data).toString()}`;
          },
          async encode(data, encoding) {
            return `encoded:${encoding}:${data}`;
          },
        },
        fs: {
          extend(_test, factory) {
            providerFactory = factory;
          },
          remove() {},
        },
        helpers: {
          decodeText(data, encoding) {
            return `fallback:${encoding}:${Buffer.from(data).toString()}`;
          },
        },
        prompt: async (_title, message) => {
          promptMessages.push(message);
          return promptResult;
        },
        url: {
          basename: path.posix.basename,
          dirname: path.posix.dirname,
          join: joinUrl,
        },
      };
      if (!(name in modules))
        throw new Error(`Unexpected Acode module: ${name}`);
      return modules[name];
    },
  };

  return {
    createdTokens,
    dependencies: { createGitHub },
    gistCalls,
    globals: { FileReader: fileReader, acode },
    open(url) {
      return providerFactory(url);
    },
    promptMessages,
    repositoryCalls,
    token: async () => 'phase-one-token',
  };
}

function joinUrl(first, ...rest) {
  return [
    first.replace(/\/+$/, ''),
    ...rest.map((part) => part.replace(/^\/+|\/+$/g, '')),
  ]
    .filter(Boolean)
    .join('/');
}
