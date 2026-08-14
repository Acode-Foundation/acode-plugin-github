const assert = require('node:assert/strict');
const test = require('node:test');

const { withSourceModule } = require('./helpers/load-source-module');

test('sidebar icon repeatedly launches the full GitHub page and cleans up', async () => {
  const registrations = [];
  const removals = [];
  let opens = 0;
  const sidebarApps = {
    add(icon, id, title, init, prepend, onSelected) {
      registrations.push({ icon, id, init, onSelected, prepend, title });
    },
    remove(id) {
      removals.push(id);
    },
  };

  await withSourceModule(
    'githubLauncher.js',
    { queueMicrotask },
    async ({ GitHubLauncher }) => {
      const launcher = new GitHubLauncher({
        open: () => {
          opens += 1;
        },
        sidebarApps,
      });
      assert.equal(launcher.install(), true);
      await settle();
      assert.deepEqual(
        registrations.map(({ icon, id, prepend, title }) => ({
          icon,
          id,
          prepend,
          title,
        })),
        [
          {
            icon: 'github',
            id: 'github',
            prepend: false,
            title: 'GitHub',
          },
        ],
      );
      assert.equal(registrations[0].icon, 'github');
      assert.equal(registrations[0].init(), undefined);

      registrations[0].onSelected();
      assert.equal(opens, 1);
      launcher.pageHidden();
      await settle();
      assert.deepEqual(removals, ['github']);
      assert.equal(registrations.length, 2);

      registrations[1].onSelected();
      assert.equal(opens, 2);
      launcher.destroy();
      assert.deepEqual(removals, ['github', 'github']);
    },
  );
});

test('stored sidebar selection does not auto-open the page at startup', async () => {
  let opens = 0;
  let additions = 0;
  const sidebarApps = {
    add(_icon, _id, _title, _init, _prepend, onSelected) {
      additions += 1;
      if (additions === 1) onSelected();
    },
    remove() {},
  };

  await withSourceModule(
    'githubLauncher.js',
    { queueMicrotask },
    async ({ GitHubLauncher }) => {
      const launcher = new GitHubLauncher({
        open: () => {
          opens += 1;
        },
        sidebarApps,
      });
      launcher.install();
      await settle(2);
      assert.equal(opens, 0);
      assert.equal(additions, 2);
      launcher.destroy();
    },
  );
});

test('launcher remains optional when sidebar apps are unavailable', async () => {
  await withSourceModule(
    'githubLauncher.js',
    { acode: { require: () => undefined }, queueMicrotask },
    async ({ GitHubLauncher }) => {
      const launcher = new GitHubLauncher({ open() {} });
      assert.equal(launcher.install(), false);
      launcher.destroy();
    },
  );
});

async function settle(count = 1) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}
