// 소요리문답 암송앱 — 앱 로직
// 기능: 플래시카드, TTS(묵직한 음성/남여 교차/무한반복/3단계 속도), 해설 팝업, 네비게이션

import { CATECHISM } from "./data.js";

// ============================================================
// State
// ============================================================
const STATE = {
  index: 0,         // 0..106
  flipped: false,
  speed: "normal",  // 'slow' | 'normal' | 'fast'
  playing: null,    // 'q' | 'a' | null
};

// 속도(rate) — 묵직한 낭독 톤이지만 느려서 답답하지 않도록
const RATE = { slow: 0.85, normal: 1.0, fast: 1.2 };

// ============================================================
// DOM
// ============================================================
const $ = (sel) => document.querySelector(sel);
const card = $("#card");
const qBody = $("#qBody");
const aBody = $("#aBody");
const qNoEl = $("#qNo");
const currentNoEl = $("#currentNo");
const jumpLabel = $("#jumpLabel");
const prevBtn = $("#prevBtn");
const nextBtn = $("#nextBtn");
const jumpBtn = $("#jumpBtn");
const qVoiceBtn = $("#qVoiceBtn");
const aVoiceBtn = $("#aVoiceBtn");
const explainBtn = $("#explainBtn");
const explainModal = $("#explainModal");
const explainClose = $("#explainClose");
const exNo = $("#exNo");
const exQ = $("#exQ");
const exA = $("#exA");
const exExplain = $("#exExplain");
const jumpModal = $("#jumpModal");
const jumpClose = $("#jumpClose");
const jumpGrid = $("#jumpGrid");

// ============================================================
// LocalStorage
// ============================================================
const LS = {
  load() {
    try {
      const raw = localStorage.getItem("catechism-app");
      if (!raw) return;
      const v = JSON.parse(raw);
      if (typeof v.index === "number" && v.index >= 0 && v.index < CATECHISM.length) {
        STATE.index = v.index;
      }
      if (v.speed && RATE[v.speed]) STATE.speed = v.speed;
    } catch (e) { /* noop */ }
  },
  save() {
    try {
      localStorage.setItem("catechism-app", JSON.stringify({
        index: STATE.index, speed: STATE.speed,
      }));
    } catch (e) { /* noop */ }
  }
};

// ============================================================
// 음성(TTS) 매니저 — 묵직한 낭독 톤, 무한반복, 남여 교차
// ============================================================
const TTS = (() => {
  const synth = window.speechSynthesis;
  let voicesCache = [];
  let voicesReadyResolve;
  const voicesReady = new Promise((res) => { voicesReadyResolve = res; });

  function loadVoices() {
    const v = synth.getVoices() || [];
    if (v.length > 0) {
      voicesCache = v;
      voicesReadyResolve?.(v);
    }
  }
  loadVoices();
  if (typeof synth.onvoiceschanged !== "undefined") {
    synth.addEventListener("voiceschanged", loadVoices);
  }

  // 한국어 음성 중 남/여 후보를 골라낸다.
  // iOS/macOS: Yuna(여), Heami(여) 등 — 남성 한국어가 거의 없음 → fallback은 pitch로 구분
  // Android: ko-KR-male/female 또는 Google 한국어
  // 카카오톡 인앱 브라우저: iOS WebView를 사용하므로 iOS와 동일
  function pickKoreanVoices() {
    const all = voicesCache.length ? voicesCache : (synth.getVoices() || []);
    const ko = all.filter(v => /ko[-_]?KR|Korean|한국어/i.test(v.lang + " " + v.name));
    if (ko.length === 0) return { male: null, female: null };

    // 이름으로 성별 식별 (휴리스틱)
    const isFemaleName = (n) => /female|woman|yuna|heami|sora|ko-KR-Standard-A|ko-KR-Standard-B|ko-KR-Wavenet-A|ko-KR-Wavenet-B/i.test(n);
    const isMaleName   = (n) => /male|man|jinho|ko-KR-Standard-C|ko-KR-Standard-D|ko-KR-Wavenet-C|ko-KR-Wavenet-D/i.test(n);

    const female = ko.find(v => isFemaleName(v.name)) || ko[0];
    const male   = ko.find(v => isMaleName(v.name) && v.name !== female.name) || ko[1] || ko[0];
    return { male, female };
  }

  function makeUtterance(text, gender) {
    const u = new SpeechSynthesisUtterance(text);
    const { male, female } = pickKoreanVoices();
    const v = (gender === "male" ? male : female) || male || female;
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else {
      u.lang = "ko-KR";
    }
    // 묵직한 낭독 톤 — 남성: pitch 낮게, 여성: pitch 약간 낮춰 진중하게
    u.pitch = (gender === "male") ? 0.7 : 0.95;
    // 동일 음성을 남/여로 fallback할 때 구분하기 위해 pitch 차이를 둠
    if (male && female && male.name === female.name) {
      u.pitch = (gender === "male") ? 0.55 : 1.1;
    }
    u.rate = RATE[STATE.speed] || 1.0;
    u.volume = 1.0;
    return u;
  }

  let currentToken = 0; // 재생 세션 토큰 — 변경되면 onend 무한루프 중단
  let currentUtter = null;

  function stop() {
    currentToken++;
    currentUtter = null;
    try { synth.cancel(); } catch (e) { /* noop */ }
  }

  /**
   * @param {string} text 낭독할 텍스트
   * @param {'male'|'female'} gender
   * @param {() => void} onEndOnce 한 번 재생이 끝날 때마다 호출 (반복 카운터 등)
   */
  function speakLoop(text, gender, onEndOnce) {
    stop();
    const myToken = ++currentToken;
    // currentToken은 stop() 후 다시 ++된 값. 여기서 myToken 고정.

    const fire = () => {
      if (myToken !== currentToken) return; // 다른 재생이 시작됨
      const u = makeUtterance(text, gender);
      currentUtter = u;
      u.onend = () => {
        if (myToken !== currentToken) return;
        onEndOnce && onEndOnce();
        // 짧은 간격 후 재시작 (무한반복)
        setTimeout(() => {
          if (myToken !== currentToken) return;
          fire();
        }, 700);
      };
      u.onerror = () => {
        if (myToken !== currentToken) return;
        // 일부 브라우저는 cancel 시 error 이벤트가 발생 — 토큰 검증으로 무한루프 방지됨
      };
      try {
        // iOS에서 voices가 늦게 로드되는 경우 대비
        if ((synth.getVoices() || []).length === 0) {
          voicesReady.then(() => {
            if (myToken !== currentToken) return;
            try { synth.speak(makeUtterance(text, gender)); } catch (e) { /* noop */ }
          });
        } else {
          synth.speak(u);
        }
      } catch (e) { /* noop */ }
    };
    fire();
  }

  return { speakLoop, stop, voicesReady };
})();

