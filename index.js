/**
 * 冷凍空調公司 · 每日開銷記帳 — Cloudflare Worker
 * 資料庫：D1 (cooling-expense-db)
 */

const CATEGORIES = {
  "機器款項": ["緯昇機器", "和美機器", "其他"],
  "冷氣材料": ["銅管", "護欄", "電源線", "安裝架", "落地架", "冷煤", "排水軟管", "排水硬管", "排水器", "管槽", "角鐵", "矽利康", "控制線", "冷氣材料", "其他"],
  "水電材料": ["馬達", "開關/插座", "水管/排水配件", "水電材料", "其他"],
  "木工材料": ["角材", "木板", "矽酸鈣板", "其他"],
  "車輛與交通": ["加油費", "停車費", "過路費", "其他"],
  "工具與設備": ["其他"],
  "人力與點工": ["冷氣點工", "水電點工", "木工點工", "其他"],
  "公司固定開銷": ["薪資", "勞健保", "車子分期", "會計費用", "其他"],
  "餐費": ["餐費", "其他"],
  "其他": ["雜項支出", "員工請款", "零用金", "待歸類項目", "其他"],
};
const PAYMENTS = ["現金", "公司戶轉帳", "現金（零用金）", "信用卡（公司卡）", "信用卡（個人代墊）", "其他"];
const HANDLERS = ["國鼎", "翁崇理", "陳睿騰", "王金水"];

/** 選到這些類別時，品名直接帶入預設值，不必再選一次（還是可以改成別的品名） */
const DEFAULT_ITEMS = { "餐費": "餐費" };

/**
 * 類別改名對照表：資料庫裡的舊紀錄還是存著舊名稱，若不轉換，報表會拆成
 * 兩個類別（舊名一列、新名一列）。讀出來時統一換成新名，畫面與統計才會合併；
 * 舊紀錄被編輯儲存時也會自然寫回新名稱，資料等於慢慢遷移過去。
 */
const CATEGORY_RENAMES = { "公司固定雜支": "公司固定開銷" };

/**
 * 品名獨立成類別：餐費本來是「公司固定開銷」底下的一個品名，現在自成一類。
 * 舊紀錄的類別欄還是寫著「公司固定開銷」，讀出來時依品名歸到新類別，報表才會
 * 立刻分開；這些紀錄被編輯儲存時也會自然寫回新類別。
 */
const ITEM_TO_CATEGORY = { "餐費": { from: "公司固定開銷", to: "餐費" } };

function catName(category, item) {
  const s = String(category || "");
  const c = CATEGORY_RENAMES[s] || s;
  const move = ITEM_TO_CATEGORY[String(item || "")];
  return move && move.from === c ? move.to : c;
}

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 台灣 UTC+8：Worker 跑在 UTC，換算後才算得出正確的「今天」
const DAY_MS = 86400000;
const TREND_DAYS = 30;
const TREND_MONTHS = 12;
const RECENT_LIMIT = 50;

