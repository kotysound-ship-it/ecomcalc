// GitHub Releases 기반 자동 업데이트
//  - 릴리스에 올라간 latest.yml(Windows) / latest-mac.yml(macOS)로 새 버전 확인
//  - 설치 파일을 받아 sha512로 무결성 검증 후 설치
//  - macOS: 서명 인증서 없이도 동작하도록 앱 번들을 직접 교체 후 재실행
//  - Windows: NSIS 설치 파일을 조용히(/S) 실행 → 설치 후 자동 재실행
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const yaml = require('js-yaml');

const REPO = 'kotysound-ship-it/ecomcalc';
const DEFAULT_BASE = `https://github.com/${REPO}/releases/latest/download`;
const releasePage = (v) => `https://github.com/${REPO}/releases/${v ? 'tag/v' + v : 'latest'}`;

// "1.10.0" > "1.9.3", 프리릴리스(1.3.0-beta)는 정식보다 낮게
function compare(a, b) {
  const parse = (v) => { const [main, pre] = String(v).replace(/^v/, '').split('-'); return { n: main.split('.').map((x) => parseInt(x, 10) || 0), pre }; };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) { const d = (A.n[i] || 0) - (B.n[i] || 0); if (d) return d > 0 ? 1 : -1; }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  return A.pre === B.pre ? 0 : (A.pre > B.pre ? 1 : -1);
}

function create({ app, platform = process.platform, arch = process.arch }) {
  const base = () => (process.env.ECOM_UPDATE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const enabled = () => app.isPackaged || !!process.env.ECOM_UPDATE_URL;
  const IS_MAC = platform === 'darwin';
  let found = null; // { version, file:{url,sha512,size} }
  let busy = false;

  async function fetchText(url) {
    const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return null; // 아직 릴리스가 없거나 해당 OS 파일이 업로드 전
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  function pickFile(info) {
    const files = Array.isArray(info.files) ? info.files : [];
    if (IS_MAC) {
      const zips = files.filter((f) => /\.zip$/i.test(f.url));
      const isArm = (f) => /arm64/i.test(f.url);
      return zips.find((f) => (arch === 'arm64' ? isArm(f) : !isArm(f))) || null;
    }
    return files.find((f) => /\.exe$/i.test(f.url)) || null;
  }

  async function check() {
    const current = app.getVersion();
    if (!enabled()) return { available: false, current, disabled: true };
    const text = await fetchText(`${base()}/${IS_MAC ? 'latest-mac.yml' : 'latest.yml'}`);
    if (!text) return { available: false, current };
    const info = yaml.load(text) || {};
    const file = pickFile(info);
    if (!info.version || !file || !file.sha512) return { available: false, current };
    if (compare(info.version, current) <= 0) return { available: false, current, latest: info.version };
    found = { version: String(info.version), file };
    return { available: true, current, version: found.version, notesUrl: releasePage(found.version), size: file.size || 0 };
  }

  // 내려받기 + sha512 검증. 진행률은 onProgress(0~100)
  async function download(onProgress) {
    if (!found) throw new Error('먼저 업데이트를 확인해 주세요.');
    const { file, version } = found;
    const dir = path.join(app.getPath('temp'), 'ecomcalc-update', version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(decodeURIComponent(file.url.split('?')[0]));
    const dest = path.join(dir, name);
    const url = /^https?:\/\//.test(file.url) ? file.url : `${base()}/${file.url}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`다운로드 실패 (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || file.size || 0;
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(dest);
    let got = 0, last = -1;
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      got += chunk.length;
      const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0;
      if (pct !== last) { last = pct; onProgress && onProgress(pct); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (hash.digest('base64') !== file.sha512) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('내려받은 파일이 손상되었거나 변조되었습니다. 잠시 후 다시 시도해 주세요.');
    }
    return { dir, file: dest, version };
  }

  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(so))));

  // 현재 실행 중인 .app 경로 (…/EcomCalc AI.app/Contents/MacOS/EcomCalc AI)
  function macBundle() {
    const p = path.resolve(app.getPath('exe'), '..', '..', '..');
    return p.endsWith('.app') ? p : null;
  }
  function canReplace(bundle) {
    if (!bundle) return false;
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return false; // DMG에서 바로 실행 / 격리 실행
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); return true; } catch { return false; }
  }

  // 설치. 반환: { restarting:true } | { manual:true, path, reason }
  async function install(dl) {
    if (IS_MAC) {
      const extractDir = path.join(dl.dir, 'app');
      fs.mkdirSync(extractDir, { recursive: true });
      await run('/usr/bin/ditto', ['-x', '-k', dl.file, extractDir]);
      const appName = fs.readdirSync(extractDir).find((n) => n.endsWith('.app'));
      if (!appName || !fs.existsSync(path.join(extractDir, appName, 'Contents', 'Info.plist'))) throw new Error('업데이트 파일에서 앱을 찾지 못했습니다.');
      const newApp = path.join(extractDir, appName);
      const target = process.env.ECOM_UPDATE_TARGET || macBundle();
      if (!canReplace(target)) {
        // 응용 프로그램 폴더 밖(DMG 등)에서 실행 중이거나 쓰기 권한이 없음 → 다운로드 폴더에 새 앱을 놓고 안내
        const manualDir = path.join(app.getPath('downloads'), `EcomCalc AI ${dl.version}`);
        fs.rmSync(manualDir, { recursive: true, force: true });
        fs.mkdirSync(manualDir, { recursive: true });
        await run('/usr/bin/ditto', [newApp, path.join(manualDir, appName)]);
        const reason = target && (target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) ? 'NOT_IN_APPLICATIONS' : 'NO_PERMISSION';
        return { manual: true, path: path.join(manualDir, appName), reason };
      }
      if (process.env.ECOM_UPDATE_DRYRUN) return { dryRun: true, newApp, target };
      // 앱 종료를 기다렸다가 교체 → 실패하면 원래 앱 복구 → 재실행
      const script = path.join(dl.dir, 'swap.sh');
      fs.writeFileSync(script, [
        '#!/bin/bash',
        'PID="$1"; NEW="$2"; TARGET="$3"; BACKUP="$TARGET.updating-old"',
        'for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
        'rm -rf "$BACKUP"',
        'if mv "$TARGET" "$BACKUP"; then',
        '  if /usr/bin/ditto "$NEW" "$TARGET"; then rm -rf "$BACKUP"; else rm -rf "$TARGET"; mv "$BACKUP" "$TARGET"; fi',
        'fi',
        'open "$TARGET"',
        'rm -rf "$(dirname "$NEW")"',
      ].join('\n'), { mode: 0o755 });
      spawn('/bin/bash', [script, String(process.pid), newApp, target], { detached: true, stdio: 'ignore' }).unref();
      return { restarting: true };
    }
    if (process.env.ECOM_UPDATE_DRYRUN) return { dryRun: true, installer: dl.file };
    // Windows: 기존 설치 위치에 조용히 설치하고 끝나면 앱 다시 실행
    spawn(dl.file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    return { restarting: true };
  }

  async function downloadAndInstall(onProgress) {
    if (busy) throw new Error('이미 업데이트를 진행 중입니다.');
    busy = true;
    try { return await install(await download(onProgress)); } finally { busy = false; }
  }

  return { check, downloadAndInstall, releasePage };
}

module.exports = { create, compare, releasePage, REPO };
