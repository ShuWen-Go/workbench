// 把两个作品的「项目根」同步进 app/link、app/voice
//
// 为什么要有这一步：
//   发布打的是**一个目录**，但两个作品是**两个独立仓库**。
//   所以 app/link、app/voice 明确定义为**生成物** —— 每次发布前重新生成（整目录覆盖）。
//   这样一来就不会出现「改了一个仓库、发布用的是另一个版本」的漂移。
//
// 开发分工：功能与界面改在各自原项目里（体验完全不变），改完跑一次本脚本即可。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const appDir = path.join(root, 'app');

const JOBS = [
  { label: '链藏', from: 'D:/VibeCoding/link-vault', to: path.join(appDir, 'link') },
  { label: '听藏', from: 'D:/VibeCoding/voice-vault', to: path.join(appDir, 'voice') },
];

// 这些不进发布包
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', 'Thumbs.db']);

// 同步进来的 .env 是「本地开发版」，里面有的路径在云端并不存在。
// 这里统一改写成「云端就绪」版 —— 否则每次发布前都得手工改，而下次同步又会覆盖回去。
//   注释掉 VV_DATA_DIR → 云端改用项目内 data/（演示数据就放那儿，随包上云）
//   VV_PYTHON=python3  → 沙箱里没有本地的隔离 venv
//   清空 VV_MODEL_DIR  → 沙箱里没有那 1.5GB 模型
const CLOUD_ENV_OVERRIDE = { VV_DATA_DIR: null, VV_PYTHON: 'python3', VV_MODEL_DIR: '' };

function adaptEnvForCloud(dir) {
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return 0;
  let touched = 0;
  const out = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((line) => {
    const m = /^\s*([A-Z_0-9]+)\s*=/.exec(line);
    if (!m || !(m[1] in CLOUD_ENV_OVERRIDE)) return line;
    touched += 1;
    const key = m[1];
    return CLOUD_ENV_OVERRIDE[key] === null
      ? `# ${key} 云端不适用（发布版改用项目内 data/）`
      : `${key}=${CLOUD_ENV_OVERRIDE[key]}`;
  }).join('\n');
  if (touched) fs.writeFileSync(p, out, 'utf8');
  return touched;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) {
      const r = copyDir(s, d);
      files += r.files;
      bytes += r.bytes;
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
      files += 1;
      bytes += fs.statSync(s).size;
    }
  }
  return { files, bytes };
}

let ok = 0;
for (const job of JOBS) {
  if (!fs.existsSync(job.from)) {
    console.log(`⚠️  ${job.label}：源目录不存在，跳过 —— ${job.from}`);
    continue;
  }
  fs.rmSync(job.to, { recursive: true, force: true }); // 先清空 ⇒ 保证是"重新生成"，不是叠加
  const r = copyDir(job.from, job.to);
  const fixed = adaptEnvForCloud(job.to);
  console.log(`✅ ${job.label}：${r.files} 个文件 / ${(r.bytes / 1024 / 1024).toFixed(1)} MB  →  ${job.to}` +
    (fixed ? `（云端配置已适配 ${fixed} 项）` : ''));
  ok += 1;
}

console.log(ok ? '\n同步完成 —— app/link、app/voice 是生成物，别直接在上面改。' : '\n没有同步任何作品。');
