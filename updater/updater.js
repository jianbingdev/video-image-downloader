/* 更新执行器 —— 下载 zipball → 解压 → 校验 → 写盘 → 重载。
 *
 * 关键约束（都是实测或官方文档确认过的）：
 *   - 扩展目录里 `_` 开头的文件会让扩展直接加载失败，写盘前必须整体校验（_locales 例外）
 *   - File System Access 的目录句柄要存 IndexedDB 才能跨会话复用
 *   - requestPermission 必须发生在用户手势里，所以授权动作只能由按钮触发
 *   - runtime.reload() 对解压加载的扩展有效，且会被当作 update（探针已验证）
 */

'use strict';

const PROGRESS_KEY = 'updater:progress';
const DB_NAME = 'updater-db';
const DB_STORE = 'kv';
const DB_DIR_KEY = 'dir';

// 不写进扩展目录的文件：仓库里的发布元数据与平台杂物
const SKIP_FILES = new Set(['.gitignore', '.gitattributes', 'README.md', 'version.json', 'desktop.ini', 'Thumbs.db']);
// 清理旧文件时永远不碰的目录
const PROTECT_DIRS = new Set(['.git', 'backup', 'node_modules', '.wxt', '.output']);
// 只清理扩展自身类型的残留文件，用户自己放进去的笔记之类不动
const EXT_FILE_RE = /\.(js|mjs|html|htm|css|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|md|txt|map)$/i;

const state = {
  meta: null,
  currentVersion: chrome.runtime.getManifest().version,
  dirHandle: null,
  buffer: null,
  files: null,
  running: false
};

/* ==================== UI ==================== */

const $ = (id) => document.getElementById(id);

function setStep(name, mode) {
  const li = document.querySelector(`li[data-step="${name}"]`);
  if (!li) return;
  li.classList.remove('done', 'active');
  if (mode) li.classList.add(mode);
}

function setProgress(percent, text, indeterminate) {
  const bar = $('bar');
  bar.classList.toggle('indeterminate', !!indeterminate);
  if (!indeterminate) {
    bar.querySelector('i').style.width = Math.max(0, Math.min(100, percent)) + '%';
  }
  if (text) $('status').textContent = text;
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.classList.add('show');
  $('btnRetry').hidden = false;
  $('btnClose').hidden = false;
  setProgress(0, '已停止', false);
  report({ phase: 'error', percent: 0, message: msg });
}

function hideError() {
  $('error').classList.remove('show');
  $('btnRetry').hidden = true;
  $('btnClose').hidden = true;
}

function showPickButton(label) {
  const b = $('btnPick');
  b.hidden = false;
  if (label) b.textContent = label;
}

function hidePickButton() {
  $('btnPick').hidden = true;
}

/* ==================== 进度回传（给 popup 看） ==================== */

function report(patch) {
  const payload = Object.assign({ at: Date.now() }, patch);
  try { chrome.storage.local.set({ [PROGRESS_KEY]: payload }); } catch (_) {}
}

/* ==================== IndexedDB ==================== */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const r = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ==================== 目录句柄 ==================== */

/** 有句柄且已授权就直接用；没授权返回 null，交给按钮触发 */
async function getAuthorizedDir() {
  let handle = state.dirHandle;
  if (!handle) {
    try { handle = await idbGet(DB_DIR_KEY); } catch (_) { handle = null; }
  }
  if (!handle) return null;

  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      state.dirHandle = handle;
      return handle;
    }
  } catch (_) {}
  return null;
}

/** 必须在用户点击的调用栈里执行 */
async function pickOrAuthorize() {
  let handle = state.dirHandle;
  if (!handle) {
    try { handle = await idbGet(DB_DIR_KEY); } catch (_) { handle = null; }
  }

  if (handle) {
    try {
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        state.dirHandle = handle;
        return handle;
      }
    } catch (_) {}
  }

  handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'ext-root' });
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('没有拿到文件夹的读写权限');
  state.dirHandle = handle;
  try { await idbSet(DB_DIR_KEY, handle); } catch (_) {}
  return handle;
}

/* ==================== 下载 ==================== */

async function download(url, onProgress) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
  if (!res.body) return await res.arrayBuffer();

  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(total ? (received / total) * 100 : 0, received, total);
  }

  const all = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return all.buffer;
}

/* ==================== 路径校验 ==================== */

