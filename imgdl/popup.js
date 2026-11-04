/* 图片下载器 - 弹窗
 *
 * 两部分：
 *   1. 本页图片数量 + 一键下载全部
 *   2. 设置面板：自定义页面上那个下载按钮的位置（九宫格锚点 + 距边缘距离）
 *      设置写在 chrome.storage 里，内容脚本通过 chrome.storage.onChanged 立刻生效。
 */

const DEFAULTS = { anchor: 'tl', gapX: 16, gapY: 16, showRing: false };
const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const POS_LABEL = {
  tl: '左上角', tc: '顶部中间', tr: '右上角',
  ml: '左侧中间', mc: '页面正中', mr: '右侧中间',
  bl: '左下角', bc: '底部中间', br: '右下角'
};

const statusEl = document.getElementById('status');
const btnAll = document.getElementById('downloadAll');
const gearBtn = document.getElementById('gear');
const panel = document.getElementById('panel');
const gridEl = document.getElementById('grid');
const gapXEl = document.getElementById('gapX');
const gapYEl = document.getElementById('gapY');
const previewEl = document.getElementById('preview');
const dotEl = document.getElementById('dot');
const ringEl = document.getElementById('showRing');
const hintEl = document.getElementById('hint');
const savedEl = document.getElementById('saved');
const vidOptionsEl = document.getElementById('vidOptions');

let items = [];
let settings = Object.assign({}, DEFAULTS);
let savedTimer = 0;

/* ==================== 设置读写 ==================== */

function store() {
  try {
    if (!chrome.storage) return null;
    return chrome.storage.sync || chrome.storage.local || null;
  } catch (_) { return null; }
}

function clampGap(v) {
  const n = Number(v);
  if (!isFinite(n)) return DEFAULTS.gapX;
  return Math.max(0, Math.min(400, Math.round(n)));
}

function normalize(s) {
  const out = Object.assign({}, DEFAULTS, s || {});
  if (ANCHORS.indexOf(out.anchor) < 0) out.anchor = DEFAULTS.anchor;
  // 兼容旧版：以前只有一个 gap，读到就同时当作水平和垂直
  if (out.gap != null) {
    if (out.gapX == null) out.gapX = out.gap;
    if (out.gapY == null) out.gapY = out.gap;
  }
  out.gapX = clampGap(out.gapX);
  out.gapY = clampGap(out.gapY);
  delete out.gap;
  out.showRing = !!out.showRing;
  return out;
}

function loadSettings() {
  return new Promise((resolve) => {
    const area = store();
    if (!area || typeof area.get !== 'function') { resolve(normalize(null)); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(normalize(v)); } };
    try {
      area.get(DEFAULTS, (v) => {
        try { if (chrome.runtime.lastError) { finish(null); return; } } catch (_) {}
        finish(v);
      });
    } catch (_) { finish(null); }
    setTimeout(() => finish(null), 500);
  });
}

function save(patch) {
  settings = normalize(Object.assign({}, settings, patch));
  const area = store();
  if (area && typeof area.set === 'function') {
    try { area.set(patch); } catch (_) { /* 存不下也不影响本次生效 */ }
  }
  renderSettings();
  showSaved();
}

function showSaved() {
  savedEl.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1200);
}

/* ==================== 设置界面 ==================== */

/** 把 anchor + gap 画成预览里那个小方块的位置 */
function renderPreview() {
  if (!previewEl || !dotEl) return;
  const w = previewEl.clientWidth;
  const h = previewEl.clientHeight;
  if (!w || !h) return;            // panel 还没展开，宽高为 0，先跳过

  const DW = 26;
  const DH = 16;
  // 按比例映射，而不是把 gap 直接当像素用：预览区只有 90px 高，
  // 直接映射的话 gap 超过 37 就顶死不动了，滑块会显得没反应。
  const gx = Math.min((settings.gapX / 400) * w, w - DW);
  const gy = Math.min((settings.gapY / 400) * h, h - DH);
  const a = settings.anchor || 'tl';

  let left;
  if (a.charAt(1) === 'l') left = gx;
  else if (a.charAt(1) === 'r') left = w - DW - gx;
  else left = (w - DW) / 2;

  let top;
  if (a.charAt(0) === 't') top = gy;
  else if (a.charAt(0) === 'b') top = h - DH - gy;
  else top = (h - DH) / 2;

  dotEl.style.left = Math.round(left) + 'px';
  dotEl.style.top = Math.round(top) + 'px';
}

