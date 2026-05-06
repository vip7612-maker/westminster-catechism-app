#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(__dirname, "..", "data.js");
const src = readFileSync(dataPath, "utf8");

const mod = await import("file://" + dataPath);
const data = mod.CATECHISM ?? mod.default;

const errors = [];
const push = (msg) => errors.push(msg);

if (!Array.isArray(data)) push("CATECHISM은 배열이어야 합니다.");
if (data.length !== 107) push(`문답 개수가 107이 아님: ${data.length}`);

const seen = new Set();
for (const item of data) {
  const { id, question, answer, explanation } = item ?? {};
  if (typeof id !== "number") push(`id 누락/형식오류: ${JSON.stringify(item)}`);
  if (seen.has(id)) push(`중복 id: ${id}`);
  seen.add(id);
  if (!question || question.trim().length < 3) push(`#${id} question 비어있음/너무짧음`);
  if (!answer || answer.trim().length < 3) push(`#${id} answer 비어있음/너무짧음`);
  if (!explanation || explanation.trim().length < 3) push(`#${id} explanation 비어있음/너무짧음`);
}

for (let i = 1; i <= 107; i++) {
  if (!seen.has(i)) push(`누락된 문번호: ${i}`);
}

if (errors.length === 0) {
  console.log(`OK: 107문 데이터 무결성 통과 (총 ${data.length}개)`);
  console.log(`샘플 #1: ${data[0].question.slice(0, 30)}…`);
  console.log(`샘플 #107: ${data[106].question.slice(0, 30)}…`);
  process.exit(0);
} else {
  console.error("FAIL:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
