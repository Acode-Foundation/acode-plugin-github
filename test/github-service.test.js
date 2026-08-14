const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('GitHub service uses current headers, pagination, and narrow REST operations', async () => {
  const transport = createQueuedTransport([
    json({ login: 'octocat' }),
    json([{ id: 1 }], {
      link: '<https://api.github.test/user/repos?page=2>; rel="next"',
    }),
    json([{ id: 2 }]),
    json({ installations: [{ id: 10 }], total_count: 1 }),
    json({
      repositories: [{ id: 20 }],
      repository_selection: 'selected',
      total_count: 1,
    }),
    json([{ name: 'main' }]),
    json({ object: { sha: 'branch-sha' } }),
    json({ ref: 'refs/heads/feature' }),
    json({ path: 'src/index.js', sha: 'file-sha', size: 5, type: 'file' }),
    json({ content: 'aGVsbG8=\n', encoding: 'base64' }),
    json({ sha: 'old-sha', type: 'file' }),
    json({ content: { sha: 'updated-sha' } }),
    json({ message: 'Not Found' }, {}, 404),
    json({ content: { sha: 'created-sha' } }),
    json({ sha: 'delete-sha', type: 'file' }),
    json({ object: { sha: 'head-sha' } }),
    json({ tree: { sha: 'base-tree' } }),
    json({ sha: 'delete-tree' }),
    json({ sha: 'delete-commit' }),
    json({ object: { sha: 'delete-commit' } }),
    json([{ id: 'gist-1' }]),
    json({ files: {}, id: 'gist-1' }),
    json({ files: {}, id: 'gist-2' }),
    json({ files: {}, id: 'gist-1' }),
    empty(204),
  ]);

  await withSourceModule('githubService.js', {}, async (module) => {
    const service = module.createGitHubService('phase-three-token', {
      baseUrl: 'https://api.github.test',
      fetch: transport.fetch,
    });

    assert.equal((await service.getAuthenticatedUser()).login, 'octocat');
    assert.deepEqual(
      (await service.listRepositories()).map(({ id }) => id),
      [1, 2],
    );
    assert.deepEqual(await service.listInstallations(), [{ id: 10 }]);
    assert.deepEqual(await service.listInstallationRepositories(10), [
      { id: 20 },
    ]);
    assert.deepEqual(await service.listBranches('octocat', 'example'), [
      { name: 'main' },
    ]);
    await service.createBranch('octocat', 'example', 'main', 'feature');
    assert.equal(
      (await service.getContent('octocat', 'example', 'src/index.js', 'main'))
        .sha,
      'file-sha',
    );
    assert.equal(
      Buffer.from(
        await service.getBlob('octocat', 'example', 'file-sha'),
      ).toString(),
      'hello',
    );
    await service.writeFile({
      branch: 'main',
      content: 'updated',
      message: 'Update source',
      owner: 'octocat',
      path: 'src/index.js',
      repo: 'example',
    });
    await service.createFile({
      branch: 'main',
      content: 'created',
      message: 'Create source',
      owner: 'octocat',
      path: 'src/new file.js',
      repo: 'example',
    });
    await service.deleteFile({
      branch: 'main',
      message: 'Remove obsolete source',
      owner: 'octocat',
      path: 'src/index.js',
      repo: 'example',
    });
    assert.deepEqual(await service.listGists(), [{ id: 'gist-1' }]);
    assert.equal((await service.getGist('gist-1')).id, 'gist-1');
    assert.equal(
      (
        await service.createGist({
          description: 'Example',
          files: { 'notes.md': { content: '# Notes' } },
          public: false,
        })
      ).id,
      'gist-2',
    );
    await service.updateGist('gist-1', {
      files: { 'new.md': { content: 'new' }, 'old.md': null },
    });
    await service.deleteGist('gist-1');

    assert.equal(transport.remaining(), 0);
    for (const request of transport.requests) {
      assert.equal(request.headers.authorization, 'Bearer phase-three-token');
      assert.equal(request.headers.accept, module.GITHUB_ACCEPT);
      assert.equal(
        request.headers['x-github-api-version'],
        module.GITHUB_API_VERSION,
      );
      assert.equal(request.url.includes('_datetime'), false);
    }
  });

  assert.deepEqual(requestShape(transport.requests[1]), {
    method: 'GET',
    path: '/user/repos',
    query: { page: null, per_page: '100', sort: 'updated', type: 'all' },
  });
  assert.equal(
    new URL(transport.requests[2].url).searchParams.get('page'),
    '2',
  );
  assert.equal(
    transport.requests[6].url.endsWith('/git/ref/heads%2Fmain'),
    true,
  );
  assert.deepEqual(transport.requests[7].body, {
    ref: 'refs/heads/feature',
    sha: 'branch-sha',
  });
  assert.equal(
    transport.requests[12].url.includes('src%2Fnew%20file.js'),
    true,
  );
  assert.deepEqual(transport.requests[13].body, {
    branch: 'main',
    content: 'Y3JlYXRlZA==',
    message: 'Create source',
  });
  assert.equal(
    transport.requests[15].url.endsWith('/git/ref/heads%2Fmain'),
    true,
  );
  assert.equal(
    transport.requests[16].url.endsWith('/git/commits/head-sha'),
    true,
  );
  assert.deepEqual(transport.requests[17].body, {
    base_tree: 'base-tree',
    tree: [
      {
        mode: '100644',
        path: 'src/index.js',
        sha: null,
        type: 'blob',
      },
    ],
  });
  assert.deepEqual(transport.requests[18].body, {
    message: 'Remove obsolete source',
    parents: ['head-sha'],
    tree: 'delete-tree',
  });
  assert.deepEqual(transport.requests[19].body, {
    force: false,
    sha: 'delete-commit',
  });
});

