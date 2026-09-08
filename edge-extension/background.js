/* 内容脚本跑在选课页面里，直接 fetch 大模型接口会被页面的同源策略挡掉。
 * 转到这里发：后台用的是扩展自己的权限（manifest 里的 host_permissions），不受页面 CORS 限制。
 *
 * 想换成 manifest 里没列的服务商，把它的域名加进 host_permissions，
 * 再到 edge://extensions/ 点一下本扩展的“刷新”。 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'szg-fetch') return;

  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, msg.timeout || 20000);

  fetch(msg.url, {
    method: 'POST',
    headers: msg.headers || {},
    body: msg.body,
    signal: ctl.signal
  }).then(function (r) {
    return r.text().then(function (text) { sendResponse({ status: r.status, text: text }); });
  }).catch(function (e) {
    var name = e && e.name;
    sendResponse({
      error: name === 'AbortError' ? '请求超时'
           : String((e && e.message) || e) + '（域名可能不在 manifest 的 host_permissions 里）'
    });
  }).then(function () { clearTimeout(timer); });

  return true;        // 告诉 Chrome 这是异步回包，别提前把 sendResponse 收走
});
