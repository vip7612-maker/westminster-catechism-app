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

// 속도(rate) — 자연스러운 팟캐스트 페이스
const RATE = { slow: 0.82, normal: 0.95, fast: 1.15 };

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
// 음성(TTS) 매니저 — 사전 생성 MP3 우선, Web Speech API 폴백
// ============================================================
const TTS = (() => {
  // ── HTML5 Audio (사전 생성 파일) ─────────────────────────────
  let currentAudio = null;
  let audioToken   = 0;

  // ── Web Speech API (폴백) ─────────────────────────────────────
  const synth = window.speechSynthesis;
  let voicesCache = [];
  let voicesReadyResolve;
  const voicesReady = new Promise((res) => { voicesReadyResolve = res; });

  function loadVoices() {
    const v = synth.getVoices() || [];
    if (v.length > 0) { voicesCache = v; voicesReadyResolve?.(v); }
  }
  loadVoices();
  if (typeof synth.onvoiceschanged !== "undefined") {
    synth.addEventListener("voiceschanged", loadVoices);
  }

  function voiceQualityTier(v) {
    const n = v.name.toLowerCase();
    if (/premium|enhanced/i.test(n)) return 0;
    if (/neural|wavenet/i.test(n)) return 1;
    if (/google/i.test(n)) return 2;
    return 3;
  }

  function pickKoreanVoices() {
    const all = voicesCache.length ? voicesCache : (synth.getVoices() || []);
    const ko  = all.filter(v => /ko[-_]?KR|Korean|한국어/i.test(v.lang + " " + v.name));
    if (ko.length === 0) return { male: null, female: null };
    const sorted = [...ko].sort((a, b) => voiceQualityTier(a) - voiceQualityTier(b));
    const isF = (n) => /female|woman|yuna|heami|sora|Standard-A|Standard-B|Wavenet-A|Wavenet-B/i.test(n);
    const isM = (n) => /male|man|jinho|Standard-C|Standard-D|Wavenet-C|Wavenet-D/i.test(n);
    const female = sorted.find(v => isF(v.name)) || sorted[0];
    const male   = sorted.find(v => isM(v.name) && v.name !== female.name)
                || sorted.find(v => v.name !== female.name)
                || sorted[0];
    return { male, female };
  }

  function makeUtterance(text, gender) {
    const u = new SpeechSynthesisUtterance(text);
    const { male, female } = pickKoreanVoices();
    const v = (gender === "male" ? male : female) || male || female;
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "ko-KR"; }
    u.pitch  = 1.0;
    if (male && female && male.name === female.name) {
      u.pitch = (gender === "male") ? 0.85 : 1.1;
    }
    u.rate   = RATE[STATE.speed] || 1.0;
    u.volume = 1.0;
    return u;
  }

  let synthToken = 0;

  function stopSynth() {
    synthToken++;
    try { synth.cancel(); } catch (e) { /* noop */ }
  }

  function speakLoopWeb(text, gender) {
    stopSynth();
    const myToken = ++synthToken;
    const fire = () => {
      if (myToken !== synthToken) return;
      const u = makeUtterance(text, gender);
      u.onend  = () => {
        if (myToken !== synthToken) return;
        setTimeout(() => { if (myToken !== synthToken) return; fire(); }, 700);
      };
      u.onerror = () => { /* cancel 이벤트 등 무시 */ };
      try {
        if ((synth.getVoices() || []).length === 0) {
          voicesReady.then(() => {
            if (myToken !== synthToken) return;
            try { synth.speak(makeUtterance(text, gender)); } catch (e) { /* noop */ }
          });
        } else { synth.speak(u); }
      } catch (e) { /* noop */ }
    };
    fire();
  }

  function stop() {
    audioToken++;
    if (currentAudio) { try { currentAudio.pause(); } catch (e) { /* noop */ } currentAudio = null; }
    stopSynth();
  }

  /**
   * @param {string} text    낭독 텍스트 (폴백용)
   * @param {'male'|'female'} gender  폴백 성별
   * @param {string} [src]   사전 생성 MP3 경로 (없으면 Web Speech API만 사용)
   */
  function speakLoop(text, gender, src) {
    stop();
    const myToken = ++audioToken;

    if (src) {
      const tryAudio = () => {
        if (myToken !== audioToken) return;
        const audio          = new Audio(src);
        audio.playbackRate   = RATE[STATE.speed] || 1.0;
        currentAudio         = audio;

        audio.onerror = () => {
          if (myToken !== audioToken) return;
          speakLoopWeb(text, gender);   // 파일 없음 → 폴백
        };
        audio.onended = () => {
          if (myToken !== audioToken) return;
          setTimeout(() => { if (myToken !== audioToken) return; tryAudio(); }, 500);
        };
        audio.play().catch(() => {
          if (myToken !== audioToken) return;
          speakLoopWeb(text, gender);
        });
      };
      tryAudio();
    } else {
      speakLoopWeb(text, gender);
    }
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

// TTS용 텍스트 — 괄호 안 중복 설명 제거, 줄바꿈은 공백으로
function ttsText(s) {
  return (s || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 음성 재생 시작 — 사전 생성 MP3(audio/{which}{id}.mp3) 우선, 없으면 Web Speech API
function startVoice(which) {
  const item   = getCurrent();
  const text   = ttsText(which === "q" ? item.question : item.answer);
  const gender = genderForId(item.id);
  const src    = `./audio/${which}${item.id}.mp3`;
  STATE.playing = which;
  setVoiceBtnState(which, true);
  TTS.speakLoop(text, gender, src);
}

function toggleVoice(which) {
  if (STATE.playing === which) { stopAllVoice(); return; }
  stopAllVoice();
  startVoice(which);
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
      startVoice(which);
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

// 데이터 로딩 실패 감지 — 3초 후에도 "로딩 중" 텍스트면 새로고침 안내
setTimeout(() => {
  const qb = document.getElementById("qBody");
  if (qb && qb.textContent.trim() === "질문 로딩 중…") {
    qb.innerHTML = `데이터를 불러오지 못했습니다.<br>
      <button onclick="location.reload(true)"
        style="margin-top:12px;padding:8px 20px;border-radius:8px;
               background:#c9a84c;color:#0e1c2e;border:none;
               font-size:15px;cursor:pointer;font-weight:600;">
        새로고침
      </button>`;
  }
}, 3000);

// iOS AudioContext/Speech 권한 워밍업 — 첫 사용자 인터랙션에서 활성화
const warmup = () => {
  // Web Speech API 워밍업 (폴백 대비)
  if ("speechSynthesis" in window) {
    try {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* noop */ }
  }
  // HTML5 Audio 워밍업 — 짧은 무음으로 autoplay 정책 해제
  try {
    const a = new Audio();
    a.volume = 0;
    a.play().catch(() => { /* 정상 */ });
  } catch (e) { /* noop */ }
};
document.addEventListener("touchstart", warmup, { once: true, passive: true });
document.addEventListener("click",      warmup, { once: true });