function taipeiNow() {
  return new Date(Date.now() + TZ_OFFSET_MS);
}
function dayKey(d) {
  return d.toISOString().slice(0, 10);
}
function shiftMonth(key, delta) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- 靜態前端 ----
    if (path === "/" || path === "/index.html") {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 沒有 favicon 的話，每次開頁面瀏覽器都會打一次 /favicon.ico 拿到 404
    if (path === "/favicon.svg" || path === "/favicon.ico") {
      return new Response(FAVICON_SVG, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // ---- API ----
    if (path === "/api/bootstrap" && request.method === "GET") {
      return handleBootstrap(env);
    }
    if (path === "/api/expenses" && request.method === "GET") {
      return handleSearch(url, env);
    }
    if (path === "/api/expenses/month" && request.method === "GET") {
      return handleMonthScope(url, env);
    }
    if (path === "/api/expenses" && request.method === "POST") {
      return handleAdd(request, env);
    }
    const one = path.match(/^\/api\/expenses\/(\d+)$/);
    if (one && request.method === "PUT") {
      return handleUpdate(Number(one[1]), request, env);
    }
    if (one && request.method === "DELETE") {
      return handleDelete(Number(one[1]), env);
    }
    if (path === "/api/export.csv" && request.method === "GET") {
      return handleExportCsv(url, env);
    }

    return json({ error: "Not found" }, 404);
  },
};

// ---- 統計小工具 ----
function newScope() {
  return { total: 0, count: 0, cat: {}, pay: {}, person: {} };
}
function bump(map, key, amt) {
  if (!map[key]) map[key] = { total: 0, count: 0 };
  map[key].total += amt;
  map[key].count += 1;
}
function addTo(scope, row, amt) {
  scope.total += amt;
  scope.count += 1;
  bump(scope.cat, catName(row.category, row.item) || "未分類", amt);
  bump(scope.pay, String(row.payment || "").trim() || "未指定", amt);
  bump(scope.person, String(row.person || "").trim() || "未填", amt);
}
function rank(map, total) {
  return Object.keys(map)
    .map((k) => ({
      name: k,
      total: map[k].total,
      count: map[k].count,
      pct: total ? (map[k].total / total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}
function packScope(s) {
  return {
    total: s.total,
    count: s.count,
    cat: rank(s.cat, s.total),
    pay: rank(s.pay, s.total),
    person: rank(s.person, s.total),
  };
}

async function handleBootstrap(env) {
  return json(await bootstrapData(env));
}

async function bootstrapData(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM expenses ORDER BY date ASC, id ASC"
  ).all();

  const now = taipeiNow();
  const todayKey = dayKey(now);
  const curMonth = todayKey.slice(0, 7);
  const curYear = todayKey.slice(0, 4);
  const prevMonth = shiftMonth(curMonth, -1);
  const daysElapsed = Number(todayKey.slice(8, 10));

  const dayAgg = {}, monthAgg = {}, yearAgg = {};
  const scope = { month: newScope(), year: newScope(), all: newScope() };
  // 月初拿「這個月才過幾天」去比「上個月整個月」，幾乎一定是大跌，沒有參考價值；
  // 改成跟上個月同一段日子（1 號到今天的日期）比，才是同期比較
  let prevMonthToDate = 0;
  let todayTotal = 0, todayCount = 0;

  for (const r of results) {
    const amt = Number(r.amount) || 0;
    const d = String(r.date || "").slice(0, 10);
    if (!d) continue;
    const mo = d.slice(0, 7);
    const yr = d.slice(0, 4);

    dayAgg[d] = (dayAgg[d] || 0) + amt;
    monthAgg[mo] = (monthAgg[mo] || 0) + amt;
    yearAgg[yr] = (yearAgg[yr] || 0) + amt;

    addTo(scope.all, r, amt);
    if (yr === curYear) addTo(scope.year, r, amt);
    if (mo === curMonth) addTo(scope.month, r, amt);
    if (mo === prevMonth && Number(d.slice(8, 10)) <= daysElapsed) prevMonthToDate += amt;
    if (d === todayKey) { todayTotal += amt; todayCount += 1; }
  }

  // 趨勢：日/月補零，缺的日子也要佔一格，否則折線與柱狀會說謊
  const trendDay = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const k = dayKey(new Date(now.getTime() - i * DAY_MS));
    trendDay.push({ key: k, total: dayAgg[k] || 0 });
  }
  const trendMonth = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    const k = shiftMonth(curMonth, -i);
    trendMonth.push({ key: k, total: monthAgg[k] || 0 });
  }
  const trendYear = Object.keys(yearAgg)
    .sort()
    .map((k) => ({ key: k, total: yearAgg[k] }));

  const prevMonthTotal = monthAgg[prevMonth] || 0;
  const stats = {
    monthTotal: scope.month.total,
    monthCount: scope.month.count,
    prevMonthTotal,
    prevMonthToDate,
    monthDeltaPct: prevMonthToDate
      ? ((scope.month.total - prevMonthToDate) / prevMonthToDate) * 100
      : null,
    dayAvg: daysElapsed ? scope.month.total / daysElapsed : 0,
    todayTotal,
    todayCount,
    yearTotal: scope.year.total,
    count: results.length,
  };

  // 明細會按日期分組並顯示每天小計；最舊那一天若只切到一半，小計就會少算，
  // 所以往前補齊那一天的其餘紀錄
  let start = Math.max(0, results.length - RECENT_LIMIT);
  while (start > 0 && String(results[start - 1].date).slice(0, 10) === String(results[start].date).slice(0, 10)) start--;

  const recent = results
    .slice(start)
    .reverse()
    .map((r) => ({
      id: r.id,
      date: String(r.date || "").slice(0, 10),
      category: catName(r.category, r.item),
      item: r.item,
      amount: r.amount,
      payment: r.payment,
      person: r.person,
      note: r.note,
    }));

  return {
    categories: CATEGORIES,
    payments: PAYMENTS,
    handlers: HANDLERS,
    defaultItems: DEFAULT_ITEMS,
    today: todayKey,
    monthLabel: Number(curMonth.slice(5, 7)) + "月",
    stats,
    trend: { day: trendDay, month: trendMonth, year: trendYear },
    scopes: {
      month: packScope(scope.month),
      year: packScope(scope.year),
      all: packScope(scope.all),
    },
    // 經手人月度明細用的月份選擇器邊界：最早有紀錄的月份 ~ 最晚（today 或最後一筆，取較大者）
    monthRange: {
      min: results.length ? String(results[0].date).slice(0, 7) : curMonth,
      max: results.length && String(results[results.length - 1].date).slice(0, 7) > curMonth
        ? String(results[results.length - 1].date).slice(0, 7)
        : curMonth,
    },
    recent,
  };
}

/** 指定月份的支出結構（類別／支付方式／經手人）＋逐筆明細，給「經手人月度明細」用 */
async function handleMonthScope(url, env) {
  const ym = (url.searchParams.get("ym") || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return json({ error: "月份格式錯誤" }, 400);

  const { results } = await env.DB.prepare(
    "SELECT * FROM expenses WHERE date LIKE ? ORDER BY date DESC, id DESC"
  )
    .bind(ym + "%")
    .all();

  const scope = newScope();
  for (const r of results) addTo(scope, r, Number(r.amount) || 0);

  const rows = results.map((r) => ({
    id: r.id,
    date: String(r.date || "").slice(0, 10),
    category: catName(r.category, r.item),
    item: r.item,
    amount: r.amount,
    payment: r.payment,
    person: r.person,
    note: r.note,
  }));

  return json({
    month: ym,
    monthLabel: Number(ym.slice(5, 7)) + "月",
    ...packScope(scope),
    rows,
  });
}

/** 新增與編輯共用的欄位檢查，回傳 [清乾淨的值, 錯誤訊息] */
async function readExpense(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return [null, "格式錯誤"];
  }
  const { date, category, item, amount, payment, person, note } = body;
  if (!date || !category || !item || amount === undefined || amount === null || amount === "") {
    return [null, "日期、費用類別、品名、金額為必填"];
  }
  const amt = Number(amount);
  if (Number.isNaN(amt)) return [null, "金額必須是數字"];
  return [
    { date, category, item, amount: amt, payment: payment || "", person: person || "", note: note || "" },
    null,
  ];
}

async function handleAdd(request, env) {
  const [rec, err] = await readExpense(request);
  if (err) return json({ error: err }, 400);

  const res = await env.DB.prepare(
    `INSERT INTO expenses (date, category, item, amount, payment, person, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(rec.date, rec.category, rec.item, rec.amount, rec.payment, rec.person, rec.note)
    .run();

  // savedId 讓前端在明細裡標出剛存的那一筆
  const data = await bootstrapData(env);
  data.savedId = res && res.meta ? res.meta.last_row_id : null;
  return json(data);
}

async function handleUpdate(id, request, env) {
  const [rec, err] = await readExpense(request);
  if (err) return json({ error: err }, 400);

  const { results } = await env.DB.prepare("SELECT id FROM expenses WHERE id = ?").bind(id).all();
  if (!results.length) return json({ error: "找不到這筆紀錄，可能已被刪除" }, 404);

  await env.DB.prepare(
    `UPDATE expenses SET date = ?, category = ?, item = ?, amount = ?,
     payment = ?, person = ?, note = ? WHERE id = ?`
  )
    .bind(rec.date, rec.category, rec.item, rec.amount, rec.payment, rec.person, rec.note, id)
    .run();

  const data = await bootstrapData(env);
  data.savedId = id;
  return json(data);
}

async function handleDelete(id, env) {
  const { results } = await env.DB.prepare("SELECT id FROM expenses WHERE id = ?").bind(id).all();
  if (!results.length) return json({ error: "找不到這筆紀錄，可能已被刪除" }, 404);

  await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
  return handleBootstrap(env);
}

/**
 * 全形轉半形後再比對。中文輸入法在全形標點模式下打出來的是「／」(U+FF0F)、
 * 「（）」、「２０２６」，跟資料庫裡存的半形字不是同一個字元，直接比對會搜不到。
 * 查詢字串與資料兩邊都套同一套正規化，才不會出現「打得出來卻搜不到」。
 * 注意：支付方式本來就刻意用全形括號（信用卡（公司卡）），所以只正規化查詢字串
 * 會反而害那組搜不到，兩邊都要一起轉。
 */
function foldText(s) {
  return String(s ?? "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .toLowerCase();
}

/**
 * 明細列表上的日期顯示成「9/16」，資料庫存的卻是「2026-09-16」，使用者照著
 * 畫面上看到的打就搜不到。把常見的幾種寫法都放進比對字串，斜線、破折號、
 * 有沒有補零、中文的「9月16日」都能搜。
 */
function dateVariants(d) {
  const s = String(d || "").slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [s];
  const y = m[1], mo = m[2], da = m[3];
  const M = String(Number(mo)), D = String(Number(da));
  return [s, y + "/" + mo + "/" + da, y + "/" + M + "/" + D, y + "-" + M + "-" + D,
    mo + "/" + da, M + "/" + D, M + "-" + D,
    y + "年" + M + "月" + D + "日", M + "月" + D + "日"];
}

/** 搜尋全部歷史紀錄，讓舊資料也編輯得到（最近紀錄只列最新 50 筆） */
async function handleSearch(url, env) {
  const raw = (url.searchParams.get("q") || "").trim();
  if (!raw) return json({ rows: [] });
  const q = foldText(raw);

  const { results } = await env.DB.prepare(
    `SELECT id, date, category, item, amount, payment, person, note FROM expenses
     ORDER BY date DESC, id DESC`
  ).all();

  const rows = [];
  for (const r of results) {
    // \u0000 當分隔字元，避免跨欄位湊出假的命中
    const hay = foldText(
      [r.item, catName(r.category, r.item), r.person, r.note, r.payment]
        .concat(dateVariants(r.date)).join("\u0000")
    );
    if (!hay.includes(q)) continue;
    rows.push({
      id: r.id,
      date: String(r.date || "").slice(0, 10),
      category: catName(r.category, r.item),
      item: r.item,
      amount: r.amount,
      payment: r.payment,
      person: r.person,
      note: r.note,
    });
    if (rows.length >= 100) break;
  }

  return json({ rows });
}

/** 不帶參數匯出全部；帶 ?ym=2026-09 只匯出那個月，方便每月交給會計 */
async function handleExportCsv(url, env) {
  const ym = (url.searchParams.get("ym") || "").trim();
  if (ym && !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return json({ error: "月份格式錯誤" }, 400);

  const sql = "SELECT date, category, item, amount, payment, person, note FROM expenses"
    + (ym ? " WHERE date LIKE ?" : "") + " ORDER BY date ASC, id ASC";
  const stmt = env.DB.prepare(sql);
  const { results } = await (ym ? stmt.bind(ym + "%") : stmt).all();

  const headers = ["日期", "費用類別", "品名", "金額", "支付方式", "經手人 / 代墊", "發票 / 備註"];
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of results) {
    lines.push(
      [r.date, catName(r.category, r.item), r.item, r.amount, r.payment, r.person, r.note]
        .map(csvEscape)
        .join(",")
    );
  }
  const csv = "﻿" + lines.join("\r\n"); // 加 BOM 讓 Excel 開啟中文不亂碼

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="expenses' + (ym ? "-" + ym : "") + '.csv"',
    },
  });
}

/** 雪花圖示，配色沿用介面的 accent 藍 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#0E7AC0"/>
<g stroke="#fff" stroke-width="2.1" stroke-linecap="round">
<path d="M16 5.5v21M6.9 10.75l18.2 10.5M6.9 21.25l18.2-10.5"/>
<path d="M12.6 8.2 16 10.3l3.4-2.1M12.6 23.8 16 21.7l3.4 2.1"/>
</g></svg>`;

const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0F6FAE">
<title>冷凍空調 · 每日開銷</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  /* 主色是天空藍：--accent 上放白字要過 4.5:1，所以不能太淺；
     比較淺的 --sky 只拿來做漸層和裝飾，不放文字 */
  :root{
    color-scheme:light;
    --page:#F4F9FD; --surface:#FFFFFF; --raise:#F1F8FD;
    --ink:#0F2A3A; --ink-2:#34566A; --muted:#50707F;
    --line:#D5E8F5; --grid:#E7F1F8; --axis:#C2DAEA;
    --accent:#0E7AC0; --accent-deep:#0A5F96; --sky:#5DB7EF; --on-accent:#FFFFFF; --track:#E8F4FC;
    --good:#1E7A4A; --danger:#B4432B; --amber:#E39232;
    --ring:rgba(14,122,192,.18); --flash:#D3EBFB;
    --hero-a:#E3F2FC; --hero-line:#BEDEF3;
    --hdr:radial-gradient(120% 160% at 100% 0%,rgba(255,255,255,.24) 0%,rgba(255,255,255,0) 45%),
          linear-gradient(115deg,#0F6FAE 0%,#1C88CF 58%,#46ADEA 100%);
    --shadow:0 1px 2px rgba(14,122,192,.05),0 6px 18px rgba(14,122,192,.06);
    --shadow-lg:0 18px 48px rgba(9,40,64,.24);
    --ctl-h:40px;   /* 表單欄位統一高度，以下拉選單的原生高度為準 */
    --tip-bg:#0F2A3A; --tip-ink:#FFFFFF; --toast-act:#7CC8F5;
  }
  @media (prefers-color-scheme:dark){
    :root{
      color-scheme:dark;
      --page:#0D161D; --surface:#15212A; --raise:#1A2833;
      --ink:#E8F2F8; --ink-2:#B5CCDA; --muted:#8FA9B8;
      --line:#243642; --grid:#1D2B35; --axis:#2C3F4C;
      /* 深色模式的主色改用淺天空藍，按鈕上的字跟著換成深色，對比才夠 */
      --accent:#5DB7EF; --accent-deep:#8CCDF5; --sky:#3E9AD3; --on-accent:#06263A; --track:#1D2C37;
      --good:#4FBF85; --danger:#EE927C; --amber:#E8A65C;
      --ring:rgba(93,183,239,.22); --flash:#1F3E54;
      --hero-a:#173246; --hero-line:#2A4A60;
      --hdr:radial-gradient(120% 160% at 100% 0%,rgba(93,183,239,.20) 0%,rgba(93,183,239,0) 45%),
            linear-gradient(115deg,#0B3D5F 0%,#0F527F 60%,#1A6C9F 100%);
      --shadow:0 1px 3px rgba(0,0,0,.3);
      --shadow-lg:0 18px 48px rgba(0,0,0,.5);
      --tip-bg:#E8F2F8; --tip-ink:#0D161D; --toast-act:#0A5F96;
    }
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,-apple-system,sans-serif;
    background:var(--page);color:var(--ink);-webkit-font-smoothing:antialiased;padding-bottom:96px}
  .wrap{max-width:980px;margin:0 auto;padding:0 16px}

  /* ---- 頁首：KPI 卡片會往上疊在藍色區塊上 ---- */
  header{background:var(--hdr);color:#fff;padding:26px 0 66px}
  .brand{display:flex;align-items:center;gap:12px}
  .logo{width:40px;height:40px;border-radius:12px;flex:none;display:grid;place-items:center;
    background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28)}
  .logo svg{width:22px;height:22px}
  header h1{font-size:19px;font-weight:700;letter-spacing:.02em}
  header p{font-size:12.5px;opacity:.92;margin-top:2px;font-variant-numeric:tabular-nums}

  /* ---- 卡片 ---- */
  .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px;
    box-shadow:var(--shadow);scroll-margin-top:12px}
  .card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  /* nowrap 是必要的：中文可以逐字斷行，flex 會把標題壓到比內容還窄而讓字疊在一起 */
  .card h2{font-size:14.5px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:8px;white-space:nowrap}
  .card h2::before{content:"";width:3px;height:15px;background:linear-gradient(var(--sky),var(--accent));border-radius:2px;flex:none}
  .sub{font-size:11.5px;color:var(--muted);font-weight:500;margin-top:3px;padding-left:11px}
  .card-foot{display:flex;justify-content:flex-end;margin-top:18px;padding-top:14px;border-top:1px solid var(--grid)}
  .card-foot[hidden]{display:none}

  /* ---- KPI ---- */
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:-44px 0 16px;position:relative}
  .kpi{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 14px 13px;box-shadow:var(--shadow);min-width:0}
  .kpi.hero{background:linear-gradient(150deg,var(--hero-a) 0%,var(--surface) 78%);border-color:var(--hero-line)}
  .kpi.hero .val{color:var(--accent-deep)}
  .kpi.link{cursor:pointer;transition:border-color .15s,transform .15s}
  .kpi.link:hover{border-color:var(--accent)}
  .kpi .lbl{font-size:11.5px;color:var(--muted);letter-spacing:.03em}
  /* 「NT$」跟數字可以分兩行，但數字本身不斷開：手機上千萬級的金額才不會被截掉 */
  .kpi .val{font-size:23px;font-weight:700;color:var(--ink);margin-top:6px;line-height:1.12;font-variant-numeric:tabular-nums;
    display:flex;flex-wrap:wrap;align-items:baseline;column-gap:3px}
  .kpi .val small{font-size:12.5px;font-weight:500;color:var(--muted)}
  .kpi .delta{font-size:11.5px;font-weight:500;margin-top:5px;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;color:var(--muted)}
  .kpi .delta b{font-weight:700}
  .kpi .delta.up b{color:var(--danger)}
  .kpi .delta.down b{color:var(--good)}

  /* ---- 表單 ---- */
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}
  /* Grid 項目預設 min-width:auto，會依內容的「內在最小寬度」撐開所在欄軌。
     Safari 的原生日期元件內在寬度算法跟其他欄位不同，沒有這行會把日期所在的
     那一欄（跟費用類別、支付方式同欄）撐得比另一欄（品名、經手人）寬，
     兩欄看起來就不一樣寬。強制歸零讓欄軌完全照 1fr 平分。 */
  .grid>div{min-width:0}
  .full{grid-column:1/-1}
  label{display:block;font-size:12px;line-height:18px;color:var(--muted);margin-bottom:5px;font-weight:500}
  label .req{color:var(--amber)}
  /* 日期標籤右邊的「今天／昨天」：高度鎖死跟 label 一樣，隔壁金額欄的輸入框才會對齊 */
  .lbl-row{display:flex;align-items:center;justify-content:space-between;gap:8px;height:18px;margin-bottom:5px}
  .lbl-row label{margin:0}
  .chips{display:inline-flex;gap:4px}
  .chip{font-size:11.5px;font-weight:600;height:20px;line-height:20px;padding:0 9px;border-radius:999px;
    background:var(--track);color:var(--muted)}
  .chip:hover{color:var(--accent)}
  .chip[aria-pressed="true"]{background:var(--accent);color:var(--on-accent)}
  input,select,textarea{width:100%;font-family:inherit;font-size:14.5px;color:var(--ink);background:var(--raise);
    border:1px solid var(--line);border-radius:10px;padding:10px 11px;transition:border-color .15s,background .15s,box-shadow .15s}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);background:var(--surface);
    box-shadow:0 0 0 3px var(--ring)}
  input.invalid,select.invalid{border-color:var(--danger);box-shadow:0 0 0 3px rgba(180,67,43,.12)}
  select:disabled{opacity:.5;cursor:not-allowed}
  textarea{resize:vertical;min-height:44px}
  /* 日期、數字、文字、下拉的原生高度各不相同（40.5／44／38／40），
     一律鎖成同一個高度，欄位才會跟費用類別、品名對齊 */
  .grid input,.grid select{height:var(--ctl-h);min-width:0}

  /* Safari／iOS 的 input[type=date] 是原生元件，會照內容決定自己的寬高，
     不關掉 appearance 的話 width:100% 和 height 都會被忽略，欄位就比別人短或矮。
     以下把它的內部元件全部歸零，逼它跟其他欄位長得一模一樣。 */
  input[type="date"]{-webkit-appearance:none;appearance:none;
    width:100%;max-width:100%;min-width:0;display:block;
    height:var(--ctl-h);line-height:normal;text-align:left}
  input[type="date"]::-webkit-date-and-time-value{
    text-align:left;margin:0;padding:0;min-height:0;line-height:normal}
  input[type="date"]::-webkit-datetime-edit{padding:0;line-height:normal}
  input[type="date"]::-webkit-datetime-edit-fields-wrapper{padding:0}
  input[type="date"]::-webkit-inner-spin-button{display:none;-webkit-appearance:none;margin:0}
  input[type="date"]::-webkit-clear-button{display:none;-webkit-appearance:none}
  input[type="date"]::-webkit-calendar-picker-indicator{margin:0;padding:0;flex:none}
  /* 數字欄位的上下箭頭也會多佔寬度 */
  input[type="number"]{-webkit-appearance:none;appearance:none;margin:0}
  input[type="number"]::-webkit-outer-spin-button,
  input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  #amount,#e_amount{font-weight:600;font-variant-numeric:tabular-nums}
  /* 金額欄左邊固定顯示 NT$，一眼就知道這格要填錢 */
  .amt-wrap{position:relative}
  .amt-pre{position:absolute;left:11px;top:50%;transform:translateY(-50%);font-size:12px;font-weight:600;
    color:var(--muted);pointer-events:none}
  .amt-wrap input{padding-left:42px}
  /* 經手人選「其他」時才會冒出來的自由輸入欄，跟上面的下拉選單隔開一點 */
  .person-other{margin-top:8px}
  .btn-row{display:flex;gap:10px;margin-top:18px}
  button{font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;border:none;border-radius:10px;
    padding:13px 18px;transition:opacity .15s,transform .1s,background .15s,color .15s,border-color .15s}
  button:active{transform:translateY(1px)}
  button:disabled{opacity:.55;cursor:wait}
  button:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .primary{flex:1;background:var(--accent);color:var(--on-accent)}
  .primary:hover:not(:disabled){background:var(--accent-deep);color:var(--on-accent)}
  .ghost{background:var(--raise);color:var(--muted);border:1px solid var(--line)}
  .ghost:hover:not(:disabled){color:var(--ink)}
  .ghost.danger{color:var(--danger)}
  .ghost.danger:hover:not(:disabled){color:var(--danger);border-color:var(--danger)}
  #msg{display:none;padding:11px 14px;border-radius:10px;font-size:13.5px;margin-top:14px;line-height:1.5}
  #msg.ok{display:block;background:var(--raise);color:var(--good);border:1px solid var(--line)}
  #msg.err{display:block;background:var(--raise);color:var(--danger);border:1px solid var(--line)}

  /* ---- 分段控制 ---- */
  .seg{display:inline-flex;background:var(--track);border-radius:10px;padding:3px;gap:2px}
  .seg button{font-size:12.5px;font-weight:600;padding:6px 13px;border-radius:8px;background:transparent;color:var(--muted)}
  .seg button[aria-pressed="true"]{background:var(--surface);color:var(--accent);box-shadow:var(--shadow)}
  .head-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .linkbtn{background:none;border:none;font-size:12.5px;font-weight:600;color:var(--muted);padding:6px 4px}
  .linkbtn:hover{color:var(--accent)}
  .scope-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

  /* ---- 經手人月度：月份導覽 ---- */
  .month-nav{display:inline-flex;align-items:center;background:var(--track);border-radius:10px;padding:3px;gap:1px}
  .mnav-btn{background:transparent;color:var(--muted);font-size:15px;font-weight:700;padding:5px 9px;
    border-radius:8px;line-height:1;font-family:inherit}
  .mnav-btn:hover:not(:disabled){color:var(--accent);background:var(--surface)}
  .mnav-btn:disabled{opacity:.35;cursor:not-allowed}
  .mnav-label{font-size:12.5px;font-weight:600;padding:6px 10px;border-radius:8px;background:transparent;
    color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
  .mnav-label[aria-pressed="true"]{background:var(--surface);color:var(--accent);box-shadow:var(--shadow)}
  #mToday{border:1px solid var(--line);border-radius:8px}

  /* ---- 經手人月度明細（展開列） ---- */
  .pane h3{display:flex;align-items:center;gap:8px}
  .hint{font-size:11px;font-weight:500;color:var(--muted);letter-spacing:0}
  .pt-clickable{cursor:pointer}
  .pt-clickable:hover td{background:var(--raise)}
  .pt-chev{width:22px;padding-right:0}
  .chev{display:inline-block;color:var(--muted);font-size:11px;transition:transform .18s ease}
  .pt-row.open .chev{transform:rotate(90deg);color:var(--accent)}
  .pt-detail td{padding:0 8px 12px;border-bottom:1px solid var(--grid)}
  .pt-list{display:flex;flex-direction:column;gap:1px;background:var(--track);border-radius:10px;overflow:hidden}
  .pt-item{display:grid;grid-template-columns:52px 1fr auto auto;gap:10px;align-items:center;
    background:var(--surface);padding:8px 10px;font-size:12.5px}
  .pt-date{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .pt-name{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pt-meta{color:var(--muted);font-size:11px;white-space:nowrap}
  .pt-amt{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
  /* 依日期分組：日期那一行是小計，底下縮排列出當天每一筆 */
  .dg-head{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;
    background:var(--raise);padding:7px 10px;font-size:12px}
  .dg-date{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums}
  .dg-cnt{color:var(--muted);font-size:11px}
  .dg-sum{color:var(--ink-2);font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
  .dg-row{grid-template-columns:1fr auto auto;padding-left:22px}

  /* ---- 柱狀圖 ---- */
  .chart{padding-left:48px;padding-top:14px;position:relative}
  .plot{position:relative;height:190px}
  .gl{position:absolute;left:0;right:0;height:1px;background:var(--grid)}
  .gl.base{background:var(--axis)}
  .gl b{position:absolute;left:-48px;top:-8px;width:42px;text-align:right;font-size:10.5px;
    font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}
  .cols{position:absolute;inset:0;display:flex;align-items:flex-end;gap:2px}
  .col{flex:1;height:100%;display:flex;align-items:flex-end;justify-content:center;position:relative}
  .col.link{cursor:pointer}
  .col-fill{position:relative;width:100%;max-width:24px;min-height:2px;background:linear-gradient(180deg,var(--accent),var(--sky));
    border-radius:5px 5px 0 0;transition:height .4s ease}
  .col.zero .col-fill{background:var(--track)}
  .col:hover .col-fill{background:var(--accent-deep)}
  .col-tag{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:5px;
    font-size:10.5px;font-weight:700;color:var(--ink-2);white-space:nowrap;font-variant-numeric:tabular-nums}
  .xlabels{display:flex;gap:2px;margin-top:8px}
  .xlabels span{flex:1;text-align:center;font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden}
  .chart-foot{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:14px;padding-left:0;font-size:12px;color:var(--muted)}
  .chart-foot b{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums}
  .tr-link{cursor:pointer}
  .tr-link:hover td{background:var(--raise)}

  /* ---- 橫向長條清單 ---- */
  .bl{display:flex;flex-direction:column;gap:10px}
  /* 可展開的類別：整列（列＋明細）綁在一起，才不會被 .bl 的 gap 拆散 */
  .bl-group{display:flex;flex-direction:column;gap:8px}
  .bl-clickable{cursor:pointer;border-radius:8px;margin:-4px -6px;padding:4px 6px}
  .bl-clickable:hover{background:var(--raise)}
  .bl-name .chev{margin-right:4px}
  .bl-clickable.open .chev{transform:rotate(90deg);color:var(--accent)}
  .bl-clickable.open .bl-name{color:var(--ink);font-weight:600}
  .bl-detail{padding-bottom:4px}
  /* 名稱欄要放得下最長的「信用卡（個人代墊）」9 個字，否則會被截成「信用卡（個人…」 */
  .bl-row{display:grid;grid-template-columns:118px 1fr 74px 42px;align-items:center;gap:10px;font-size:12.5px}
  .bl-name{color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bl-track{height:8px;background:var(--track);border-radius:4px;overflow:hidden}
  .bl-fill{height:100%;background:linear-gradient(90deg,var(--sky),var(--accent));border-radius:0 4px 4px 0;transition:width .45s ease}
  .bl-val{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:var(--ink)}
  .bl-pct{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted);font-size:11.5px}
  .panes{display:grid;grid-template-columns:1fr 1fr;gap:24px 28px}
  .pane h3{font-size:12.5px;font-weight:700;color:var(--muted);letter-spacing:.04em;margin-bottom:13px}
  .pane.wide{grid-column:1/-1}

  /* ---- 表格 ---- */
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:11.5px;color:var(--muted);font-weight:600;padding:0 8px 9px;border-bottom:1px solid var(--line)}
  td{padding:10px 8px;border-bottom:1px solid var(--grid);vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  tfoot td{border-bottom:none;border-top:1px solid var(--line);font-weight:700;padding-top:11px}
  .t-date{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .t-cat{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:var(--track);color:var(--accent-deep);white-space:nowrap}
  .t-amt{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
  .t-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
  .t-sm{color:var(--ink-2);font-size:12.5px}
  .t-note{color:var(--muted);font-size:12px;margin-top:2px}
  .t-meta{display:none;color:var(--muted);font-size:11.5px;margin-top:3px}
  .empty,.loading{text-align:center;color:var(--muted);font-size:13px;padding:28px 0}
  .loading{animation:pulse 1.2s ease-in-out infinite}
  .export{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--accent);text-decoration:none;font-weight:600;white-space:nowrap}
  .export:hover{text-decoration:underline}

  /* ---- 紀錄明細：依日期分組，點整列開編輯 ---- */
  .day-row td{padding:16px 0 6px;border-bottom:none}
  tbody .day-row:first-child td{padding-top:2px}
  .day-bar{display:flex;align-items:baseline;gap:8px;padding:7px 10px;background:var(--raise);border-radius:9px;font-size:12px}
  .day-bar .dg-date{flex:1}
  .rec{cursor:pointer}
  .rec td{transition:background .12s}
  .rec:hover td{background:var(--raise)}
  .rec:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .t-go{width:20px;padding-left:0;color:var(--axis);font-size:18px;line-height:1.1;text-align:right}
  .rec:hover .t-go{color:var(--accent)}
  .rec.flash td{animation:flash 2s ease-out}

  /* ---- 搜尋 ---- */
  .search-wrap{position:relative}
  .search-ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--muted);pointer-events:none}
  .search{width:230px;font-size:12.5px;padding:8px 30px 8px 31px;border-radius:10px}
  .search-x{position:absolute;right:3px;top:50%;transform:translateY(-50%);background:none;color:var(--muted);
    font-size:17px;line-height:1;padding:4px 8px;border-radius:7px}
  .search-x:active{transform:translateY(-50%)}
  .search-x:hover{color:var(--ink)}

  /* ---- 編輯視窗（手機上改成從底部滑上來的面板，拇指比較好按） ---- */
  .modal{position:fixed;inset:0;z-index:60;background:rgba(8,24,36,.5);
    display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto;animation:fade .16s ease-out}
  .modal[hidden]{display:none}
  .modal-card{background:var(--surface);border:1px solid var(--line);border-radius:18px;
    padding:22px;width:100%;max-width:560px;box-shadow:var(--shadow-lg);margin:auto;animation:pop .22s cubic-bezier(.2,.8,.2,1)}
  .modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
  .modal-card h2{font-size:15px;font-weight:700;color:var(--ink);
    display:flex;align-items:center;gap:8px;white-space:nowrap}
  .modal-card h2::before{content:"";width:3px;height:15px;background:linear-gradient(var(--sky),var(--accent));border-radius:2px;flex:none}
  .x-btn{background:none;color:var(--muted);font-size:22px;font-weight:400;line-height:1;padding:4px 9px;border-radius:9px}
  .x-btn:hover{background:var(--raise);color:var(--ink)}
  .modal-msg{display:none;font-size:13px;color:var(--danger);margin-top:12px}
  .modal-msg.on{display:block}
  .modal-actions{display:flex;align-items:center;gap:8px;margin-top:20px}
  .modal-actions .spacer{flex:1}
  .modal-actions .ghost{padding:12px 14px;font-size:14px}
  .modal-actions .primary{flex:0 0 auto;min-width:128px}
  html.modal-open{overflow:hidden}

  /* ---- 浮動「記一筆」：表單捲出畫面時才出現 ---- */
  .fab{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:50;
    display:flex;align-items:center;gap:6px;padding:12px 18px 12px 15px;border-radius:999px;font-size:14.5px;
    background:var(--accent);color:var(--on-accent);box-shadow:0 8px 24px rgba(14,122,192,.35);
    opacity:0;transform:translateY(16px) scale(.96);pointer-events:none;transition:opacity .2s,transform .2s,background .15s}
  .fab.on{opacity:1;transform:none;pointer-events:auto}
  .fab:hover{background:var(--accent-deep)}
  .fab svg{width:16px;height:16px}

  /* ---- 通知（存檔、刪除、復原），固定在畫面底部，捲到哪都看得到 ---- */
  #toast{position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));z-index:80;
    display:flex;align-items:center;gap:14px;width:max-content;max-width:calc(100% - 32px);
    background:var(--tip-bg);color:var(--tip-ink);padding:11px 12px 11px 16px;border-radius:12px;
    font-size:13.5px;line-height:1.45;box-shadow:var(--shadow-lg);
    opacity:0;transform:translate(-50%,14px);pointer-events:none;transition:opacity .2s,transform .2s}
  #toast.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}
  #toast.err{box-shadow:inset 4px 0 0 var(--danger),var(--shadow-lg)}
  #toastAct{background:none;color:var(--toast-act);font-size:13.5px;font-weight:700;padding:4px 8px;border-radius:7px;white-space:nowrap}
  #toastAct[hidden]{display:none}

  /* ---- Tooltip ---- */
  #tip{position:fixed;z-index:99;pointer-events:none;opacity:0;transition:opacity .12s;
    background:var(--tip-bg);color:var(--tip-ink);border-radius:8px;padding:7px 10px;font-size:12px;line-height:1.45;
    white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.18)}
  #tip.on{opacity:1}
  #tip b{font-variant-numeric:tabular-nums}
  #tip .tk{opacity:.72;font-size:11px}

  /* ---- 動態：只在第一次載入、或使用者切換檢視時播（.anim），存檔後的重繪不重播 ---- */
  @keyframes rise{from{transform:scaleY(0)}}
  @keyframes grow{from{transform:scaleX(0)}}
  @keyframes fade{from{opacity:0}}
  @keyframes drop{from{opacity:0;transform:translateY(-4px)}}
  @keyframes pop{from{opacity:0;transform:translateY(10px) scale(.98)}}
  @keyframes sheet{from{transform:translateY(100%)}}
  @keyframes pulse{50%{opacity:.45}}
  @keyframes flash{0%,35%{background:var(--flash)}100%{background:transparent}}
  .anim .col-fill{transform-origin:bottom;animation:rise .55s cubic-bezier(.2,.8,.2,1) both}
  .anim .col-tag{animation:fade .3s .5s both}
  .anim .bl-fill{transform-origin:left;animation:grow .6s cubic-bezier(.2,.8,.2,1) both}
  .bl-detail:not([hidden]),.pt-detail:not([hidden]) .pt-list{animation:drop .2s ease-out}

  @media(max-width:820px){
    .kpis{grid-template-columns:1fr 1fr}
    .panes{grid-template-columns:1fr;gap:22px}
  }
  @media(max-width:600px){
    header{padding:22px 0 62px}
    .kpi{padding:13px 12px 12px}
    .kpi .val{font-size:20px}
    .grid{grid-template-columns:1fr}
    /* 窄螢幕：名稱與金額同一行，長條自己一行，長的中文名稱才不會被截掉 */
    .bl{gap:14px}
    .bl-row{grid-template-columns:1fr auto;grid-template-areas:"name val" "track track";gap:6px 10px}
    .bl-name{grid-area:name;white-space:normal;color:var(--ink)}
    .bl-val{grid-area:val}
    .bl-track{grid-area:track}
    .bl-pct{display:none}
    .chart{padding-left:42px}
    .gl b{left:-42px;width:36px}
    .hide-sm{display:none}
    /* 窄螢幕：類別／支付／經手人收進品名底下，品名才有寬度不會一字一行 */
    .t-meta{display:block}
    .search-wrap{flex:1}
    .search{width:100%}
    .head-tools{width:100%;justify-content:space-between;flex-wrap:nowrap}
    td,th{padding-left:5px;padding-right:5px}
    /* 窄螢幕：經手人明細的逐筆列，類別／支付方式收到第二行，才不會擠成五欄 */
    .scope-tools{width:100%;justify-content:space-between}
    .pt-item{grid-template-columns:44px 1fr auto;grid-template-areas:"date name amt" "meta meta meta";gap:3px 8px}
    .pt-date{grid-area:date}
    .pt-name{grid-area:name;white-space:normal}
    .pt-amt{grid-area:amt}
    .pt-meta{grid-area:meta}
    /* 日期分組的逐筆列沒有日期欄，品名與金額一行、支付／經手人收到第二行 */
    .dg-row{grid-template-columns:1fr auto;grid-template-areas:"name amt" "meta meta";padding-left:18px}
    .modal{padding:0}
    /* margin-top:auto 而不是 align-items:flex-end：內容比畫面高時才捲得到最上面 */
    .modal-card{margin:auto 0 0;max-width:none;border-radius:20px 20px 0 0;border-bottom:none;
      padding-bottom:calc(20px + env(safe-area-inset-bottom));animation:sheet .26s cubic-bezier(.2,.8,.2,1)}
    .modal-actions{flex-wrap:wrap}
    .modal-actions .primary{order:-1;flex:1 1 100%}
    .modal-actions .spacer{display:none}
    .modal-actions .ghost{flex:1}
    #toast{bottom:calc(80px + env(safe-area-inset-bottom))}
  }
  @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<header>
  <div class="wrap brand">
    <span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
      <path d="M16 4v24M5.6 10l20.8 12M5.6 22l20.8-12"/><path d="M12 7.2 16 9.6l4-2.4M12 24.8l4-2.4 4 2.4"/></svg></span>
    <div>
      <h1>冷凍空調 · 每日開銷</h1>
      <p id="todayLbl">&nbsp;</p>
    </div>
  </div>
</header>

<div class="wrap">
  <div class="kpis">
    <div class="kpi hero">
      <div class="lbl" id="kMonthLbl">本月支出</div>
      <div class="val"><small>NT$</small><span id="kMonth">—</span></div>
      <div class="delta" id="kDelta"></div>
    </div>
    <div class="kpi link" id="kTodayCard" tabindex="0" title="看今天的明細">
      <div class="lbl">今日支出</div>
      <div class="val"><small>NT$</small><span id="kToday">—</span></div>
      <div class="delta" id="kTodaySub"></div>
    </div>
    <div class="kpi">
      <div class="lbl">本月日均</div>
      <div class="val"><small>NT$</small><span id="kAvg">—</span></div>
      <div class="delta" id="kAvgSub"></div>
    </div>
    <div class="kpi">
      <div class="lbl">今年累計</div>
      <div class="val"><small>NT$</small><span id="kYear">—</span></div>
      <div class="delta" id="kYearSub"></div>
    </div>
  </div>

  <div class="card" id="addCard">
    <div class="card-head"><h2>記一筆支出</h2></div>
    <div class="grid">
      <div>
        <div class="lbl-row"><label for="date">日期 <span class="req">*</span></label>
          <span class="chips" id="dateChips"><button type="button" class="chip" data-day="0" aria-pressed="false">今天</button><button type="button" class="chip" data-day="-1" aria-pressed="false">昨天</button></span></div>
        <input type="date" id="date">
      </div>
      <div><label for="amount">金額 <span class="req">*</span></label>
        <div class="amt-wrap"><span class="amt-pre">NT$</span><input type="number" id="amount" inputmode="decimal" step="0.01" placeholder="0"></div></div>
      <div><label for="category">費用類別 <span class="req">*</span></label><select id="category"><option value="">請選擇</option></select></div>
      <div id="itemField"><label for="item">品名 <span class="req">*</span></label><select id="item" disabled><option value="">先選類別</option></select></div>
      <div><label for="payment">支付方式</label><select id="payment"><option value="">未指定</option></select></div>
      <div><label for="person">經手人 / 代墊</label><select id="person"><option value="">未指定</option></select>
        <input type="text" class="person-other" id="personOther" lang="zh-Hant" autocomplete="off" placeholder="輸入人名" aria-label="經手人姓名" hidden></div>
      <div class="full"><label for="note">發票 / 備註</label><textarea id="note" lang="zh-Hant" autocomplete="off" rows="1" placeholder="發票號碼、工地名稱、其他說明"></textarea></div>
    </div>
    <div class="btn-row">
      <button class="primary" id="saveBtn" type="button">儲存這筆</button>
    </div>
    <div id="msg" role="alert"></div>
  </div>

  <div class="card" id="trendCard">
    <div class="card-head">
      <div>
        <h2>支出趨勢</h2>
        <div class="sub" id="trendSub">&nbsp;</div>
      </div>
      <div class="head-tools">
        <div class="seg" id="trendSeg">
          <button data-mode="day" aria-pressed="false">每日</button>
          <button data-mode="month" aria-pressed="true">每月</button>
          <button data-mode="year" aria-pressed="false">每年</button>
        </div>
        <button class="linkbtn" id="trendView">表格</button>
      </div>
    </div>
    <div id="trendBox"><div class="loading">載入中…</div></div>
  </div>

  <div class="card" id="scopeCard">
    <div class="card-head">
      <div>
        <h2>支出結構</h2>
        <div class="sub" id="scopeSub">&nbsp;</div>
      </div>
      <div class="scope-tools">
        <div class="month-nav" id="monthNav">
          <button class="mnav-btn" id="mPrev" type="button" aria-label="上一個月">‹</button>
          <button class="mnav-label" id="mLabel" type="button" aria-pressed="true">本月</button>
          <button class="mnav-btn" id="mNext" type="button" aria-label="下一個月">›</button>
        </div>
        <button class="linkbtn" id="mToday" type="button" hidden>回本月</button>
        <div class="seg" id="scopeSeg">
          <button data-scope="year" aria-pressed="false">今年</button>
          <button data-scope="all" aria-pressed="false">全部</button>
        </div>
      </div>
    </div>
    <div class="panes" id="panes">
      <div class="pane"><h3>費用類別<span class="hint" id="catHint"></span></h3><div id="catBox"><div class="loading">載入中…</div></div></div>
      <div class="pane"><h3>支付方式</h3><div id="payBox"><div class="loading">載入中…</div></div></div>
      <div class="pane wide"><h3>經手人 / 代墊<span class="hint" id="personHint"></span></h3><div id="personBox"><div class="loading">載入中…</div></div></div>
    </div>
    <div class="card-foot" id="scopeFoot" hidden></div>
  </div>

  <div class="card" id="listCard">
    <div class="card-head">
      <div>
        <h2>紀錄明細</h2>
        <div class="sub" id="listSub">&nbsp;</div>
      </div>
      <div class="head-tools">
        <div class="search-wrap">
          <svg class="search-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.8"/><path d="m10.6 10.6 3.4 3.4"/></svg>
          <input type="text" id="search" class="search" lang="zh-Hant" autocomplete="off" placeholder="搜尋品名、人名、備註、日期" aria-label="搜尋紀錄">
          <button class="search-x" id="searchX" type="button" aria-label="清除搜尋" hidden>×</button>
        </div>
        <a class="export" href="/api/export.csv" title="下載全部紀錄">↓ <span class="hide-sm">全部 </span>CSV</a>
      </div>
    </div>
    <div id="recentBox"><div class="loading">載入中…</div></div>
  </div>
</div>

<button class="fab" id="fab" type="button" aria-label="記一筆支出"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>記一筆</button>
<div id="toast" role="status" aria-live="polite"><span id="toastText"></span><button id="toastAct" type="button" hidden></button></div>
<div id="tip"></div>

<div class="modal" id="editModal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="editTitle">
    <div class="modal-head">
      <h2 id="editTitle">編輯這筆支出</h2>
      <button class="x-btn" id="editClose" type="button" aria-label="關閉">×</button>
    </div>
    <div class="grid">
      <div><label for="e_date">日期 <span class="req">*</span></label><input type="date" id="e_date"></div>
      <div><label for="e_amount">金額 <span class="req">*</span></label>
        <div class="amt-wrap"><span class="amt-pre">NT$</span><input type="number" id="e_amount" inputmode="decimal" step="0.01"></div></div>
      <div><label for="e_category">費用類別 <span class="req">*</span></label><select id="e_category"></select></div>
      <div id="e_itemField"><label for="e_item">品名 <span class="req">*</span></label><select id="e_item"></select></div>
      <div><label for="e_payment">支付方式</label><select id="e_payment"></select></div>
      <div><label for="e_person">經手人 / 代墊</label><select id="e_person"></select>
        <input type="text" class="person-other" id="e_personOther" lang="zh-Hant" autocomplete="off" placeholder="輸入人名" aria-label="經手人姓名" hidden></div>
      <div class="full"><label for="e_note">發票 / 備註</label><textarea id="e_note" lang="zh-Hant" autocomplete="off" rows="2"></textarea></div>
    </div>
    <div id="editMsg" class="modal-msg" role="alert"></div>
    <div class="modal-actions">
      <button class="ghost danger" id="editDelete" type="button">刪除</button>
      <span class="spacer"></span>
      <button class="ghost" id="editCopy" type="button" title="把這筆的內容帶到新增表單，日期改成今天">複製一筆</button>
      <button class="ghost" id="editCancel" type="button">取消</button>
      <button class="primary" id="editSave" type="button">儲存變更</button>
    </div>
  </div>
</div>

<script>
var DATA = null;
var STATE = { trend: 'month', trendView: 'chart', scope: 'month', ym: null };
var FIRST = true;          // 第一次渲染才播數字與長條的進場動畫
var FLASH_ID = null;       // 剛存好的那一筆，明細裡閃一下讓人找得到
var LAST_POINTER = 'mouse';
var REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
// 只有滑鼠／觸控板才自動把游標放進欄位；手機一 focus 就會跳鍵盤擋住畫面
var FINE_POINTER = !!(window.matchMedia && matchMedia('(pointer: fine)').matches);

function el(id){ return document.getElementById(id); }
function nf(n){ return (Number(n)||0).toLocaleString('en-US'); }
function nf0(n){ return Math.round(Number(n)||0).toLocaleString('en-US'); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
function closest(e, sel){ return e.target.closest ? e.target.closest(sel) : null; }

/** 共用的 API 呼叫：回傳 {ok, data}，伺服器的錯誤訊息放在 data.error */
function api(url, method, body){
  var opt = { method: method || 'GET' };
  if(body){ opt.headers = {'Content-Type':'application/json'}; opt.body = JSON.stringify(body); }
  return fetch(url, opt).then(function(r){
    return r.json().then(function(d){ return {ok:r.ok, data:d}; });
  });
}

document.addEventListener('pointerdown', function(e){ LAST_POINTER = e.pointerType || 'mouse'; }, true);

/* ---------- Tooltip ---------- */
var TIP = null;
function showTip(node){
  if(!TIP) TIP = el('tip');
  var hint = node.getAttribute('data-h');
  if(hint && LAST_POINTER === 'touch') hint = '再' + hint;
  TIP.innerHTML = '<span class="tk">' + esc(node.getAttribute('data-k')) + '</span><br><b>NT$ '
    + esc(node.getAttribute('data-v')) + '</b>' + (hint ? '<br><span class="tk">' + esc(hint) + '</span>' : '');
  TIP.classList.add('on');
  var r = node.getBoundingClientRect();
  var w = TIP.offsetWidth, h = TIP.offsetHeight;
  var left = r.left + r.width/2 - w/2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  var top = r.top - h - 8;
  if(top < 8) top = r.bottom + 8;
  TIP.style.left = left + 'px'; TIP.style.top = top + 'px';
}
function hideTip(){ if(TIP) TIP.classList.remove('on'); }
document.addEventListener('mouseover', function(e){
  var t = closest(e, '[data-k]');
  if(t) showTip(t); else hideTip();
});
document.addEventListener('touchstart', function(e){
  var t = closest(e, '[data-k]');
  if(t) showTip(t); else hideTip();
}, {passive:true});
window.addEventListener('scroll', hideTip, {passive:true});

/* ---------- 通知 ---------- */
var toastTimer = null;
/** opt：{ type:'err', action:'復原', onAction:fn, ms } */
function toast(text, opt){
  opt = opt || {};
  var t = el('toast'), a = el('toastAct');
  el('toastText').textContent = text;
  t.className = 'on' + (opt.type === 'err' ? ' err' : '');
  a.hidden = !opt.action;
  a.textContent = opt.action || '';
  a.onclick = opt.action ? function(){ hideToast(); opt.onAction(); } : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opt.ms || 3800);
}
function hideToast(){ el('toast').className = ''; }

/* ---------- 格式 ---------- */
function fmtDay(k){ var p=k.split('-'); return Number(p[1])+'/'+Number(p[2]); }
var WEEKDAYS = ['日','一','二','三','四','五','六'];
function weekday(k){ return WEEKDAYS[new Date(k + 'T00:00:00Z').getUTCDay()]; }
/** 「9/16（三）」：明細按日期分組時，標上星期比較好對帳 */
function fmtDayWd(k){ return fmtDay(k) + '（' + weekday(k) + '）'; }
function fmtDateLong(k){ var p=k.split('-'); return p[0]+'年'+Number(p[1])+'月'+Number(p[2])+'日（'+weekday(k)+'）'; }
function fmtDayFull(k){ var p=k.split('-'); return p[0]+'/'+p[1]+'/'+p[2]; }
function fmtMonth(k){ var p=k.split('-'); return Number(p[1])+'月'; }
function fmtMonthFull(k){ var p=k.split('-'); return p[0]+' 年 '+Number(p[1])+' 月'; }
function fmtYear(k){ return k+' 年'; }
function addDays(k, n){
  var d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}
/** 明細的日期標題，今天／昨天直接講白 */
function dayTitle(k){
  var t = DATA && DATA.today;
  var rel = k === t ? '今天 · ' : (t && k === addDays(t, -1) ? '昨天 · ' : '');
  return rel + fmtDayWd(k);
}

/** 數字從 0 跑到目標值，只在第一次載入時播。
    動畫還沒跑完就有新數字（例如一載入馬上存了一筆）時，舊的動畫要停，不然會蓋回舊值 */
function setNum(node, v){
  var seq = node._numSeq = (node._numSeq || 0) + 1;
  if(!FIRST || REDUCED || !window.requestAnimationFrame){ node.textContent = nf0(v); return; }
  var t0 = null, dur = 700;
  requestAnimationFrame(function step(t){
    if(node._numSeq !== seq) return;
    if(t0 === null) t0 = t;
    var p = Math.min(1, (t - t0) / dur);
    node.textContent = nf0(v * (1 - Math.pow(1 - p, 3)));
    if(p < 1) requestAnimationFrame(step);
  });
}

function scrollToEl(node){
  node.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
}

/* 座標軸刻度取整：1/2/5 × 10^n */
function niceTicks(max){
  if(max <= 0) return [0];
  var raw = max/3, mag = Math.pow(10, Math.floor(Math.log(raw)/Math.LN10));
  var n = raw/mag, step = (n<1.5?1:n<3?2:n<7?5:10)*mag;
  var out = [], v = 0;
  while(v < max + step*0.001){ out.push(v); v += step; }
  // 頂端一定要留白，柱子才不會頂到天花板、標籤才有地方站
  if(out[out.length-1] <= max) out.push(out[out.length-1] + step);
  return out;
}

/* ---------- 柱狀圖 ---------- */
/** goHint 有值時，有支出的柱子可以點，跳到對應的明細 */
function columnChart(rows, fmtShort, fmtLong, labelEvery, goHint){
  if(!rows.length) return '<div class="empty">這段期間還沒有支出紀錄</div>';
  var max = rows.reduce(function(m,r){ return Math.max(m, r.total); }, 0);
  var ticks = niceTicks(max);
  var top = ticks[ticks.length-1] || 1;
  var maxIdx = -1;
  rows.forEach(function(r,i){ if(r.total > 0 && (maxIdx < 0 || r.total > rows[maxIdx].total)) maxIdx = i; });

  var gl = ticks.map(function(t){
    var pct = (t/top)*100;
    return '<div class="gl' + (t===0?' base':'') + '" style="bottom:' + pct + '%"><b>' + nf0(t) + '</b></div>';
  }).join('');

  var cols = rows.map(function(r,i){
    var h = top ? (r.total/top)*100 : 0;
    var go = goHint && r.total > 0;
    // 只標最高的那根（直接標示要克制，其餘交給座標軸與 tooltip）
    var tag = i === maxIdx ? '<div class="col-tag">' + nf0(r.total) + '</div>' : '';
    return '<div class="col' + (r.total>0?'':' zero') + (go?' link':'') + '" data-k="' + esc(fmtLong(r.key))
      + '" data-v="' + nf0(r.total) + '"' + (go ? ' data-go="' + esc(r.key) + '" data-h="' + esc(goHint) + '"' : '') + '>'
      + '<div class="col-fill" style="height:' + (r.total>0?Math.max(h,1):0) + '%;animation-delay:'
      + Math.min(i*16, 420) + 'ms">' + tag + '</div></div>';
  }).join('');

  var labels = rows.map(function(r,i){
    var show = labelEvery <= 1 || i === rows.length-1 || (rows.length-1-i) % labelEvery === 0;
    return '<span>' + (show ? esc(fmtShort(r.key)) : '') + '</span>';
  }).join('');

  var sum = rows.reduce(function(s,r){ return s + r.total; }, 0);
  var nz = rows.filter(function(r){ return r.total > 0; }).length;

  return '<div class="chart"><div class="plot">' + gl + '<div class="cols">' + cols + '</div></div>'
    + '<div class="xlabels">' + labels + '</div></div>'
    + '<div class="chart-foot"><span>合計 <b>NT$ ' + nf0(sum) + '</b></span>'
    + '<span>有支出 <b>' + nz + '</b> / ' + rows.length + '</span>'
    + '<span>最高 <b>NT$ ' + nf0(max) + '</b></span></div>';
}

function trendTable(rows, fmtLong, label, goHint){
  if(!rows.length) return '<div class="empty">這段期間還沒有支出紀錄</div>';
  var sum = rows.reduce(function(s,r){ return s+r.total; }, 0);
  var body = rows.slice().reverse().map(function(r){
    var pct = sum ? (r.total/sum*100) : 0;
    var go = goHint && r.total > 0;
    return '<tr' + (go ? ' class="tr-link" data-go="' + esc(r.key) + '" title="' + esc(goHint) + '"' : '') + '>'
      + '<td class="t-date">' + esc(fmtLong(r.key)) + '</td>'
      + '<td class="t-num">' + pct.toFixed(1) + '%</td>'
      + '<td class="t-amt">' + nf0(r.total) + '</td></tr>';
  }).join('');
  return '<table><thead><tr><th>' + label + '</th><th style="text-align:right">佔比</th>'
    + '<th style="text-align:right">金額</th></tr></thead><tbody>' + body + '</tbody>'
    + '<tfoot><tr><td>合計</td><td></td><td class="t-amt">' + nf0(sum) + '</td></tr></tfoot></table>';
}

function renderTrend(anim){
  var t = DATA.trend, box = el('trendBox');
  var cfg = {
    day:   { rows:t.day,   short:fmtDay,   long:fmtDayFull,   every:5, label:'日期', sub:'最近 30 天（含沒有支出的日子）', go:'點一下看當天明細' },
    month: { rows:t.month, short:fmtMonth, long:fmtMonthFull, every:1, label:'月份', sub:'最近 12 個月 · 點月份看當月結構', go:'點一下看這個月的結構' },
    year:  { rows:t.year,  short:fmtYear,  long:fmtYear,      every:1, label:'年份', sub:'所有有紀錄的年份', go:'' }
  }[STATE.trend];
  el('trendSub').textContent = cfg.sub;
  el('trendView').textContent = STATE.trendView === 'chart' ? '表格' : '圖表';
  box.classList.toggle('anim', !!anim);
  box.innerHTML = STATE.trendView === 'chart'
    ? columnChart(cfg.rows, cfg.short, cfg.long, cfg.every, cfg.go)
    : trendTable(cfg.rows, cfg.long, cfg.label, cfg.go);
}

/* 點柱子／表格列：月份 → 支出結構切到那個月；日期 → 明細搜尋那一天 */
var ARMED = null;
el('trendBox').addEventListener('click', function(e){
  var c = closest(e, '[data-go]');
  if(!c) return;
  // 觸控沒有 hover：第一下先看 tooltip 上的數字，再點同一根才跳過去
  if(LAST_POINTER === 'touch' && c.hasAttribute('data-k') && ARMED !== c){ ARMED = c; return; }
  ARMED = null; hideTip();
  var k = c.getAttribute('data-go');
  if(k.length === 7){ goToMonth(k, true); scrollToEl(el('scopeCard')); }
  else { setSearch(fmtDayFull(k)); scrollToEl(el('listCard')); }
});

/* ---------- 橫向長條清單 ---------- */
/** 逐筆明細清單，經手人與費用類別的下拉明細共用 */
function txList(list, metaFn, emptyText){
  if(!list || !list.length) return '<div class="empty" style="padding:8px 0">' + esc(emptyText) + '</div>';
  return '<div class="pt-list">' + list.map(function(t){
    return '<div class="pt-item"><span class="pt-date">' + esc(fmtDay(t.date)) + '</span>'
      + '<span class="pt-name">' + esc(t.item) + '</span>'
      + '<span class="pt-meta">' + esc(metaFn(t)) + '</span>'
      + '<span class="pt-amt">NT$ ' + nf0(t.amount) + '</span></div>';
  }).join('') + '</div>';
}
function groupBy(rows, keyFn){
  var out = {};
  (rows || []).forEach(function(t){ var k = keyFn(t); (out[k] = out[k] || []).push(t); });
  return out;
}
function sumAmount(list){
  return list.reduce(function(a, b){ return a + (Number(b.amount) || 0); }, 0);
}

/** 依日期分組的明細：每個日期一行小計，底下列出那天的每一筆 */
function txListByDate(list, metaFn, emptyText){
  if(!list || !list.length) return '<div class="empty" style="padding:8px 0">' + esc(emptyText) + '</div>';
  var byDate = groupBy(list, function(t){ return t.date; });
  var dates = Object.keys(byDate).sort().reverse();
  return '<div class="pt-list">' + dates.map(function(d){
    var items = byDate[d];
    return '<div class="dg-head"><span class="dg-date">' + esc(fmtDayWd(d)) + '</span>'
      + '<span class="dg-cnt">' + items.length + ' 筆</span>'
      + '<span class="dg-sum">NT$ ' + nf0(sumAmount(items)) + '</span></div>'
      + items.map(function(t){
          return '<div class="pt-item dg-row"><span class="pt-name">' + esc(t.item) + '</span>'
            + '<span class="pt-meta">' + esc(metaFn(t)) + '</span>'
            + '<span class="pt-amt">NT$ ' + nf0(t.amount) + '</span></div>';
        }).join('');
  }).join('') + '</div>';
}

/** txByCat 有值時（月度明細模式）每一列可以點開看逐筆支出 */
function barList(rows, txByCat){
  if(!rows || !rows.length) return '<div class="empty">這段期間還沒有紀錄</div>';
  var max = rows[0].total || 1;
  var canExpand = !!txByCat;
  return '<div class="bl">' + rows.map(function(r, idx){
    var w = Math.max(2, (r.total/max)*100);
    var chev = canExpand ? '<span class="chev">▸</span>' : '';
    var row = '<div class="bl-row' + (canExpand ? ' bl-clickable' : '') + '" data-idx="' + idx + '"'
      + (canExpand ? ' tabindex="0" role="button" aria-expanded="false"' : '')
      + ' data-k="' + esc(r.name) + '（' + r.count + ' 筆）" data-v="' + nf0(r.total) + '">'
      + '<div class="bl-name">' + chev + esc(r.name) + '</div>'
      + '<div class="bl-track"><div class="bl-fill" style="width:' + w + '%;animation-delay:' + Math.min(idx*45, 400) + 'ms"></div></div>'
      + '<div class="bl-val">' + nf0(r.total) + '</div>'
      + '<div class="bl-pct">' + r.pct.toFixed(0) + '%</div></div>';
    if(!canExpand) return row;
    var detail = '<div class="bl-detail" id="cd-' + idx + '" hidden>'
      + txListByDate(txByCat[r.name], function(t){
          return (t.payment || '未指定') + ' · ' + (String(t.person || '').trim() || '未填');
        }, '這個月這一類沒有明細')
      + '</div>';
    return '<div class="bl-group">' + row + detail + '</div>';
  }).join('') + '</div>';
}

/** txByPerson 有值時（月度明細模式）每一列可以點開看逐筆支出 */
function personTable(rows, txByPerson){
  if(!rows || !rows.length) return '<div class="empty">這段期間還沒有紀錄</div>';
  var max = rows[0].total || 1;
  var sum = rows.reduce(function(s,r){ return s+r.total; }, 0);
  var canExpand = !!txByPerson;
  var cols = canExpand ? 6 : 5;
  var body = rows.map(function(r, idx){
    var w = Math.max(2, (r.total/max)*100);
    var chevTd = canExpand ? '<td class="pt-chev"><span class="chev">▸</span></td>' : '';
    var detail = '';
    if(canExpand){
      var list = txByPerson[r.name] || [];
      detail = '<tr class="pt-detail" id="pd-' + idx + '" hidden><td colspan="' + cols + '">'
        + txList(list, function(t){
            return t.category + ' · ' + (t.payment || '未指定');
          }, '這個月沒有這位的明細')
        + '</td></tr>';
    }
    return '<tr class="pt-row' + (canExpand ? ' pt-clickable' : '') + '" data-idx="' + idx + '"'
      + (canExpand ? ' tabindex="0" aria-expanded="false"' : '') + '>'
      + chevTd + '<td>' + esc(r.name) + '</td>'
      + '<td class="hide-sm" style="width:30%"><div class="bl-track"><div class="bl-fill" style="width:' + w + '%;animation-delay:' + Math.min(idx*45, 400) + 'ms"></div></div></td>'
      + '<td class="t-num">' + r.count + ' 筆</td>'
      + '<td class="t-num">' + r.pct.toFixed(1) + '%</td>'
      + '<td class="t-amt">' + nf0(r.total) + '</td></tr>'
      + detail;
  }).join('');
  return '<table><thead><tr>' + (canExpand ? '<th></th>' : '') + '<th>經手人 / 代墊</th><th class="hide-sm"></th>'
    + '<th style="text-align:right">筆數</th><th style="text-align:right">佔比</th>'
    + '<th style="text-align:right">金額</th></tr></thead><tbody>' + body + '</tbody>'
    + '<tfoot><tr>' + (canExpand ? '<td></td>' : '') + '<td>合計</td><td class="hide-sm"></td><td></td><td></td>'
    + '<td class="t-amt">' + nf0(sum) + '</td></tr></tfoot></table>';
}

/** 依經手人分組逐筆支出，'' 統一併入「未填」，跟後端聚合口徑一致 */
function groupByPerson(rows){
  return groupBy(rows, function(t){ return String(t.person || '').trim() || '未填'; });
}

/* ---------- 經手人月度明細：月份選擇與快取 ---------- */
var monthCache = {};      // ym -> /api/expenses/month 回傳結果；資料一有變動就整個清掉（見 render）
var monthReqSeq = 0;      // 避免使用者連續切月份時，舊的請求晚回來蓋掉新畫面

function shiftYm(ym, delta){
  var y = Number(ym.slice(0,4)), m = Number(ym.slice(5,7));
  var d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0,7);
}
function ymLabel(ym){ return Number(ym.slice(0,4)) + '年' + Number(ym.slice(5,7)) + '月'; }

function loadMonth(ym){
  if(monthCache[ym]) return Promise.resolve(monthCache[ym]);
  return fetch('/api/expenses/month?ym=' + ym).then(function(r){ return r.json(); })
    .then(function(d){ monthCache[ym] = d; return d; });
}

function updateMonthNav(){
  var r = DATA.monthRange;
  el('mLabel').textContent = ymLabel(STATE.ym);
  el('mLabel').setAttribute('aria-pressed', String(STATE.scope === 'month'));
  el('mPrev').disabled = STATE.ym <= r.min;
  el('mNext').disabled = STATE.ym >= r.max;
  el('mToday').hidden = STATE.ym === DATA.today.slice(0,7);
}

function goToMonth(ym, anim){
  var r = DATA.monthRange;
  if(ym < r.min || ym > r.max) return;
  STATE.ym = ym;
  STATE.scope = 'month';
  Array.prototype.forEach.call(el('scopeSeg').querySelectorAll('button'), function(x){
    x.setAttribute('aria-pressed', 'false');
  });
  updateMonthNav();
  renderBreakdown(anim);
}

function renderBreakdown(anim){
  el('panes').classList.toggle('anim', !!anim);
  var foot = el('scopeFoot');
  if(STATE.scope === 'month'){
    updateMonthNav();
    var seq = ++monthReqSeq, ym = STATE.ym;
    el('catBox').innerHTML = '<div class="loading">載入中…</div>';
    el('payBox').innerHTML = '<div class="loading">載入中…</div>';
    el('personBox').innerHTML = '<div class="loading">載入中…</div>';
    el('personHint').textContent = ''; el('catHint').textContent = '';
    loadMonth(ym).then(function(d){
      if(seq !== monthReqSeq) return;   // 使用者已經切到別的月份，這筆回應過期了
      el('scopeSub').textContent = ymLabel(ym) + '共 ' + nf(d.count) + ' 筆 · NT$ ' + nf0(d.total);
      el('catHint').textContent = d.count ? '（點一列看逐筆明細）' : '';
      el('catBox').innerHTML = barList(d.cat, groupBy(d.rows, function(t){
        return t.category || '未分類';
      }));
      el('payBox').innerHTML = barList(d.pay);
      el('personHint').textContent = d.count ? '（點一列看逐筆明細）' : '';
      el('personBox').innerHTML = personTable(d.person, groupByPerson(d.rows));
      // 每月交給會計：直接下載這個月的 CSV
      foot.hidden = !d.count;
      foot.innerHTML = d.count ? '<a class="export" href="/api/export.csv?ym=' + ym + '">↓ 下載 ' + ymLabel(ym) + ' CSV</a>' : '';
    }).catch(function(err){
      if(seq !== monthReqSeq) return;
      var msg = '<div class="empty">載入失敗：' + esc(err.message) + '</div>';
      el('catBox').innerHTML = msg; el('payBox').innerHTML = msg; el('personBox').innerHTML = msg;
      foot.hidden = true;
    });
    return;
  }
  foot.hidden = true;
  el('mLabel').setAttribute('aria-pressed', 'false');
  var s = DATA.scopes[STATE.scope];
  var name = { year: '今年', all: '全部期間' }[STATE.scope];
  el('scopeSub').textContent = name + '共 ' + nf(s.count) + ' 筆 · NT$ ' + nf0(s.total);
  el('personHint').textContent = ''; el('catHint').textContent = '';
  el('catBox').innerHTML = barList(s.cat);
  el('payBox').innerHTML = barList(s.pay);
  el('personBox').innerHTML = personTable(s.person);
}

el('mPrev').addEventListener('click', function(){ goToMonth(shiftYm(STATE.ym, -1), true); });
el('mNext').addEventListener('click', function(){ goToMonth(shiftYm(STATE.ym, 1), true); });
el('mLabel').addEventListener('click', function(){ goToMonth(STATE.ym, true); });
el('mToday').addEventListener('click', function(){ goToMonth(DATA.today.slice(0,7), true); });

function toggleDetail(row, detailId){
  var detail = document.getElementById(detailId);
  if(!detail) return;
  detail.hidden = !detail.hidden;
  row.classList.toggle('open', !detail.hidden);
  row.setAttribute('aria-expanded', String(!detail.hidden));
  hideTip();   // 展開時 tooltip 還黏在原地會擋住內容
}
el('personBox').addEventListener('click', function(e){
  var row = closest(e, '.pt-clickable');
  if(row) toggleDetail(row, 'pd-' + row.getAttribute('data-idx'));
});
el('catBox').addEventListener('click', function(e){
  var row = closest(e, '.bl-clickable');
  if(row) toggleDetail(row, 'cd-' + row.getAttribute('data-idx'));
});
/* 可以點的列（不是原生按鈕）也要能用鍵盤 Enter／空白鍵操作 */
document.addEventListener('keydown', function(e){
  if(e.key !== 'Enter' && e.key !== ' ') return;
  var t = e.target;
  if(!t.matches || !t.matches('.bl-clickable,.pt-clickable,.rec,.kpi.link')) return;
  e.preventDefault();
  t.click();
});

/* ---------- 紀錄明細：依日期分組，點一筆開編輯 ---------- */
var ROWS = {};   // id -> 紀錄，編輯時直接取用

function renderList(list, emptyText){
  var box = el('recentBox');
  ROWS = {};
  var flash = FLASH_ID; FLASH_ID = null;
  if(!list || !list.length){ box.innerHTML = '<div class="empty">' + esc(emptyText) + '</div>'; return; }
  var byDate = groupBy(list, function(r){ return r.date; });
  var dates = Object.keys(byDate).sort().reverse();
  var body = dates.map(function(d){
    var items = byDate[d];
    return '<tr class="day-row"><td colspan="6"><div class="day-bar"><span class="dg-date">' + esc(dayTitle(d)) + '</span>'
      + '<span class="dg-cnt">' + items.length + ' 筆</span>'
      + '<span class="dg-sum">NT$ ' + nf0(sumAmount(items)) + '</span></div></td></tr>'
      + items.map(function(r){
          ROWS[r.id] = r;
          var meta = [r.category, r.payment, r.person].filter(function(v){ return v; }).join(' · ');
          return '<tr class="rec' + (flash != null && String(r.id) === String(flash) ? ' flash' : '') + '" data-id="' + r.id + '" tabindex="0">'
            + '<td class="hide-sm"><span class="t-cat">' + esc(r.category) + '</span></td>'
            + '<td>' + esc(r.item)
            + '<div class="t-meta">' + esc(meta) + '</div>'
            + (r.note ? '<div class="t-note">' + esc(r.note) + '</div>' : '') + '</td>'
            + '<td class="hide-sm t-sm">' + esc(r.payment) + '</td>'
            + '<td class="hide-sm t-sm">' + esc(r.person) + '</td>'
            + '<td class="t-amt">' + nf0(r.amount) + '</td>'
            + '<td class="t-go" aria-hidden="true">›</td></tr>';
        }).join('');
  }).join('');
  box.innerHTML = '<table><thead><tr><th class="hide-sm">類別</th><th>品名</th>'
    + '<th class="hide-sm">支付</th><th class="hide-sm">經手人</th>'
    + '<th style="text-align:right">金額</th><th></th></tr></thead><tbody>' + body + '</tbody></table>';
}

function renderRecent(){
  el('listSub').textContent = '最近 ' + DATA.recent.length + ' 筆 · 點一筆可以編輯、複製或刪除';
  renderList(DATA.recent, '還沒有任何紀錄，從上面記第一筆吧');
}

el('recentBox').addEventListener('click', function(e){
  var tr = closest(e, 'tr.rec');
  if(tr) openEdit(tr.getAttribute('data-id'));
});

/* ---------- 搜尋 ---------- */
var searchTimer = null, searchSeq = 0;
function runSearch(q){
  var seq = ++searchSeq;
  if(!q){ renderRecent(); return; }
  el('listSub').textContent = '搜尋「' + q + '」…';
  fetch('/api/expenses?q=' + encodeURIComponent(q))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(seq !== searchSeq) return;   // 打字很快時，舊的結果晚回來不能蓋掉新的
      el('listSub').textContent = '搜尋「' + q + '」：' + d.rows.length + ' 筆 · NT$ ' + nf0(sumAmount(d.rows))
        + (d.rows.length >= 100 ? '（只顯示前 100 筆）' : '');
      renderList(d.rows, '找不到符合「' + q + '」的紀錄');
    })
    .catch(function(err){ if(seq === searchSeq) el('listSub').textContent = '搜尋失敗：' + err.message; });
}
function setSearchBox(q){
  clearTimeout(searchTimer);
  el('search').value = q;
  el('searchX').hidden = !q;
}
function setSearch(q){ setSearchBox(q); runSearch(q.trim()); }
/** 資料變動後重畫明細：正在搜尋就重跑搜尋，不要把使用者找到一半的結果洗掉。
    一律經過 runSearch，才會讓還在路上的舊搜尋結果作廢 */
