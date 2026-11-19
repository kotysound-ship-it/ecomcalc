// 업데이트 모듈 단위 테스트: 버전 비교, 새 버전 확인, 아키텍처별 파일 선택, 무결성 검증, macOS 앱 교체 준비
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Updater = require('../src/updater');
const Mock = require('./mock-ai');

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('✅', name); };

(async () => {
  await t('버전 비교', () => {
    const c = Updater.compare;
    assert.strictEqual(c('1.3.0', '1.2.9'), 1);
    assert.strictEqual(c('1.10.0', '1.9.0'), 1);
    assert.strictEqual(c('v1.3.0', '1.3.0'), 0);
    assert.strictEqual(c('1.3.0-beta', '1.3.0'), -1);
    assert.strictEqual(c('1.2.0', '1.3.0'), -1);
  });

  const mock = await Mock.create();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-updtest-'));
  process.env.ECOM_UPDATE_URL = `http://127.0.0.1:${mock.port}/update`;
  const fakeApp = (version) => ({ isPackaged: true, getVersion: () => version, getPath: (k) => path.join(tmp, k) });

  await t('새 버전 있음 (macOS arm64 → arm64 zip 선택)', async () => {
    const u = Updater.create({ app: fakeApp('1.3.0'), platform: 'darwin', arch: 'arm64' });
    const r = await u.check();
    assert.strictEqual(r.available, true); assert.strictEqual(r.version, '9.9.0');
    assert.match(r.notesUrl, /releases\/tag\/v9\.9\.0$/);
    const req = mock.state.requests.at(-1); assert.strictEqual(req.path, '/update/latest-mac.yml');
  });
  await t('같은 버전이면 업데이트 없음', async () => {
    const r = await Updater.create({ app: fakeApp('9.9.0'), platform: 'darwin', arch: 'arm64' }).check();
    assert.strictEqual(r.available, false);
  });
  await t('개발 모드(패키징 안 됨) + 주소 미지정이면 확인 안 함', async () => {
    const saved = process.env.ECOM_UPDATE_URL; delete process.env.ECOM_UPDATE_URL;
    const r = await Updater.create({ app: { ...fakeApp('1.0.0'), isPackaged: false } }).check();
    process.env.ECOM_UPDATE_URL = saved;
    assert.strictEqual(r.disabled, true);
  });
  await t('릴리스 파일 없음(404)이면 조용히 업데이트 없음', async () => {
    const saved = process.env.ECOM_UPDATE_URL; process.env.ECOM_UPDATE_URL = `http://127.0.0.1:${mock.port}/nothing`;
    const r = await Updater.create({ app: fakeApp('1.0.0'), platform: 'darwin' }).check();
    process.env.ECOM_UPDATE_URL = saved;
    assert.strictEqual(r.available, false); assert.ok(!r.error);
  });
  await t('Windows: latest.yml의 exe 내려받기 + sha512 검증 + 진행률', async () => {
    process.env.ECOM_UPDATE_DRYRUN = '1';
    const u = Updater.create({ app: fakeApp('1.3.0'), platform: 'win32', arch: 'x64' });
    await u.check();
    const prog = [];
    const r = await u.downloadAndInstall((p) => prog.push(p));
    assert.strictEqual(r.dryRun, true); assert.match(r.installer, /EcomCalc-AI-Setup-9\.9\.0\.exe$/);
    assert.strictEqual(fs.statSync(r.installer).size, 300000);
    assert.strictEqual(prog.at(-1), 100);
    assert.ok(mock.state.requests.some((q) => q.path === '/update/latest.yml'));
  });
  await t('손상·변조된 파일은 거부하고 지움', async () => {
    mock.state.update.corrupt = true;
    const u = Updater.create({ app: fakeApp('1.3.0'), platform: 'win32', arch: 'x64' });
    await u.check();
    await assert.rejects(u.downloadAndInstall(), /손상되었거나 변조/);
    assert.ok(!fs.existsSync(path.join(tmp, 'temp', 'ecomcalc-update', '9.9.0')));
    mock.state.update.corrupt = false;
  });
  if (process.platform === 'darwin') {
    await t('macOS: zip 풀고 교체 대상 확인 (쓰기 가능한 위치)', async () => {
      const target = path.join(tmp, 'Applications', 'EcomCalc AI.app');
      fs.mkdirSync(target, { recursive: true });
      process.env.ECOM_UPDATE_TARGET = target;
      const u = Updater.create({ app: fakeApp('1.3.0'), platform: 'darwin', arch: 'x64' });
      await u.check();
      const r = await u.downloadAndInstall();
      assert.strictEqual(r.dryRun, true); assert.strictEqual(r.target, target);
      assert.match(fs.readFileSync(path.join(r.newApp, 'Contents', 'Info.plist'), 'utf8'), /9\.9\.0/);
      assert.ok(mock.state.requests.some((q) => q.path === '/update/EcomCalc-AI-9.9.0-mac.zip'), 'x64는 arm64가 아닌 zip');
    });
    await t('macOS: DMG에서 바로 실행 중이면 다운로드 폴더에 새 앱 준비 후 안내', async () => {
      process.env.ECOM_UPDATE_TARGET = '/Volumes/EcomCalc/EcomCalc AI.app';
      const u = Updater.create({ app: fakeApp('1.3.0'), platform: 'darwin', arch: 'arm64' });
      await u.check();
      const r = await u.downloadAndInstall();
      assert.strictEqual(r.manual, true); assert.strictEqual(r.reason, 'NOT_IN_APPLICATIONS');
      assert.ok(fs.existsSync(path.join(r.path, 'Contents', 'Info.plist')));
      assert.ok(r.path.startsWith(path.join(tmp, 'downloads')));
    });
  }
  mock.server.close();
  console.log(`\n업데이트 테스트 ${pass}개 통과`);
})().catch((e) => { console.error('❌', e); process.exit(1); });
