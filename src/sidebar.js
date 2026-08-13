import plugin from '../plugin.json';

var SIDEBAR_ID = plugin.id + '.sidebar';

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function isChineseLocale() {
  var langs = [];
  try {
    if (Array.isArray(navigator.languages)) langs = langs.concat(navigator.languages);
    if (navigator.language) langs.push(navigator.language);
  } catch (_) {}

  for (var i = 0; i < langs.length; i++) {
    if (/^zh(?:-|$)/i.test(String(langs[i] || ''))) return true;
  }
  return false;
}

function getI18n() {
  if (isChineseLocale()) {
    return {
      title: 'GitHub',
      token: '令牌',
      tokenSet: '已设置',
      tokenNotSet: '未设置',
      status: '状态',
      idle: '空闲',
      running: '执行中…',
      repository: '仓库',
      openRepository: '打开仓库',
      gist: 'Gist',
      openGist: '打开 Gist',
      deleteGist: '删除 Gist',
      deleteGistFile: '删除 Gist 文件',
      accountCache: '账号 / 缓存',
      updateToken: '更新令牌',
      clearCache: '清空缓存',
      actionRunning: 'GitHub 操作正在执行',
      actionUnavailable: '操作不可用',
      actionFailed: '执行失败',
      cacheCleared: '缓存已清空',
      tokenUpdated: '令牌已更新'
    };
  }

  return {
    title: 'GitHub',
    token: 'Token',
    tokenSet: 'SET',
    tokenNotSet: 'NOT SET',
    status: 'Status',
    idle: 'idle',
    running: 'running…',
    repository: 'Repository',
    openRepository: 'Open Repository',
    gist: 'Gist',
    openGist: 'Open Gist',
    deleteGist: 'Delete Gist',
    deleteGistFile: 'Delete Gist File',
    accountCache: 'Account / Cache',
    updateToken: 'Update Token',
    clearCache: 'Clear Cache',
    actionRunning: 'GitHub action is running',
    actionUnavailable: 'Action unavailable',
    actionFailed: 'Action failed',
    cacheCleared: 'Cache cleared',
    tokenUpdated: 'Token updated'
  };
}

export default function createSidebar(pluginInstance) {
  var sidebarApps;
  var toast;
  var t = getI18n();
  try {
    sidebarApps = acode.require('sidebarApps');
    toast = acode.require('toast');
  } catch (e) {
    return null;
  }
  if (!sidebarApps) return null;

  var container = null;
  var busy = false;

  function init(el) {
    container = el;
    showPanel();
  }

  function notify(message) {
    try {
      if (toast) toast(message);
      else if (window.toast) window.toast(message);
    } catch (_) {}
  }

  // [Copilot review] Removed unused `refreshAfter` parameter — showPanel()
  // is already called unconditionally in .finally(), so the panel always
  // refreshes after every action regardless.
  function runAction(methodName, title) {
    if (busy) {
      notify(t.actionRunning);
      return;
    }

    var action = pluginInstance && pluginInstance[methodName];
    if (typeof action !== 'function') {
      notify(t.actionUnavailable + ': ' + title);
      return;
    }

    busy = true;
    showPanel();

    Promise.resolve()
      .then(function () { return action.call(pluginInstance); })
      .then(function () {
        if (methodName === 'clearCache') notify(t.cacheCleared);
        if (methodName === 'updateToken') notify(t.tokenUpdated);
      })
      .catch(function (error) {
        var msg = error && (error.message || String(error)) || 'Unknown error';
        notify(t.actionFailed + ': ' + title + ' - ' + msg);
      })
      .finally(function () {
        busy = false;
        showPanel();
      });
  }

  function createActionButton(text, methodName) {
    var button = document.createElement('button');
    button.textContent = text;
    button.disabled = busy;
    button.style.cssText = [
      'display:block',
      'width:100%',
      'margin:6px 0',
      'padding:7px 10px',
      'text-align:left',
      'font-size:12px',
      'background:#333',
      'color:#ddd',
      'border:1px solid #555',
      'border-radius:4px',
      'opacity:' + (busy ? '0.7' : '1')
    ].join(';');
    button.onclick = function () {
      runAction(methodName, text);
    };
    return button;
  }

  function showPanel() {
    if (!container) return;
    container.innerHTML = '';
    var div = document.createElement('div');
    div.style.cssText = 'padding:8px;font-size:12px;color:#ccc;word-break:break-all;font-family:monospace;line-height:1.5';

    var tokenState = pluginInstance && pluginInstance.token ? t.tokenSet : t.tokenNotSet;
    var header = document.createElement('div');
    header.innerHTML = '<p><b>' + t.title + '</b></p>'
      + '<p><b>' + t.token + ':</b> ' + esc(tokenState) + '</p>'
      + '<p><b>' + t.status + ':</b> ' + (busy ? t.running : t.idle) + '</p>'
      + '<hr style="border-color:#555;margin:8px 0">';
    div.appendChild(header);

    var repoTitle = document.createElement('p');
    repoTitle.innerHTML = '<b>' + t.repository + '</b>';
    div.appendChild(repoTitle);
    div.appendChild(createActionButton(t.openRepository, 'openRepo'));

    var gistTitle = document.createElement('p');
    gistTitle.style.marginTop = '10px';
    gistTitle.innerHTML = '<b>' + t.gist + '</b>';
    div.appendChild(gistTitle);
    div.appendChild(createActionButton(t.openGist, 'openGist'));
    div.appendChild(createActionButton(t.deleteGist, 'deleteGist'));
    div.appendChild(createActionButton(t.deleteGistFile, 'deleteGistFile'));

    var utilTitle = document.createElement('p');
    utilTitle.style.marginTop = '10px';
    utilTitle.innerHTML = '<b>' + t.accountCache + '</b>';
    div.appendChild(utilTitle);
    div.appendChild(createActionButton(t.updateToken, 'updateToken'));
    div.appendChild(createActionButton(t.clearCache, 'clearCache'));

    container.appendChild(div);
  }

  function onSelected() {
    showPanel();
  }

  function removeAll() {
    var removed = 0;
    while (true) {
      try {
        sidebarApps.get(SIDEBAR_ID);
        sidebarApps.remove(SIDEBAR_ID);
        removed++;
      } catch (_) {
        break;
      }
    }
    return removed;
  }

  function register() {
    removeAll();
    sidebarApps.add('github', SIDEBAR_ID, 'GitHub', init, false, onSelected);
  }

  function unregister() {
    removeAll();
  }

  return { register: register, unregister: unregister };
}