function refreshList(){ runSearch(el('search').value.trim()); }
el('search').addEventListener('input', function(){
  var q = this.value.trim();
  el('searchX').hidden = !this.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function(){ runSearch(q); }, 250);
});
el('searchX').addEventListener('click', function(){ setSearch(''); el('search').focus(); });

/* ---------- 表單共用 ---------- */
function fillSelect(sel, values, current){
  sel.innerHTML = '';
  values.forEach(function(v){
    var o = document.createElement('option'); o.value = v; o.textContent = v;
    if(v === current) o.selected = true;
    sel.appendChild(o);
  });
}
/** 經手人下拉＋「其他」自由輸入的共用邏輯（新增表單、編輯 modal 各用一份） */
function setPersonValue(selId, otherId, current){
  var sel = el(selId), other = el(otherId);
  var known = DATA.handlers.indexOf(current) >= 0;
  if(current && !known){
    sel.value = '其他'; other.hidden = false; other.value = current;
  } else {
    sel.value = known ? current : ''; other.hidden = true; other.value = '';
  }
}
function getPersonValue(selId, otherId){
  var sel = el(selId);
  return sel.value === '其他' ? el(otherId).value.trim() : sel.value;
}
function bindPersonToggle(selId, otherId){
  el(selId).addEventListener('change', function(){
    var other = el(otherId);
    if(this.value === '其他'){ other.hidden = false; other.focus(); }
    else { other.hidden = true; other.value = ''; }
  });
}

