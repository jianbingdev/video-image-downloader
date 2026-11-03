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

  // dev 分支读 @dev，合并回 main 发版时这一行要改成 @main
  const SOURCE = 'https://cdn.jsdelivr.net/gh/jianbingdev/video-image-downloader@dev/version.json';
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

  function dateKey() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  async function getState() {
    const got = await chrome.storage.local.get(STATE_KEY);
    return got[STATE_KEY] || {
      current: currentVersion(),
      latest: '',
      hasUpdate: false,
      meta: null,
      lastCheck: 0,
      lastError: '',
      checking: false
    };
  }

  async function setState(patch) {
    const next = Object.assign(await getState(), patch, { current: currentVersion() });
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  }

  async function fetchVersionMeta() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // 日期参数用来绕开 jsDelivr 的 12 小时分支缓存，同一天内仍然命中缓存
      const res = await fetch(`${SOURCE}?d=${dateKey()}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json || !json.version) throw new Error('version.json 缺少 version 字段');
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {boolean} force 忽略 24 小时节流
   */
  async function check(force) {
    const state = await getState();
    if (!force && state.lastCheck && Date.now() - state.lastCheck < CHECK_INTERVAL_MS) {
      return state;
    }

    await setState({ checking: true });
    try {
      const meta = await fetchVersionMeta();
      const hasUpdate = compareVersion(meta.version, currentVersion()) > 0;
      return await setState({
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
