// LOCAL PATCH: DeepSeek짱 — Harness 화면에 밝은 파스텔 테마와 Live2D 캐릭터(상반신)를 띄우고,
// 지금 열린 대화의 Harness 작업 상태(작업 중 / 도구 / 승인·질문 대기 / 완료 / 실패)에 반응한다.
// 바깥 신호는 받지 않는다(포트 없음). 제거: dist/index.html의 dsc 두 줄을 지우면 된다.
(() => {
  const BASE = new URL("./", document.currentScript.src).href;   // dsh-app://app/assets/dsc/
  const TEXT = {
    hello: "안녕하세요! 오늘은 뭘 만들어 볼까요?",
    start: "알겠어요! 시작할게요",
    approval: "확인이 필요해요! 한번 봐 주세요",
    question: "여쭤볼 게 있어요!",
    done: "다 했어요!",
    error: "앗, 문제가 생겼어요…",
  };
  // 도구 줄 제목(한국어 UI) → 말풍선
  const TOOLS = {
    "명령 실행": "명령 실행 중…", "코드": "코드 돌리는 중…", "읽기": "파일 읽는 중…", "이미지 읽기": "그림 보는 중…",
    "편집": "코드 고치는 중…", "쓰기": "파일 쓰는 중…", "검색": "찾아보는 중…", "파일 내용 검색": "찾아보는 중…",
    "파일 찾기": "파일 찾는 중…", "웹 검색": "검색하는 중…", "웹페이지 가져오기": "웹페이지 보는 중…",
    "하위 에이전트 만들기": "도우미 부르는 중…", "팀원 만들기": "도우미 부르는 중…", "워크플로 실행": "워크플로 돌리는 중…",
    // 영어 화면
    "Bash": "명령 실행 중…", "Pwsh": "명령 실행 중…", "Code": "코드 돌리는 중…", "Read": "파일 읽는 중…", "Read image": "그림 보는 중…",
    "Edit": "코드 고치는 중…", "Write": "파일 쓰는 중…", "Search": "찾아보는 중…", "Grep": "찾아보는 중…", "Glob": "파일 찾는 중…",
    "Fetch": "웹페이지 보는 중…", "Create subagent": "도우미 부르는 중…", "Create teammate": "도우미 부르는 중…", "Run workflow": "워크플로 돌리는 중…",
  };
  // Harness 화면 문구 (한국어 화면 / 영어 화면)
  const UI = {
    stop: 'button[aria-label="생성 중지"], button[aria-label="Stop generating"]',
    send: 'button[aria-label="메시지 보내기"], button[aria-label="Send message"]',
    approval: '[aria-label="승인 상세"], [aria-label="Approval details"]',
    turnError: ["이번 턴 실행 실패", "This turn failed"],
  };

  const ready = (fn) => (document.body ? fn() : addEventListener("DOMContentLoaded", fn, { once: true }));
  ready(() => {
    // ---------- 밝은 모드 고정 + 테마용 표시 ----------
    const keepLight = () => { if (document.body.hasAttribute("data-ds-dark-theme")) document.body.removeAttribute("data-ds-dark-theme"); };
    keepLight();
    new MutationObserver(keepLight).observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });

    let tagQueued = false;
    const tag = () => {
      tagQueued = false;
      document.querySelectorAll('[class*="_card"]').forEach((e) => {
        if (!e.classList.contains("dsc-composer") && e.closest('[class*="_root"]') && e.querySelector('[class*="_input"]')) e.classList.add("dsc-composer");
      });
      document.querySelectorAll(UI.send.split(", ").map((s) => s + ":not(.dsc-send)").join(", ")).forEach((e) => e.classList.add("dsc-send"));
      document.querySelectorAll('button[class*="_newSession"]:not(.dsc-newsession)').forEach((e) => e.classList.add("dsc-newsession"));
    };
    tag();

    // ---------- 상태 감시 ----------
    let running = false, lastError = -1e9, lastToolSay = 0, waitingKind = null;
    const listeners = { tool: null };
    const scanAdded = (node) => {
      if (node.nodeType !== 1) return;
      const t = node.textContent || "";
      if (t.length < 400 && UI.turnError.some((w) => t.includes(w))) lastError = performance.now();
      if (running && listeners.tool && t.length < 200) {
        const leaves = node.children.length === 0 ? [node] : node.querySelectorAll("span, div");
        for (const el of leaves) {
          if (el.children.length) continue;
          const s = (el.textContent || "").trim();
          if (TOOLS[s]) { listeners.tool(TOOLS[s]); break; }
        }
      }
    };
    new MutationObserver((records) => {
      if (!tagQueued) { tagQueued = true; requestAnimationFrame(tag); }
      for (const r of records) for (const n of r.addedNodes) scanAdded(n);
    }).observe(document.body, { childList: true, subtree: true });

    // ---------- Live2D ----------
    const load = (src) => new Promise((ok, no) => {
      const s = document.createElement("script"); s.src = BASE + src; s.onload = ok; s.onerror = () => no(new Error(src));
      document.head.appendChild(s);
    });
    (async () => {
      if (!window.Live2DCubismCore) await load("vendor/live2dcubismcore.min.js");
      if (!window.PIXI) await load("vendor/pixi.min.js");
      if (!window.PIXI.live2d) await load("vendor/cubism4.patched.js");

      const W = 300, H = 300;
      const canvas = document.createElement("canvas"); canvas.id = "dsc-stage";
      const bubble = document.createElement("div"); bubble.id = "dsc-bubble";
      document.body.append(canvas, bubble);
      const app = new PIXI.Application({ view: canvas, width: W, height: H, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: (devicePixelRatio || 1) * 1.5 });   // 1.5배로 그려 줄여 보여 줌
      const model = await PIXI.live2d.Live2DModel.from(BASE + "model/model.model3.json", { autoInteract: false, idleMotionGroup: "Idle" });
      app.stage.addChild(model);
      const im = model.internalModel, core = im.coreModel;
      im.eyeBlink = undefined; im.breath = undefined;

      // 상반신(머리 ~ 허리)만 캔버스에: 아래는 잘림
      core.update();
      const cm = core.getModel();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const each = (fn) => {
        for (let i = 0; i < cm.drawables.count; i++) {
          if (cm.drawables.opacities[i] < 0.01) continue;
          const v = im.getDrawableVertices(i);
          for (let k = 0; k < v.length; k += 2) fn(v[k], v[k + 1]);
        }
      };
      each((x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
      const cutY = minY + (maxY - minY) * 0.47;
      let ux0 = Infinity, ux1 = -Infinity;
      each((x, y) => { if (y < cutY) { ux0 = Math.min(ux0, x); ux1 = Math.max(ux1, x); } });
      const bw = ux1 - ux0, bh = cutY - minY;
      const s = Math.min((W * 0.98) / bw, (H * 0.95) / bh);
      model.scale.set(s);
      model.x = W / 2 - (ux0 + bw / 2) * s;
      model.y = H * 0.05 - minY * s;

      // 표정
      const exp = {};
      await Promise.all(["loading", "heart", "blush", "sweat", "dizzy", "tears", "squint", "smug", "dark"].map(async (f) => {
        try { exp[f] = (await (await fetch(`${BASE}model/exp/${f}.exp3.json`)).json()).Parameters || []; } catch { exp[f] = []; }
      }));
      const weight = {}, hold = {}, until = {};
      const EYE_EXP = ["heart", "squint", "smug", "dizzy"];
      const clearOtherEyes = (name) => { if (EYE_EXP.includes(name)) for (const e of EYE_EXP) if (e !== name) { until[e] = 0; hold[e] = false; } };
      const setExp = (name, on) => { if (on) clearOtherEyes(name); hold[name] = on; };
      const flashExp = (name, ms) => { clearOtherEyes(name); until[name] = performance.now() + ms; };

      // 버튜버식 몸짓: 한 번씩 재생하는 동작(gesture) + 지금 상태에 따른 자세(mood)
      const gest = { name: null, start: 0, dur: 0, dir: 1 };
      const play = (name, dur) => { gest.name = name; gest.start = performance.now(); gest.dur = dur; gest.dir = Math.random() < 0.5 ? -1 : 1; };
      let mood = "idle", moodUntil = 0, nextIdleGesture = performance.now() + 6000, talkUntil = 0;
      const setMood = (m, ms = 0) => { mood = m; moodUntil = ms ? performance.now() + ms : 0; };
      const pose = { lean: 0, headZ: 0, headY: 0, bodyY: 0, swayAmp: 0 };   // 부드럽게 따라가는 자세 값
      let shiverStarted = -1e9, touchLeanUntil = 0, touchLean = 0;

      // 위치: 오른쪽 아래 구석, 입력창을 가리지 않는 가장 큰 크기
      const visW = bw * s, visH = H * 0.95;
      let curK = 1, fleeX = 0;     // 현재 배율, 도망갈 때 오른쪽으로 밀려난 거리(px)
      // 시작 연출: 처음엔 화면 가운데에 크게 인사 → 본 화면이 뜨면 오른쪽 아래 제자리로 이동
      const DPR = (devicePixelRatio || 1) * 1.5;   // 1.5배로 그려 줄여 보여 줌 (윤곽선 매끄럽게)
      const intro = { phase: "center", start: performance.now(), moveStart: 0, from: null, kc: 1 };
      const veil = document.createElement("div");
      veil.style.cssText = "position:fixed;inset:0;z-index:29;background:radial-gradient(circle at 50% 55%,#ffffffd9,#eef0ffcc 70%);backdrop-filter:blur(8px);opacity:0;transition:none;cursor:pointer";
      document.body.append(veil);
      veil.addEventListener("pointerdown", () => { if (intro.phase === "center") intro.skip = true; });
      const setRes = (k) => { app.renderer.resolution = DPR * Math.max(1, k); app.renderer.resize(W, H); };
      const ease = (p) => (p < 0 ? 0 : p > 1 ? 1 : p * p * (3 - 2 * p));
      // 오른쪽 아래 제자리 (원래 배치)
      const homePose = () => {
        const card = document.querySelector(".dsc-composer");
        const maxK = Math.min(1.25, (innerHeight * 0.45) / visH);
        let k = maxK;
        if (card) { const r = card.getBoundingClientRect(); k = Math.min(maxK, Math.max((innerWidth - r.right - 8) / visW, (innerHeight - r.bottom - 10) / visH)); }
        return { k, x: innerWidth - 4 - (W + visW) / 2 * k + fleeX, y: innerHeight - H * k, card };
      };
      const centerPose = () => {
        // 가운데 아래에 붙여 상반신이 화면 아래에서 올라온 모습 (잘린 선이 화면 중간에 뜨지 않게)
        const k = Math.min(innerHeight * 0.74 / visH, innerWidth * 0.55 / visW, 3.2);
        return { k, x: innerWidth / 2 - W * k / 2, y: innerHeight - H * k };
      };
      intro.kc = centerPose().k; setRes(intro.kc);
      const place = () => {
        const now = performance.now();
        const home = homePose();
        let { k, x, y } = home;
        let introOn = intro.phase !== "done", vo = 0;
        if (introOn) {
          const c = centerPose();
          if (intro.phase === "center") {
            vo = ease((now - intro.start) / 300);
            k = c.k; x = c.x; y = c.y;
            const ready = !!home.card || now - intro.start > 15000;
            if (intro.skip || (now - intro.start > 6800 && ready)) { intro.phase = "move"; intro.moveStart = now; intro.from = c; }
          } else {
            const p = ease((now - intro.moveStart) / 900);
            vo = 1 - p;
            k = intro.from.k + (home.k - intro.from.k) * p; x = intro.from.x + (home.x - intro.from.x) * p; y = intro.from.y + (home.y - intro.from.y) * p;
            if (p >= 1) { intro.phase = "done"; introOn = false; setRes(1); veil.remove(); bubble.style.left = ""; bubble.style.fontSize = ""; bubble.style.padding = ""; }
          }
          veil.style.opacity = vo; veil.style.pointerEvents = intro.phase === "center" ? "auto" : "none";
        }
        const show = introOn || k >= 0.42;
        canvas.style.display = bubble.style.display = show ? "block" : "none";
        if (!show) return;
        curK = k;
        canvas.style.width = W * k + "px"; canvas.style.height = H * k + "px";
        if (fleeX > 0) bubble.style.display = "none";
        canvas.style.left = x + "px"; canvas.style.top = y + "px";
        const headTop = y + H * 0.05 * k;
        bubble.classList.remove("side");
        if (introOn) {   // 가운데에선 머리 위에 큰 말풍선
          bubble.style.right = "auto"; bubble.style.fontSize = "22px"; bubble.style.padding = "14px 24px"; bubble.style.maxWidth = "560px";
          bubble.style.left = (x + W * k / 2 - bubble.offsetWidth / 2) + "px";
          bubble.style.top = Math.max(8, headTop - bubble.offsetHeight - 6) + "px";
          return;
        }
        const card = home.card;
        bubble.style.right = "10px";
        bubble.style.maxWidth = Math.max(150, visW * k * 1.1) + "px";
        bubble.style.top = Math.max(8, headTop - bubble.offsetHeight - 10) + "px";
        if (card) {
          const r = card.getBoundingClientRect(), b = bubble.getBoundingClientRect();
          if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) {
            bubble.classList.add("side");
            bubble.style.maxWidth = "220px";
            bubble.style.right = innerWidth - (x + (W - visW) / 2 * k) + 8 + "px";
            bubble.style.top = Math.max(r.bottom + 8, headTop + 4) + "px";
          }
        }
      };
      const raf = () => { place(); requestAnimationFrame(raf); };
      requestAnimationFrame(raf);

      // 말풍선
      let bubbleTimer;
      let lastSayAt = 0;
      // 숨김 타이머: 외부 음성이 재생 중이면(voiceState.speaking) 말풍선을 붙잡아 두고 250ms 뒤 다시 확인.
      // voiceState가 null(음성 없음)이면 예전처럼 setTimeout(ms) 한 번만 돌아 동작이 같다.
      const hideBubble = (delay) => {
        bubbleTimer = setTimeout(() => {
          if (voiceState?.speaking === true) { hideBubble(250); return; }
          bubble.classList.remove("show");
        }, delay);
      };
      const say = (text, ms = 3500, mutter = false, kind) => {
        bubble.textContent = text; bubble.classList.add("show");
        bubble.classList.toggle("mutter", mutter);   // 혼잣말: 점선 말풍선 + 생각하는 시선
        lastSayAt = performance.now();
        startTalk(text, ms || 3000, mutter);   // 말하는 동안 글자 모음에 맞춰 입 움직임
        clearTimeout(bubbleTimer); if (ms) hideBubble(ms);
        // 바깥(자막·로깅·음성 엔진 등)이 대사를 알 수 있게 동기로 알린다. 실패해도 무시.
        kind = kind || (mutter ? "mutter" : "other");
        try { window.dispatchEvent(new CustomEvent("dsc:say", { detail: { text, ms, kind } })); } catch {}
      };
      const hush = () => { clearTimeout(bubbleTimer); bubble.classList.remove("show"); };

      // ---------- 버튜버식 움직임 (얼굴 추적처럼) ----------
      // 이 모델은 VBridger식 리깅: 머리 = AngleX/Y/Z, 몸 = PositionX/Y/Z·LeanInput(물리 엔진이 늦게 따라감),
      // 머리카락 물리 입력 = ParamAngleX/Y/Z, 귀 = 눈썹(ParamBrowLY/RY)을 따라 쫑긋. 입 = ParamA/I/U/E/O 모음.
      let mx = innerWidth / 2, my = innerHeight / 2, lastMove = 0;
      addEventListener("mousemove", (e) => { mx = e.clientX; my = e.clientY; lastMove = performance.now(); }, { passive: true });

      // 부드러운 잡음: 정수점마다 무작위 값을 두고 매끄럽게 잇기 (두 겹)
      const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
      const vnoise = (t) => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return (hash(i) * (1 - u) + hash(i + 1) * u) * 2 - 1; };
      const noise = (t, seed) => vnoise(t + seed * 17.31) * 0.72 + vnoise(t * 2.3 + seed * 5.17) * 0.28;
      // 스프링: 목표를 살짝 넘었다 돌아오며 따라감 (k 클수록 빠름, d 클수록 덜 출렁임)
      const S = () => ({ x: 0, v: 0 });
      // 프레임 간격이 길어도 흔들리지 않게 8ms 단위로 잘게 나눠 계산 (한 번에 계산하면 30fps 이하에서 눈동자가 매 프레임 튐)
      const spring = (s, target, dt, k, d) => { const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n; for (let i = 0; i < n; i++) { s.v += ((target - s.x) * k - s.v * d) * h; s.x += s.v * h; } return s.x; };
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      const hx = S(), hy = S(), ex = S(), ey = S();
      let energy = 0.6;                                   // 움직임 크기 (상태마다 다름)
      const attn = { x: 0, y: 0.05, next: 0 };            // 지금 바라보는 곳 (-1~1, 캔버스 기준)

      // 바라볼 곳 고르기: 말할 땐 정면(시청자), 작업 중엔 대화창을 읽듯 왼쪽, 가끔 입력창·딴 곳
      const pickAttention = (now, talking) => {
        let p;
        const r = Math.random();
        if (talking) p = r < 0.85 ? [0, 0.05] : [-0.5, 0.1];
        else if (mood === "work") p = r < 0.55 ? [-0.75, 0.12] : r < 0.75 ? [-0.55, -0.3] : r < 0.9 ? [0, 0.05] : [0.35, 0.3];
        else if (mood === "wait") p = r < 0.7 ? [0, 0.05] : [-0.7, 0.05];
        else if (mood === "sad") p = r < 0.6 ? [0.1, -0.45] : [-0.3, -0.3];
        else p = r < 0.4 ? [0, 0.05] : r < 0.6 ? [-0.7, 0.1] : [(Math.random() - 0.5) * 1.2, (Math.random() - 0.4) * 0.7];
        attn.x = p[0] + (Math.random() - 0.5) * 0.12; attn.y = p[1] + (Math.random() - 0.5) * 0.1;
        attn.next = now + (talking ? 2500 : mood === "work" ? 1200 : 1500) + Math.random() * 3000;
        if (Math.random() < 0.35) blink.next = Math.min(blink.next, now + 60);   // 시선을 옮길 때 자주 깜빡임
        if (Math.random() < 0.3) browKick = Math.max(browKick, 0.25);
      };

      // ---- 말하기: 말풍선 글자의 모음으로 입 모양 ----
      // 한글 중성 21개 → 입 모양 (ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ)
      const JUNG = "AEAEOEOEOAEEOUOEIUUII";
      let talk = null;   // { syl: [{v, d, amp, stress}], t0, total, quiet }
      const startTalk = (text, ms, quiet) => {
        const syl = [];
        const words = String(text).split(/(\s+)/);
        for (const w of words) {
          if (/^\s+$/.test(w)) { syl.push({ v: null, d: 0.07 }); continue; }
          let first = true, prevVowel = false;
          for (const ch of w) {
            const c = ch.charCodeAt(0);
            if (c >= 0xac00 && c <= 0xd7a3) {
              syl.push({ v: JUNG[Math.floor(((c - 0xac00) % 588) / 28)], d: 0.12 + Math.random() * 0.04, amp: 0.65 + Math.random() * 0.35, stress: first });
              first = false;
            } else if (/[aeiouy]/i.test(ch)) {
              if (!prevVowel) { const l = ch.toLowerCase(); syl.push({ v: l === "a" ? "A" : l === "e" ? "E" : l === "o" ? "O" : l === "u" ? "U" : "I", d: 0.1 + Math.random() * 0.04, amp: 0.55 + Math.random() * 0.35, stress: first }); first = false; }
              prevVowel = true; continue;
            } else if (/[.,!?…~。，！？]/.test(ch)) syl.push({ v: null, d: ch === "," || ch === "，" ? 0.12 : 0.24 });
            else if (/[0-9]/.test(ch)) { syl.push({ v: "A", d: 0.12, amp: 0.7, stress: first }); first = false; }
            prevVowel = false;
          }
        }
        let total = syl.reduce((s, x) => s + x.d, 0);
        const limit = (ms || 3000) / 1000 * 0.92;
        if (total > limit && total > 0) { const k = limit / total; for (const x of syl) x.d *= k; total = limit; }   // 말풍선 시간 안에 끝나게
        talk = { syl, t0: performance.now(), total, quiet };
      };
      const VOW = ["A", "I", "U", "E", "O"];
      const vowel = { A: 0, I: 0, U: 0, E: 0, O: 0 };
      let mouthOpen = 0, browKick = 0, nodKick = 0, lastStressIdx = -1;
      let voiceState = null;   // 외부 음성 상태(선택): { speaking, level, vowels, until } | null — 없으면 예전 그대로

      const look = { x: 0, y: 0 };   // (터치·확인용으로 남겨 둔 값)
      const pose1 = { lean: 0, headZ: 0, headY: 0, bodyY: 0 };   // 자세 1단계 (S자 전환용)
      // 몸짓 곡선: 천천히 들어가서(0~35%) 머물렀다가(~70%) 천천히 돌아옴
      const sstep = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * x * (x * (x * 6 - 15) + 10); };
      const holdCurve = (p, a = 0.35, b = 0.7) => (p < a ? sstep(p / a) : p > b ? sstep((1 - p) / (1 - b)) : 1);
      let blink = { next: performance.now() + 2000, start: -1e9, double: false }, lastT = performance.now();
      im.motionManager.expressionManager = {
        destroy() {},
        update() {
          const now = performance.now(), dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
          const T = now / 1000;
          if (voiceState && voiceState.until && now > voiceState.until) voiceState = null;   // 만료된 음성 상태 비우기
          const talking = (voiceState?.speaking === true) || (bubble.classList.contains("show") && fleeX === 0);
          const muttering = talking && bubble.classList.contains("mutter");
          if (moodUntil && now > moodUntil) { mood = "idle"; moodUntil = 0; }

          // 움직임 크기: 대기 < 작업 < 말하기, 웃을 땐 크게, 시무룩하면 작게
          const laughing = gest.name === "laugh";
          const eTarget = (mood === "sad" ? 0.35 : mood === "wait" ? 0.55 : mood === "work" ? 0.75 : 0.6) + (talking && !muttering ? 0.35 : 0) + (laughing ? 0.5 : 0);
          energy += (eTarget - energy) * Math.min(1, dt * 1.5);

          // ---- 바라보는 곳 ----
          let tx, ty;
          if (muttering) { tx = 0.4; ty = 0.38; }                    // 혼잣말: 옆 위를 보며 생각
          else if (now - lastMove < 2500 && !talking) {             // 마우스를 움직이면 눈은 커서를, 고개는 반쯤
            const r = canvas.getBoundingClientRect();
            tx = clamp((mx - (r.left + r.width / 2)) / 600, -1, 1);
            ty = clamp(((r.top + r.height * 0.25) - my) / 500, -1, 1);
          } else {
            if (now > attn.next || (talking && Math.abs(attn.x) > 0.3 && Math.random() < dt * 2)) pickAttention(now, talking);
            tx = attn.x; ty = attn.y;
          }
          // 눈은 빠르게(휙), 고개는 천천히 따라감 → 눈이 먼저 가고 고개가 뒤따르는 버튜버 느낌
          spring(ex, tx, dt, 900, 55); spring(ey, ty, dt, 900, 55);
          spring(hx, tx * 0.85, dt, 38, 9.5); spring(hy, ty * 0.8, dt, 38, 9.5);
          look.x = hx.x; look.y = hy.x;

          // ---- 말하기 (입 모양 · 고개 끄덕 · 눈썹) ----
          let open = 0;
          for (const k of VOW) vowel[k] *= Math.max(0, 1 - dt * 14);
          if (talk) {
            let t = (now - talk.t0) / 1000;
            if (t >= talk.total) talk = null;
            else {
              let i = 0; while (i < talk.syl.length && t > talk.syl[i].d) { t -= talk.syl[i].d; i++; }
              const s = talk.syl[i];
              if (s && s.v) {
                const p = t / s.d, env = Math.pow(Math.sin(Math.PI * Math.min(1, p)), 0.7);
                open = env * s.amp * (talk.quiet ? 0.3 : 1);
                vowel[s.v] = Math.max(vowel[s.v], open);
                if (s.stress && i !== lastStressIdx) {               // 낱말 첫소리: 눈썹 살짝(귀 쫑긋) + 가끔 끄덕
                  lastStressIdx = i;
                  if (!talk.quiet) { browKick = Math.max(browKick, 0.35 + Math.random() * 0.35); if (Math.random() < 0.45) nodKick = Math.max(nodKick, 0.6 + Math.random() * 0.5); }
                }
              }
            }
          }
          if (voiceState?.speaking) {   // 실제 재생 중이면 오디오 레벨·모음이 입 모양을 덮어쓴다
            open = clamp(voiceState.level, 0, 1) * 0.9;
            if (voiceState.vowels) for (const k of VOW) vowel[k] = Math.max(vowel[k] * 0.4, clamp(voiceState.vowels[k] || 0, 0, 1));
          }
          mouthOpen += (open - mouthOpen) * Math.min(1, dt * 22);
          browKick *= Math.max(0, 1 - dt * 3.5);
          nodKick *= Math.max(0, 1 - dt * 5);

          // ---- 상태별 자세 (작업 중 = 살짝 앞으로, 대기 = 숙이고 갸웃, 실패 = 고개 숙임) ----
          const goal = { lean: 0, headZ: 0, headY: 0, bodyY: 0 };
          if (mood === "work") { goal.lean = -7; goal.headY = -5; }          // 작업 중: 상체를 조금 내밀고 화면을 내려다봄
          if (mood === "wait") { goal.lean = -9; goal.headZ = 8; goal.headY = 3; }   // 대기: 다가와 갸웃하며 사용자를 올려다봄
          if (mood === "sad") { goal.headY = -10; goal.bodyY = -5; }
          const pk = Math.min(1, dt * 2.2);   // 두 단계로 따라가서 S자 곡선 (툭 끊기지 않게)
          for (const key in goal) { pose1[key] += (goal[key] - pose1[key]) * pk; pose[key] += (pose1[key] - pose[key]) * pk; }

          // ---- 고개 (AngleX/Y/Z): 시선 + 잔잔한 흔들림 + 말할 때 끄덕 ----
          let yaw = hx.x * 22 + noise(T * 0.33, 1) * 6 * energy;
          let pitch = hy.x * 13 + noise(T * 0.41, 2) * 4.5 * energy + pose.headY - nodKick * 4 - mouthOpen * 1.5;
          let roll = noise(T * 0.27, 3) * 7.5 * energy - hx.x * hy.x * 7 + pose.headZ;
          // ---- 몸 (PositionX/Y/Z·LeanInput → 물리가 몸통을 늦게 따라 움직임) ----
          let bodyX = hx.x * 8 + noise(T * 0.17, 4) * 5 * energy;
          let bodyZ = roll * 0.5 + noise(T * 0.21, 5) * 3 * energy;
          let bodyY = pose.bodyY + Math.sin(T * 2 * Math.PI / 3.6) * 1.2;   // 숨쉬기
          let lean = pose.lean, smile = 0, eyeSmileAdd = 0, eyeClose = 0, mouthAdd = 0;
          if (mood === "work") bodyZ += Math.sin(T * 2.1) * 1.2;        // 작업 중엔 리듬 타기

          if (gest.name) {
            const p = (now - gest.start) / gest.dur;
            if (p >= 1) gest.name = null;
            else {
              const env = Math.sin(Math.PI * p), d = gest.dir;
              switch (gest.name) {
                case "nod": pitch -= Math.abs(Math.sin(p * Math.PI * 4)) * 11 * env; break;                       // 끄덕끄덕
                case "tilt": roll += 15 * env * d; bodyZ += 6 * env * d; smile += env; break;                    // 고개 갸웃
                case "lean": { const h = holdCurve(p, 0.3, 0.72); lean -= 12 * h; pitch += 4 * h; roll += 8 * h * d; bodyX += 4 * h * d; smile += 0.7 * h; break; }   // 다가와 들여다보기: 몸은 앞으로, 턱은 살짝 들어 화면을 봄
                case "sway": bodyZ += Math.sin(p * Math.PI * 6) * 9 * env; roll += Math.sin(p * Math.PI * 6) * 6 * env; smile += env; break;   // 흔들흔들
                case "bounce": bodyY += Math.abs(Math.sin(p * Math.PI * 4)) * 8 * env; bodyZ += Math.sin(p * Math.PI * 4) * 6 * env; smile += env; break;   // 신나서 통통
                case "droop": pitch -= 14 * env; bodyY -= 6 * env; break;                                          // 시무룩
                case "laugh":                                                                                      // ^^ 눈웃음 + 어깨 들썩
                  eyeSmileAdd += env; eyeClose += env * 0.85; smile += env;
                  { const hb = holdCurve(p, 0.25, 0.65), hh = holdCurve(Math.max(0, p - 0.08) / 0.92, 0.3, 0.6);   // 몸이 먼저, 고개가 조금 늦게
                    lean -= 10 * hb; pitch -= 9 * hh - (p > 0.7 ? 3 * Math.sin(Math.PI * (p - 0.7) / 0.3) : 0); roll += 7 * hb * d; }
                  bodyY += Math.abs(Math.sin(p * Math.PI * 7)) * 5 * env; mouthAdd += 0.45 * env;
                  break;
              }
            }
          }
          if (!gest.name && mood === "idle" && now > nextIdleGesture) {   // 가만히 있을 때 가끔 몸짓
            const r = Math.random();
            const pick = r < 0.3 ? "tilt" : r < 0.5 ? "sway" : r < 0.72 ? "lean" : r < 0.88 ? "nod" : "laugh";
            play(pick, pick === "lean" ? 2600 : pick === "sway" ? 2300 : pick === "laugh" ? 1500 : 1800);
            nextIdleGesture = now + 7000 + Math.random() * 9000;
          }
          touchLean += ((now < touchLeanUntil ? -30 : 0) - touchLean) * Math.min(1, dt * 4);   // 가슴 터치 때 가끔 앞으로 숙임
          lean += touchLean;
          const se = (now - shiverStarted) / 1000;                   // 부끄러워 떨기 (5초에 걸쳐 잦아듦)
          if (se >= 0 && se < 5) {
            const tr = Math.sin(se * Math.PI * 2 * 8) * Math.min(1, se / 0.2) * Math.pow(1 - se / 5, 1.5);
            bodyZ -= tr * 3; roll += tr * 2;
          }
          if (fleeX > 0) bodyZ += Math.sin(T * 16) * 8;              // 도망가며 종종걸음

          yaw = clamp(yaw, -30, 30); pitch = clamp(pitch, -30, 30); roll = clamp(roll, -30, 30);
          for (const [id, v] of [["AngleX", yaw], ["AngleY", pitch], ["AngleZ", roll], ["ParamAngleX", yaw], ["ParamAngleY", pitch], ["ParamAngleZ", roll],
            ["PositionX", clamp(bodyX, -30, 30)], ["PositionY", clamp(bodyY, -30, 30)], ["PositionZ", clamp(bodyZ, -30, 30)], ["LeanInput", clamp(lean, -30, 30)]]) core.addParameterValueById(id, v);

          // ---- 눈: 눈동자는 고개보다 먼저 (머리 기준 상대 위치) ----
          // 눈동자는 작게만 (크게 움직이면 흰자가 드러나 곁눈질처럼 보임)
          core.addParameterValueById("ParamEyeBallX", clamp(((ex.x - hx.x) * 0.9 + hx.x * 0.2) * 0.6, -0.45, 0.45));
          core.addParameterValueById("ParamEyeBallY", clamp(((ey.x - hy.x) * 0.9 + hy.x * 0.2) * 0.6, -0.3, 0.3));
          core.setParameterValueById("ParamBreath", 0.5 + 0.5 * Math.sin(T * 2 * Math.PI / 3.6));

          // ---- 눈썹 (귀가 따라 움직임) ----
          const brow = browKick + noise(T * 0.5, 7) * 0.12 + (mood === "wait" ? 0.25 : mood === "sad" ? -0.3 : 0);
          core.addParameterValueById("ParamBrowLY", clamp(brow, -1, 1));
          core.addParameterValueById("ParamBrowRY", clamp(brow + noise(T * 0.6, 8) * 0.06, -1, 1));
          if (browKick > 0.2) core.addParameterValueById("BrowInnerUp", Math.min(1, browKick * 0.6));

          // ---- 입: 모음 모양 + 늘 살짝 웃는 입꼬리 ----
          const openNow = clamp(mouthOpen + mouthAdd, 0, 1);
          if (openNow > 0.01) {
            core.setParameterValueById("ParamMouthOpenY", openNow * 0.9);
            core.addParameterValueById("JawOpen", openNow * 0.45);
            core.setParameterValueById("ParamSilence", 1 - openNow);
            for (const k of VOW) if (vowel[k] > 0.01) core.addParameterValueById("Param" + k, Math.min(1, vowel[k]));
            if (mouthAdd > 0.01) core.addParameterValueById("ParamA", mouthAdd * 0.8);
          }
          const baseSmile = mood === "sad" ? 0 : mood === "wait" ? 0.15 : 0.35;
          core.addParameterValueById("ParamMouthForm", clamp(baseSmile + smile * 0.4, -1, 1));
          core.addParameterValueById("MouthSmile_L", clamp(baseSmile + smile * 0.5, 0, 1));
          core.addParameterValueById("MouthSmile_R", clamp(baseSmile + smile * 0.5 + noise(T * 0.3, 9) * 0.05, 0, 1));
          const eSmile = clamp((mood === "sad" ? 0 : 0.12) + smile * 0.35 + eyeSmileAdd, 0, 1);
          if (eSmile > 0.01) core.addParameterValueById("EyeSmile", eSmile);

          // ---- 눈 깜빡임: 2~6초 불규칙, 가끔 두 번 ----
          if (now >= blink.next && !laughing) {
            blink.start = now;
            blink.next = blink.double ? now + 2000 + Math.random() * 4000 : (Math.random() < 0.18 ? now + 260 : now + 2000 + Math.random() * 4000);
            blink.double = !blink.double && blink.next - now < 400;
          }
          const bt = (now - blink.start) / 1000;
          const blinkClose = bt < 0.07 ? bt / 0.07 : bt < 0.1 ? 1 : bt < 0.22 ? 1 - (bt - 0.1) / 0.12 : 0;
          const eyeOpen = clamp((mood === "work" ? 0.92 : 0.97) * (1 - blinkClose) * (1 - eyeClose), 0, 1.2);
          core.setParameterValueById("ParamEyeLOpen", eyeOpen); core.setParameterValueById("ParamEyeROpen", eyeOpen);

          for (const [name, params] of Object.entries(exp)) {
            const target = hold[name] || (until[name] || 0) > now ? 1 : 0;
            // 하트·><·얄미운·빙글빙글 눈은 눈 그림 자체를 바꾸므로 한 번에 바꾸고, 그 순간 깜빡여 감춤
            const EYE_SWAP = name === "heart" || name === "squint" || name === "smug" || name === "dizzy";
            if (EYE_SWAP && (weight[name] > 0.5) !== (target > 0.5)) { blink.start = now - 0.07 * 1000; blink.next = Math.max(blink.next, now + 1500); }
            const w = weight[name] = EYE_SWAP ? target : (weight[name] || 0) + (target - (weight[name] || 0)) * Math.min(1, dt * 6);
            if (w < 0.01) continue;
            for (const p of params) {
              if (p.Blend === "Multiply") core.multiplyParameterValueById(p.Id, p.Value, w);
              else if (p.Blend === "Add") core.addParameterValueById(p.Id, p.Value, w);
              else core.setParameterValueById(p.Id, p.Value, w);
            }
          }
        },
      };

      // ---------- 터치 (데스크톱 펫과 같은 부위 판정) ----------
      // 대사: 펫 코드(lines.js)에 든 기본 대사 + 기본 대사가 없는 상황만 짧게 채움. [표정] 꼬리표로 표정 지정.
      const LINES = {
        head: ["[홍조, ><] 에헤헤, 쓰다듬어 주는 거예요?", "[홍조, ><] 머리는… 조금 부끄러워요", "[홍조, ><] 헤헤♪", "[홍조, ><] 더 해 주세요!"],
        head_many: ["[하트, 홍조] 헤헤, 오늘 기분 좋은가 봐요?", "[하트, 홍조] 이러다 머리 다 헝클어지겠어요!"],
        body: ["[하트] 불렀어요?", "[홍조] 왜, 왜요?", "[얄미운] 흐응~?", "[식은땀] 앗, 깜짝이야!", "[하트, 홍조] 오늘도 화이팅이에요!"],
        arm: ["[홍조] 손 잡고 싶은 거예요?", "[홍조] 팔은 왜요~?"],
        leg: ["[식은땀, 홍조] 어, 어디 만지는 거예요!", "[식은땀, 홍조] 다리는 안 돼요…!"],
        chest1: ["[홍조, 얄미운] 앗… 조금 부끄러워요.", "[홍조, 얄미운] 제 반응이 궁금한 거예요?"],
        chest2: ["[홍조, 식은땀] 자꾸 그러면… 얼굴 빨개지잖아요!", "[홍조, 식은땀] 으으… 놀리지 말아요…"],
        chest3: ["[홍조, ><] 너무 부끄러워요… 잠깐만요!"],
        chest_calm: ["[홍조] 후우… 잠깐 진정할게요."],
        lower1: ["[홍조, 식은땀] 거, 거기는 안 돼요!", "[홍조, 식은땀] 치마는 만지면 안 돼요…"],
        lower2: ["[홍조, ><] 진짜 화낼 거예요!", "[홍조, ><] 으으… 그만해요…"],
        lower3: ["[><, 식은땀] 히익…!"],
        lower_after: ["[홍조, 눈물] …다시는 그러지 마요.", "[홍조, 눈물] 흥, 이번만 봐줄게요."],
        spam: ["[어두운, 얄미운] …그만 좀 눌러요."],
        makeup: ["[홍조] …이제 안 누를 거죠?"],
        working: ["[식은땀] 지금 일하는 중이에요~"],
      };
      const EXP_NAME = { "홍조": "blush", "><": "squint", "하트": "heart", "얄미운": "smug", "식은땀": "sweat", "어두운": "dark", "눈물": "tears" };
      const lastLine = {};
      const speak = (key, ms = 3500) => {
        const list = LINES[key]; if (!list) return;
        let i = Math.floor(Math.random() * list.length);
        if (list.length > 1 && i === lastLine[key]) i = (i + 1) % list.length;
        lastLine[key] = i;
        let text = list[i];
        const m = text.match(/^\[([^\]]+)\]\s*/);
        if (m) { text = text.slice(m[0].length); for (const n of m[1].split(",")) { const e = EXP_NAME[n.trim()]; if (e) flashExp(e, ms); } }
        say(text, ms);
      };

      const PART_REGION = {
        Part99: "head", Part47: "head", Part155: "head", Part156: "head", Part161: "head", Part64: "head", Part66: "head", Part10: "head", Part8: "head",
        Part127: "arm", Part94: "arm", Part68: "arm", Part93: "arm", Part117: "arm", Part54: "arm", Part42: "arm",
        Part114: "leg", Part97: "lower", Part107: "lower", Part125: "lower", Part126: "lower",
        Part89: "waist", Part85: "chestpart", Part88: "chestpart", Part136: "tail",
      };
      const DR = cm.drawables, PT = cm.parts;
      const drawRegion = Array.from({ length: DR.count }, (_, i) => {
        for (let p = DR.parentPartIndices[i]; p >= 0; p = PT.parentIndices[p]) if (PART_REGION[PT.ids[p]]) return PART_REGION[PT.ids[p]];
        return null;
      });
      const chestDraw = [];
      for (let i = 0; i < DR.count; i++) for (let p = DR.parentPartIndices[i]; p >= 0; p = PT.parentIndices[p]) if (PT.ids[p] === "Part88" || PT.ids[p] === "Part86") { chestDraw.push(i); break; }
      const chestCenter = () => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const i of chestDraw) {
          if (DR.opacities[i] < 0.05) continue;
          const v = im.getDrawableVertices(i);
          for (let k = 0; k < v.length; k += 2) { x0 = Math.min(x0, v[k]); x1 = Math.max(x1, v[k]); y0 = Math.min(y0, v[k + 1]); y1 = Math.max(y1, v[k + 1]); }
        }
        return x0 === Infinity ? null : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      };
      const chestBase = chestCenter();
      const B = { minX, minY, w: maxX - minX, h: maxY - minY };   // 전신 그림 영역 (펫과 같은 기준)
      const AN = 512;
      let alphaMaps = null;
      const buildAlpha = () => {
        alphaMaps = model.textures.map((t) => {
          try {
            const c = document.createElement("canvas"); c.width = c.height = AN;
            const g = c.getContext("2d", { willReadFrequently: true });
            g.drawImage(t.baseTexture.resource.source, 0, 0, AN, AN);
            const d = g.getImageData(0, 0, AN, AN).data, a = new Uint8Array(AN * AN);
            for (let k = 0; k < a.length; k++) a[k] = d[k * 4 + 3];
            return a;
          } catch { return null; }
        });
      };
      const alphaAt = (tex, u, v) => {
        const a = alphaMaps[tex]; if (!a) return 255;
        return a[Math.min(AN - 1, Math.max(0, Math.floor((1 - v) * AN))) * AN + Math.min(AN - 1, Math.max(0, Math.floor(u * AN)))];
      };
      const pickDrawable = (x, y) => {   // x, y: 캔버스(배율 1) 좌표
        if (!alphaMaps) buildAlpha();
        const px = (x - model.x) / model.scale.x, py = (y - model.y) / model.scale.y;
        let best = -1, bestOrder = -Infinity;
        for (let i = 0; i < DR.count; i++) {
          if (DR.opacities[i] < 0.05 || !(DR.dynamicFlags[i] & 1)) continue;
          const order = DR.renderOrders[i];
          if (order <= bestOrder) continue;
          const v = im.getDrawableVertices(i);
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (let k = 0; k < v.length; k += 2) { if (v[k] < x0) x0 = v[k]; if (v[k] > x1) x1 = v[k]; if (v[k + 1] < y0) y0 = v[k + 1]; if (v[k + 1] > y1) y1 = v[k + 1]; }
          if (px < x0 || px > x1 || py < y0 || py > y1) continue;
          const idx = DR.indices[i], uv = DR.vertexUvs[i];
          for (let k = 0; k < idx.length; k += 3) {
            const a = idx[k] * 2, b = idx[k + 1] * 2, c = idx[k + 2] * 2;
            const d = (v[b + 1] - v[c + 1]) * (v[a] - v[c]) + (v[c] - v[b]) * (v[a + 1] - v[c + 1]);
            if (Math.abs(d) < 1e-9) continue;
            const l1 = ((v[b + 1] - v[c + 1]) * (px - v[c]) + (v[c] - v[b]) * (py - v[c + 1])) / d;
            const l2 = ((v[c + 1] - v[a + 1]) * (px - v[c]) + (v[a] - v[c]) * (py - v[c + 1])) / d;
            const l3 = 1 - l1 - l2;
            if (l1 < 0 || l2 < 0 || l3 < 0) continue;
            if (alphaAt(DR.textureIndices[i], l1 * uv[a] + l2 * uv[b] + l3 * uv[c], l1 * uv[a + 1] + l2 * uv[b + 1] + l3 * uv[c + 1]) > 40) { best = i; bestOrder = order; break; }
          }
        }
        return best;
      };
      const touchRegion = (x, y, d) => {
        const sc = model.scale.x, cc = chestCenter();
        const shiftX = cc && chestBase ? cc.x - chestBase.x : 0, shiftY = cc && chestBase ? cc.y - chestBase.y : 0;
        const rx = (x - model.x - (B.minX + shiftX) * sc) / (B.w * sc);
        const ry = (y - model.y - (B.minY + shiftY) * sc) / (B.h * sc);
        const inChest = Math.pow((rx - 0.45) / 0.13, 2) + Math.pow((ry - 0.295) / 0.045, 2) <= 1;
        let r = drawRegion[d];
        if (r === "head" && ry > 0.3) r = null;
        if (r === "arm" || r === "leg" || r === "head") return r;
        if (inChest) return "chest";
        if (r === "lower") return "lower";
        if (r === "waist") return ry > 0.4 ? "lower" : "chest";
        if (r === null && ry < 0.3) return "head";
        return ry < 0.4 ? "chest" : "body";
      };
      // 화면 좌표 → 캔버스 좌표, 캐릭터 위면 [x, y, 메시 번호]
      const hitAt = (cx, cy) => {
        if (canvas.style.display === "none" || fleeX > 0) return null;
        const r = canvas.getBoundingClientRect();
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
        const x = (cx - r.left) / curK, y = (cy - r.top) / curK;
        const d = pickDrawable(x, y);
        return d >= 0 ? [x, y, d] : null;
      };

      let clicks = [], headClicks = [], spamAt = -1e9, inputLockedUntil = 0;
      const shy = { count: 0, last: -1e9, cooldownUntil: 0 }, low = { count: 0, last: -1e9, cooldownUntil: 0 };
      const onChest = (now) => {
        if (now < shy.cooldownUntil || now - shy.last < 180) return;
        if (now - shy.last > 8000) shy.count = 0;
        shy.last = now; shy.count++;
        if (shy.count <= 4) {
          if (now < touchLeanUntil || Math.random() < 0.16) touchLeanUntil = now + 3000;   // 가끔 앞으로 숙임, 숙인 동안 누르면 3초 연장
          speak(shy.count <= 2 ? "chest1" : "chest2", 4000);
        } else {
          touchLeanUntil = 0; shy.count = 0;
          shy.cooldownUntil = inputLockedUntil = now + 6000;   // 진정할 때까지 터치 안 받음
          shiverStarted = now;
          speak("chest3", 3000);
          setTimeout(() => speak("chest_calm", 2800), 3000);
        }
      };
      const flee = () => {   // 오른쪽 밖으로 사라졌다가 10초 뒤 돌아옴
        const off = (W + 80) * curK, go = (from, to, ms, done) => {
          const t0 = performance.now();
          const step = () => {
            const p = Math.min(1, (performance.now() - t0) / ms), e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
            fleeX = from + (to - from) * e;
            if (p < 1) requestAnimationFrame(step); else done && done();
          };
          requestAnimationFrame(step);
        };
        hush();
        go(0.01, off, 700, () => setTimeout(() => go(off, 0, 1100, () => { fleeX = 0; setTimeout(() => speak("lower_after", 4000), 400); }), 10000));
      };
      const onLower = (now) => {
        if (fleeX > 0 || now < low.cooldownUntil || now - low.last < 180) return;
        if (now - low.last > 8000) low.count = 0;
        low.last = now; low.count++;
        if (low.count <= 2) speak("lower1", 4000);
        else if (low.count <= 4) speak("lower2", 4000);
        else {
          low.count = 0;
          low.cooldownUntil = now + 14000;
          shiverStarted = now;
          speak("lower3", 900);
          setTimeout(flee, 900);
        }
      };
      const onTouch = (x, y, d) => {
        const now = performance.now();
        if (now < inputLockedUntil) return;
        const region = touchRegion(x, y, d);
        if (region === "chest") { clicks = []; headClicks = []; low.count = 0; return onChest(now); }
        if (region === "lower") { clicks = []; headClicks = []; shy.count = 0; return onLower(now); }
        shy.count = 0; low.count = 0;
        clicks = clicks.filter((t) => now - t < 3000); clicks.push(now);
        if (clicks.length >= 6) { clicks = []; headClicks = []; spamAt = now; return speak("spam", 3000); }
        if (running && Math.random() < 0.5) return speak("working");
        if (region === "head") {
          if (now - spamAt < 10000) { spamAt = -1e9; return speak("makeup"); }
          headClicks = headClicks.filter((t) => now - t < 8000); headClicks.push(now);
          if (headClicks.length >= 5) { headClicks = []; play("laugh", 1800); return speak("head_many"); }
          play(Math.random() < 0.45 ? "laugh" : "tilt", 1500);
          return speak("head");
        }
        if (region === "arm") return speak("arm");
        if (region === "leg") return speak("leg");
        play("sway", 1600);
        speak("body");
      };
      // 캔버스는 클릭을 통과시키므로, 문서 단계에서 캐릭터 위 클릭만 가로챔 (투명한 곳은 뒤 화면으로 그대로)
      let swallowClick = false;
      document.addEventListener("pointerdown", (e) => {
        swallowClick = false;
        if (e.button !== 0) return;
        const h = hitAt(e.clientX, e.clientY);
        if (!h) return;
        e.preventDefault(); e.stopPropagation(); swallowClick = true;
        onTouch(h[0], h[1], h[2]);
      }, true);
      for (const type of ["pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
        document.addEventListener(type, (e) => {
          if (!swallowClick) return;
          e.preventDefault(); e.stopPropagation();
          if (type === "click" || type === "dblclick") setTimeout(() => { swallowClick = false; }, 0);
        }, true);
      }
      let hoverCheck = 0;
      document.addEventListener("mousemove", (e) => {   // 캐릭터 위에서는 손가락 커서
        const now = performance.now(); if (now - hoverCheck < 80) return; hoverCheck = now;
        const over = !!hitAt(e.clientX, e.clientY);
        document.documentElement.classList.toggle("dsc-hover", over);
      }, { passive: true });

      // ---------- Harness 상태 → 반응 ----------
      listeners.tool = (text) => {
        const now = performance.now();
        if (waitingKind || now - lastToolSay < 1500) return;
        lastToolSay = now; say(text, 0, false, "status");
      };
      // 추론 혼잣말: 작업 중 화면의 추론 요약 줄(방금 끝난 문단의 첫 줄)이 바뀌면, 한국어·영어 문장을 가끔 중얼거림
      let lastThought = "", lastMutterAt = 0;
      const thoughtLine = (s) => {
        const t = s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim()
          .replace(/^(?:[-•]|\d+[.)])\s+/, "")            // 목록 기호 (- • 1. 1))
          .replace(/^\([^)]{1,30}\):?\s*/, "");          // (Self-Correction): 같은 머리말
        const hangul = (t.match(/[가-힣]/g) || []).length;
        const latin = (t.match(/[A-Za-z]/g) || []).length;
        const first = (t.match(/^.{4,}?[.!?。…](\s|$)/) || [t])[0].trim();   // 첫 문장
        if (hangul >= 4 && latin <= hangul * 0.35)                          // 한국어가 대부분인 문장
          return first.length > 42 ? first.slice(0, 40).trim() + "…" : first;
        // 영어 문장: 낱말 3개 이상, 한글은 거의 없고, 코드·경로처럼 기호가 많은 줄은 뺌
        const words = first.split(" ").filter((w) => /[A-Za-z]{2,}/.test(w)).length;
        const symbols = (first.match(/[{}()\[\];=<>\/\\|$@]/g) || []).length;
        if (latin < 12 || words < 3 || hangul > latin * 0.1 || symbols > first.length * 0.04 || first.includes("://")) return null;
        let line = vtuberize(first);
        const hmm = Math.random() < 0.3 ? "Hmm… " : "";                    // 가끔 생각하는 소리
        const max = 64 - hmm.length;
        if (line.length > max) {
          const cut = line.slice(0, max - 2), sp = cut.lastIndexOf(" ");    // 낱말 중간에서 자르지 않음
          line = (sp > 30 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, "") + "…";
        }
        if ((line.match(/"/g) || []).length % 2) line = line.slice(0, line.lastIndexOf('"')).replace(/[\s,;:]+$/, "") + "…";   // 따옴표 짝 맞추기
        return hmm + line;
      };
      // 버튜버 말투: 추론 속 "the user"를 시청자에게 말하듯 "you"로 (동사도 맞춤)
      const VERB = { is: "are", was: "were", has: "have", wants: "want", needs: "need", asks: "ask", asked: "asked",
        said: "said", says: "say", likes: "like", prefers: "prefer", seems: "seem", mentioned: "mentioned", requested: "requested" };
      const vtuberize = (s) => s
        .replace(/\b(the|this) user's\b/gi, (m) => (m[0] === "T" ? "Your" : "your"))
        .replace(/\b(the|this) user (\w+)/gi, (m, d, v) => {
          const you = d[0] === d[0].toUpperCase() ? "You" : "you";
          return you + " " + (VERB[v.toLowerCase()] || v);
        })
        .replace(/\b(the|this) user\b/gi, (m) => (m[0] === m[0].toUpperCase() ? "You" : "you"));
      const readThought = () => {
        // 요약 줄은 진짜 줄 + 늘 비어 있는 숨은 사본이 함께 있어서, 글자가 있는 마지막 줄을 고름
        const live = [...document.querySelectorAll('[class*="VJlF5q_summary"][data-streaming]')].map((e) => (e.textContent || "").trim()).filter(Boolean).pop();
        if (live) return live;
        // 추론이 진행 묶음 안에 접혀 있으면 요약 줄이 안 그려짐 → 묶음 제목("요청 분석 중 · <지금 문단 첫 줄>")의 뒷부분을 읽음
        //   진행 중인 묶음만 data-shimmer 가 붙고, 그 안의 두 번째 span 은 반짝이 효과용 사본이라 첫 span 만 읽음
        const live2 = [...document.querySelectorAll('button[data-process-activity="thinking"][aria-expanded="false"] [data-shimmer] > span:first-child')].pop();
        if (live2) {
          const t = live2.textContent || "", i = t.indexOf(" · ");
          if (i >= 0 && t.slice(i + 3).trim()) return t.slice(i + 3).trim();
        }
        const body = [...document.querySelectorAll('[class*="VJlF5q_thinkBody"]')].pop();   // 펼쳐 둔 경우: 마지막으로 끝난 문단
        if (!body) return "";
        const paras = (body.innerText || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
        return paras.length > 1 ? paras[paras.length - 2].split("\n")[0] : "";
      };
      const mutterCheck = () => {
        const raw = readThought();
        if (!raw || raw === lastThought) return;
        lastThought = raw;
        const now = performance.now();
        if (now - lastMutterAt < 6000 || now - lastSayAt < 2500) return;
        const line = thoughtLine(raw);
        if (!line) return;
        lastMutterAt = now;
        say(line, Math.min(5200, Math.max(3800, 1500 + line.length * 55)), true);
        if (Math.random() < 0.35) play("tilt", 1600);
      };

      // 시작 인사 (가운데 연출 중): 0.7초 뒤 5.8초 동안
      setTimeout(() => { say(TEXT.hello, 5800, false, "reaction"); play("sway", 2300); }, 700);
      window.__dsc = { say, play, setMood, flashExp, regionAt: (cx, cy) => { const h = hitAt(cx, cy); return h && touchRegion(h[0], h[1], h[2]); }, fleeX: () => fleeX, bubble: () => bubble.classList.contains("show") ? bubble.textContent : "", lines: TEXT, voice: (s) => { voiceState = s && s.speaking !== false ? s : null; } };   // 확인용
      setInterval(() => {
        const nowRunning = !!document.querySelector(UI.stop);
        if (nowRunning && !waitingKind) mutterCheck();
        const kind = document.querySelector(UI.approval + ', [class*="Zf6DNq_card"]') ? "approval"
          : document.querySelector('[class*="Nksazq_card"], [class*="wnLwla_card"]') ? "question" : null;
        if (kind !== waitingKind) {
          waitingKind = kind;
          setExp("sweat", kind === "approval");
          setExp("squint", kind === "question");
          if (kind) { say(TEXT[kind], 0, false, "reaction"); setMood("wait"); play("tilt", 1800); }
          else { setMood(running ? "work" : "idle"); if (running) hush(); }
        }
        if (nowRunning && !running) {
          running = true; lastError = -1e9;
          setExp("loading", true);
          if (!waitingKind) { say(TEXT.start, 2500, false, "reaction"); setMood("work"); play("nod", 1300); }
        } else if (!nowRunning && running) {
          running = false;
          setExp("loading", false);
          setTimeout(() => {   // 실패 문구가 늦게 그려질 수 있어 잠깐 기다림
            if (running) return;
            if (performance.now() - lastError < 8000) { flashExp("tears", 5000); flashExp("dizzy", 2500); say(TEXT.error, 5000, false, "reaction"); setMood("sad", 5000); play("droop", 2000); }
            else { flashExp("heart", 4000); flashExp("blush", 4000); say(TEXT.done, 4000, false, "reaction"); setMood("idle"); play("laugh", 1700); }
          }, 600);
        }
      }, 400);
    })().catch((e) => console.warn("DeepSeek짱 캐릭터 로드 실패:", e));
  });
})();