/** 必填欄位沒填的標紅框，回傳第一個沒填的欄位（讓游標跳過去） */
function checkRequired(ids){
  var first = null;
  ids.forEach(function(id){
    var n = el(id), bad = !n.value;
    n.classList.toggle('invalid', bad);
    if(bad && !first) first = n;
  });
  return first;
}
document.addEventListener('input', function(e){ if(e.target.classList) e.target.classList.remove('invalid'); });
document.addEventListener('change', function(e){ if(e.target.classList) e.target.classList.remove('invalid'); });

/** Enter 直接儲存；備註是多行，要 Ctrl／⌘＋Enter */
function enterToSave(ids, btnId){
  ids.forEach(function(id){
    el(id).addEventListener('keydown', function(e){
      // 中文輸入法選字時按的 Enter 是確認選字，不能拿來送出
      if(e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if(this.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      el(btnId).click();
    });
  });
}

/* ---------- 編輯 / 複製 / 刪除 ---------- */
function syncEditItems(current){
  var cat = el('e_category').value;
  var items = (DATA.categories[cat] || []).slice();
  // 舊資料的品名可能已經不在目前的清單裡，保留它才不會一存就被改掉
  if(current && items.indexOf(current) < 0) items.unshift(current);
  // 沒有既有品名時（例如剛改類別），有預設品名的類別直接帶入並把欄位收起來
  var def = (DATA.defaultItems || {})[cat];
  var use = def && (DATA.categories[cat] || []).indexOf(def) >= 0;
  var pick = current || (use ? def : '');
  fillSelect(el('e_item'), items, pick);
  // 舊資料的品名若跟預設不同（例如餐費類別底下存的是「其他」），還是要讓使用者看得到
  el('e_itemField').hidden = !!use && pick === def;
}

function readEditForm(){
  return { date: el('e_date').value, category: el('e_category').value, item: el('e_item').value,
    amount: el('e_amount').value, payment: el('e_payment').value,
    person: getPersonValue('e_person', 'e_personOther'), note: el('e_note').value };
}
function showEditMsg(text){ var m = el('editMsg'); m.textContent = text; m.className = 'modal-msg on'; }

var editingId = null, editReturnFocus = null;
function openEdit(id){
  var r = ROWS[id];
  if(!r) return;
  editingId = id;
  // 用鍵盤打開的，關掉後焦點要回到原本那一列；用滑鼠／手指點的就不必，免得列上多一圈外框
  try { editReturnFocus = document.activeElement.matches(':focus-visible') ? document.activeElement : null; }
  catch(e){ editReturnFocus = null; }
  el('e_date').value = r.date;
  el('e_amount').value = r.amount;
  // 類別同理：舊資料的類別若已不在清單裡，要保留它，否則下拉會自動落在第一個
  // 選項，使用者只是改個金額就會把類別默默改掉
  var cats = Object.keys(DATA.categories);
  if(r.category && cats.indexOf(r.category) < 0) cats.unshift(r.category);
  fillSelect(el('e_category'), cats, r.category);
  syncEditItems(r.item);
  fillSelect(el('e_payment'), [''].concat(DATA.payments), r.payment || '');
  el('e_payment').options[0].textContent = '未指定';
  fillSelect(el('e_person'), [''].concat(DATA.handlers, ['其他']), '');
  el('e_person').options[0].textContent = '未指定';
  el('e_person').options[el('e_person').options.length - 1].textContent = '其他（自行輸入）';
  setPersonValue('e_person', 'e_personOther', r.person || '');
  el('e_note').value = r.note || '';
  el('editMsg').className = 'modal-msg';
  ['e_date','e_amount','e_category','e_item'].forEach(function(i){ el(i).classList.remove('invalid'); });
  el('editModal').hidden = false;
  document.documentElement.classList.add('modal-open');
  hideTip();
  if(FINE_POINTER) el('e_amount').focus(); else el('editClose').focus();
}
function closeEdit(){
  el('editModal').hidden = true;
  document.documentElement.classList.remove('modal-open');
  editingId = null;
  // 焦點回到原本那一列（存檔後列表重畫過，原本的節點不在了就算了）
  if(editReturnFocus && document.body.contains(editReturnFocus) && editReturnFocus.focus) editReturnFocus.focus();
  editReturnFocus = null;
}

el('e_category').addEventListener('change', function(){ syncEditItems(''); });
bindPersonToggle('e_person', 'e_personOther');
el('editCancel').addEventListener('click', closeEdit);
el('editClose').addEventListener('click', closeEdit);
el('editModal').addEventListener('click', function(e){ if(e.target === this) closeEdit(); });
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape' && !el('editModal').hidden) closeEdit();
});

