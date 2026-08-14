const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('native GitHub fetch supports REST methods, headers, JSON, and 204', async () => {
  const calls = [];
  const responses = [
    response(200, '[{"id":1}]', { link: '</next>; rel="next"' }),
    response(200, '{}'),
    response(200, '{}'),
    response(200, '{}'),
    response(204, ''),
    response(200, '[{"id":1}]', {
      link: '<https://api.github.com/user/repos?page=2>; rel="next"',
    }),
    response(200, '[{"id":2}]'),
  ];
  const http = queuedHttp(calls, responses);

  await withSourceModule(
    'githubNativeFetch.js',
    {
      DOMException: undefined,
      Headers: undefined,
      Response: undefined,
      TextDecoder: undefined,
      TextEncoder: undefined,
    },
    async ({ createGitHubServiceFactory, createNativeGitHubFetch }) => {
      const fetch = createNativeGitHubFetch(http);
      const first = await fetch('https://api.github.com/user/repos', {
        headers: { Authorization: 'Bearer redacted-token' },
      });
      assert.equal(first.url, 'https://api.github.com/user/repos');
      assert.equal(first.headers.get('link'), '</next>; rel="next"');
      assert.deepEqual(await first.json(), [{ id: 1 }]);

      for (const method of ['POST', 'PUT', 'PATCH']) {
        const result = await fetch('https://api.github.com/gists/1', {
          body: JSON.stringify({ method }),
          headers: { 'Content-Type': 'application/json' },
          method,
        });
        assert.equal(result.status, 200);
      }

      const empty = await fetch('https://api.github.com/gists/1', {
        method: 'DELETE',
      });
      assert.equal(empty.status, 204);
      assert.equal(await empty.text(), '');
      await assert.rejects(
        fetch('https://api.github.com/gists/1', {
          body: '{}',
          method: 'DELETE',
        }),
        { kind: 'body' },
      );

      const service = createGitHubServiceFactory({ http })('token');
      assert.deepEqual(
        (await service.listRepositories()).map(({ id }) => id),
        [1, 2],
      );
    },
  );

  assert.deepEqual(
    calls.slice(1, 4).map(({ options }) => options.method),
    ['post', 'put', 'patch'],
  );
  assert.equal(calls[3].options.serializer, 'utf8');
  assert.equal(calls[4].options.data, undefined);
  assert.equal(
    calls.every(({ options }) => options.followRedirect === false),
    true,
  );
});

test('native GitHub fetch preserves HTTP errors and blocks unsafe redirects and hosts', async () => {
  const calls = [];
  const http = queuedHttp(calls, [
    response(422, '{"message":"invalid"}'),
    response(302, '', { location: 'https://example.com/steal' }),
  ]);

  await withSourceModule(
    'githubNativeFetch.js',
    {},
    async ({ createNativeGitHubFetch }) => {
      const fetch = createNativeGitHubFetch(http);
      const invalid = await fetch('https://api.github.com/gists', {
        method: 'POST',
      });
      assert.equal(invalid.status, 422);

      await assert.rejects(
        fetch('https://api.github.com/redirect', {
          headers: { authorization: 'Bearer secret-token' },
        }),
        (error) => {
          assert.equal(error.message, 'GitHub transport failed.');
          assert.equal(error.kind, 'redirect');
          assert.equal(JSON.stringify(error).includes('secret-token'), false);
          assert.equal(error.stack.includes('secret-token'), false);
          return true;
        },
      );
      for (const url of [
        'http://api.github.com/user',
        'https://api.github.com.evil.test/user',
        'https://api.github.com:444/user',
        'https://user:pass@api.github.com/user',
        'https://api.github.com/user#token',
      ]) {
        await assert.rejects(fetch(url), { kind: 'host' });
      }
      assert.equal(calls.length, 2);
    },
  );
});

test('native GitHub fetch aborts the native request and never falls back', async () => {
  let abortId;
  const http = {
    abort(id, success) {
      abortId = id;
      success();
    },
    sendRequest() {
      return 17;
    },
  };

  await withSourceModule(
    'githubNativeFetch.js',
    {},
    async ({ createNativeGitHubFetch }) => {
      const controller = new AbortController();
      const pending = createNativeGitHubFetch(http)(
        'https://api.github.com/user',
        { signal: controller.signal },
      );
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(abortId, 17);
    },
  );
});

