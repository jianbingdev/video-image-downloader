/* 合并版的后台入口。
 *
 * MV3 的 service worker 在**非 module 模式**下支持 importScripts()，
 * 所以这里直接把两边的后台原样串起来，两边的代码一行都不用改：
 *
 *   background.js        视频下载（WXT 打包出来的 IIFE，不依赖任何模块）
 *   imgdl/background.js  图片下载
 *
 * 两边各自注册自己的 chrome.runtime.onMessage 监听器，互不干扰：
 *   - 视频那边只认 DOWNLOAD_VIDEO_REQ / ERROR_FIND_VID_REQ
 *   - 图片这边只认 imgdl:download / imgdl:downloadMany
 * 收到不认识的消息各自直接返回，不会抢答。
 *
 * 注意：importScripts 必须顶层同步调用，不能放进回调或 await 后面。
 */
importScripts('background.js', 'imgdl/background.js');