el('editSave').addEventListener('click', function(){
  var rec = readEditForm();
  var bad = checkRequired(['e_date','e_amount','e_category','e_item']);
  if(bad){ showEditMsg('日期、費用類別、品名、金額都要填。'); bad.focus(); return; }
  var btn = this, id = editingId; btn.disabled = true; btn.textContent = '儲存中…';
  api('/api/expenses/' + id, 'PUT', rec)
    .then(function(res){
      if(!res.ok) throw new Error(res.data.error || '儲存失敗');
      closeEdit();
      render(res.data);
      toast('已更新：' + rec.category + ' / ' + rec.item + ' / NT$' + nf0(rec.amount));
    })
    .catch(function(err){ showEditMsg(err.message); })
    .finally(function(){ btn.disabled = false; btn.textContent = '儲存變更'; });
});

el('editDelete').addEventListener('click', function(){
  var r = ROWS[editingId];
  if(!r) return;
  if(!confirm('確定刪除這筆？\n' + fmtDayFull(r.date) + '　' + r.item + '　NT$' + nf0(r.amount))) return;
  var btn = this; btn.disabled = true;
  api('/api/expenses/' + r.id, 'DELETE')
    .then(function(res){
      if(!res.ok) throw new Error(res.data.error || '刪除失敗');
      closeEdit();
      render(res.data);
      toast('已刪除：' + r.item + ' / NT$' + nf0(r.amount), {
        action: '復原', ms: 8000, onAction: function(){ restoreDeleted(r); } });
    })
    .catch(function(err){ showEditMsg(err.message); })
    .finally(function(){ btn.disabled = false; });
});

