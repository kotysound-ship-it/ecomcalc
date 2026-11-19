// E2E 실행기: 임시 프로필로 앱을 띄우고 test/e2e.js 시나리오 결과를 출력
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecomcalc-e2e-'));
const userData = path.join(tmp, 'profile');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ledgerPath: path.join(tmp, '장부.xlsx') }));
const out = path.join(tmp, 'results.json');
const shots = process.env.E2E_SHOTS || tmp;
const electron = require('electron');
const env = { ...process.env, ECOM_USERDATA: userData, ECOM_E2E: path.join(__dirname, 'e2e.js'), ECOM_E2E_OUT: out, ECOM_E2E_SHOTS: shots, ECOM_EXPORT_PATH: path.join(tmp, '내보내기.xlsx') };
delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.GEMINI_API_KEY;
spawnSync(electron, [root], { env, stdio: 'ignore', timeout: 240000 });
if (!fs.existsSync(out)) { console.error('E2E 결과 없음 (앱이 비정상 종료)'); process.exit(1); }
const results = JSON.parse(fs.readFileSync(out, 'utf8'));
let fail = 0;
for (const r of results) { if (!r.ok) fail++; console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`); }
console.log(`\n${results.length - fail}/${results.length} 통과 · 스크린샷: ${shots}`);
process.exit(fail ? 1 : 0);
