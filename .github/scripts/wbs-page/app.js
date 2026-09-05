const D = JSON.parse(document.getElementById("wbs-data").textContent);
const ITEMS = D.items, GROUPS = D.groups, AFFECTS = D.affects;
const GID = Object.fromEntries(GROUPS.map(g => [g.id, g]));

// **狀態是 progress.sh 算好送過來的，這裡不重算。**
// 曾經在這裡重寫過一次，於是網頁跟指令講出不同的答案。
const KIND = { "等外部": "wait", "待裁決": "wait", "已取消": "stop", "常態": "reg", "未開始": "" };
ITEMS.forEach(it => {
  it.st = { k: KIND[it.state] ?? "", t: it.state };
  it.alarm = it.marks.includes("Alarm");
});

// **銜接清單是哪一組，用算的。** 寫死組名的話，換個命名
// （BE-G、DEP-G、EXT-G⋯⋯）整個側欄會靜靜地空掉，而且沒有人會發現。
// 定義：被別的項目寫在「阻塞」欄的那些項目，它們所屬的組。
const GAP_GROUPS = new Set(
  ITEMS.filter(i => AFFECTS[i.id] && AFFECTS[i.id].length).map(i => i.group));
const GAPS = ITEMS.filter(i => GAP_GROUPS.has(i.group));
const FE = ITEMS.filter(i => !GAP_GROUPS.has(i.group));
const wkNum = w => parseInt(String(w).match(/\d+/)[0], 10);