// ============================================================
// Render
// ============================================================
function getCurrent() { return CATECHISM[STATE.index]; }

// 홀수문(id 1,3,5...) → 남성, 짝수문(2,4,6...) → 여성
function genderForId(id) { return (id % 2 === 1) ? "male" : "female"; }

function render() {
  const item = getCurrent();
  qNoEl.textContent = String(item.id);
  currentNoEl.textContent = String(item.id);
  jumpLabel.textContent = `${item.id} 문`;
  qBody.textContent = item.question;
  aBody.textContent = item.answer;

  // 카드를 항상 질문면으로 리셋
  STATE.flipped = false;
  card.classList.remove("is-flipped");

  // 음성 정지
  stopAllVoice();

  // 네비게이션 버튼 활성/비활성
  prevBtn.disabled = STATE.index === 0;
  nextBtn.disabled = STATE.index === CATECHISM.length - 1;

  LS.save();
}

// ============================================================
// 카드 뒤집기
// ============================================================
function flipCard() {
  STATE.flipped = !STATE.flipped;
  card.classList.toggle("is-flipped", STATE.flipped);
  // 뒤집을 때 음성 정지
  stopAllVoice();
}

// 카드 영역 탭 — 단, 버튼 위에서는 뒤집지 않음
card.addEventListener("click", (e) => {
  if (e.target.closest(".icon-btn")) return;
  flipCard();
});
card.addEventListener("keydown", (e) => {
  if (e.target !== card) return;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    flipCard();
  }
});

// ============================================================
// 음성 버튼
// ============================================================
function setVoiceBtnState(which, playing) {
  const btn = which === "q" ? qVoiceBtn : aVoiceBtn;
  btn.classList.toggle("is-playing", playing);
  btn.querySelector(".btn-label").textContent = playing ? "정지" : "듣기";
}

function stopAllVoice() {
  TTS.stop();
  STATE.playing = null;
  setVoiceBtnState("q", false);
  setVoiceBtnState("a", false);
}

// TTS용 텍스트 — 데이터의 \n 줄바꿈은 공백으로 (낭독 시 어색한 끊김 방지)
function ttsText(s) { return (s || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim(); }

function toggleVoice(which) {
  const item = getCurrent();
  const text = ttsText(which === "q" ? item.question : item.answer);
  const gender = genderForId(item.id);

  if (STATE.playing === which) {
    stopAllVoice();
    return;
  }
  // 다른 면 재생 중이면 정지하고 새로 재생
  stopAllVoice();
  STATE.playing = which;
  setVoiceBtnState(which, true);
  TTS.speakLoop(text, gender);
}

qVoiceBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleVoice("q"); });
aVoiceBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleVoice("a"); });