function buildGrid() {
  ANCHORS.forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pos';
    b.dataset.a = a;
    b.title = POS_LABEL[a];
    b.setAttribute('aria-label', POS_LABEL[a]);
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(document.createElement('i'));
    b.addEventListener('click', () => save({ anchor: a, gapX: 16, gapY: 16 }));
    gridEl.appendChild(b);
  });
}

function renderSettings() {
  const tiles = gridEl.querySelectorAll('.pos');
  for (let i = 0; i < tiles.length; i++) {
    tiles[i].setAttribute('aria-pressed', String(tiles[i].dataset.a === settings.anchor));
  }
  if (document.activeElement !== gapXEl) gapXEl.value = String(settings.gapX);
  if (document.activeElement !== gapYEl) gapYEl.value = String(settings.gapY);
  ringEl.checked = settings.showRing;
  renderPreview();

  const label = POS_LABEL[settings.anchor] || POS_LABEL.tl;
  hintEl.innerHTML = '<b>下载单张：</b>把鼠标移到任意图片上，再点' + label + '的「下载图片」按钮。';
}

gearBtn.addEventListener('click', () => {
  const open = panel.classList.toggle('open');
  gearBtn.setAttribute('aria-expanded', String(open));
  // panel 展开前宽高是 0，渲染不出位置，展开后补一次
  if (open) requestAnimationFrame(renderPreview);
});

/** 点预览区任意位置：按三等分判断落在哪一格 */
if (previewEl) {
  previewEl.addEventListener('click', (e) => {
    const r = previewEl.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const col = x < r.width / 3 ? 'l' : x > (r.width * 2) / 3 ? 'r' : 'c';
    const row = y < r.height / 3 ? 't' : y > (r.height * 2) / 3 ? 'b' : 'm';
    save({ anchor: row + col, gapX: 16, gapY: 16 });
  });
}

gapXEl.addEventListener('input', () => {
  settings.gapX = clampGap(gapXEl.value);
  renderPreview();
});
gapYEl.addEventListener('input', () => {
  settings.gapY = clampGap(gapYEl.value);
  renderPreview();
});

gapXEl.addEventListener('change', () => {
  const v = clampGap(gapXEl.value);
  gapXEl.value = String(v);
  save({ gapX: v });
});
gapYEl.addEventListener('change', () => {
  const v = clampGap(gapYEl.value);
  gapYEl.value = String(v);
  save({ gapY: v });
});

ringEl.addEventListener('change', () => save({ showRing: ringEl.checked }));

/* ==================== 本页图片 ==================== */

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function scanPage() {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) {
    setStatus('读不到当前标签页', 'warn');
    return;
  }

  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'imgdl:collect' });
  } catch (_) {
    res = null;
  }

  if (!res || !res.ok) {
    setStatus('这个页面不支持下载（浏览器内置页、扩展商店页都取不到图片）', 'warn');
    return;
  }

  items = res.items || [];
  if (!items.length) {
    setStatus('本页没有找到可下载的图片', 'warn');
    return;
  }

  setStatus('本页找到 ' + items.length + ' 张图片', 'ready');
  btnAll.disabled = false;
  btnAll.textContent = '下载本页全部图片（' + items.length + '）';
}

btnAll.addEventListener('click', async () => {
  if (!items.length) return;
  btnAll.disabled = true;
  btnAll.textContent = '正在下载…';

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'imgdl:downloadMany', items });
  } catch (_) {
    res = null;
  }

  if (!res || !res.ok) {
    btnAll.textContent = '下载失败，请重试';
    return;
  }

  const done = res.done || 0;
  const failed = res.failed || 0;
  btnAll.textContent = failed
    ? '完成：成功 ' + done + ' 张，失败 ' + failed + ' 张'
    : '已保存 ' + done + ' 张';

  setTimeout(() => window.close(), 1400);
});

/* ==================== 视频下载设置 ==================== */

// 合并版：这个按钮直接打开视频那边的设置页（manifest 里的 options_ui.page）
vidOptionsEl.addEventListener('click', () => {
  try { chrome.runtime.openOptionsPage(); } catch (_) { /* 平台不支持就忽略 */ }
  window.close();
});