test('installation pagination consumes wrapped GitHub response pages', async () => {
  const transport = createQueuedTransport([
    json(
      { installations: [{ id: 10 }], total_count: 2 },
      {
        link: '<https://api.github.test/user/installations?per_page=100&page=2>; rel="next"',
      },
    ),
    json({ installations: [{ id: 11 }], total_count: 2 }),
    json(
      {
        repositories: [{ id: 20 }],
        repository_selection: 'selected',
        total_count: 2,
      },
      {
        link: '<https://api.github.test/user/installations/10/repositories?per_page=100&page=2>; rel="next"',
      },
    ),
    json({ repositories: [{ id: 21 }], total_count: 2 }),
  ]);

  await withSourceModule(
    'githubService.js',
    {},
    async ({ createGitHubService }) => {
      const service = createGitHubService('token', {
        baseUrl: 'https://api.github.test',
        fetch: transport.fetch,
      });
      const installations = await service.listInstallations();
      const repositories = await service.listInstallationRepositories(10);

      assert.deepEqual(
        installations.map(({ id }) => id),
        [10, 11],
      );
      assert.deepEqual(
        repositories.map(({ id }) => id),
        [20, 21],
      );
      assert.equal(installations.includes(undefined), false);
      assert.equal(repositories.includes(undefined), false);
    },
  );

  assert.equal(transport.remaining(), 0);
  assert.equal(
    new URL(transport.requests[1].url).searchParams.get('page'),
    '2',
  );
  assert.equal(
    new URL(transport.requests[3].url).searchParams.get('page'),
    '2',
  );
});

test('installation pagination accepts zero results and rejects malformed lists', async () => {
  const transport = createQueuedTransport([
    json({ installations: [], total_count: 0 }),
  ]);

  await withSourceModule(
    'githubService.js',
    {},
    async ({ GitHubService, createGitHubService }) => {
      const emptyService = createGitHubService('token', {
        baseUrl: 'https://api.github.test',
        fetch: transport.fetch,
      });
      assert.deepEqual(await emptyService.listInstallations(), []);

      class MalformedOctokit {
        hook = { before() {} };

        async paginate() {
          return { installations: [] };
        }
      }

      const malformedService = new GitHubService('token', {
        OctokitClass: MalformedOctokit,
        transport: 'native',
      });
      await assert.rejects(malformedService.listInstallations(), (error) => {
        assert.equal(error.kind, 'internal');
        assert.equal(error.operation, 'installations');
        assert.equal(error.transport, 'native');
        assert.equal(error.status, undefined);
        return true;
      });
    },
  );
});

test('repository deletion preserves not-found and conflict diagnostics', async () => {
  await withSourceModule(
    'githubService.js',
    {},
    async ({ createGitHubService }) => {
      const missing = createQueuedTransport([
        json({ message: 'Not Found' }, {}, 404),
      ]);
      await assert.rejects(
        createGitHubService('token', {
          baseUrl: 'https://api.github.test',
          fetch: missing.fetch,
        }).deleteFile({
          branch: 'main',
          message: 'Delete missing workflow',
          owner: 'octocat',
          path: '.github/workflows/missing.yml',
          repo: 'example',
        }),
        (error) => error.kind === 'not-found' && error.operation === 'contents',
      );
      assert.equal(missing.requests.length, 1);

      const conflict = createQueuedTransport([
        json({ sha: 'file-sha', type: 'file' }),
        json({ object: { sha: 'head-sha' } }),
        json({ tree: { sha: 'base-tree' } }),
        json({ sha: 'next-tree' }),
        json({ sha: 'next-commit' }),
        json({ message: 'Reference changed' }, {}, 409),
      ]);
      await assert.rejects(
        createGitHubService('token', {
          baseUrl: 'https://api.github.test',
          fetch: conflict.fetch,
        }).deleteFile({
          branch: 'release/next',
          message: 'Delete workflow',
          owner: 'octocat',
          path: '.github/workflows/release.yml',
          repo: 'example',
        }),
        (error) => error.kind === 'conflict' && error.operation === 'contents',
      );
      assert.equal(
        conflict.requests[1].url.endsWith('/git/ref/heads%2Frelease%2Fnext'),
        true,
      );
      assert.equal(
        conflict.requests[3].body.tree[0].path,
        '.github/workflows/release.yml',
      );
      assert.equal(conflict.requests[5].method, 'PATCH');
      assert.equal(conflict.requests[5].body.force, false);
    },
  );
});