// ============================================================
// 해설 모달
// ============================================================
function openExplain() {
  const item = getCurrent();
  exNo.textContent = String(item.id);
  exQ.textContent = item.question;
  exA.textContent = item.answer;
  exExplain.textContent = item.explanation;
  explainModal.classList.add("is-open");
  explainModal.setAttribute("aria-hidden", "false");
}
function closeExplain() {
  explainModal.classList.remove("is-open");
  explainModal.setAttribute("aria-hidden", "true");
}
explainBtn.addEventListener("click", (e) => { e.stopPropagation(); openExplain(); });
explainClose.addEventListener("click", closeExplain);
explainModal.addEventListener("click", (e) => {
  if (e.target.dataset.close === "1") closeExplain();
});

// ============================================================
// 점프 모달 (1~107)
// ============================================================
function buildJumpGrid() {
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= 107; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "jump-cell";
    b.textContent = String(i);
    b.dataset.no = String(i);
    frag.appendChild(b);
  }
  jumpGrid.appendChild(frag);
}
function openJump() {
  // 현재 번호 표시
  const cells = jumpGrid.querySelectorAll(".jump-cell");
  const currentId = getCurrent().id;
  cells.forEach((c) => c.classList.toggle("is-current", Number(c.dataset.no) === currentId));
  jumpModal.classList.add("is-open");
  jumpModal.setAttribute("aria-hidden", "false");
}
function closeJump() {
  jumpModal.classList.remove("is-open");
  jumpModal.setAttribute("aria-hidden", "true");
}
jumpBtn.addEventListener("click", openJump);
jumpClose.addEventListener("click", closeJump);
jumpModal.addEventListener("click", (e) => {
  if (e.target.dataset.close === "1") closeJump();
  const cell = e.target.closest(".jump-cell");
  if (cell) {
    STATE.index = Number(cell.dataset.no) - 1;
    closeJump();
    render();
  }
});

// ============================================================
// 네비게이션
// ============================================================
function go(delta) {
  const next = STATE.index + delta;
  if (next < 0 || next >= CATECHISM.length) return;
  STATE.index = next;
  render();
}
prevBtn.addEventListener("click", () => go(-1));
nextBtn.addEventListener("click", () => go(+1));

// 좌우 스와이프
let touchX = null;
let touchY = null;
let touchT = 0;
card.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
  touchT = Date.now();
}, { passive: true });
card.addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = (e.changedTouches[0].clientX - touchX);
  const dy = (e.changedTouches[0].clientY - touchY);
  const dt = Date.now() - touchT;
  touchX = touchY = null;
  if (dt > 600) return;
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
  if (dx < 0) go(+1); else go(-1);
}, { passive: true });

// ============================================================
// 속도 조절
// ============================================================
document.querySelectorAll(".speed-btn").forEach((b) => {
  b.addEventListener("click", () => {
    const s = b.dataset.speed;
    if (!RATE[s]) return;
    STATE.speed = s;
    document.querySelectorAll(".speed-btn").forEach((x) => x.classList.toggle("is-active", x === b));
    LS.save();
    // 재생 중이면 새 속도로 즉시 재시작
    if (STATE.playing) {
      const which = STATE.playing;
      stopAllVoice();
      STATE.playing = which;
      setVoiceBtnState(which, true);
      const item = getCurrent();
      const text = ttsText(which === "q" ? item.question : item.answer);
      TTS.speakLoop(text, genderForId(item.id));
    }
  });
});

function applySpeedUI() {
  document.querySelectorAll(".speed-btn").forEach((x) => {
    x.classList.toggle("is-active", x.dataset.speed === STATE.speed);
  });
}

// ============================================================
// 페이지 가시성 변경 / 페이지 떠남 시 음성 정지
// ============================================================
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAllVoice();
});
window.addEventListener("pagehide", stopAllVoice);
window.addEventListener("beforeunload", stopAllVoice);

// ============================================================
// Init
// ============================================================
LS.load();
buildJumpGrid();
applySpeedUI();
render();

// iOS에서 첫 사용자 액션 전까지는 voices가 비어 있을 수 있음 — 미리 워밍업
if ("speechSynthesis" in window) {
  // touchstart에서 한 번 빈 utterance를 시도하여 권한 활성화
  const warmup = () => {
    try {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* noop */ }
    document.removeEventListener("touchstart", warmup);
    document.removeEventListener("click", warmup);
  };
  document.addEventListener("touchstart", warmup, { once: true, passive: true });
  document.addEventListener("click", warmup, { once: true });
}
