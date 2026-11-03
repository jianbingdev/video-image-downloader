/* 极简 ZIP 读取器 —— 只干一件事：把 GitHub 的 zipball 解成文件列表。
 *
 * 为什么不用第三方库：MV3 不允许远程代码，本地也不想为一个功能塞进 jszip（100KB+）。
 * 浏览器自带 DecompressionStream('deflate-raw')，所以只需要自己解析 ZIP 结构。
 *
 * 支持范围：store(0) 和 deflate(8)，不支持加密、不支持 zip64。
 * GitHub zipball 完全落在这个范围内（仓库 2MB 级，远不到 4GB 的 zip64 门槛）。
 */

window.MiniZip = (function () {
  'use strict';

  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;

  /** 从末尾倒着找 EOCD（注释最长 65535，所以最多回退 22+65535） */
  function findEocd(view, total) {
    const minPos = Math.max(0, total - 22 - 65535);
    for (let i = total - 22; i >= minPos; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  /** 读中央目录，返回条目元数据 */
  function readCentralDirectory(view, u8, eocd) {
    const count = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const entries = [];
    let p = cdOffset;

    for (let i = 0; i < count; i++) {
      if (p + 46 > view.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error('ZIP 中央目录损坏（第 ' + (i + 1) + ' 项）');
      }
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const uncompSize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));

      entries.push({ name, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /** 取某条目的原始压缩数据（跳过本地头） */
  function sliceEntryData(view, u8, entry) {
    const p = entry.localOffset;
    if (p + 30 > view.byteLength || view.getUint32(p, true) !== SIG_LOCAL) {
      throw new Error('ZIP 本地文件头损坏：' + entry.name);
    }
    const nameLen = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);
    const start = p + 30 + nameLen + extraLen;
    return u8.subarray(start, start + entry.compSize);
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * 解压整个 zip。
   * @param {ArrayBuffer} buffer
   * @returns {Promise<Array<{path: string, data: Uint8Array}>>}
   */
  async function unzip(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const eocd = findEocd(view, buffer.byteLength);
    if (eocd < 0) throw new Error('不是有效的 ZIP（找不到目录结束标记）');

    const entries = readCentralDirectory(view, u8, eocd);
    const files = [];

    for (const entry of entries) {
      // 目录条目（名字以 / 结尾）直接跳过，写文件时会按路径自动建目录
      if (entry.name.endsWith('/')) continue;
      const raw = sliceEntryData(view, u8, entry);

      let data;
      if (entry.method === 0) {
        data = raw.slice();
      } else if (entry.method === 8) {
        data = await inflateRaw(raw);
      } else {
        throw new Error('不支持的压缩方式 ' + entry.method + '：' + entry.name);
      }

      if (entry.uncompSize && data.length !== entry.uncompSize) {
        throw new Error('解压后大小不符：' + entry.name + '（期望 ' + entry.uncompSize + '，实际 ' + data.length + '）');
      }

      files.push({ path: entry.name, data });
    }

    return files;
  }

  /** GitHub zipball 多包一层 `repo-hash/`，统一剥掉 */
  function stripCommonRoot(files) {
    if (!files.length) return files;
    const first = files[0].path.split('/')[0];
    if (!first) return files;
    const allShare = files.every((f) => f.path.startsWith(first + '/'));
    if (!allShare) return files;
    return files.map((f) => ({ path: f.path.slice(first.length + 1), data: f.data })).filter((f) => f.path);
  }

  return { unzip, stripCommonRoot };
})();