function pathProblem(p) {
  if (!p) return '空路径';
  if (p.includes('\\')) return '含反斜杠';
  if (p.startsWith('/')) return '绝对路径';
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '')) return '含非法路径段';
  const head = segs[0];
  if (head.startsWith('_') && head !== '_locales') return '下划线开头（扩展系统保留）';
  return '';
}

function shouldSkip(p) {
  if (SKIP_FILES.has(p)) return true;
  const base = p.split('/').pop();
  if (SKIP_FILES.has(base)) return true;
  if (base.startsWith('.')) return true;
  if (p.startsWith('__MACOSX/')) return true;
  return false;
}

/* ==================== 写盘 ==================== */

async function writeOne(dir, path, data) {
  const parts = path.split('/');
  const name = parts.pop();
  let d = dir;
  for (const seg of parts) {
    d = await d.getDirectoryHandle(seg, { create: true });
  }
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

/** 收集需要删除的旧文件（先收集再删，避免边遍历边删） */
async function collectStale(dir, keepSet) {
  const stale = [];

  async function walk(d, prefix) {
    for await (const [name, handle] of d.entries()) {
      const path = prefix ? prefix + '/' + name : name;
      if (handle.kind === 'directory') {
        if (PROTECT_DIRS.has(name)) continue;
        await walk(handle, path);
      } else {
        if (keepSet.has(path)) continue;
        if (SKIP_FILES.has(name)) continue;
        if (!EXT_FILE_RE.test(name)) continue;
        stale.push({ parent: d, name, path });
      }
    }
  }

  await walk(dir, '');
  return stale;
}

/* ==================== 主流程 ==================== */

/** 防呆：确认这个文件夹真的是扩展目录，避免往无关文件夹里写 47 个文件 */
async function looksLikeExtensionDir(dir) {
  try {
    const fh = await dir.getFileHandle('manifest.json');
    const json = JSON.parse(await (await fh.getFile()).text());
    return json && json.manifest_version === 3;
  } catch (_) {
    return false;
  }
}

async function runUpdate(dir, meta) {
  if (state.running) return;
  state.running = true;
  hideError();
  $('tip').hidden = true;

  if (!(await looksLikeExtensionDir(dir))) {
    state.running = false;
    showError('这个文件夹里没有有效的 manifest.json，看起来不是扩展目录。请选择你加载扩展时用的那个文件夹（里面有 manifest.json 的那一层）。');
    return;
  }

  try {
    // --- 下载 ---
    setStep('dir', 'done');
    setStep('download', 'active');
    setProgress(0, '开始下载…', true);

    if (!state.buffer) {
      const url = meta.zipball;
      if (!url) throw new Error('没有拿到更新包地址（version.json 里缺 zipball 字段）');
      state.buffer = await download(url, (pct, got, total) => {
        if (total) {
          const mb = (got / 1048576).toFixed(1);
          const tm = (total / 1048576).toFixed(1);
          setProgress(pct, `下载中 ${Math.round(pct)}%　${mb} / ${tm} MB`, false);
          report({ phase: 'downloading', percent: Math.round(pct), message: `下载中 ${Math.round(pct)}%` });
        } else {
          setProgress(0, `下载中 ${(got / 1048576).toFixed(1)} MB`, true);
          report({ phase: 'downloading', percent: 0, message: `下载中 ${(got / 1048576).toFixed(1)} MB` });
        }
      });
    }
    setStep('download', 'done');

    // --- 解压 ---
    setStep('extract', 'active');
    setProgress(0, '正在解压…', true);
    report({ phase: 'extracting', percent: 0, message: '正在解压…' });

    let files = state.files;
    if (!files) {
      const raw = await MiniZip.unzip(state.buffer);
      files = MiniZip.stripCommonRoot(raw).filter((f) => !shouldSkip(f.path));
      state.files = files;
    }
    if (!files.length) throw new Error('更新包里没有可写入的文件');

    const bad = files.filter((f) => pathProblem(f.path));
    if (bad.length) {
      throw new Error(
        `更新包里有 ${bad.length} 个文件路径不合法，已全部中止（没有写入任何文件）：\n` +
        bad.slice(0, 3).map((f) => `${f.path} → ${pathProblem(f.path)}`).join('\n')
      );
    }
    setProgress(100, `解压完成，共 ${files.length} 个文件`, false);
    setStep('extract', 'done');

    // --- 写入 ---
    setStep('write', 'active');
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      await writeOne(dir, f.path, f.data);
      const pct = Math.round(((i + 1) / files.length) * 100);
      if (i % 3 === 0 || i === files.length - 1) {
        setProgress(pct, `写入文件 ${i + 1} / ${files.length}`, false);
        report({ phase: 'writing', percent: pct, message: `写入 ${i + 1}/${files.length}` });
      }
    }

    // --- 清理旧文件 ---
    const keep = new Set(files.map((f) => f.path));
    let removed = [];
    try {
      const stale = await collectStale(dir, keep);
      for (const s of stale) {
        try {
          await s.parent.removeEntry(s.name);
          removed.push(s.path);
        } catch (_) { /* 单个删不掉不影响整体 */ }
      }
    } catch (_) { /* 清理失败不算更新失败 */ }

    setStep('write', 'done');

    // --- 重载 ---
    setStep('reload', 'active');
    setProgress(100, '更新完成，正在重新加载扩展…', false);
    report({ phase: 'reloading', percent: 100, message: '正在重载…', removed: removed.length });

    state.running = false;
    setTimeout(() => {
      chrome.runtime.reload();
    }, 800);
  } catch (e) {
    state.running = false;
    showError(String((e && e.message) || e));
    throw e;
  }
}

