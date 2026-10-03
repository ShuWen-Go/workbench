// AI 工作台 · 总服务（单端口，挂三个东西）
//
//   /            → 工作台首页（本目录的 index.html）
//   /link/*      → 链藏（子进程 @3001）—— 云端真跑
//   /voice/*     → 听藏（子进程 @3002）—— 演示模式
//
// 为什么用「子进程 + 反向代理」，而不是把两个服务合并进一个进程：
//   1) 两个作品保持**完全独立** —— 各自仓库照常开发、照常本地跑（node app/server.mjs → :3000），
//      改一个不会碰到另一个，也不会碰到 hub
//   2) 以后加第三个作品 = 加一条规则 + 一个子进程，不用改造已有作品
// 代价：发布目录里是两个作品的副本 —— 由 scripts/sync.mjs 从各自仓库**重新生成**（副本即产物）
//
// 鉴权统一做在这一层：子应用收到 VV_ACCESS_TOKEN=''（见 startApp），
// 否则代理转发时没带口令，会被子应用自己 401 掉。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));   // .../workbench/app/
const root = fileURLToPath(new URL('../', import.meta.url));  // .../workbench/

// ===== 读 .env（优先级：系统环境变量 > .env 文件 > 默认值）=====
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
let fileEnv = {};
try { fileEnv = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')); } catch { /* 没有就全用默认 */ }
const pick = (k, d) => process.env[k] ?? fileEnv[k] ?? d;

const PORT = Number(pick('PORT', '3000')) || 3000;
const ACCESS_TOKEN = pick('VV_ACCESS_TOKEN', '');
const RATE_LIMIT_PER_MIN = Math.max(0, Number(pick('VV_RATE_LIMIT_PER_MIN', '0')) || 0);

// ===== 子应用清单（加新作品 = 在这里加一行）=====
const APPS = [
  { key: 'link',  prefix: '/link',  label: '链藏', port: Number(pick('LINK_PORT', '3001')) || 3001,
    dir: path.join(here, 'link'),  entry: 'app/server.mjs' },
  { key: 'voice', prefix: '/voice', label: '听藏', port: Number(pick('VOICE_PORT', '3002')) || 3002,
    dir: path.join(here, 'voice'), entry: 'app/server.mjs' },
];

// ===== 起子进程 =====
const children = new Map();
function startApp(app, attempt = 0) {
  const entry = path.join(app.dir, app.entry);
  if (!fs.existsSync(entry)) {
    console.warn(`[hub] ${app.label}：入口不存在，跳过 —— ${entry}`);
    console.warn('[hub] 请先执行 node scripts/sync.mjs 把作品同步进来');
    return;
  }
  const child = spawn(process.execPath, [entry], {
    cwd: app.dir,
    env: {
      ...process.env,
      PORT: String(app.port),
      VV_ACCESS_TOKEN: '', // 子应用不鉴权，口令统一在 hub 层
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(app.key, child);
  const tag = `[${app.label}] `;
  child.stdout.on('data', (d) => process.stdout.write(tag + String(d)));
  child.stderr.on('data', (d) => process.stderr.write(tag + String(d)));
  child.on('exit', (code) => {
    children.delete(app.key);
    if (code === 0) return;
    console.error(`[hub] ${app.label} 退出（code=${code}）`);
    if (attempt < 3) {
      console.error(`[hub] ${app.label} 将在 2s 后重启（第 ${attempt + 1} 次）`);
      setTimeout(() => startApp(app, attempt + 1), 2000);
    }
  });
  console.log(`[hub] ${app.label} → 127.0.0.1:${app.port}`);
}

// ===== 访问控制 =====
// 四条通道，**不用 Authorization**：云端网关会把那个头剥掉（实测踩过）。
//   ① Cookie hub_token ② Cookie vv_token（旧版听藏留下的，兼容，别让老浏览器撞死墙）
//   ③ 请求头 X-VV-Token ④ URL 查询 ?token=
// 未配置口令 = 完全不启用（本地开发无感）。
const COOKIE_NAMES = ['hub_token', 'vv_token'];
const UNLOCK_PATH = '/__unlock';

function readCookieToken(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(String(req.headers.cookie || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

function cookieHeader(token, maxAge = 2592000) {
  return `hub_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// 只允许跳回本站路径，避免被当成开放重定向
function safeNext(raw) {
  const s = String(raw || '');
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
}

function readBody(req, limit = 2048) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// 登录页：不再只留一句"请用带口令的链接打开"（实测这就是个死胡同 ——
// 裸域名进来的人、以及浏览器里只有旧 cookie 的人，都卡在这里出不去）
function renderUnlock(res, { error = '', next = '/' } = {}) {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>需要访问口令</title>
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:380px;margin:14vh auto;padding:0 24px;line-height:1.9;color:#1b1b1f">
  <h2 style="margin:0 0 6px">需要访问口令</h2>
  <p style="color:#777;margin:0 0 20px;font-size:14px">这是一个私人工作台，输入口令后浏览器会记住。</p>
  ${error ? `<p style="color:#b4232a;font-size:14px;margin:0 0 12px">${error}</p>` : ''}
  <form method="POST" action="${UNLOCK_PATH}" style="display:flex;gap:8px">
    <input type="hidden" name="next" value="${String(next).replace(/"/g, '&quot;')}">
    <input name="token" type="password" autofocus autocomplete="current-password"
           placeholder="访问口令" style="flex:1;padding:10px 12px;font-size:15px;border:1px solid #d8d8e0;border-radius:8px">
    <button type="submit" style="padding:10px 18px;font-size:15px;border:0;border-radius:8px;background:#C00000;color:#fff;cursor:pointer">进入</button>
  </form>
  <p style="color:#aaa;font-size:12.5px;margin-top:18px">也可以直接用带口令的链接：<code>?token=你的口令</code></p>
</div>`);
}

function checkAuth(req, res) {
  if (!ACCESS_TOKEN) return true;
  if (req.headers['x-vv-token'] === ACCESS_TOKEN) return true;
  for (const name of COOKIE_NAMES) {
    if (readCookieToken(req, name) === ACCESS_TOKEN) return true;
  }

  let url = null;
  try { url = new URL(req.url, 'http://localhost'); } catch { /* 畸形 URL */ }
  if (url && url.searchParams.get('token') === ACCESS_TOKEN) {
    const cookie = cookieHeader(ACCESS_TOKEN);
    if (String(req.headers.accept || '').includes('text/html')) {
      url.searchParams.delete('token');
      const qs = url.searchParams.toString();
      res.writeHead(302, { 'Set-Cookie': cookie, Location: url.pathname + (qs ? '?' + qs : '') });
      res.end();
    } else {
      res.setHeader('Set-Cookie', cookie);
      return true;
    }
    return false;
  }

  renderUnlock(res, { next: url ? url.pathname : '/' });
  return false;
}

// ===== 限流（全局计数，不按 IP：反代后 clientIp 每请求都可能不同）=====
const rateWindow = [];
function rateLimited(req, res) {
  if (!RATE_LIMIT_PER_MIN) return false;
  const now = Date.now();
  while (rateWindow.length && now - rateWindow[0] > 60000) rateWindow.shift();
  if (rateWindow.length >= RATE_LIMIT_PER_MIN) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `请求太频繁，请稍后再试（每分钟最多 ${RATE_LIMIT_PER_MIN} 次）` }));
    return true;
  }
  rateWindow.push(now);
  return false;
}

// 口令尝试单独限流：全局计数（反代后 per-IP 无意义），分钟级封顶，防暴力猜
const unlockWindow = [];
const UNLOCK_PER_MIN = 10;
function unlockLimited(res) {
  const now = Date.now();
  while (unlockWindow.length && now - unlockWindow[0] > 60000) unlockWindow.shift();
  if (unlockWindow.length >= UNLOCK_PER_MIN) {
    res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta charset="utf-8"><p style="font-family:system-ui;padding:48px">尝试太频繁，请稍后再试。</p>');
    return true;
  }
  unlockWindow.push(now);
  return false;
}

// ===== 反向代理 =====
function proxyTo(app, req, res) {
  const rest = req.url.slice(app.prefix.length) || '/';
  const up = http.request(
    {
      host: '127.0.0.1',
      port: app.port,
      method: req.method,
      path: rest,
      headers: { ...req.headers, host: `127.0.0.1:${app.port}` },
    },
    (pr) => {
      const h = { ...pr.headers };
      delete h['transfer-encoding']; // 长度交给 Node 自己算，避免和 chunked 冲突
      delete h['connection'];
      res.writeHead(pr.statusCode || 502, h);
      pr.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta charset="utf-8"><div style="font-family:system-ui;padding:44px;line-height:1.9">' +
      `<h2>${app.label} 暂时不可用</h2>` +
      '<p>子服务可能正在启动，或启动失败（可看服务端日志）。刷新试试。</p></div>');
  });
  req.pipe(up);
}

// ===== 工作台自己的静态文件 =====
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};
function serveStatic(req, res, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Request'); return;
  }
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(here, rel);
  if (!file.startsWith(here)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

// ===== 主服务 =====
const server = http.createServer(async (req, res) => {
  const pathname0 = (req.url || '/').split('?')[0];

  // 口令登录：必须在鉴权之前处理 —— 它本身就是"怎么拿到凭据"
  if (pathname0 === UNLOCK_PATH) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('请用表单提交');
      return;
    }
    if (unlockLimited(res)) return;
    const form = new URLSearchParams(await readBody(req));
    const token = form.get('token') || '';
    if (ACCESS_TOKEN && token === ACCESS_TOKEN) {
      res.writeHead(302, { 'Set-Cookie': cookieHeader(ACCESS_TOKEN), Location: safeNext(form.get('next')) });
      res.end();
    } else {
      console.log('[hub] 口令尝试失败');
      renderUnlock(res, { error: '口令不对，再试一次。', next: safeNext(form.get('next')) });
    }
    return;
  }

  if (!checkAuth(req, res)) return;

  // 只对「提交类」POST 限流；GET（轮询、静态）一律放行
  if (req.method === 'POST' && rateLimited(req, res)) return;

  const urlPath = (req.url || '/').split('?')[0];

  for (const app of APPS) {
    if (urlPath === app.prefix) {
      // 补尾斜杠 —— 否则子页面里的相对路径（api/xxx）会解析到工作台根
      const qs = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
      res.writeHead(302, { Location: app.prefix + '/' + qs });
      res.end();
      return;
    }
    if (urlPath.startsWith(app.prefix + '/')) { proxyTo(app, req, res); return; }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '不支持的请求方法' }));
    return;
  }
  serveStatic(req, res, urlPath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI 工作台已启动：http://localhost:${PORT}`);
  console.log('  首页   /');
  for (const app of APPS) console.log(`  ${app.label}   ${app.prefix}/  →  子服务 127.0.0.1:${app.port}`);
  console.log(`  口令   ${ACCESS_TOKEN ? '已启用' : '未启用（本地开发免登录）'}`);
  for (const app of APPS) startApp(app);
});

// 收到退出信号时收拾子进程，别留孤儿
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of children.values()) { try { c.kill(); } catch { /* 已退出 */ } }
    process.exit(0);
  });
}
