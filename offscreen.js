/* MV3 offscreen 文档 —— 视频下载的第二通道。
 *
 * 为什么要它：
 *   1) service worker 里**没有** URL.createObjectURL，拿不到 blob URL，也就没法
 *      把「已经取到内存的数据」交给 chrome.downloads；
 *   2) 从后台把视频以 ArrayBuffer 回传给页面又受消息大小限制。
 * 本页面是扩展页面（chrome-extension://），它的 fetch 属于「扩展请求」，
 * 受 manifest 的 host_permissions 保护 —— **不受 CORS 限制**，
 * 所以那些不返回 Access-Control-Allow-Origin 的 CDN 也能在这里读到数据。
 * 缺失的 Referer 由后台用 declarativeNetRequest 临时注入（对 xmlhttprequest 类型有效）。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "OFFSCREEN_DOWNLOAD") return;

    (async () => {
        try {
            const resp = await fetch(msg.url);
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const blob = await resp.blob();
            const u = URL.createObjectURL(blob);
            // 走 downloads.download 而不是 <a download>：这里支持 "子目录/文件名"，
            // 不会像 <a download> 那样把斜杠吃掉。
            await chrome.downloads.download({
                url: u,
                filename: msg.filename || "video.mp4",
                conflictAction: "uniquify",
                saveAs: false
            });
            setTimeout(() => URL.revokeObjectURL(u), 120000);
            sendResponse({ ok: true });
        } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
    })();

    return true;   // 异步响应
});