// 行內 markdown：粗體與行內碼。內容是我們自己寫的，但還是只認這兩種
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                      .replace(/`([^`]+)`/g, "<code>$1</code>");

const ui = { view: "grp", alarm: false, wait: false, week: null, gap: null, q: "" };
const $ = id => document.getElementById(id);

/* ── 總計 ── */
(() => {
  const c = {}; ITEMS.forEach(i => c[i.st.t] = (c[i.st.t] || 0) + 1);
  const cells = [
    ["t-go", ITEMS.length, "項工作項目"],
    ["", FE.length, "項在前端手上"],
    ["t-wait", GAPS.filter(g => g.st.t !== "已取消").length, "項待跟後端銜接"],
    ["t-stop", ITEMS.filter(i => i.st.k === "stop").length, "項已取消"],
    ["", FE.reduce((a, b) => a + b.pts, 0), "點（估的）"],
  ];
  $("tally").innerHTML = cells.map(([k, n, l]) =>
    `<div class="${k}"><b>${n}</b><span>${l}</span></div>`).join("");
})();

/* ── 每週負荷 ── */
(() => {
  const per = {};
  FE.forEach(it => it.rows.forEach(r => {
    const m = /^W(\d+)/.exec(r.week);
    if (m && /^\d+$/.test(r.pts)) per[+m[1]] = (per[+m[1]] || 0) + +r.pts;
  }));
  const ws = Object.keys(per).map(Number).sort((a, b) => a - b);
  const max = Math.max(...ws.map(w => per[w]));
  $("bars").innerHTML = ws.map(w =>
    `<button class="bar" data-w="${w}" aria-pressed="false" title="W${w}：${per[w]} 點">
       <i style="height:${Math.round(per[w] / max * 46) + 4}px"></i><b>${w}</b></button>`).join("");
  $("bars").addEventListener("click", e => {
    const b = e.target.closest(".bar"); if (!b) return;
    const w = +b.dataset.w;
    ui.week = ui.week === w ? null : w;
    ui.view = ui.week ? "wk" : ui.view;
    render();
  });
})();

/* ── 銜接清單 ── */
(() => {
  // **組名是算出來的，頁面上的字也要跟著算。** 副標寫死 `BE-G`、
  // 面板標題寫死「後端」，就是這一頁到處在抓的那種「同一件事寫兩個地方」。
  const gname = [...GAP_GROUPS].sort().join("／");
  if ($("gapname")) $("gapname").textContent = gname || "（沒有）";
  if ($("gaph")) $("gaph").textContent = gname ? `銜接清單 ${gname}` : "銜接清單（目前沒有）";
  // 一組都沒有的時候要**說出來**。留一個空的 <ul> 等於頁面在說謊：
  // 標題說有這一組，底下什麼都沒有，讀的人只會以為是還沒載入。
  if (!GAPS.length) {
    $("gaps").innerHTML = `<li class="none">沒有任何項目被寫進別的項目的「阻塞」欄
      —— 所以算不出銜接清單。要嘛真的沒有外部缺口，要嘛阻塞欄還沒填。</li>`;
    return;
  }
  $("gaps").innerHTML = GAPS.map(g => {
    const n = (AFFECTS[g.id] || []).length, dead = g.st.k === "stop";
    return `<li><button data-g="${g.id}" aria-pressed="false">
      <span class="gid2 ${dead ? "no" : ""}">${g.id}</span>
      <span class="gt"><span class="${dead ? "no" : ""}">${md(g.name)}</span>
        <span class="gc">${dead ? "已取消 · " + esc(g.reason.slice(0, 30)) :
          (g.deadline ? "決策≤W" + g.deadline + " · " : "") + (n ? "影響 " + n + " 項" : "沒有項目引用")}</span>
      </span></button></li>`;
  }).join("");
  $("gaps").addEventListener("click", e => {
    const b = e.target.closest("button[data-g]"); if (!b) return;
    ui.gap = ui.gap === b.dataset.g ? null : b.dataset.g;
    render();
  });
})();

/* ── 里程碑 ── */
$("mile").innerHTML = D.milestones.map(m =>
  `<li><span class="mw">${esc(m.w)}</span><span>${md(m.text)}</span></li>`).join("");

$("foot").innerHTML =
  `完整內容在 <code>專案-frontend/docs/WBS.md</code>，狀態用 <code>bash .github/scripts/progress.sh --all</code> 查。<br>
   <code>--check</code> 會驗這張表自己訂的規則，CI 也在跑它 ——
   但它<strong>只驗「前端工作 vs 後端決策期限」，不驗前端項目彼此的先後</strong>。
   已知的跨項依賴（${D.deps.length} 條）寫在 WBS 的〈這張表的意思〉，那一段靠人維護。`;

/* ── 控制 ── */
$("v-grp").onclick = () => { ui.view = "grp"; render(); };
$("v-wk").onclick = () => { ui.view = "wk"; render(); };
$("f-alarm").onclick = () => { ui.alarm = !ui.alarm; render(); };
$("f-wait").onclick = () => { ui.wait = !ui.wait; render(); };
$("f-clear").onclick = () => { Object.assign(ui, { alarm: false, wait: false, week: null, gap: null, q: "" }); $("q").value = ""; render(); };
$("q").addEventListener("input", e => { ui.q = e.target.value.trim().toLowerCase(); render(); });

function match(it) {
  if (ui.alarm && !it.alarm) return false;
  if (ui.wait && it.st.k !== "wait") return false;
  if (ui.week && !it.rows.some(r => new RegExp("^W" + ui.week + "\\b").test(r.week))) return false;
  if (ui.gap && !it.blockers.includes(ui.gap)) return false;
  if (ui.q && !(it.id + " " + it.name).toLowerCase().includes(ui.q)) return false;
  return true;
}

function rowHTML(it) {
  const hit = ui.gap && it.blockers.includes(ui.gap);
  // 銜接清單沒有週次 —— 它的「週」欄放的是決策期限，不是工期。
  // 少了這一行，那些項目在清單裡看起來像「忘了排」。
  const wks = it.weeks.length
    ? it.weeks.map(w => `<span class="wk">${w}</span>`).join("")
    : (it.deadline ? `<span class="wk dl">決策≤W${it.deadline}</span>` : "");
  const dep = it.blockers.length
    ? `<span class="dep" title="這幾列要跟後端對齊：${it.blockers.join("、")}">↗${it.blockers.length}</span>` : "";
  const st = it.st.t === "未開始" ? "" : `<span class="st ${it.st.k}">${it.st.t}</span>`;
  const why = it.reason ? `<p class="why">${md(it.reason)}</p>` : "";
  const subs = it.rows.map(r => {
    const wk = r.week && r.week !== "—" ? `<em>${esc(r.week)}</em>` : "";
    const pt = /^\d+$/.test(r.pts) ? `<em>${r.pts} 點</em>` : "";
    const bk = r.blk ? `<span class="dep" title="待銜接">↗</span>` : "";
    return `<li><span>${md(r.work)}</span><span class="sm">${wk}${pt}${bk}</span></li>`;
  }).join("");
  return `<div class="row${hit ? " hit" : ""}" data-id="${it.id}">
    <button class="rhead" aria-expanded="false">
      <span class="rid">${it.id}</span>
      <span class="rname">${md(it.name)}${it.alarm ? '<span class="flag">⚠</span>' : ""}</span>
      <span class="rmeta">${dep}${wks}<span class="pt">${it.pts || "—"}</span>${st}</span>
    </button>
    <div class="rbody">${why}<ul class="sub">${subs}</ul></div>
  </div>`;
}

function render() {
  $("v-grp").setAttribute("aria-pressed", ui.view === "grp");
  $("v-wk").setAttribute("aria-pressed", ui.view === "wk");
  $("f-alarm").setAttribute("aria-pressed", ui.alarm);
  $("f-wait").setAttribute("aria-pressed", ui.wait);
  [...$("bars").children].forEach(b => b.setAttribute("aria-pressed", +b.dataset.w === ui.week));
  [...$("gaps").querySelectorAll("button")].forEach(b => b.setAttribute("aria-pressed", b.dataset.g === ui.gap));

  // **銜接清單也在主清單裡。** 側欄那份只有 ID 與名稱，
  // 於是那些項目的實際內容在整頁上一個字都讀不到。側欄留著當索引與篩選器。
  const shown = ITEMS.filter(match);
  $("count").textContent = shown.length === ITEMS.length
    ? ITEMS.length + " 項" : shown.length + " / " + ITEMS.length + " 項";

  if (!shown.length) { $("list").innerHTML = `<p class="empty">沒有符合的項目。</p>`; return; }

  let html = "";
  if (ui.view === "grp") {
    // 銜接清單擺最後 —— 它不是我們的待辦，是給對方讀的
    [...GROUPS.filter(g => !GAP_GROUPS.has(g.id)),
     ...GROUPS.filter(g => GAP_GROUPS.has(g.id))].forEach(g => {
      const its = shown.filter(i => i.group === g.id); if (!its.length) return;
      const note = (GID[g.id].desc || "").split("\n").find(l => l.trim() && !l.startsWith("|")) || "";
      html += `<section class="grp"><div class="grp-h">
          <span class="gid">${g.id}</span><h2>${esc(g.title.replace(g.id, "").trim())}</h2>
          <span class="gn">${its.length} 項 · ${its.reduce((a, b) => a + b.pts, 0)} 點</span></div>
        ${note ? `<p class="grp-note">${md(note)}</p>` : ""}
        ${its.map(rowHTML).join("")}</section>`;
    });
    // **落在任何已知群組之外的項目要露出來。** 群組是從 `## <ID> 標題`
    // 解析的；標題漏寫或格式不對，那一組的項目就會從畫面上消失，
    // 而計數仍然是對的 —— 沒有任何一邊會報錯。寧可難看，不要靜靜少掉。
    const orphan = shown.filter(i => !GID[i.group]);
    if (orphan.length) {
      html += `<section class="grp"><div class="grp-h">
          <span class="gid">?</span><h2>沒有群組標題的項目</h2>
          <span class="gn">${orphan.length} 項</span></div>
        <p class="grp-note">這些項目的 <code>## ${
          [...new Set(orphan.map(o => o.group))].join("／")
        } …</code> 標題在 WBS.md 裡找不到 —— 補上標題它們就會歸位。</p>
        ${orphan.map(rowHTML).join("")}</section>`;
    }
  } else {
    const buckets = new Map();
    shown.forEach(it => {
      const k = it.weeks.length ? wkNum(it.weeks[0]) : (it.deadline || 999);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(it);
    });
    [...buckets.keys()].sort((a, b) => a - b).forEach(k => {
      const its = buckets.get(k);
      const label = k === 999 ? "沒有排程" : "W" + k;
      // 決策期限跟工期混在同一週會誤讀，所以標題要說得出來。
      // **要看 deadline，不是「沒有週次」** —— 已取消的缺口兩者都沒有，
      // 用後者數，「沒有排程」那一桶會被說成「N 項是決策期限」。
      const gaps = its.filter(i => !i.weeks.length && i.deadline).length;
      const mile = D.milestones.find(m => m.w === label);
      html += `<section class="grp"><div class="grp-h">
          <span class="gid">${label}</span><h2>${mile ? esc(mile.text.replace(/\*\*/g, "").split("。")[0]) : "尚未排程"}</h2>
          <span class="gn">${its.length} 項 · ${its.reduce((a, b) => a + b.pts, 0)} 點${
            gaps ? " · " + gaps + " 項是決策期限" : ""}</span></div>
        ${its.map(rowHTML).join("")}</section>`;
    });
  }
  $("list").innerHTML = html;
}

$("list").addEventListener("click", e => {
  const h = e.target.closest(".rhead"); if (!h) return;
  const row = h.parentElement, open = row.classList.toggle("open");
  h.setAttribute("aria-expanded", open);
});

render();
