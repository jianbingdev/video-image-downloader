/* 图片下载器 - 后台服务
 * 所有下载都走这里：chrome.downloads 是浏览器级下载，不受页面 CORS 限制，
 * 所以抖音这类 CDN 图片也能直接存下来。
 */

const MAX_BATCH = 100;      // 单次批量下载上限
const BATCH_DELAY = 150;    // 每张之间的间隔(ms)，避免被浏览器限流

/** 把文件名清理成 Windows / macOS 都能用的安全名字 */
function sanitize(name) {
  let s = String(name == null ? '' : name);
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');      // 控制字符
  s = s.replace(/[\\/:*?"<>|]/g, '_');               // 非法字符
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '');                          // 不能以点开头
  s = s.slice(0, 90).trim();
  if (!s) s = 'image_' + Date.now();
  return s;
}

/** 单个下载 */
async function downloadOne(item) {
  const url = item && item.url;
  if (!url) throw new Error('缺少图片地址');
  if (!/^(https?:|data:|blob:)/i.test(url)) throw new Error('不支持的地址类型');

  const options = {
    url,
    conflictAction: 'uniquify',   // 同名自动加 (1)(2)，绝不覆盖
    saveAs: false
  };
  if (item.filename) options.filename = sanitize(item.filename);

  const id = await chrome.downloads.download(options);
  if (id === undefined) throw new Error('浏览器拒绝了这次下载');
  return id;
}

/** 批量下载 */
async function downloadMany(items) {
  const list = Array.isArray(items) ? items.slice(0, MAX_BATCH) : [];
  let done = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < list.length; i++) {
    try {
      await downloadOne(list[i]);
      done++;
    } catch (err) {
      failed++;
      if (errors.length < 3) errors.push(String((err && err.message) || err));
    }
    if (i < list.length - 1) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY));
    }
  }
  return { ok: true, done, failed, total: list.length, errors };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'imgdl:download') {
    downloadOne(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;   // 异步响应
  }

  if (msg.type === 'imgdl:downloadMany') {
    downloadMany(msg.items)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
});
