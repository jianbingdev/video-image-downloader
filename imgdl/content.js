/* 图片下载器 - 内容脚本
 *
 * 两条互不干扰的机制：
 *   1. 按钮：position:fixed，常驻显示、永不移动，不参与鼠标命中，
 *      所以不存在"鼠标压到按钮上导致闪烁 / 点不动"的问题。
 *      位置（九宫格锚点 + 距边缘距离）由弹窗里的"设置"决定，存在 chrome.storage。
 *   2. 目标图：由鼠标位置决定 —— 鼠标指着哪张图就下载哪张。
 *      鼠标没指着任何图时，保留上一次的目标；从没指过就退回"屏幕上最大的一张"。
 *
 * 选区虚线框默认**关闭**（页面更干净），需要的话在设置里打开。
 *
 * 注意两件事：
 *   1. 不能用 elementFromPoint(单数) 找图片。抖音这类站点的图片上面盖着一层透明
 *      <button> 点击热区，命中结果是那层按钮而不是 <img>。统一改成拿矩形算。
 *   2. 拿矩形算就必须自己处理 overflow 裁剪。getBoundingClientRect 是"布局矩形"，
 *      它不管祖先有没有 overflow:hidden。轮播图里被裁掉的"上一张/下一张"仍然占着
 *      屏幕上的坐标，鼠标划过去就会被误判成当前目标 —— 见 visibleRect() 的注释。
 */