test('repository deletion redacts malformed Git object responses', async () => {
  const transport = createQueuedTransport([
    json({ sha: 'file-sha', type: 'file' }),
    json({ object: {} }),
  ]);

  await withSourceModule(
    'githubService.js',
    {},
    async ({ createGitHubService }) => {
      await assert.rejects(
        createGitHubService('secret-token', {
          baseUrl: 'https://api.github.test',
          fetch: transport.fetch,
          transport: 'native',
        }).deleteFile({
          branch: 'main',
          message: 'Delete source',
          owner: 'octocat',
          path: 'src/index.js',
          repo: 'example',
        }),
        (error) => {
          assert.equal(error.kind, 'internal');
          assert.equal(error.operation, 'contents');
          assert.equal(error.transport, 'native');
          assert.equal(JSON.stringify(error).includes('secret-token'), false);
          return true;
        },
      );
    },
  );
});

test('GitHub failures are classified without retaining credentials', async () => {
  await withSourceModule(
    'githubService.js',
    {},
    async ({ GitHubError, normalizeGitHubError }) => {
      const cases = [
        [401, {}, 'authentication'],
        [403, {}, 'permission'],
        [403, { 'x-ratelimit-remaining': '0' }, 'rate-limit'],
        [404, {}, 'not-found'],
        [409, {}, 'conflict'],
        [422, {}, 'validation'],
        [503, {}, 'network'],
      ];
      for (const [status, headers, kind] of cases) {
        const original = new Error('request failed with secret-token');
        original.status = status;
        original.request = {
          headers: { authorization: 'Bearer secret-token' },
        };
        original.response = { data: { message: 'failed' }, headers, status };
        const normalized = normalizeGitHubError(original);
        assert.ok(normalized instanceof GitHubError);
        assert.equal(normalized.kind, kind);
        assert.equal(
          JSON.stringify(normalized).includes('secret-token'),
          false,
        );
        assert.equal(normalized.stack.includes('secret-token'), false);
        assert.equal('cause' in normalized, false);
      }

      const sso = normalizeGitHubError({
        status: 403,
        response: {
          data: { message: 'SSO authorization required' },
          headers: {
            'x-accepted-github-permissions': 'contents=write',
            'x-github-sso':
              'required; url=https://github.com/orgs/acode/sso?authorization_request=1',
          },
          status: 403,
        },
      });
      assert.equal(
        sso.recoveryUrl,
        'https://github.com/orgs/acode/sso?authorization_request=1',
      );
      assert.equal(sso.requiredPermissions, 'contents=write');

      const unsafeSso = normalizeGitHubError({
        status: 403,
        response: {
          data: {},
          headers: {
            'x-github-sso': 'required; url=https://example.com/login',
          },
          status: 403,
        },
      });
      assert.equal(unsafeSso.recoveryUrl, undefined);

      const internal = normalizeGitHubError(
        new TypeError('secret-token was not iterable'),
        { operation: 'gists', transport: 'native' },
      );
      assert.equal(internal.kind, 'internal');
      assert.equal(internal.operation, 'gists');
      assert.equal(internal.transport, 'native');
      assert.equal(internal.message.includes('secret-token'), false);
      assert.equal(internal.stack.includes('secret-token'), false);
    },
  );
});

function createQueuedTransport(entries) {
  const requests = [];
  let index = 0;
  return {
    fetch: async (input, init) => {
      const request = await captureRequest(input, init);
      requests.push(request);
      const entry = entries[index++];
      if (!entry) throw new Error('Unexpected GitHub request');
      return toResponse(entry, request.url);
    },
    remaining: () => entries.length - index,
    requests,
  };
}

async function captureRequest(input, init) {
  const request = input instanceof Request ? input : new Request(input, init);
  const text = await request.clone().text();
  return {
    body: text ? JSON.parse(text) : undefined,
    headers: Object.fromEntries(request.headers),
    method: request.method,
    url: request.url,
  };
}

function json(body, headers = {}, status = 200) {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    status,
  };
}

function empty(status) {
  return { body: null, headers: {}, status };
}

function toResponse({ body, headers, status }, url) {
  const response = new Response(body, { headers, status });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
}

function requestShape(request) {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: url.pathname,
    query: {
      page: url.searchParams.get('page'),
      per_page: url.searchParams.get('per_page'),
      sort: url.searchParams.get('sort'),
      type: url.searchParams.get('type'),
    },
  };
}