/** 刪錯了可以馬上救回來：用原本的內容重新新增一筆 */
function restoreDeleted(r){
  api('/api/expenses', 'POST', { date: r.date, category: r.category, item: r.item, amount: r.amount,
    payment: r.payment, person: r.person, note: r.note })
    .then(function(res){
      if(!res.ok) throw new Error(res.data.error || '復原失敗');
      render(res.data);
      toast('已復原：' + r.item + ' / NT$' + nf0(r.amount));
    })
    .catch(function(err){ toast('復原失敗：' + err.message, { type: 'err' }); });
}

/** 把編輯視窗目前的內容帶到新增表單，日期改成今天：加油、停車、點工這類重複的支出記起來最快 */
el('editCopy').addEventListener('click', function(){
  var rec = readEditForm();
  closeEdit();
  fillForm(rec);
  focusAmount();
  toast('已複製到上方表單，日期改成今天，確認後按「儲存這筆」', { ms: 5000 });
});

/* ---------- 新增表單 ---------- */
/** 依類別重建品名下拉；current 是想保留的品名（複製舊紀錄時可能已不在清單裡） */
function syncFormItems(current){
  var itemSel = el('item'), cat = el('category').value, items = DATA.categories[cat];
  itemSel.innerHTML = '';
  if(!cat || !items){
    itemSel.disabled = true; itemSel.innerHTML = '<option value="">先選類別</option>';
    el('itemField').hidden = false;
    return;
  }
  itemSel.disabled = false; itemSel.innerHTML = '<option value="">請選擇</option>';
  var list = items.slice();
  if(current && list.indexOf(current) < 0) list.unshift(current);
  list.forEach(function(i){
    var o = document.createElement('option'); o.value = i; o.textContent = i; itemSel.appendChild(o);
  });
  if(items.length === 1) itemSel.value = items[0];
  // 像「餐費」這種類別，品名就是同一個名字，直接帶進去並把整個欄位收起來
  var def = (DATA.defaultItems || {})[cat];
  var use = def && items.indexOf(def) >= 0;
  if(use) itemSel.value = def;
  if(current) itemSel.value = current;
  el('itemField').hidden = !!use && itemSel.value === def;
}