/* ==================== 更新提示 ==================== */

const updateBox = document.getElementById('updateBox');
const updateText = document.getElementById('updateText');
const updateGo = document.getElementById('updateGo');
const updateBar = document.getElementById('updateBar');
const updateSub = document.getElementById('updateSub');

let updateTries = 0;

function sendUpdate(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res || null);
      });
    } catch (_) { resolve(null); }
  });
}

function renderUpdate(state) {
  if (!state) return;
  if (state.hasUpdate && state.meta && state.meta.version) {
    updateBox.classList.add('show');
    updateText.textContent = '新版本 ' + state.meta.version;
    updateGo.hidden = false;
    updateBar.hidden = true;
    updateSub.textContent = state.meta.notes || '';
    updateSub.hidden = !state.meta.notes;
  } else if (!updateBox.dataset.busy) {
    // 更新过程中收到 status 不该把横幅收起来
    updateBox.classList.remove('show');
  }
}

async function refreshUpdate() {
  const res = await sendUpdate({ type: 'updater:status' });
  if (!res || !res.ok) return;
  renderUpdate(res.state);
  const s = res.state || {};
  // 第一次打开还没有任何检查结果时，主动催一次（不阻塞界面）
  if (!s.latest && !s.checking && updateTries < 2) {
    updateTries++;
    sendUpdate({ type: 'updater:check' });
    setTimeout(refreshUpdate, 2500);
  }
}

updateGo.addEventListener('click', () => {
  sendUpdate({ type: 'updater:openPage' });
  window.close();
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['updater:progress']) return;
    const p = changes['updater:progress'].newValue;
    if (!p || !p.phase) return;

    updateBox.classList.add('show');
    updateBox.dataset.busy = '1';
    updateSub.hidden = true;

    if (p.phase === 'error') {
      updateText.textContent = '更新失败';
      updateGo.hidden = false;
      updateBar.hidden = true;
      updateSub.textContent = p.message || '';
      updateSub.hidden = false;
      delete updateBox.dataset.busy;
      return;
    }

    if (p.phase === 'reloading') {
      updateText.textContent = '更新完成，正在重载…';
      updateGo.hidden = true;
      updateBar.hidden = false;
      updateBar.querySelector('i').style.width = '100%';
      return;
    }

    updateGo.hidden = true;
    updateText.textContent = p.message || '正在更新…';
    if (p.phase === 'downloading' || p.phase === 'writing') {
      updateBar.hidden = false;
      updateBar.querySelector('i').style.width = (p.percent || 0) + '%';
    } else {
      updateBar.hidden = true;
    }
  });
} catch (_) {}

/* ---------- 手动检查更新 ---------- */

const verText = document.getElementById('verText');
const checkBtn = document.getElementById('checkBtn');

if (verText) verText.textContent = 'v' + chrome.runtime.getManifest().version;

function resetCheckBtn(label) {
  checkBtn.textContent = label;
  setTimeout(() => {
    checkBtn.textContent = '检查更新';
    checkBtn.disabled = false;
    checkBtn.title = '';
  }, 2200);
}

if (checkBtn) {
  checkBtn.addEventListener('click', async () => {
    if (checkBtn.disabled) return;
    checkBtn.disabled = true;
    checkBtn.textContent = '检查中…';

    const res = await sendUpdate({ type: 'updater:check' });

    if (!res || !res.ok) {
      checkBtn.title = (res && res.error) || '请求失败';
      resetCheckBtn('检查失败');
      return;
    }

    renderUpdate(res.state);
    const s = res.state || {};
    if (s.hasUpdate) {
      const v = (s.meta && s.meta.version) || '新版本';
      resetCheckBtn('发现 ' + v);
    } else if (s.lastError) {
      checkBtn.title = s.lastError;   // 悬停能看到真实原因，不占版面
      resetCheckBtn('检查失败');
    } else {
      resetCheckBtn('已是最新');
    }
  });
}

/* ==================== 启动 ==================== */

(async () => {
  buildGrid();
  settings = await loadSettings();
  renderSettings();
  refreshUpdate().catch(() => {});
  scanPage().catch(() => setStatus('在扩展里打开才能读取当前页面', 'warn'));
})();
