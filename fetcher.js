// 页面主世界脚本：所有需要 Referer 的网络操作都要在这里做。
// 内容脚本（隔离世界）和后台发出的请求都不带 Referer，会被抖音 CDN 判为盗链 403。

/** 把 Blob 存盘并向内容脚本回执 */
function saveBlobAndReply(blob, filename, rid, respType) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    // <a download> 无法创建子目录，把 / \ 换成 _ 让文件名可预期
    a.download = String(filename || "video.mp4").replace(/[\\/]+/g, "_");
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 120000);
    window.postMessage({ type: respType, rid: rid, ok: true }, "*");
}

window.addEventListener("message", async (event) => {
    const e = event.data;
    if (!e || !e.type) return;

    if (e.type === "FETCH_AWEME_DETAIL_REQ") {
        await fetch(e.data.url, { method: "GET" });
        return;
    }

    // 通道一：页面主世界直接 fetch（Referer 正常，最快、不额外占内存）
    if (e.type === "BLOB_DOWNLOAD_REQ") {
        const rid = e.rid;
        const url = e.data.url;
        const filename = e.data.filename;
        try {
            const resp = await fetch(url, { referrerPolicy: "unsafe-url", credentials: "omit" });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const blob = await resp.blob();
            saveBlobAndReply(blob, filename, rid, "BLOB_DOWNLOAD_RESP");
        } catch (err) {
            // 诊断：用 no-cors 探测区分「CORS 被阻止」和「网络/域名不可达」
            // 有些抖音 CDN 不返回 Access-Control-Allow-Origin，页面无权读取响应体，
            // 这种只能改由后台取数据（见 SAVE_BUFFER_REQ）。
            let hint = "";
            try {
                await fetch(url, { mode: "no-cors", credentials: "omit" });
                hint = "（no-cors 可达 → 属 CORS 限制）";
            } catch (e2) {
                hint = "（no-cors 不可达 → 网络或域名问题）";
            }
            window.postMessage({
                type: "BLOB_DOWNLOAD_RESP",
                rid: rid,
                ok: false,
                error: String((err && err.message) || err) + hint
            }, "*");
        }
        return;
    }

    // 通道二（后台兜底）：后台已用 host_permissions 绕开 CORS 取到数据，这里只负责存盘
    if (e.type === "SAVE_BUFFER_REQ") {
        const rid = e.rid;
        try {
            const blob = new Blob([e.data.buf]);
            saveBlobAndReply(blob, e.data.filename, rid, "SAVE_BUFFER_RESP");
        } catch (err) {
            window.postMessage({
                type: "SAVE_BUFFER_RESP",
                rid: rid,
                ok: false,
                error: String((err && err.message) || err)
            }, "*");
        }
        return;
    }
});