function fillForm(rec){
  el('category').value = DATA.categories[rec.category] ? rec.category : '';
  syncFormItems(rec.item);
  el('amount').value = rec.amount;
  el('payment').value = DATA.payments.indexOf(rec.payment) >= 0 ? rec.payment : '';
  setPersonValue('person', 'personOther', rec.person || '');
  el('note').value = rec.note || '';
  setDate(DATA.today);
  el('msg').className = '';
  ['date','amount','category','item'].forEach(function(i){ el(i).classList.remove('invalid'); });
}

/** 捲到表單並把游標放進金額。focus 要在點擊當下同步呼叫，iOS 才會跳出鍵盤 */
function focusAmount(){
  scrollToEl(el('addCard'));
  var a = el('amount');
  try { a.focus({ preventScroll: true }); } catch(e){ a.focus(); }
  try { a.select(); } catch(e){}
}

function setDate(k){ el('date').value = k; syncDateChips(); }
function syncDateChips(){
  var v = el('date').value;
  Array.prototype.forEach.call(el('dateChips').querySelectorAll('.chip'), function(b){
    var on = !!DATA && v === addDays(DATA.today, Number(b.getAttribute('data-day')));
    b.setAttribute('aria-pressed', String(on));
  });
}
el('dateChips').addEventListener('click', function(e){
  var b = closest(e, '.chip');
  if(!b || !DATA) return;
  setDate(addDays(DATA.today, Number(b.getAttribute('data-day'))));
  el('date').classList.remove('invalid');
});
el('date').addEventListener('change', syncDateChips);
el('date').addEventListener('input', syncDateChips);