/* ==================== 启动 ==================== */

async function getState() {
  const got = await chrome.storage.local.get('updater');
  return got.updater || { current: state.currentVersion, meta: null };
}

async function start() {
  const st = await getState();
  state.meta = st.meta;
  state.currentVersion = st.current || state.currentVersion;

  // 已经是最新：不能显示"正在更新"，更不能让用户再点一次
  if (!st.hasUpdate) {
    $('title').textContent = '已是最新版本';
    $('subtitle').textContent = `当前 ${state.currentVersion}`;
    $('steps').hidden = true;
    $('bar').hidden = true;
    $('status').textContent = '没有可用的更新';
    $('hint').textContent = '';
    $('btnClose').hidden = false;
    return;
  }

  if (!state.meta || !state.meta.version) {
    $('title').textContent = '没有可用的版本信息';
    $('subtitle').textContent = `当前版本 ${state.currentVersion}`;
    showError('还没拿到新版本信息。回到扩展弹窗点一次「检查更新」，或稍后再试。');
    return;
  }

  $('title').textContent = `正在更新到 ${state.meta.version}`;
  $('subtitle').textContent = `当前 ${state.currentVersion}　→　目标 ${state.meta.version}`;
  $('hint').textContent = state.meta.notes || '';

  // 目录：已授权就直接跑，没授权才让用户点
  setStep('dir', 'active');
  const dir = await getAuthorizedDir();
  if (dir) {
    setStep('dir', 'done');
    await runUpdate(dir, state.meta);
  } else {
    setProgress(0, '第一次更新需要指定扩展文件夹，只需一次', false);
    showPickButton('选择扩展文件夹并继续');
    $('hint').textContent = '';
    $('tip').hidden = false;
    $('tip').innerHTML = '<b>要选哪个文件夹？</b>就是你加载此扩展时选的那个目录。选错会提示，不会误写。';
  }
}

/* ==================== 事件 ==================== */

$('btnPick').addEventListener('click', async () => {
  $('btnPick').disabled = true;
  try {
    const dir = await pickOrAuthorize();
    hidePickButton();
    hideError();
    await runUpdate(dir, state.meta);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      setProgress(0, '你取消了选择，可以再点一次', false);
    } else {
      showError('选择文件夹失败：' + ((e && e.message) || e));
    }
  } finally {
    $('btnPick').disabled = false;
  }
});

$('btnRetry').addEventListener('click', async () => {
  const dir = state.dirHandle || (await getAuthorizedDir());
  if (!dir) {
    showPickButton('选择扩展文件夹并继续');
    hideError();
    return;
  }
  hideError();
  await runUpdate(dir, state.meta);
});

$('btnClose').addEventListener('click', () => window.close());

/* 忘记已记住的文件夹：清掉 IndexedDB 里的句柄后重载页面，
 * 下次就会重新走"选择扩展文件夹"的首次流程。换目录或重演首测时用。 */
$('forgetDir').addEventListener('click', async (e) => {
  e.preventDefault();
  if (state.running && !window.confirm('更新正在进行，重置会中断它（已下载的部分会丢弃）。继续吗？')) return;
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(DB_DIR_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch (_) {}
  location.reload();
});

start().catch((e) => showError(String((e && e.message) || e)));
