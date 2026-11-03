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
  const REF = 'dev';
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
   * @param {boolean} force 忽略 24 小时节流
   */
  async function check(force) {
    const state = await getState();

    // manifest 版本跟上次检查时不一样 → 说明扩展刚被更新过，必须重新核对，
    // 不能因为「24 小时内查过了」就沿用旧结论。
    const versionChanged = state.checkedVersion !== state.current;

    if (!force && !versionChanged && state.lastCheck && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) {
      return state;
    }

    await setState({ checking: true });
    try {
      const meta = await fetchVersionMeta();
      const hasUpdate = compareVersion(meta.version, currentVersion()) > 0;
      return await setState({
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
      // 失败静默：保留上一次的结论，只记录错误原因，避免误报"有更新"
      return await setState({
        checkedVersion: currentVersion(),
        checking: false,
        lastCheck: Date.now(),
        lastError: String((e && e.message) || e)
      });
    }
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

  chrome.runtime.onInstalled.addListener(() => {
    ensureAlarm();
    check(false);
  });

  chrome.runtime.onStartup.addListener(() => {
    ensureAlarm();
    check(false);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'updater:status') {
      getState().then((s) => sendResponse({ ok: true, state: s }));
      return true;
    }

    if (msg.type === 'updater:check') {
      check(true)
        .then((s) => sendResponse({ ok: true, state: s }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }

    if (msg.type === 'updater:openPage') {
      chrome.tabs.create({ url: chrome.runtime.getURL('updater/updater.html') });
      sendResponse({ ok: true });
      return false;
    }
  });

  // service worker 冷启动时也把闹钟补上（浏览器重启后 alarms 会保留，这里只是兜底）
  ensureAlarm();
})();
