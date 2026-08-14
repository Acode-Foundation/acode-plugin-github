const LAUNCHER_ID = 'github';
const LAUNCHER_ICON = 'github';

export class GitHubLauncher {
  #installed = false;
  #open;
  #ready = false;
  #selected = false;
  #sidebarApps;

  constructor({ open, sidebarApps }) {
    this.#open = open;
    if (sidebarApps !== undefined) {
      this.#sidebarApps = sidebarApps;
      return;
    }
    try {
      this.#sidebarApps = acode.require('sidebarApps');
    } catch (_error) {
      this.#sidebarApps = undefined;
    }
  }

  get installed() {
    return this.#installed;
  }

  install() {
    if (typeof this.#sidebarApps?.add !== 'function') return false;
    this.#installed = true;
    this.#add();
    return true;
  }

  pageHidden() {
    if (this.#selected) this.#reset();
  }

  destroy() {
    if (this.#installed) this.#sidebarApps.remove?.(LAUNCHER_ID);
    this.#installed = false;
    this.#selected = false;
  }

  #add() {
    let selectedDuringInstall = false;
    this.#ready = false;
    this.#sidebarApps.add(
      LAUNCHER_ICON,
      LAUNCHER_ID,
      'GitHub',
      () => {},
      false,
      () => {
        if (!this.#ready) {
          selectedDuringInstall = true;
          return;
        }
        this.#selected = true;
        this.#open();
      },
    );
    queueMicrotask(() => {
      if (!this.#installed) return;
      this.#ready = true;
      if (selectedDuringInstall) this.#reset();
    });
  }

  #reset() {
    this.#selected = false;
    this.#sidebarApps.remove?.(LAUNCHER_ID);
    if (this.#installed) this.#add();
  }
}
