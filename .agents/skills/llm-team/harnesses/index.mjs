// ─────────────────── harness registry（呼叫點只查這裡） ───────────────────
// 🔴 加一個 harness：新增 harnesses/<name>.mjs、在下面 registry 加一列——council／write／setup／usage 不用改。
//   拿掉 registry 一列或缺欄位 ⇒ 載入時就 throw（assertHarnessContract，fail-closed）。
// 🔴 HARNESSES／WRITER_HARNESSES／QUOTA_BUCKETS 的值與順序必須跟 1.14.0 的字面完全相同（既有測試有精確斷言；
//   config 錯誤訊息也印這個順序）。registry 的插入順序就是 HARNESSES 的順序，不要重排。
//   陽性對照 harnesses.test.mjs「② HARNESSES／WRITER_HARNESSES／QUOTA_BUCKETS 精確等於重構前字面」。
// 🔴 測試接縫：council.mjs runOne／write.mjs main／setup.mjs main 都接受 `deps.getHarness`（預設本檔的 getHarness），
//   測試注入假 harness 就能攔住派工，不需要逐 harness 的 deps 別名。

import { harness as agy } from './agy.mjs'
import { harness as codex } from './codex.mjs'
import { harness as claude } from './claude.mjs'
import { harness as gemini } from './gemini.mjs'
import { assertHarnessContract } from './_contract.mjs'

/** @type {Map<string, import('./_contract.mjs').Harness>} 插入順序 ＝ HARNESSES 順序（1.14.0 字面：agy, codex, claude, gemini）。 */
export const registry = new Map([
  ['agy', agy],
  ['codex', codex],
  ['claude', claude],
  ['gemini', gemini],
])

// 🔴 載入時就驗契約（不是等派工才死）：
//   事故：2026-09-22 加 gemini 複審席一共動了 5 個檔（lib／council／write／setup／test），council 的回覆正文取法三種各寫一條——
//     漏掉任一種 ⇒ 該席整輪零輸出、ticket 被 anyEmpty 擋（1.14.0 r1 sol Q3 抓的就是這類「呼叫點自己認名字」的漏網）。
//   陽性對照：harnesses.test.mjs ①「{name:'agy'} 缺一堆 ⇒ throw 點名缺的欄」「canReview:true 但沒 review ⇒ 拒」。
//   停止條件：harness 模組改由 TypeScript 型別或 schema 檔（例如 JSON Schema 驗 harness 物件）在 CI 驗證時，本段撤。
for (const [name, h] of registry) {
  assertHarnessContract(h)
  if (h.name !== name) throw new Error(`harness registry 鍵 ${JSON.stringify(name)} 與模組 name ${JSON.stringify(h.name)} 不符`)
}

export const HARNESSES = [...registry.keys()]
export const WRITER_HARNESSES = HARNESSES.filter((n) => registry.get(n).canWrite)
export const REVIEWER_HARNESSES = HARNESSES.filter((n) => registry.get(n).canReview)
export const COORDINATOR_HARNESSES = HARNESSES.filter((n) => registry.get(n).canCoordinate)

// 🔴 2026-09-22 Fergus 定案：不再吃 agy 訂閱額度當複審席，改直接用 Gemini CLI（按量計費）。
//   `gemini` 桶＝agy 的 Antigravity 訂閱額度（不動）；`gemini-api` 桶＝Gemini CLI 直接的按量計費額度——
//   兩者是不同的資源池，統整者與複審者的「不同桶」不變式要能分辨這兩種 Gemini 用量互不相抵。
// 既有字面（順序要保留）∪ 各 harness 的 quotaBuckets；新 harness 帶新桶就自動進清單（排在既有字面之後）。
const LEGACY_QUOTA_BUCKETS = ['anthropic', 'gemini', 'agy-claude', 'openai', 'gemini-api']
export const QUOTA_BUCKETS = [...new Set([...LEGACY_QUOTA_BUCKETS, ...HARNESSES.flatMap((n) => registry.get(n).quotaBuckets)])]

/** 查 harness；未知 ⇒ throw（訊息列出准許清單）。 */
export function getHarness(name) {
  const h = registry.get(name)
  if (!h) throw new Error(`未知 harness ${JSON.stringify(name)}，只准 ${HARNESSES.join('|')}`)
  return h
}

export function hasHarness(name) {
  return registry.has(name)
}

/** usage.mjs 用：這個 harness 有沒有 Claude Code transcript 可量（未知 harness ⇒ false，不 throw——量測端 fail-safe 記 measurable:false）。 */
export function isTranscriptMeasurable(name) {
  return registry.has(name) && registry.get(name).transcriptMeasurable === true
}
