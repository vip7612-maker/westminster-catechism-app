#!/usr/bin/env node
/**
 * Azure TTS (SunHi Neural / InJoon Neural) 로 소요리문답 전체 음성 파일 사전 생성
 *
 * 사용법:
 *   AZURE_SPEECH_KEY=<키> AZURE_SPEECH_REGION=<지역> node scripts/generate-audio.js
 *
 * 옵션:
 *   --only-missing   기존 파일 건너뜀 (기본값)
 *   --force          기존 파일도 재생성
 *   --q-only         질문만 생성
 *   --a-only         답변만 생성
 *
 * 결과: audio/q1.mp3 ~ audio/q107.mp3, audio/a1.mp3 ~ audio/a107.mp3
 *
 * 필요 Node 버전: 18 이상 (native fetch 사용)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ── 환경 변수 ────────────────────────────────────────────────
const KEY    = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION || "koreacentral";

if (!KEY) {
  console.error("❌  AZURE_SPEECH_KEY 환경 변수가 필요합니다.");
  console.error("   예) AZURE_SPEECH_KEY=xxx node scripts/generate-audio.js");
  process.exit(1);
}

// ── CLI 플래그 ───────────────────────────────────────────────
const args   = process.argv.slice(2);
const FORCE  = args.includes("--force");
const Q_ONLY = args.includes("--q-only");
const A_ONLY = args.includes("--a-only");

// ── 음성 설정 ────────────────────────────────────────────────
//   질문: 여성 호스트 SunHi (명료하고 자연스러운 진행자 톤)
//   답변: 남성 호스트 InJoon (진중하고 안정된 답변 톤)
const Q_VOICE = "ko-KR-SunHiNeural";
const A_VOICE = "ko-KR-InJoonNeural";

// ── 출력 디렉토리 ────────────────────────────────────────────
const OUT = path.join(ROOT, "audio");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// ── 데이터 로드 ──────────────────────────────────────────────
const { CATECHISM } = await import(path.join(ROOT, "data.js"));

// ── 텍스트 정제 (괄호 내용 제거, 줄바꿈 공백화) ──────────────
function cleanText(s) {
  return (s || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── SSML 생성 ────────────────────────────────────────────────
function makeSSML(text, voice) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<speak version='1.0' xml:lang='ko-KR'>
  <voice xml:lang='ko-KR' name='${voice}'>${escaped}</voice>
</speak>`;
}

// ── Azure TTS REST 호출 ──────────────────────────────────────
async function synthesize(text, voice) {
  const ssml = makeSSML(text, voice);
  const url  = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEY,
      "Content-Type":              "application/ssml+xml",
      "X-Microsoft-OutputFormat":  "audio-24khz-96kbitrate-mono-mp3",
      "User-Agent":                "catechism-tts-gen/1.0",
    },
    body: ssml,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Azure TTS ${res.status}: ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── 재시도 래퍼 (일시적 네트워크 오류 대응) ──────────────────
async function synthesizeWithRetry(text, voice, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await synthesize(text, voice);
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`  ⚠  재시도 ${i + 1}/${retries - 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ── 진행률 표시 ──────────────────────────────────────────────
function bar(done, total, width = 30) {
  const filled = Math.round((done / total) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + `] ${done}/${total}`;
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  const tasks = [];
  for (const item of CATECHISM) {
    if (!A_ONLY) tasks.push({ id: item.id, which: "q", text: item.question, voice: Q_VOICE });
    if (!Q_ONLY) tasks.push({ id: item.id, which: "a", text: item.answer,   voice: A_VOICE });
  }

  const total   = tasks.length;
  let done      = 0;
  let skipped   = 0;
  let generated = 0;

  console.log(`\n🎙  Azure TTS 음성 생성 시작`);
  console.log(`   지역: ${REGION}  |  Q 음성: ${Q_VOICE}  |  A 음성: ${A_VOICE}`);
  console.log(`   총 ${total}개 파일 (107문 × 2)\n`);

  for (const task of tasks) {
    const fname = `${task.which}${task.id}.mp3`;
    const fpath = path.join(OUT, fname);

    if (!FORCE && fs.existsSync(fpath)) {
      skipped++;
      done++;
      process.stdout.write(`\r   ${bar(done, total)}  ⏭ ${fname} 스킵`);
      continue;
    }

    try {
      const text = cleanText(task.text);
      const buf  = await synthesizeWithRetry(text, task.voice);
      fs.writeFileSync(fpath, buf);
      generated++;
      done++;
      process.stdout.write(`\r   ${bar(done, total)}  ✅ ${fname} (${(buf.length / 1024).toFixed(0)}KB)`);
    } catch (e) {
      done++;
      console.error(`\n   ❌ ${fname} 실패: ${e.message}`);
    }

    // Rate limit 방지 — 200ms 간격
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\n✅ 완료! 생성: ${generated}개, 스킵: ${skipped}개`);
  console.log(`   저장 위치: ${OUT}\n`);
}

main().catch(e => {
  console.error("\n❌ 오류:", e.message);
  process.exit(1);
});