el('category').addEventListener('change', function(){ syncFormItems(''); });
bindPersonToggle('person', 'personOther');
enterToSave(['date', 'amount', 'personOther', 'note'], 'saveBtn');
enterToSave(['e_date', 'e_amount', 'e_personOther', 'e_note'], 'editSave');

function showMsg(text, type){
  var m = el('msg'); m.textContent = text; m.className = type;
  if(type === 'ok') setTimeout(function(){ m.className=''; }, 4000);
}

el('saveBtn').addEventListener('click', function(){
  var rec = { date: el('date').value, category: el('category').value, item: el('item').value,
    amount: el('amount').value, payment: el('payment').value,
    person: getPersonValue('person', 'personOther'), note: el('note').value };
  var bad = checkRequired(['date', 'amount', 'category', 'item']);
  if(bad){ showMsg('日期、費用類別、品名、金額都要填。', 'err'); bad.focus(); return; }
  var btn = this, prevToday = DATA.today; btn.disabled = true; btn.textContent = '儲存中…';
  api('/api/expenses', 'POST', rec)
    .then(function(res){
      if(!res.ok){ throw new Error(res.data.error || '儲存失敗'); }
      setSearchBox('');   // 新增的那筆要出現在列表上，搜尋清掉（render 會重畫明細）
      render(res.data);
      el('msg').className = '';
      el('amount').value=''; el('person').value=''; el('personOther').hidden=true; el('personOther').value='';
      el('note').value='';
      // 補登過去的單據時常常一次記好幾筆同一天，選過的日期就留著；
      // 原本就是「今天」的話跟著伺服器的今天走，頁面開著跨過午夜才不會記到昨天
      setDate(rec.date === prevToday ? res.data.today : rec.date);
      toast('已存入：' + rec.category + ' / ' + rec.item + ' / NT$' + nf0(rec.amount)
        + (rec.date !== res.data.today ? '（' + fmtDayWd(rec.date) + '）' : ''));
      if(FINE_POINTER) el('amount').focus();
    })
    .catch(function(err){ showMsg('存不進去：' + err.message, 'err'); })
    .finally(function(){ btn.disabled=false; btn.textContent='儲存這筆'; });
});

/* ---------- 主渲染 ---------- */
var loadedAt = 0;
function render(data){
  var anim = FIRST;
  DATA = data;
  loadedAt = Date.now();
  monthCache = {};   // 資料有變動，月度快取一律作廢，否則支出結構會停在舊數字
  FLASH_ID = data.savedId || null;
  if(!STATE.ym) STATE.ym = data.today.slice(0,7);
  var s = data.stats;

  el('todayLbl').textContent = fmtDateLong(data.today);

  el('kMonthLbl').textContent = data.monthLabel + '支出';
  setNum(el('kMonth'), s.monthTotal);
  var dl = el('kDelta');
  dl.title = '上個月整月 NT$ ' + nf0(s.prevMonthTotal);
  if(s.monthDeltaPct === null || s.monthDeltaPct === undefined){
    dl.className = 'delta flat';
    dl.textContent = s.prevMonthTotal ? '上月同期沒有支出可比較' : '上月沒有紀錄可比較';
  } else {
    var up = s.monthDeltaPct >= 0, flat = Math.abs(s.monthDeltaPct) < 0.5;
    dl.className = 'delta ' + (flat ? 'flat' : (up ? 'up' : 'down'));
    dl.innerHTML = '<b>' + (flat ? '持平' : (up ? '▲ ' : '▼ ') + Math.abs(s.monthDeltaPct).toFixed(0) + '%') + '</b>'
      + '<span>較上月同期 NT$ ' + nf0(s.prevMonthToDate) + '</span>';
  }
  setNum(el('kToday'), s.todayTotal);
  el('kTodaySub').textContent = s.todayCount ? '今天記了 ' + nf(s.todayCount) + ' 筆 ›' : '今天還沒有支出';
  setNum(el('kAvg'), s.dayAvg);
  el('kAvgSub').textContent = data.monthLabel + '至今每日平均';
  setNum(el('kYear'), s.yearTotal);
  el('kYearSub').textContent = '今年 ' + nf(data.scopes.year.count) + ' 筆 · 全部 ' + nf(s.count) + ' 筆';

  var catSel = el('category');
  if(catSel.options.length <= 1){
    Object.keys(data.categories).forEach(function(c){
      var o = document.createElement('option'); o.value=c; o.textContent=c; catSel.appendChild(o);
    });
    var paySel = el('payment');
    data.payments.forEach(function(p){
      var o = document.createElement('option'); o.value=p; o.textContent=p; paySel.appendChild(o);
    });
    var perSel = el('person');
    data.handlers.forEach(function(h){
      var o = document.createElement('option'); o.value=h; o.textContent=h; perSel.appendChild(o);
    });
    var oOpt = document.createElement('option'); oOpt.value='其他'; oOpt.textContent='其他（自行輸入）';
    perSel.appendChild(oOpt);
  }

  renderTrend(anim);
  renderBreakdown(anim);
  refreshList();
  syncDateChips();
  FIRST = false;
}

/* ---------- 互動 ---------- */
function segBind(segId, key, after){
  el(segId).addEventListener('click', function(e){
    var b = closest(e, 'button');
    if(!b) return;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function(x){
      x.setAttribute('aria-pressed', String(x === b));
    });
    STATE[key] = b.getAttribute('data-mode') || b.getAttribute('data-scope');
    if(DATA) after(true);
  });
}
segBind('trendSeg', 'trend', renderTrend);
segBind('scopeSeg', 'scope', renderBreakdown);

el('trendView').addEventListener('click', function(){
  STATE.trendView = STATE.trendView === 'chart' ? 'table' : 'chart';
  if(DATA) renderTrend(true);
});

el('kTodayCard').addEventListener('click', function(){
  if(!DATA) return;
  setSearch(fmtDayFull(DATA.today));
  scrollToEl(el('listCard'));
});

/* 表單捲出畫面時，右下角浮出「記一筆」，不用一路滑回頂端 */
if('IntersectionObserver' in window){
  new IntersectionObserver(function(entries){
    el('fab').classList.toggle('on', !entries[0].isIntersecting);
  }).observe(el('addCard'));
}
el('fab').addEventListener('click', focusAmount);

function load(){
  return fetch('/api/bootstrap').then(function(r){ return r.json(); }).then(function(d){
    // 日期欄還停在舊的「今天」（或空白）就跟著換成新的今天；使用者自己選過別天就不動
    var follow = !el('date').value || (DATA && el('date').value === DATA.today);
    render(d);
    if(follow) setDate(d.today);
  });
}

/* 手機上頁面常常一開就是好幾個小時：切回來時資料超過 5 分鐘就重抓，
   才看得到別人剛記的帳，日期也會跨日。正在編輯就不打擾 */
document.addEventListener('visibilitychange', function(){
  if(document.visibilityState !== 'visible' || !DATA) return;
  if(Date.now() - loadedAt < 5 * 60 * 1000 || !el('editModal').hidden) return;
  load().catch(function(){});
});

load().catch(function(err){
  ['trendBox','catBox','payBox','personBox','recentBox'].forEach(function(id){
    el(id).innerHTML = '<div class="empty">載入失敗：' + esc(err.message) + '</div>';
  });
});
</script>
</body>
</html>`;
