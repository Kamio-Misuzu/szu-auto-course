/* 把主脚本同步到 Edge 扩展和离线 demo，避免几份代码各改各的。
 * 用法： node build.js  */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const src = fs.readFileSync(path.join(root, 'szu-auto-course.user.js'), 'utf8');

// 1) Edge / Chrome 扩展的内容脚本
fs.mkdirSync(path.join(root, 'edge-extension'), { recursive: true });
fs.writeFileSync(path.join(root, 'edge-extension', 'content.js'), src, 'utf8');

// 2) 离线仿真页：把脚本内联进去，双击就能跑
//    demo.html       = 选课列表，测抢课主流程
//    login-demo.html = 登录页，测掉线自动重登 + 验证码识别（那边的大模型接口是假的）
const demos = ['demo.html', 'login-demo.html'];
const synced = ['edge-extension/content.js'];
demos.forEach(function (name) {
  const p = path.join(root, 'test', name);
  if (!fs.existsSync(p)) return;
  let html = fs.readFileSync(p, 'utf8');
  const start = html.indexOf('<!--SCRIPT-->');
  if (start < 0) { console.warn(name + ' 里没有 <!--SCRIPT--> 标记，跳过'); return; }
  html = html.slice(0, start) + '<!--SCRIPT-->\n<script>\n' + src + '\n</scr' + 'ipt>\n</body>\n</html>\n';
  fs.writeFileSync(p, html, 'utf8');
  synced.push('test/' + name);
});

console.log('已同步：' + synced.join('、'));