test('GitHub service factory falls back only when the native bridge is absent', async () => {
  let webCalls = 0;
  await withSourceModule(
    'githubNativeFetch.js',
    {},
    async ({ createGitHubServiceFactory }) => {
      const createGitHub = createGitHubServiceFactory({
        fetch: async () => {
          webCalls += 1;
          return new Response('{"id":1,"login":"octocat"}', {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        },
        http: undefined,
      });
      assert.equal((await createGitHub('token').getAuthenticatedUser()).id, 1);
    },
  );
  assert.equal(webCalls, 1);
});

test('cold-start clients recheck native HTTP and never use Web Fetch in Cordova', async () => {
  const calls = [];
  const cordova = { plugin: {} };
  let webCalls = 0;
  await withSourceModule(
    'githubNativeFetch.js',
    { cordova },
    async ({ createGitHubServiceFactory }) => {
      const createGitHub = createGitHubServiceFactory({
        fetch: async () => {
          webCalls += 1;
          throw new Error('Web Fetch must not run in Acode.');
        },
      });

      await assert.rejects(
        createGitHub('restored-token').listGists(),
        (error) => {
          assert.equal(error.kind, 'network');
          assert.equal(error.operation, 'gists');
          assert.equal(error.transport, 'native');
          return true;
        },
      );
      assert.equal(webCalls, 0);

      cordova.plugin.http = queuedHttp(calls, [
        response(200, '{"id":1,"login":"octocat"}'),
        response(200, '{"installations":[{"id":10}],"total_count":1}'),
        response(200, '{"repositories":[{"id":20}],"total_count":1}'),
        response(200, '[{"id":"gist-1"}]'),
      ]);
      const client = createGitHub('restored-token');
      assert.equal((await client.getAuthenticatedUser()).login, 'octocat');
      assert.deepEqual(
        (await client.listInstallations()).map(({ id }) => id),
        [10],
      );
      assert.deepEqual(
        (await client.listInstallationRepositories(10)).map(({ id }) => id),
        [20],
      );
      assert.deepEqual(
        (await client.listGists()).map(({ id }) => id),
        ['gist-1'],
      );
    },
  );

  assert.equal(webCalls, 0);
  assert.equal(calls.length, 4);
});

test('native service paginates wrapped installation responses', async () => {
  const calls = [];
  const http = queuedHttp(calls, [
    response(
      200,
      JSON.stringify({ installations: [{ id: 10 }], total_count: 2 }),
      {
        link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"',
      },
    ),
    response(
      200,
      JSON.stringify({ installations: [{ id: 11 }], total_count: 2 }),
    ),
    response(
      200,
      JSON.stringify({
        repositories: [{ id: 20 }],
        repository_selection: 'selected',
        total_count: 2,
      }),
      {
        link: '<https://api.github.com/user/installations/10/repositories?per_page=100&page=2>; rel="next"',
      },
    ),
    response(
      200,
      JSON.stringify({ repositories: [{ id: 21 }], total_count: 2 }),
    ),
  ]);

  await withSourceModule(
    'githubNativeFetch.js',
    {},
    async ({ createGitHubServiceFactory }) => {
      const service = createGitHubServiceFactory({ http })('token');
      assert.deepEqual(
        (await service.listInstallations()).map(({ id }) => id),
        [10, 11],
      );
      assert.deepEqual(
        (await service.listInstallationRepositories(10)).map(({ id }) => id),
        [20, 21],
      );
    },
  );

  assert.equal(calls.length, 4);
  assert.equal(
    calls.every(({ options }) => options.method === 'get'),
    true,
  );
  assert.equal(
    calls.every(
      ({ options }) => options.headers.authorization === 'Bearer token',
    ),
    true,
  );
});

test('native service errors retain only redacted diagnostics', async () => {
  const secret = 'github_pat_must-never-escape';
  const http = queuedHttp(
    [],
    [
      response(403, `{"message":"denied ${secret}"}`, {
        'x-accepted-github-permissions': 'contents=write',
      }),
      { data: `offline ${secret}`, headers: {}, status: -6 },
    ],
  );

  await withSourceModule(
    'githubNativeFetch.js',
    {},
    async ({ createGitHubServiceFactory }) => {
      const service = createGitHubServiceFactory({ http })(secret);
      await assert.rejects(service.listGists(), (error) => {
        assert.equal(error.kind, 'permission');
        assert.equal(error.operation, 'gists');
        assert.equal(error.transport, 'native');
        assert.equal(error.status, 403);
        assert.equal(error.requiredPermissions, 'contents=write');
        assert.equal(JSON.stringify(error).includes(secret), false);
        assert.equal(error.stack.includes(secret), false);
        return true;
      });
      await assert.rejects(service.getAuthenticatedUser(), (error) => {
        assert.equal(error.kind, 'network');
        assert.equal(error.operation, 'identity');
        assert.equal(error.transport, 'native');
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      });
    },
  );
});

function queuedHttp(calls, responses) {
  let followRedirect = true;
  return {
    getFollowRedirect() {
      return followRedirect;
    },
    sendRequest(url, options, success, failure) {
      assert.equal(followRedirect, false);
      calls.push({ options, url });
      const value = responses.shift();
      setImmediate(() =>
        value.status >= 400 ? failure(value) : success(value),
      );
      return calls.length;
    },
    setFollowRedirect(value) {
      followRedirect = value;
    },
  };
}

function response(status, data, headers = {}) {
  return {
    data,
    headers: { 'content-type': 'application/json', ...headers },
    status,
  };
}
