const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('device flow honors polling intervals, slow down, and token expiry fields', async () => {
  const clock = createAdvancingClock(1_000_000);
  const transport = createTransport([
    deviceCode({ expires_in: 60, interval: 2 }),
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    tokenResponse(),
  ]);
  const states = [];
  let displayed;

  await withSourceModule(
    'githubAuth/deviceFlow.js',
    {},
    async ({ GitHubDeviceFlow }) => {
      const flow = new GitHubDeviceFlow({
        clientId: 'Iv1.client',
        now: clock.now,
        sleep: clock.sleep,
        transport,
      });
      const tokens = await flow.authorize({
        onCode(value) {
          displayed = value;
        },
        onState(state) {
          states.push(state);
        },
      });

      assert.deepEqual(tokens, {
        accessExpiresAt: 4_611_000,
        accessToken: 'access-token',
        refreshExpiresAt: 8_211_000,
        refreshToken: 'refresh-token',
      });
    },
  );

  assert.deepEqual(displayed, {
    expiresAt: 1_060_000,
    interval: 2,
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://github.com/login/device',
  });
  assert.deepEqual(states, ['pending', 'slow-down']);
  assert.deepEqual(clock.sleeps, [2_000, 2_000, 7_000]);
  assert.equal(transport.remaining(), 0);
  assert.deepEqual(transport.calls[0].data, { client_id: 'Iv1.client' });
  assert.deepEqual(transport.calls[1].data, {
    client_id: 'Iv1.client',
    device_code: 'device-code',
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
});

test('device flow tolerates transient network loss without discarding the flow', async () => {
  const clock = createAdvancingClock(0);
  const networkError = new Error('offline with secret-device-code');
  networkError.kind = 'network';
  const transport = createTransport([
    deviceCode({ expires_in: 30, interval: 1 }),
    networkError,
    tokenResponse(),
  ]);
  const states = [];

  await withSourceModule(
    'githubAuth/deviceFlow.js',
    {},
    async ({ GitHubDeviceFlow }) => {
      const flow = new GitHubDeviceFlow({
        clientId: 'client',
        now: clock.now,
        sleep: clock.sleep,
        transport,
      });
      assert.equal(
        (await flow.authorize({ onState: (state) => states.push(state) }))
          .accessToken,
        'access-token',
      );
    },
  );

  assert.deepEqual(states, ['offline']);
  assert.deepEqual(clock.sleeps, [1_000, 1_000]);
});

test('device flow supports cancellation, denial, expiry, and malformed responses', async () => {
  await withSourceModule(
    'githubAuth/deviceFlow.js',
    {},
    async ({ GitHubDeviceFlow }) => {
      const cases = [
        [{ error: 'access_denied' }, 'denied'],
        [{ error: 'expired_token' }, 'expired'],
        [{ error: 'bad_verification_code' }, 'expired'],
        [{ error: 'unexpected' }, 'malformed-response'],
        [{ access_token: 'secret', token_type: 'wrong' }, 'malformed-response'],
      ];
      for (const [response, kind] of cases) {
        const clock = createAdvancingClock(0);
        const flow = new GitHubDeviceFlow({
          clientId: 'client',
          now: clock.now,
          sleep: clock.sleep,
          transport: createTransport([
            deviceCode({ expires_in: 10, interval: 1 }),
            response,
          ]),
        });
        await assert.rejects(flow.authorize(), hasKind(kind));
      }

      const cancelledClock = createAdvancingClock(0);
      const cancelled = new GitHubDeviceFlow({
        clientId: 'client',
        now: cancelledClock.now,
        sleep: cancelledClock.sleep,
        transport: createTransport([deviceCode({ expires_in: 10 })]),
      });
      await assert.rejects(
        cancelled.authorize({ onCode: () => cancelled.cancel() }),
        hasKind('cancelled'),
      );

      const expiredClock = createAdvancingClock(0);
      const expired = new GitHubDeviceFlow({
        clientId: 'client',
        now: expiredClock.now,
        sleep: expiredClock.sleep,
        transport: createTransport([
          deviceCode({ expires_in: 1, interval: 5 }),
        ]),
      });
      await assert.rejects(expired.authorize(), hasKind('expired'));

      const controller = new AbortController();
      controller.abort();
      const aborted = new GitHubDeviceFlow({
        clientId: 'client',
        now: Date.now,
        sleep: async () => {},
        transport: createTransport([deviceCode({ expires_in: 10 })]),
      });
      await assert.rejects(
        aborted.authorize({ signal: controller.signal }),
        hasKind('cancelled'),
      );
    },
  );
});

test('resume wakes a backgrounded flow and polls immediately when due', async () => {
  let currentTime = 0;
  let codeDisplayed;
  const shown = new Promise((resolve) => {
    codeDisplayed = resolve;
  });
  const transport = createTransport([
    deviceCode({ expires_in: 30, interval: 5 }),
    tokenResponse(),
  ]);

  await withSourceModule(
    'githubAuth/deviceFlow.js',
    {},
    async ({ GitHubDeviceFlow }) => {
      const flow = new GitHubDeviceFlow({
        clientId: 'client',
        now: () => currentTime,
        sleep: () => new Promise(() => {}),
        transport,
      });
      const authorization = flow.authorize({ onCode: codeDisplayed });
      await shown;
      await new Promise((resolve) => setImmediate(resolve));
      currentTime = 5_000;
      flow.resume();
      assert.equal((await authorization).accessToken, 'access-token');
    },
  );

  assert.equal(transport.remaining(), 0);
});

test('device flow configuration and response errors never expose OAuth values', async () => {
  await withSourceModule(
    'githubAuth/deviceFlow.js',
    {},
    async ({ GitHubDeviceFlow }) => {
      const missing = new GitHubDeviceFlow({ transport: createTransport([]) });
      await assert.rejects(missing.authorize(), hasKind('configuration'));

      const rejectedClient = new GitHubDeviceFlow({
        clientId: 'invalid-client',
        transport: createTransport([{ error: 'incorrect_client_credentials' }]),
      });
      await assert.rejects(
        rejectedClient.authorize(),
        hasKind('configuration'),
      );

      const malformed = new GitHubDeviceFlow({
        clientId: 'client',
        transport: createTransport([
          { device_code: 'secret-device-code', expires_in: 900 },
        ]),
      });
      await assert.rejects(malformed.authorize(), (error) => {
        assert.equal(error.kind, 'malformed-response');
        assert.equal(
          JSON.stringify(error).includes('secret-device-code'),
          false,
        );
        assert.equal(error.stack.includes('secret-device-code'), false);
        return true;
      });
    },
  );
});

function createAdvancingClock(initialTime) {
  let currentTime = initialTime;
  const sleeps = [];
  return {
    now: () => currentTime,
    sleep: async (milliseconds, signal) => {
      if (signal.aborted) throw cancellationError();
      sleeps.push(milliseconds);
      currentTime += milliseconds;
    },
    sleeps,
  };
}

function createTransport(entries) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async postForm(url, data) {
      calls.push({ data, url });
      const value = entries[index++];
      if (value instanceof Error) throw value;
      if (!value) throw new Error('Unexpected native HTTP request');
      return value;
    },
    remaining: () => entries.length - index,
  };
}

function deviceCode(overrides = {}) {
  return {
    device_code: 'device-code',
    expires_in: 900,
    interval: 5,
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://github.com/login/device',
    ...overrides,
  };
}

function tokenResponse() {
  return {
    access_token: 'access-token',
    expires_in: 3_600,
    refresh_token: 'refresh-token',
    refresh_token_expires_in: 7_200,
    token_type: 'bearer',
  };
}

function hasKind(kind) {
  return (error) => error.kind === kind;
}

function cancellationError() {
  const error = new Error('cancelled');
  error.kind = 'cancelled';
  return error;
}