(() => {
  'use strict';
  if (window.__imgDownloaderReady) return;
  window.__imgDownloaderReady = true;

  const MIN_RENDER = 120;       // 图片在页面上的显示尺寸下限(px)
  const MIN_NATURAL = 200;      // 图片原始尺寸下限(px)，用来排除图标/贴图
  const MIN_VISIBLE = 3600;     // 可见面积下限(约 60x60)
  const RESCUE_MIN = 80;        // 兜底找图的尺寸下限，比 MIN_RENDER 更松
  const SCAN_INTERVAL = 800;    // 候选图片缓存刷新间隔(ms)
  const POLL_INTERVAL = 1200;   // 兜底轮询，应对懒加载新出现的图片

  /* ---------- 设置（弹窗里改，存在 chrome.storage） ---------- */

  const DEFAULTS = {
    anchor: 'tl',                 // 按钮锚点：t/m/b + l/c/r
    gapX: 16,                     // 水平方向距边缘(px)：左侧锚点=距左，右侧=距右
    gapY: 16,                     // 垂直方向距边缘(px)：上方锚点=距上，下方=距下
    showRing: false               // 是否显示选区虚线框
  };
  const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
  const POS_LABEL = {
    tl: '左上角', tc: '顶部中间', tr: '右上角',
    ml: '左侧中间', mc: '页面正中', mr: '右侧中间',
    bl: '左下角', bc: '底部中间', br: '右下角'
  };

  let settings = Object.assign({}, DEFAULTS);

  let btn = null;
  let ring = null;
  let toastEl = null;
  let toastTimer = 0;

  let target = null;            // 当前会被下载的那张图
  let lastHovered = null;       // 最近一次鼠标真正压着的那张 —— 点下载时的救命稻草
  let pointerX = -1;
  let pointerY = -1;
  let queued = false;

  let cache = [];
  let cacheAt = 0;
  let clipCache = new WeakMap();   // 元素 -> 裁剪祖先链
  let seq = 0;

  /* ==================== 界面 ==================== */

  function mount() {
    if (btn || !document.documentElement) return;

    btn = document.createElement('div');
    btn.setAttribute('data-imgdl-ui', 'btn');
    btn.setAttribute('title', '把鼠标移到要下载的图片上，再点这里');
    btn.style.cssText = [
      'position:fixed',
      'visibility:hidden',        // 等设置读回来定位好再显示，避免位置跳一下
      'z-index:2147483647',
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'height:36px',
      'padding:0 13px',
      'box-sizing:border-box',
      'border-radius:10px',
      'cursor:pointer',
      'background:rgba(37,99,235,.94)',
      'color:#fff',
      'font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 3px 14px rgba(0,0,0,.28)',
      'user-select:none',
      '-webkit-user-select:none',
      'transition:background .12s ease'
    ].join(';');
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff"' +
      ' stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="flex:none">' +
      '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>' +
      '<span>下载图片</span>';

    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(29,78,216,.98)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(37,99,235,.94)'; });

    // 拦住冒泡，别让页面自己的热区/导航栏把这次点击抢走
    const swallow = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    btn.addEventListener('pointerdown', swallow, true);
    btn.addEventListener('mousedown', swallow, true);
    btn.addEventListener('mouseup', swallow, true);
    btn.addEventListener('click', onClick, true);

    document.documentElement.appendChild(btn);
    ensureRing();
    applyPosition();
  }

  /** 选区虚线框：按需创建，默认不显示 */
  function ensureRing() {
    if (ring || !document.documentElement) return ring;
    ring = document.createElement('div');
    ring.setAttribute('data-imgdl-ui', 'ring');
    ring.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'pointer-events:none',
      'display:none',
      'box-sizing:border-box',
      'border:2px dashed rgba(37,99,235,.85)',
      'border-radius:6px',
      'background:transparent',
      'transition:border-color .15s ease,background .15s ease'
    ].join(';');
    document.documentElement.appendChild(ring);
    return ring;
  }

  /* ==================== 设置 ==================== */

  function clampGap(v) {
    const n = Number(v);
    if (!isFinite(n)) return DEFAULTS.gapX;
    return Math.max(0, Math.min(400, Math.round(n)));
  }

  function normalizeSettings(s) {
    const out = Object.assign({}, DEFAULTS, s || {});
    if (ANCHORS.indexOf(out.anchor) < 0) out.anchor = DEFAULTS.anchor;
    // 兼容旧版：以前只有一个 gap，读到就同时当作水平和垂直
    if (out.gap != null && out.gapX == null) out.gapX = out.gap;
    if (out.gap != null && out.gapY == null) out.gapY = out.gap;
    out.gapX = clampGap(out.gapX);
    out.gapY = clampGap(out.gapY);
    delete out.gap;
    out.showRing = !!out.showRing;
    return out;
  }

  function storageArea() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return null;
      return chrome.storage.sync || chrome.storage.local || null;
    } catch (_) { return null; }
  }

  function loadSettings(done) {
    const area = storageArea();
    if (!area || typeof area.get !== 'function') { done(); return; }
    let called = false;
    const finish = (v) => {
      if (called) return;
      called = true;
      settings = normalizeSettings(v);
      done();
    };
    try {
      area.get(DEFAULTS, (v) => {
        try { if (chrome.runtime.lastError) { finish(null); return; } } catch (_) {}
        finish(v);
      });
    } catch (_) { finish(null); }
  }

  /** 设置面板改完立刻生效（同一个页面里的内容脚本会收到 storage 变更广播） */
  function watchSettings() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' && area !== 'local') return;
        let touched = false;
        Object.keys(DEFAULTS).forEach((k) => {
          if (changes[k]) { settings[k] = changes[k].newValue; touched = true; }
        });
        if (!touched) return;
        settings = normalizeSettings(settings);
        applyPosition();
        if (!settings.showRing && ring) ring.style.display = 'none';
        schedule();
      });
    } catch (_) {}
  }

  /** 把九宫格锚点 + 距边缘距离落到按钮的 left/right/top/bottom 上 */
  function applyPosition() {
    if (!btn) return;
    const a = ANCHORS.indexOf(settings.anchor) >= 0 ? settings.anchor : DEFAULTS.anchor;
    const row = a.charAt(0);          // t / m / b
    const col = a.charAt(1);          // l / c / r
    const gx = clampGap(settings.gapX);
    const gy = clampGap(settings.gapY);
    const s = btn.style;

    s.left = ''; s.right = ''; s.top = ''; s.bottom = ''; s.transform = '';

    if (col === 'l') s.left = gx + 'px';
    else if (col === 'r') s.right = gx + 'px';
    else s.left = '50%';

    if (row === 't') s.top = gy + 'px';
    else if (row === 'b') s.bottom = gy + 'px';
    else s.top = '50%';

    // 居中方向用 transform 补齐（用 %/transform 就不必关心按钮自身尺寸）
    if (col === 'c' && row === 'm') s.transform = 'translate(-50%,-50%)';
    else if (col === 'c') s.transform = 'translateX(-50%)';
    else if (row === 'm') s.transform = 'translateY(-50%)';
  }

  function toast(text, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('data-imgdl-ui', 'toast');
      toastEl.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:48px',
        'transform:translateX(-50%)',
        'z-index:2147483647',
        'max-width:70vw',
        'padding:10px 18px',
        'border-radius:9px',
        'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
        'color:#fff',
        'pointer-events:none',
        'display:none',
        'box-shadow:0 6px 22px rgba(0,0,0,.28)',
        'word-break:break-all'
      ].join(';');
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.background = isError ? 'rgba(220,38,38,.94)' : 'rgba(17,24,39,.92)';
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2600);
  }

  /* ==================== 找图 ==================== */

  /**
   * 这张 <img> 值不值得当候选？判定**以渲染尺寸为主，原始尺寸为辅**。
   *
   * 这里踩过一个很隐蔽的坑：原来只要 naturalWidth/naturalHeight 有一面 < 200 就
   * 直接排除。可是**往下翻页时新出现的懒加载图片**，元素已经渲染出来、占着
   * 300x400 的位置，图却还没下载完，naturalWidth 仍然是 0 —— 于是被整批过滤掉。
   * scan() 返回空 → pickAtPointer / pickLargestVisible 全都找不到目标 →
   * 点下载就提示"把鼠标移到图片上"。这就是"最上面几张能下、往下翻几页就不行"的根因：
   * 那几张早就加载好了。
   *
   * 所以：用户**看得见、点得着**才是硬指标，能不能下载得下来交给 bestUrl() 去想办法
   * （它会依次尝试 srcset / currentSrc / data-src / src）。
   */
  function isCandidate(img, rect) {
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;

    // 快路径：原始尺寸够大，铁定是内容图。不碰布局，省开销。
    if (nw >= MIN_NATURAL && nh >= MIN_NATURAL) return true;

    // 剩下的情况才去看渲染尺寸
    const r = rect || img.getBoundingClientRect();
    if (r.width < MIN_RENDER || r.height < MIN_RENDER) return false;

    // 还没加载完（懒加载中）：渲染出来了就算候选
    if (!nw || !nh) return true;

    // 低清占位图：原始尺寸很小却被放大 3 倍以上显示，也算候选
    return r.width >= nw * 3 && r.height >= nh * 3;
  }

  function scan(force) {
    const now = Date.now();
    if (!force && cache.length && now - cacheAt < SCAN_INTERVAL) return cache;
    cacheAt = now;

    const out = [];
    const imgs = document.images;
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (img.closest && img.closest('[data-imgdl-ui]')) continue;
      // 别把"别的插件插进来的界面图标"当成页面图片。
      // 典型例子：视频下载器的按钮就是个 <img class="douyin-download-button">，
      // 它的 src 是 chrome-extension://xxx/download_button.svg。
      // 这类东西既不该被下载，也不该出现在弹窗的"本页图片"列表里。
      if (img.classList && img.classList.contains('douyin-download-button')) continue;
      if (img.closest && img.closest(
            '[class*="download-button"],[class*="downloadButton"],' +
            '[id*="download-button"],[class*="extension-btn"]')) continue;
      const rawSrc = img.currentSrc || img.getAttribute('src') ||
                     img.getAttribute('data-src') || '';
      if (/^(?:chrome|moz|edge|ms-browser|safari-web)-extension:/i.test(rawSrc)) continue;
      if (!isCandidate(img)) continue;
      out.push(img);
    }
    cache = out;
    clipCache = new WeakMap();   // 页面结构可能变了，裁剪链跟着重算
    return cache;
  }

  /* ---------- 真正"露出来"的区域 ----------
   *
   * 坑：getBoundingClientRect() 返回的是布局矩形，**不考虑祖先的 overflow 裁剪**。
   *
   * 抖音图集详情页的轮播就是典型：10 张 slide 横排在一个 overflow:hidden 的容器里，
   * 靠 transform 整体平移（translate3d(-4115px) = -823px × 5，对应第 6 张）。
   * 当前显示的只有一张，但"上一张"的矩形仍然覆盖着容器左边缘以外的坐标，
   * "下一张"的矩形仍然覆盖着容器右边缘以外的坐标。
   *
   * 于是从图片往左上角按钮移动鼠标时，只要掠过容器左边缘外侧那一小片区域，
   * 命中的就是"上一张" —— 目标被悄悄改掉，到按钮上又被"保持目标"保住了，
   * 点下去自然下载到上一张。必须先把被裁掉的部分排除掉。
   */

  const CLIP_RE = /hidden|auto|scroll|clip/;
  const EMPTY_RECT = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

  function normOv(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
  }

  /** 这个元素横向/纵向是否裁剪内容 */
  function clipAxes(el) {
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return { h: false, v: false }; }
    if (!cs) return { h: false, v: false };
    const sh = normOv(cs.overflow);
    let ox = normOv(cs.overflowX);
    let oy = normOv(cs.overflowY);
    // 少数环境不展开 overflow 简写，回退到 overflow 本身
    if ((!ox || ox === 'visible') && sh && sh !== 'visible') ox = sh;
    if ((!oy || oy === 'visible') && sh && sh !== 'visible') oy = sh;
    return { h: CLIP_RE.test(ox), v: CLIP_RE.test(oy) };
  }

  /** 裁剪祖先链：只装真正会裁的元素，一般 0~2 个，所以每帧成本可以忽略 */
  function clipAncestors(el) {
    const hit = clipCache.get(el);
    if (hit) return hit;
    const chain = [];
    let p = el.parentElement;
    let guard = 0;
    while (p && guard++ < 80) {
      const ax = clipAxes(p);
      if (ax.h || ax.v) chain.push({ el: p, h: ax.h, v: ax.v });
      if (p === document.documentElement) break;
      p = p.parentElement;
    }
    clipCache.set(el, chain);
    return chain;
  }

  /** 布局矩形 ∩ 裁剪祖先 ∩ 视口 = 真正看得见的那块 */
  function visibleRect(el, raw) {
    const r = raw || el.getBoundingClientRect();
    let left = Math.max(r.left, 0);
    let top = Math.max(r.top, 0);
    let right = Math.min(r.right, window.innerWidth);
    let bottom = Math.min(r.bottom, window.innerHeight);
    if (right <= left || bottom <= top) return EMPTY_RECT;

    const chain = clipAncestors(el);
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      const pr = c.el.getBoundingClientRect();
      if (c.h) {
        if (pr.left > left) left = pr.left;
        if (pr.right < right) right = pr.right;
      }
      if (c.v) {
        if (pr.top > top) top = pr.top;
        if (pr.bottom < bottom) bottom = pr.bottom;
      }
      if (right <= left || bottom <= top) return EMPTY_RECT;
    }
    return { left: left, top: top, right: right, bottom: bottom,
             width: right - left, height: bottom - top };
  }

  function rectArea(v) {
    if (!v || v.width <= 0 || v.height <= 0) return 0;
    return v.width * v.height;
  }

  /** 鼠标指着的图：包含该点、且该点确实露在外面、面积最大的那张（嵌套时取外层大图） */
  function pickAtPointer() {
    if (pointerX < 0 || pointerY < 0) return null;
    const imgs = scan(false);
    let best = null;
    let bestArea = 0;

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      const r = img.getBoundingClientRect();
      if (r.width < MIN_RENDER || r.height < MIN_RENDER) continue;
      // 先用布局矩形粗筛（便宜）
      if (pointerX < r.left || pointerX >= r.right) continue;
      if (pointerY < r.top || pointerY >= r.bottom) continue;
      // 再确认这个点落在"真正露出来"的区域里，被 overflow 裁掉的部分不算
      const v = visibleRect(img, r);
      if (pointerX < v.left || pointerX >= v.right) continue;
      if (pointerY < v.top || pointerY >= v.bottom) continue;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = img; }
    }
    return best;
  }

  /** 兜底：屏幕上真正可见面积最大的一张（面积相同取离屏幕中心最近的） */
  function pickLargestVisible() {
    const imgs = scan(false);
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let best = null;
    let bestArea = 0;
    let bestDist = Infinity;

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      const r = img.getBoundingClientRect();
      if (r.width < MIN_RENDER || r.height < MIN_RENDER) continue;

      const v = visibleRect(img, r);
      const area = rectArea(v);
      if (area < MIN_VISIBLE) continue;

      const dx = (v.left + v.right) / 2 - cx;
      const dy = (v.top + v.bottom) / 2 - cy;
      const dist = dx * dx + dy * dy;

      if (area > bestArea || (area === bestArea && dist < bestDist)) {
        bestArea = area;
        bestDist = dist;
        best = img;
      }
    }
    return best;
  }

  /**
   * 已经选中的目标还有效吗。
   * 除了"还在页面上、够大"，还要求它现在**真的看得见**：
   * 轮播翻页后上一张会被裁到 0 面积，这时候必须换人，不能抱着旧目标不放。
   */
  /* ==================== 兜底找图（最后一道防线） ====================
   *
   * 上面那套筛选（渲染尺寸、可见面积、裁剪判定）在正常页面上够用，但总有够不着的：
   * 图片压根不是 <img>（站点用 CSS 背景图铺封面）、图片藏在 shadow DOM 里
   * （document.images 根本看不见）、或者用户指着的那张恰好被某条规则判掉了。
   * 这些页面上一个候选都选不出来，点下载只能弹"把鼠标移到图片上"。
   *
   * 所以单开一条**只在快要失败时才走**的路：门槛降到最低，也不依赖 naturalWidth。
   * 代价是慢（要翻 shadow DOM、要算全页样式），但只在兜底那一刻跑，不影响正常使用。
   */

  /** 把 background-image:url(...) 里的地址抠出来 */
  function bgUrl(el) {
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return ''; }
    if (!cs) return '';
    const bi = cs.backgroundImage || '';
    if (!bi || bi === 'none' || bi.indexOf('url(') === -1) return '';
    const m = /url\((["']?)([^"')]+)\1\)/i.exec(bi);
    return m ? m[2] : '';
  }

  /** 统一取地址：<img> 走 bestUrl，其它元素走 background-image */
  function urlOf(el) {
    if (!el) return '';
    if (el.tagName === 'IMG') return bestUrl(el);
    return absolutize(bgUrl(el));
  }

  /** 连 shadow DOM 一起遍历（不少站点的信息流是 web component 渲染的） */
  function deepElements(root, depth, out) {
    out = out || [];
    let list;
    try { list = root.querySelectorAll('*'); } catch (_) { return out; }
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      out.push(el);
      if (depth < 6 && el.shadowRoot) deepElements(el.shadowRoot, depth + 1, out);
    }
    return out;
  }

  function isOurUI(el) {
    return !!(el && el.closest && el.closest('[data-imgdl-ui]'));
  }

  let rescueBgAt = 0;      // 上次"翻全页找背景图"的时间
  let rescueBgEls = [];    // 那次翻出来的候选元素，缓存着、每帧重新打分

  /**
   * 兜底找图。打分制，而不是"谁面积大谁赢" —— 见下面 consider() 里的注释。
   *
   * @param {boolean} fast      true  = 每帧都会跑，尽量便宜
   *                            false = 只在点击救场时跑一次，可以慢
   * @param {boolean} underOnly true  = 只认"鼠标正压着的那张"，没有就返回 null。
   *                            鼠标从图片移向按钮的路上必须用这个模式：
   *                            要是这里也拿"屏幕上最大的"来充数，目标就会在半路上
   *                            被悄悄换掉，又变成"总是下载到隔壁那张"。
   */
  function rescuePick(fast, underOnly) {
    let best = null;
    let bestScore = 0;
    let bestUnder = false;

    function consider(el) {
      if (isOurUI(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < RESCUE_MIN || r.height < RESCUE_MIN) return;

      // "指针压着它"必须看**真正露出来的那块**，不能只看布局矩形 ——
      // 轮播页里被 overflow 裁掉的上一张/下一张，布局矩形照样能盖住指针，
      // 只看矩形的话它们又会被判成命中（坑 0.2）。
      let under = pointerX >= r.left && pointerX < r.right &&
                  pointerY >= r.top && pointerY < r.bottom;
      let v = null;
      if (under || !fast) v = visibleRect(el, r);
      if (under && (!v || pointerX < v.left || pointerX >= v.right ||
                    pointerY < v.top || pointerY >= v.bottom)) {
        under = false;
      }
      if (underOnly && !under) return;

      let w, h;
      if (fast && !under) {
        // 便宜版：只跟视口相交，不爬裁剪祖先链
        w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
        h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      } else {
        if (!v) v = visibleRect(el, r);
        w = v.width; h = v.height;
      }
      if (w <= 0 || h <= 0) return;

      // 打分：可见面积只是基础分。"鼠标此刻正压着它"和"它就是上一次的目标"
      // 各给一个压倒性的加成 —— 用户指着谁就下谁，这比谁面积大重要得多。
      // （坑 0.1：在多图页面上按面积挑，必然退化成"谁先出现谁赢"。）
      let s = w * h;
      if (under) s += 1e9;
      if (el === lastHovered) s += 1e12;

      if (s <= bestScore) return;
      if (!urlOf(el)) return;
      bestScore = s;
      best = el;
      bestUnder = under;
    }

    const imgs = document.images;
    for (let i = 0; i < imgs.length; i++) consider(imgs[i]);

    // 背景图 / shadow DOM 那一轮要翻全页、还要给每个元素算样式，很贵。
    // 所以把"哪些元素可能是候选"**存下来**（节流刷新），但每一帧都拿最新的
    // 鼠标位置给它们重新打分 —— 只缓存列表、不缓存分数。
    // 要是连打分也一起节流了，鼠标一移就会"目标还停在原地 / 干脆没有目标"。
    // 普通网页上 <img> 已经找到了，这一步根本不会执行。
    const now = Date.now();
    if (!best && (!fast || now - rescueBgAt > 400)) {
      rescueBgAt = now;
      rescueBgEls = [];
      const all = deepElements(document, 0);
      const cap = Math.min(all.length, 6000);
      for (let i = 0; i < cap; i++) {
        const el = all[i];
        if (el.tagName === 'IMG') {
          // shadow DOM 里的 <img> 不在 document.images 里，必须一起收着
          rescueBgEls.push(el);
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width < RESCUE_MIN || r.height < RESCUE_MIN) continue;  // 先粗筛，省掉大部分样式计算
        if (!bgUrl(el)) continue;
        rescueBgEls.push(el);
      }
    }
    for (let i = 0; i < rescueBgEls.length; i++) {
      const el = rescueBgEls[i];
      if (el.isConnected) consider(el);
    }

    // 只有"指针真的压在它上面"才算"用户指过"。
    // 别的场合不能污染这个信号，否则一次误判会被 +1e12 放大成永远甩不掉的目标。
    if (best && bestUnder) lastHovered = best;
    return best;
  }

  function targetStillUsable(img) {
    if (!img || !img.isConnected) return false;
    const r = img.getBoundingClientRect();
    // 用和 scan() 同一套判定，否则刚选中就又被判成"不可用"，来回抖
    if (!isCandidate(img, r)) return false;
    const area = rectArea(visibleRect(img, r));
    if (area < MIN_VISIBLE) return false;
    // 大半都被裁掉/滚出屏幕了，就别再当目标
    if (area < r.width * r.height * 0.25) return false;
    return true;
  }

  /** 鼠标是不是压在我们自己的按钮上（是的话别改目标） */
  function pointerOnButton() {
    if (pointerX < 0 || !btn) return false;
    const r = btn.getBoundingClientRect();
    return pointerX >= r.left && pointerX < r.right &&
           pointerY >= r.top && pointerY < r.bottom;
  }

  /** 虚线框只框住图片"真正露在屏幕里"的那块，图比屏幕大或被容器裁了都看得见 */
  function hideRing() {
    if (ring) ring.style.display = 'none';
  }

  function drawRing(img) {
    if (!settings.showRing) { hideRing(); return; }
    const v = visibleRect(img);
    if (v.width < 1 || v.height < 1) { hideRing(); return; }

    ensureRing();
    ring.style.left = v.left + 'px';
    ring.style.top = v.top + 'px';
    ring.style.width = v.width + 'px';
    ring.style.height = v.height + 'px';
    ring.style.display = 'block';
  }

  function refreshTarget() {
    queued = false;
    if (!btn) return;

    // 鼠标压在按钮上：保持当前目标，但也要确认它还看得见；
    // 轮播翻页后旧目标已被裁没了，这时候必须换到当前这张。
    if (pointerOnButton()) {
      if (!targetStillUsable(target)) target = pickLargestVisible();
    } else {
      // 先走正常筛选；它够不着的地方（CSS 背景图 / shadow DOM / 懒加载）交给兜底。
      // 这里只能用"只认鼠标正压着的那种"模式，不能退而求其次拿最大的充数。
      const hovered = pickAtPointer() || rescuePick(true, true);
      if (hovered) { target = hovered; lastHovered = hovered; }
      else if (!targetStillUsable(target)) target = pickLargestVisible();
    }

    // 兜底：上面那轮可能全军覆没 —— 比如扫描缓存里还是上一屏的图
    // （虚拟列表翻页会把旧节点回收掉，getBoundingClientRect 全变 0），
    // 或者刚好赶上新一屏还没被扫到。强制重扫一次再判断，
    // 别急着让用户"把鼠标移到图片上"。
    if (!target) {
      cache = [];
      cacheAt = 0;
      target = pointerOnButton() ? pickLargestVisible()
                                 : (pickAtPointer() || pickLargestVisible());
    }

    // 还是空的：走"兜底找图"。这条路不看 MIN_NATURAL / MIN_VISIBLE，
    // 只问一句"屏幕上到底有没有看得见的图"。上面所有筛选全落空时才会跑到这里。
    if (!target) target = rescuePick(true);

    if (!target) { hideRing(); return; }
    drawRing(target);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(refreshTarget);
  }

  /** 页面结构可能被脚本悄悄改了（轮播翻页），过一会儿再算一次 */
  function bump() {
    cacheAt = 0;
    schedule();
    setTimeout(() => { cacheAt = 0; schedule(); }, 250);
  }

  /* 滚动专用：比 bump() 温和一点。
   * 滚动事件一秒能来几十上百次，如果每次都 bump，等于每帧都要把全页图片
   * 重新过一遍（scan 里要读布局、visibleRect 里还要算裁剪祖先），滚动会发涩。
   * 所以缓存作废节流到 150ms 一次，另外在滚动停下来以后再补扫一次 ——
   * 保证"翻到底停下来"那一刻，环一定落在当前这一屏的图上。 */
  let scrollAt = 0;
  let scrollTimer = 0;
  function onScroll() {
    const now = Date.now();
    if (now - scrollAt > 150) { scrollAt = now; cacheAt = 0; }
    if (!scrollTimer) {
      scrollTimer = setTimeout(() => {
        scrollTimer = 0;
        cacheAt = 0;
        schedule();
      }, 180);
    }
    schedule();
  }

  function onMove(e) {
    pointerX = e.clientX;
    pointerY = e.clientY;
    schedule();
  }

  /* ==================== 取地址 ==================== */

  function absolutize(u) {
    if (!u) return '';
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    if (u.indexOf('//') === 0) return location.protocol + u;
    try { return new URL(u, location.href).href; } catch (_) { return ''; }
  }

  /** 1x1 占位图那种超短 data URL 不要 */
  function usable(u) {
    if (!u) return false;
    if (u.slice(0, 5).toLowerCase() === 'data:') return u.length > 1024;
    return true;
  }

  /** 依次尝试：srcset 最大候选 → currentSrc → 懒加载属性 → src */
  function bestUrl(img) {
    const candidates = [];

    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) {
      let best = null;
      let bestScore = -1;
      const parts = srcset.split(',');
      for (let i = 0; i < parts.length; i++) {
        const bits = parts[i].trim().split(/\s+/);
        const url = bits[0];
        if (!url) continue;
        const d = bits[1] || '';
        let score = 1;
        if (/^\d+w$/.test(d)) score = parseInt(d, 10);
        else if (/^[\d.]+x$/.test(d)) score = parseFloat(d) * 10000;
        if (score > bestScore) { bestScore = score; best = url; }
      }
      if (best) candidates.push(best);
    }

    if (img.currentSrc) candidates.push(img.currentSrc);

    const attrs = ['data-original', 'data-src', 'data-lazy-src', 'data-lazyload',
                   'data-actualsrc', 'data-objurl', 'data-image', 'data-url'];
    for (let i = 0; i < attrs.length; i++) {
      const v = img.getAttribute(attrs[i]);
      if (v) candidates.push(v);
    }

    if (img.src) candidates.push(img.src);

    for (let i = 0; i < candidates.length; i++) {
      const abs = absolutize(candidates[i]);
      if (usable(abs)) return abs;
    }
    return '';
  }

  function normExt(e) {
    e = String(e || '').toLowerCase();
    if (e === 'jpeg') return 'jpg';
    if (e === 'svg+xml') return 'svg';
    if (/^(jpg|png|gif|webp|bmp|avif|jfif|heic|tif|tiff|ico)$/.test(e)) return e;
    return 'jpg';
  }

  function extOf(url) {
    if (url.slice(0, 5).toLowerCase() === 'data:') {
      const m = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
      return m ? normExt(m[1]) : 'jpg';
    }
    let path = url;
    try { path = new URL(url, location.href).pathname; } catch (_) { /* 保持原样 */ }
    const m = /\.([a-z0-9]{2,5})$/i.exec(path);
    return m ? normExt(m[1]) : 'jpg';
  }

  /* ==================== 起名 ==================== */

  function pageTitle() {
    let t = (document.title || '').trim();
    // 去掉结尾的站点名，如 "租房空间小 - 抖音搜索" → "租房空间小"
    t = t.replace(
      /\s*[-|_–—·]+\s*(抖音|douyin|快手|kuaishou|小红书|xiaohongshu|哔哩哔哩|bilibili|微博|weibo|淘宝|天猫|京东|拼多多|1688|阿里巴巴)[^\s]{0,8}\s*$/i,
      ''
    );
    return t.trim();
  }

  function cleanBase(s) {
    s = String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ');
    s = s.replace(/[\\/:*?"<>|]/g, '_');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (s.length > 50) s = s.slice(0, 50).trim();
    return s || 'image';
  }

  function buildFilename(url) {
    seq += 1;
    const raw = pageTitle() || location.hostname.replace(/^www\./, '');
    const base = cleanBase(raw);
    const num = String(seq).padStart(2, '0');
    return base + '_' + num + '.' + extOf(url);
  }

  /* ==================== 下载 ==================== */

  function send(msg) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (v) => { if (!finished) { finished = true; resolve(v); } };
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) finish({ ok: false, error: err.message });
          else finish(res || { ok: false, error: '后台没有响应' });
        });
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }
      setTimeout(() => finish({ ok: false, error: '请求超时' }), 30000);
    });
  }

  function blobToDataURL(url) {
    return fetch(url)
      .then((r) => r.blob())
      .then((blob) => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('读取图片数据失败'));
        fr.readAsDataURL(blob);
      }));
  }

  /** 下载结束后把框闪一下：绿色=存好了，红色=失败。方便确认到底是哪张被下走了 */
  let flashTimer = 0;
  function flashRing(ok) {
    if (!settings.showRing) return;
    ensureRing();
    if (!ring) return;
    ring.style.borderColor = ok ? 'rgba(22,163,74,.95)' : 'rgba(220,38,38,.95)';
    ring.style.borderStyle = 'solid';
    ring.style.background = ok ? 'rgba(22,163,74,.12)' : 'rgba(220,38,38,.12)';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      ring.style.borderColor = 'rgba(37,99,235,.85)';
      ring.style.borderStyle = 'dashed';
      ring.style.background = 'transparent';
    }, 900);
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    refreshTarget();                    // 点之前按鼠标当前位置重算一次
    // refreshTarget 里已经跑过一次快速兜底了；这里放最后一道防线 ——
    // 连 shadow DOM 和 CSS 背景图一起翻。真到这一步还找不到，才认输。
    if (!target) target = rescuePick(false);
    if (!target) {
      const n = document.images.length;
      toast('把鼠标移到图片上，再点这里下载' +
            (n ? '（本页 ' + n + ' 张图，都不符合下载条件）' : '（本页没有找到图片）'), true);
      return;
    }

    const url = urlOf(target);
    if (!url) { toast('没能取到这张图片的地址', true); return; }

    const filename = buildFilename(url);
    btn.style.opacity = '.6';

    try {
      let payload = url;
      if (url.slice(0, 5).toLowerCase() === 'blob:') {
        payload = await blobToDataURL(url);
      }
      const res = await send({ type: 'imgdl:download', url: payload, filename });
      if (res && res.ok) { toast('已保存  ' + filename, false); flashRing(true); }
      else { toast('下载失败：' + ((res && res.error) || '未知错误'), true); flashRing(false); }
    } catch (err) {
      toast('下载失败：' + ((err && err.message) || err), true);
      flashRing(false);
    } finally {
      btn.style.opacity = '1';
    }
  }

  /* ==================== 收集整页图片（给弹窗用） ==================== */

  function collectAll() {
    const imgs = scan(true);
    const seen = Object.create(null);
    const found = [];

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      const r = img.getBoundingClientRect();
      if (r.width < MIN_RENDER || r.height < MIN_RENDER) continue;
      const url = bestUrl(img);
      if (!url || seen[url]) continue;
      seen[url] = true;
      found.push({ url: url, area: Math.round(r.width * r.height) });
    }

    found.sort((a, b) => b.area - a.area);
    return found.map((item) => ({ url: item.url, filename: buildFilename(item.url) }));
  }

  /* ==================== 启动 ==================== */

  function revealButton() {
    if (btn) btn.style.visibility = 'visible';
  }

  function init() {
    mount();                       // 先建出来（隐藏态），等设置读回来再定位显示
    schedule();
    watchSettings();
    loadSettings(() => { applyPosition(); revealButton(); });
    // storage 万一不回调，也别让按钮一直藏着
    setTimeout(() => { applyPosition(); revealButton(); }, 400);

    document.addEventListener('mousemove', onMove, { passive: true, capture: true });
    // 翻页 / 滚动之后新出现的图要立刻算进来。
    // 只调 schedule() 会一直沿用最多 800ms 的旧缓存，那期间新的一屏等于"不存在"。
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });
    // 轮播翻页 / 切 tab 这类操作只改 DOM、不发滚动事件，靠点击后补算一次兜住
    document.addEventListener('click', bump, { passive: true, capture: true });
    setInterval(() => { cacheAt = 0; schedule(); }, POLL_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ==================== 与弹窗通信 ==================== */

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'imgdl:collect') {
        try { respond({ ok: true, items: collectAll() }); }
        catch (err) { respond({ ok: false, error: String((err && err.message) || err) }); }
      }
    });
  }
})();
