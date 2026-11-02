// dsc.js 훅 정적 검증 — node:test + node:fs.
// plugins/dsh-tts/package.json 의 모듈 타입(ESM/CJS)이 아직 없거나 바뀌어도 돌도록,
// 내장 모듈은 process.getBuiltinModule 로 동기 로드하고 이 파일 경로는 process.argv[1] 로 찾는다.
const { test } = process.getBuiltinModule("node:test");
const assert = process.getBuiltinModule("node:assert/strict");
const fs = process.getBuiltinModule("node:fs");
const os = process.getBuiltinModule("node:os");
const path = process.getBuiltinModule("node:path");
const { spawnSync } = process.getBuiltinModule("node:child_process");

const HERE = path.dirname(path.resolve(process.argv[1] || "plugins/dsh-tts/test/dsc-hooks.test.js"));
const DSC_JS = path.resolve(
  HERE,
  "../../../harness/overlay/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/dsc/dsc.js",
);
const SRC = fs.readFileSync(DSC_JS, "utf8");

test("dsc.js 존재 + dsc:say CustomEvent 동기 디스패치", () => {
  assert.ok(SRC.length > 1000, "dsc.js 를 읽었다");
  assert.ok(SRC.includes('"dsc:say"'), "dsc:say 이벤트 이름");
  assert.ok(SRC.includes("CustomEvent"), "CustomEvent 사용");
  assert.match(
    SRC,
    /window\.dispatchEvent\(new CustomEvent\("dsc:say", \{ detail: \{ text, ms, kind \} \}\)\)/,
    "detail: { text, ms, kind } 로 동기 디스패치",
  );
  assert.match(
    SRC,
    /kind = kind \|\| \(mutter \? "mutter" : "other"\);/,
    "kind 기본값 처리(other/mutter)",
  );
});

test("호출지 kind 태깅: TEXT 5곳 reaction, TOOLS 1곳 status", () => {
  const tagged = [
    'say(TEXT.hello, 5800, false, "reaction")',
    'say(TEXT[kind], 0, false, "reaction")',
    'say(TEXT.start, 2500, false, "reaction")',
    'say(TEXT.error, 5000, false, "reaction")',
    'say(TEXT.done, 4000, false, "reaction")',
    'say(text, 0, false, "status")',
  ];
  for (const s of tagged) assert.ok(SRC.includes(s), "호출지 누락: " + s);
  assert.equal((SRC.match(/"reaction"/g) || []).length, 5, "reaction 태그 5개");
  assert.equal((SRC.match(/"status"/g) || []).length, 1, "status 태그 1개");
  // 그대로 둔 호출지: 터치 반응 = other, 혼잣말 = mutter
  assert.ok(SRC.includes("say(text, ms);"), "터치 반응 호출지는 인자 그대로");
  assert.match(
    SRC,
    /say\(line, Math\.min\(5200, Math\.max\(3800, 1500 \+ line\.length \* 55\)\), true\);/,
    "혼잣말 호출지는 mutter=true 그대로",
  );
});

test("__dsc.voice 훅 + lines 매니페스트", () => {
  assert.ok(SRC.includes("__dsc"), "window.__dsc");
  assert.ok(SRC.includes("voice:"), "voice 훅");
  assert.ok(SRC.includes("lines: TEXT"), "lines 매니페스트");
  assert.match(
    SRC,
    /voice: \(s\) => \{ voiceState = s && s\.speaking !== false \? s : null; \}/,
    "voice(s) 구현",
  );
  assert.ok((SRC.match(/voiceState = null/g) || []).length >= 2, "voiceState 선언/만료 정리");
});

test("렌더 루프: voiceState 만료 + talking/open/모음 오버라이드", () => {
  assert.match(SRC, /let voiceState = null;/, "voiceState 선언");
  assert.match(
    SRC,
    /if \(voiceState && voiceState\.until && now > voiceState\.until\) voiceState = null;/,
    "until 만료 시 null",
  );
  assert.match(
    SRC,
    /const talking = \(voiceState\?\.speaking === true\) \|\| \(bubble\.classList\.contains\("show"\) && fleeX === 0\);/,
    "talking = 음성 재생 중 또는 말풍선 표시 중",
  );
  assert.match(SRC, /open = clamp\(voiceState\.level, 0, 1\) \* 0\.9;/, "level → open 덮어쓰기");
  assert.match(
    SRC,
    /for \(const k of VOW\) vowel\[k\] = Math\.max\(vowel\[k\] \* 0\.4, clamp\(voiceState\.vowels\[k\] \|\| 0, 0, 1\)\);/,
    "vowels → vowel 덮어쓰기",
  );
});

test("말풍선 조건부 유지: 재생 중이면 250ms 재확인, voiceState 없으면 예전과 동일", () => {
  assert.match(SRC, /const hideBubble = \(delay\) => \{/, "숨김 헬퍼");
  assert.match(
    SRC,
    /if \(voiceState\?\.speaking === true\) \{ hideBubble\(250\); return; \}/,
    "재생 중이면 250ms 뒤 재확인",
  );
  assert.match(
    SRC,
    /clearTimeout\(bubbleTimer\); if \(ms\) hideBubble\(ms\);/,
    "say() 는 hideBubble(ms) 사용",
  );
  assert.ok(
    !SRC.includes('setTimeout(() => bubble.classList.remove("show"), ms)'),
    "예전 인라인 숨김 타이머 제거",
  );
});

test("dsc.js 는 특정 플러그인/URL 에 의존하지 않는다", () => {
  assert.ok(!/dsh-tts/i.test(SRC), "플러그인 이름 없음");
  assert.ok(!/https?:\/\//i.test(SRC), "http(s) URL 없음");
});

test("node --check 로 dsc.js 문법 검사", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-hooks-"));
  const tmp = path.join(dir, "dsc-check.mjs");
  try {
    fs.writeFileSync(tmp, SRC);
    const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    assert.equal(r.status, 0, "node --check 실패: " + (r.stderr || r.stdout));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
