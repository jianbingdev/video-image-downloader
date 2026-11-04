/* 版本检查 —— 独立后台脚本，通过 service-worker.js 的 importScripts 挂进来。
 *
 * 为什么不写进 background.js：那个是 WXT 打包的压缩产物，手改会在下次打包时丢。
 * 这里单独一个文件，跟打包流程互不干扰。
 *
 * 设计原则：
 *   1. 检查失败一律静默。断网、限流、CDN 抽风，都只记在状态里，绝不弹窗打扰下载。
 *   2. 24 小时内不重复请求。jsDelivr 有缓存，太频繁只会拖慢自己。
 *   3. 版本比较按数字段，不能按字符串（"1.0.10" < "1.0.9" 是字符串比较的陷阱）。
 */

(function () {
  'use strict';

  const REPO = 'jianbingdev/video-image-downloader';
  // dev 分支读 dev；合并回 main 正式发版时改成 'main'
  const REF = 'main';
  const STATE_KEY = 'updater';
  const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 8000;
  const ALARM_NAME = 'updater-check';

  const currentVersion = () => chrome.runtime.getManifest().version;

  /** 1.0.10 > 1.0.9；忽略 v 前缀和非数字后缀 */
  function compareVersion(a, b) {
    const parse = (v) => String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((x) => parseInt(x, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  /**
   * 读状态。注意 current 和 hasUpdate **永远是实时算的**，不信任存档里的值：
   * 扩展更新完 manifest 版本会变，而 storage 里那份是检查时的快照。
   * 不实时重算，就会出现「已经是 1.0.10 了还提示有新版本」。
   */
  async function getState() {
    const got = await chrome.storage.local.get(STATE_KEY);
    const raw = got[STATE_KEY] || {};
    const cur = currentVersion();
    const latest = raw.latest || '';
    return {
      current: cur,
      checkedVersion: raw.checkedVersion || '',   // 上次检查时扩展的版本
      latest,
      hasUpdate: latest ? compareVersion(latest, cur) > 0 : false,
      meta: raw.meta || null,
      lastCheck: raw.lastCheck || 0,
      lastError: raw.lastError || '',
      checking: !!raw.checking
    };
  }

  async function setState(patch) {
    const merged = Object.assign(await getState(), patch);
    merged.current = currentVersion();
    merged.hasUpdate = merged.latest ? compareVersion(merged.latest, merged.current) > 0 : false;
    await chrome.storage.local.set({ [STATE_KEY]: merged });
    return merged;
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({ cache: 'no-store' }, options, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 主源：GitHub API。内容有约 60 秒缓存，基本实时。
   * 匿名限流 60 次/小时，我们一天查一两次，够用。
   */
  async function fetchViaApi() {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${REPO}/contents/version.json?ref=${REF}`,
      { headers: { 'Accept': 'application/vnd.github.raw' } }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = JSON.parse(await res.text());
    if (!json || !json.version) throw new Error('响应缺少 version 字段');
    return json;
  }

  /**
   * 备源：jsDelivr。比 API 稳，但**分支内容会缓存 12 小时**，
   * 发版后最多延迟半天才看到新版本。所以只做兜底，不当主源。
   */
  async function fetchViaCdn() {
    const res = await fetchWithTimeout(`https://cdn.jsdelivr.net/gh/${REPO}@${REF}/version.json`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json || !json.version) throw new Error('响应缺少 version 字段');
    return json;
  }

  async function fetchVersionMeta() {
    const errors = [];
    try {
      return await fetchViaApi();
    } catch (e) {
      errors.push('API ' + ((e && e.message) || e));
    }
    try {
      return await fetchViaCdn();
    } catch (e) {
      errors.push('CDN ' + ((e && e.message) || e));
    }
    throw new Error(errors.join(' ｜ '));
  }

  /**
   * 工具栏图标角标。不打开弹窗也能看到有没有更新。
   * 用箭头而不是数字：数字容易被当成"未读消息数"。
   * 注意：这个函数必须定义在 check() 之外、同一作用域内，否则 check 里调用会 undefined。
   */
  async function syncBadge(state) {
    try {
      if (state && state.hasUpdate) {
        await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
        await chrome.action.setBadgeText({ text: '↑' });
      } else {
        await chrome.action.setBadgeText({ text: '' });
      }
    } catch (_) { /* 角标失败不影响任何功能 */ }
  }

  /**
   * @param {boolean} force 忽略 24 小时节流
   */
  async function check(force) {
    const state = await getState();
    const versionChanged = state.checkedVersion !== state.current;

    if (!force && !versionChanged && state.lastCheck && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) {
      syncBadge(state);
      return state;
    }

    await setState({ checking: true });
    let next;
    try {
      const meta = await fetchVersionMeta();
      const hasUpdate = compareVersion(meta.version, currentVersion()) > 0;
      next = await setState({
        checkedVersion: currentVersion(),
        latest: meta.version,
        hasUpdate,
        meta: {
          version: meta.version,
          notes: meta.notes || '',
          zipball: meta.zipball || '',
          page: meta.page || ''
        },
        lastCheck: Date.now(),
        lastError: '',
        checking: false
      });
    } catch (e) {
      next = await setState({
        checkedVersion: currentVersion(),
        checking: false,
        lastCheck: Date.now(),
        lastError: String((e && e.message) || e)
      });
    }
    syncBadge(next);
    return next;
  }

  function ensureAlarm() {
    chrome.alarms.get(ALARM_NAME, (a) => {
      if (!a) {
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 12 * 60 });
      }
    });
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) check(false);
  });

  chrome.runtime.onInstalled.addListener(async () => {
    ensureAlarm();
    syncBadge(await getState());   // 重载后先把角标恢复成当前状态
    check(false);
  });

  chrome.runtime.onStartup.addListener(async () => {
    ensureAlarm();
    syncBadge(await getState());
    check(false);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'updater:status') {
      getState().then((s) => {
        syncBadge(s);
        sendResponse({ ok: true, state: s });
      });
      return true;
    }

    if (msg.type === 'updater:check') {
      check(true)
        .then((s) => sendResponse({ ok: true, state: s }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }

    if (msg.type === 'updater:openPage') {
      // 用独立小窗口而不是标签页：无地址栏，看起来像安装向导，
      // 也避免在用户的标签栏里堆一个页面。窗口尺寸按 updater.html 的卡片调过。
      chrome.windows.create({
        url: chrome.runtime.getURL('updater/updater.html'),
        type: 'popup',
        width: 500,
        height: 640,
        focused: true
      });
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'updater:finish') {
      // 更新完成：先关掉那个独立小窗口，再重载扩展。
      // 顺序不能反 —— reload 会销毁 service worker 的上下文，后面的代码就不执行了。
      const reload = () => { try { chrome.runtime.reload(); } catch (_) {} };
      const wid = msg.windowId;
      if (typeof wid === 'number') {
        chrome.windows.remove(wid).then(reload, reload);
      } else {
        reload();
      }
      sendResponse({ ok: true });
      return false;
    }
  });

  // service worker 冷启动时也把闹钟补上（浏览器重启后 alarms 会保留，这里只是兜底）
  ensureAlarm();
})();
