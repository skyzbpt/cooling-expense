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
      return handleExportCsv(env);
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
  const { results } = await env.DB.prepare(
    "SELECT * FROM expenses ORDER BY date ASC, id ASC"
  ).all();

  const now = taipeiNow();
  const todayKey = dayKey(now);
  const curMonth = todayKey.slice(0, 7);
  const curYear = todayKey.slice(0, 4);
  const prevMonth = shiftMonth(curMonth, -1);

  const dayAgg = {}, monthAgg = {}, yearAgg = {};
  const scope = { month: newScope(), year: newScope(), all: newScope() };

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
  const daysElapsed = Number(todayKey.slice(8, 10));
  const stats = {
    monthTotal: scope.month.total,
    monthCount: scope.month.count,
    prevMonthTotal,
    monthDeltaPct: prevMonthTotal
      ? ((scope.month.total - prevMonthTotal) / prevMonthTotal) * 100
      : null,
    dayAvg: daysElapsed ? scope.month.total / daysElapsed : 0,
    yearTotal: scope.year.total,
    count: results.length,
  };

  const recent = results
    .slice(-50)
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

  return json({
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
  });
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

  await env.DB.prepare(
    `INSERT INTO expenses (date, category, item, amount, payment, person, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(rec.date, rec.category, rec.item, rec.amount, rec.payment, rec.person, rec.note)
    .run();

  return handleBootstrap(env);
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

  return handleBootstrap(env);
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
    //   當分隔字元，避免跨欄位湊出假的命中
    const hay = foldText(
      [r.item, catName(r.category, r.item), r.person, r.note, r.payment, r.date].join(" ")
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

async function handleExportCsv(env) {
  const { results } = await env.DB.prepare(
    "SELECT date, category, item, amount, payment, person, note FROM expenses ORDER BY date ASC, id ASC"
  ).all();

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
      "Content-Disposition": 'attachment; filename="expenses.csv"',
    },
  });
}

/** 雪花圖示，配色沿用介面的 accent 藍 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#2E86AB"/>
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
<title>冷凍空調 · 每日開銷</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root{
    color-scheme:light;
    --page:#F7FBFD; --surface:#FFFFFF; --raise:#F2F9FC;
    --ink:#16323D; --ink-2:#3E5D6B; --muted:#6B8794;
    --line:#D6E9F3; --grid:#E8F1F6; --axis:#C3D8E3;
    --accent:#2E86AB; --accent-deep:#1B5E7A; --track:#EAF4F9;
    --good:#1E6E43; --danger:#A6402A; --amber:#E8963C;
    --shadow:0 1px 3px rgba(46,134,171,.07);
    --ctl-h:40px;   /* 表單欄位統一高度，以下拉選單的原生高度為準 */
    --tip-bg:#16323D; --tip-ink:#FFFFFF;
  }
  @media (prefers-color-scheme:dark){
    :root{
      color-scheme:dark;
      --page:#0F171B; --surface:#172128; --raise:#1B2831;
      --ink:#E9F2F7; --ink-2:#B7CCD7; --muted:#8FA9B5;
      --line:#26343D; --grid:#1F2C34; --axis:#2C3D47;
      --accent:#3D9AC0; --accent-deep:#6FBBD6; --track:#1E2C35;
      --good:#4FBF85; --danger:#E8907A; --amber:#E8A65C;
      --shadow:0 1px 3px rgba(0,0,0,.3);
      --tip-bg:#E9F2F7; --tip-ink:#0F171B;
    }
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,-apple-system,sans-serif;
    background:var(--page);color:var(--ink);-webkit-font-smoothing:antialiased;padding-bottom:56px}
  .wrap{max-width:980px;margin:0 auto;padding:0 16px}
  header{background:linear-gradient(160deg,#2E86AB 0%,#1B5E7A 100%);color:#fff;padding:26px 0 34px;margin-bottom:-20px}
  header h1{font-size:19px;font-weight:700;letter-spacing:.02em}
  header p{font-size:12.5px;opacity:.84;margin-top:4px}

  /* ---- 卡片 ---- */
  .card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px;box-shadow:var(--shadow)}
  .card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  /* nowrap 是必要的：中文可以逐字斷行，flex 會把標題壓到比內容還窄而讓字疊在一起 */
  .card h2{font-size:14.5px;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:8px;white-space:nowrap}
  .card h2::before{content:"";width:3px;height:15px;background:var(--accent);border-radius:2px;flex:none}
  .sub{font-size:11.5px;color:var(--muted);font-weight:500;margin-top:3px;padding-left:11px}

  /* ---- KPI ---- */
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
  .kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 13px;box-shadow:var(--shadow)}
  .kpi .lbl{font-size:11.5px;color:var(--muted);letter-spacing:.03em}
  .kpi .val{font-size:23px;font-weight:700;color:var(--ink);margin-top:6px;line-height:1.12}
  .kpi .val small{font-size:12.5px;font-weight:500;color:var(--muted);margin-right:3px}
  .kpi .delta{font-size:11.5px;font-weight:600;margin-top:5px;display:flex;align-items:center;gap:4px}
  .kpi .delta.up{color:var(--danger)}
  .kpi .delta.down{color:var(--good)}
  .kpi .delta.flat{color:var(--muted)}

  /* ---- 表單 ---- */
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}
  /* Grid 項目預設 min-width:auto，會依內容的「內在最小寬度」撐開所在欄軌。
     Safari 的原生日期元件內在寬度算法跟其他欄位不同，沒有這行會把日期所在的
     那一欄（跟費用類別、支付方式同欄）撐得比另一欄（品名、經手人）寬，
     兩欄看起來就不一樣寬。強制歸零讓欄軌完全照 1fr 平分。 */
  .grid>div{min-width:0}
  .full{grid-column:1/-1}
  label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px;font-weight:500}
  label .req{color:var(--amber)}
  input,select,textarea{width:100%;font-family:inherit;font-size:14.5px;color:var(--ink);background:var(--raise);
    border:1px solid var(--line);border-radius:9px;padding:10px 11px;transition:border-color .15s,background .15s}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);background:var(--surface);
    box-shadow:0 0 0 3px rgba(46,134,171,.16)}
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
  /* 經手人選「其他」時才會冒出來的自由輸入欄，跟上面的下拉選單隔開一點 */
  .person-other{margin-top:8px}
  .btn-row{display:flex;gap:10px;margin-top:18px}
  button{font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;border:none;border-radius:10px;
    padding:13px 18px;transition:opacity .15s,transform .1s,background .15s,color .15s}
  button:active{transform:translateY(1px)}
  button:disabled{opacity:.55;cursor:wait}
  .primary{flex:1;background:var(--accent);color:#fff}
  .primary:hover:not(:disabled){background:var(--accent-deep);color:var(--surface)}
  .ghost{background:var(--raise);color:var(--muted);border:1px solid var(--line)}
  .ghost:hover:not(:disabled){color:var(--ink)}
  #msg{display:none;padding:11px 14px;border-radius:9px;font-size:13.5px;margin-top:14px;line-height:1.5}
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
  .chev{display:inline-block;color:var(--muted);font-size:11px;transition:transform .15s ease}
  .pt-row.open .chev{transform:rotate(90deg);color:var(--accent)}
  .pt-detail td{padding:0 8px 12px;border-bottom:1px solid var(--grid)}
  .pt-list{display:flex;flex-direction:column;gap:1px;background:var(--track);border-radius:8px;overflow:hidden}
  .pt-item{display:grid;grid-template-columns:52px 1fr auto auto;gap:10px;align-items:center;
    background:var(--surface);padding:8px 10px;font-size:12.5px}
  .pt-date{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .pt-name{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pt-meta{color:var(--muted);font-size:11px;white-space:nowrap}
  .pt-amt{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}

  /* ---- 柱狀圖 ---- */
  .chart{padding-left:48px;padding-top:14px;position:relative}
  .plot{position:relative;height:190px}
  .gl{position:absolute;left:0;right:0;height:1px;background:var(--grid)}
  .gl.base{background:var(--axis)}
  .gl b{position:absolute;left:-48px;top:-8px;width:42px;text-align:right;font-size:10.5px;
    font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}
  .cols{position:absolute;inset:0;display:flex;align-items:flex-end;gap:2px}
  .col{flex:1;height:100%;display:flex;align-items:flex-end;justify-content:center;position:relative}
  .col-fill{position:relative;width:100%;max-width:24px;min-height:2px;background:var(--accent);border-radius:4px 4px 0 0;transition:height .4s ease}
  .col.zero .col-fill{background:var(--track)}
  .col:hover .col-fill{background:var(--accent-deep)}
  .col-tag{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:5px;
    font-size:10.5px;font-weight:700;color:var(--ink-2);white-space:nowrap;font-variant-numeric:tabular-nums}
  .xlabels{display:flex;gap:2px;margin-top:8px}
  .xlabels span{flex:1;text-align:center;font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden}
  .chart-foot{display:flex;gap:18px;margin-top:14px;padding-left:0;font-size:12px;color:var(--muted)}
  .chart-foot b{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums}

  /* ---- 橫向長條清單 ---- */
  .bl{display:flex;flex-direction:column;gap:10px}
  /* 名稱欄要放得下最長的「信用卡（個人代墊）」9 個字，否則會被截成「信用卡（個人…」 */
  .bl-row{display:grid;grid-template-columns:118px 1fr 74px 42px;align-items:center;gap:10px;font-size:12.5px}
  .bl-name{color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bl-track{height:8px;background:var(--track);border-radius:4px;overflow:hidden}
  .bl-fill{height:100%;background:var(--accent);border-radius:0 4px 4px 0;transition:width .45s ease}
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
  .t-cat{display:inline-block;font-size:11px;padding:2px 7px;border-radius:5px;background:var(--track);color:var(--accent);white-space:nowrap}
  .t-amt{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
  .t-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
  .t-note{color:var(--muted);font-size:12px;margin-top:2px}
  .t-meta{display:none;color:var(--muted);font-size:11.5px;margin-top:3px}
  .empty,.loading{text-align:center;color:var(--muted);font-size:13px;padding:28px 0}
  .export{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--accent);text-decoration:none;font-weight:600}
  .export:hover{text-decoration:underline}

  /* ---- 單筆操作 ---- */
  .search{width:210px;font-size:12.5px;padding:8px 11px;border-radius:9px}
  .t-act{white-space:nowrap;text-align:right}
  .rbtn{font-size:12px;font-weight:600;padding:5px 9px;border-radius:7px;background:var(--raise);
    color:var(--muted);border:1px solid var(--line);margin-left:5px}
  .rbtn:hover{color:var(--accent);border-color:var(--accent)}
  .rbtn.del:hover{color:var(--danger);border-color:var(--danger)}

  /* ---- 編輯視窗 ---- */
  .modal{position:fixed;inset:0;z-index:60;background:rgba(11,26,33,.55);
    display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto}
  .modal[hidden]{display:none}
  .modal-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;
    padding:22px;width:100%;max-width:540px;box-shadow:0 12px 40px rgba(0,0,0,.28);margin:auto}
  .modal-card h2{font-size:15px;font-weight:700;color:var(--ink);margin-bottom:18px;
    display:flex;align-items:center;gap:8px;white-space:nowrap}
  .modal-card h2::before{content:"";width:3px;height:15px;background:var(--accent);border-radius:2px;flex:none}
  .modal-msg{display:none;font-size:13px;color:var(--danger);margin-top:12px}
  .modal-msg.on{display:block}

  /* ---- Tooltip ---- */
  #tip{position:fixed;z-index:99;pointer-events:none;opacity:0;transition:opacity .12s;
    background:var(--tip-bg);color:var(--tip-ink);border-radius:8px;padding:7px 10px;font-size:12px;line-height:1.45;
    white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.18)}
  #tip.on{opacity:1}
  #tip b{font-variant-numeric:tabular-nums}
  #tip .tk{opacity:.72;font-size:11px}

  @media(max-width:820px){
    .kpis{grid-template-columns:1fr 1fr}
    .panes{grid-template-columns:1fr;gap:22px}
  }
  @media(max-width:600px){
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
    .search{width:100%}
    .head-tools{width:100%;justify-content:space-between}
    td,th{padding-left:5px;padding-right:5px}
    .rbtn{font-size:11.5px;padding:5px 8px;margin-left:4px}
    /* 窄螢幕：經手人明細的逐筆列，類別／支付方式收到第二行，才不會擠成五欄 */
    .scope-tools{width:100%;justify-content:space-between}
    .pt-item{grid-template-columns:44px 1fr auto;grid-template-areas:"date name amt" "meta meta meta";gap:3px 8px}
    .pt-date{grid-area:date}
    .pt-name{grid-area:name;white-space:normal}
    .pt-amt{grid-area:amt}
    .pt-meta{grid-area:meta}
  }
  @media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>冷凍空調 · 每日開銷</h1>
    <p>資料存在 Cloudflare D1，全球都能即時讀寫</p>
  </div>
</header>

<div class="wrap">
  <div class="kpis" style="margin-top:34px">
    <div class="kpi">
      <div class="lbl" id="kMonthLbl">本月支出</div>
      <div class="val"><small>NT$</small><span id="kMonth">—</span></div>
      <div class="delta" id="kDelta"></div>
    </div>
    <div class="kpi">
      <div class="lbl">本月日均</div>
      <div class="val"><small>NT$</small><span id="kAvg">—</span></div>
      <div class="delta flat" id="kAvgSub"></div>
    </div>
    <div class="kpi">
      <div class="lbl">今年累計</div>
      <div class="val"><small>NT$</small><span id="kYear">—</span></div>
      <div class="delta flat" id="kYearSub"></div>
    </div>
    <div class="kpi">
      <div class="lbl">總筆數</div>
      <div class="val"><span id="kCount">—</span></div>
      <div class="delta flat" id="kCountSub"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>記一筆支出</h2></div>
    <div class="grid">
      <div><label>日期 <span class="req">*</span></label><input type="date" id="date"></div>
      <div><label>金額 <span class="req">*</span></label><input type="number" id="amount" inputmode="decimal" step="0.01" placeholder="0"></div>
      <div><label>費用類別 <span class="req">*</span></label><select id="category"><option value="">請選擇</option></select></div>
      <div><label>品名 <span class="req">*</span></label><select id="item" disabled><option value="">先選類別</option></select></div>
      <div><label>支付方式</label><select id="payment"><option value="">未指定</option></select></div>
      <div><label>經手人 / 代墊</label><select id="person"><option value="">未指定</option></select>
        <input type="text" class="person-other" id="personOther" lang="zh-Hant" autocomplete="off" placeholder="輸入人名" hidden></div>
      <div class="full"><label>發票 / 備註</label><textarea id="note" lang="zh-Hant" autocomplete="off" rows="1" placeholder="發票號碼、工地名稱、其他說明"></textarea></div>
    </div>
    <div class="btn-row">
      <button class="primary" id="saveBtn">儲存這筆</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card">
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

  <div class="card">
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
    <div class="panes">
      <div class="pane"><h3>費用類別</h3><div id="catBox"><div class="loading">載入中…</div></div></div>
      <div class="pane"><h3>支付方式</h3><div id="payBox"><div class="loading">載入中…</div></div></div>
      <div class="pane wide"><h3>經手人 / 代墊<span class="hint" id="personHint"></span></h3><div id="personBox"><div class="loading">載入中…</div></div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div>
        <h2>紀錄明細</h2>
        <div class="sub" id="listSub">最新 50 筆，可直接編輯或刪除</div>
      </div>
      <div class="head-tools">
        <input type="text" id="search" class="search" lang="zh-Hant" autocomplete="off" placeholder="搜尋品名、經手人、備註、日期…">
        <a class="export" href="/api/export.csv">↓ 下載 CSV</a>
      </div>
    </div>
    <div id="recentBox"><div class="loading">載入中…</div></div>
  </div>
</div>

<div id="tip"></div>

<div class="modal" id="editModal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="editTitle">
    <h2 id="editTitle">編輯這筆支出</h2>
    <div class="grid">
      <div><label>日期 <span class="req">*</span></label><input type="date" id="e_date"></div>
      <div><label>金額 <span class="req">*</span></label><input type="number" id="e_amount" inputmode="decimal" step="0.01"></div>
      <div><label>費用類別 <span class="req">*</span></label><select id="e_category"></select></div>
      <div><label>品名 <span class="req">*</span></label><select id="e_item"></select></div>
      <div><label>支付方式</label><select id="e_payment"></select></div>
      <div><label>經手人 / 代墊</label><select id="e_person"></select>
        <input type="text" class="person-other" id="e_personOther" lang="zh-Hant" autocomplete="off" placeholder="輸入人名" hidden></div>
      <div class="full"><label>發票 / 備註</label><textarea id="e_note" lang="zh-Hant" autocomplete="off" rows="2"></textarea></div>
    </div>
    <div id="editMsg" class="modal-msg"></div>
    <div class="btn-row">
      <button class="primary" id="editSave">儲存變更</button>
      <button class="ghost" id="editCancel">取消</button>
    </div>
  </div>
</div>

<script>
var DATA = null;
var STATE = { trend: 'month', trendView: 'chart', scope: 'month', ym: null };

function el(id){ return document.getElementById(id); }
function nf(n){ return (Number(n)||0).toLocaleString('en-US'); }
function nf0(n){ return Math.round(Number(n)||0).toLocaleString('en-US'); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

/* ---------- Tooltip ---------- */
var TIP = null;
function showTip(node){
  if(!TIP) TIP = el('tip');
  TIP.innerHTML = '<span class="tk">' + esc(node.getAttribute('data-k')) + '</span><br><b>NT$ '
    + esc(node.getAttribute('data-v')) + '</b>';
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
  var t = e.target.closest ? e.target.closest('[data-k]') : null;
  if(t) showTip(t); else hideTip();
});
document.addEventListener('touchstart', function(e){
  var t = e.target.closest ? e.target.closest('[data-k]') : null;
  if(t) showTip(t); else hideTip();
}, {passive:true});
window.addEventListener('scroll', hideTip, {passive:true});

/* ---------- 格式 ---------- */
function fmtDay(k){ var p=k.split('-'); return Number(p[1])+'/'+Number(p[2]); }
function fmtDayFull(k){ var p=k.split('-'); return p[0]+'/'+p[1]+'/'+p[2]; }
function fmtMonth(k){ var p=k.split('-'); return Number(p[1])+'月'; }
function fmtMonthFull(k){ var p=k.split('-'); return p[0]+' 年 '+Number(p[1])+' 月'; }
function fmtYear(k){ return k+' 年'; }

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
function columnChart(rows, fmtShort, fmtLong, labelEvery){
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
    // 只標最高的那根（直接標示要克制，其餘交給座標軸與 tooltip）
    var tag = i === maxIdx ? '<div class="col-tag">' + nf0(r.total) + '</div>' : '';
    return '<div class="col' + (r.total>0?'':' zero') + '" data-k="' + esc(fmtLong(r.key))
      + '" data-v="' + nf0(r.total) + '">'
      + '<div class="col-fill" style="height:' + (r.total>0?Math.max(h,1):0) + '%">' + tag + '</div></div>';
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

function trendTable(rows, fmtLong, label){
  if(!rows.length) return '<div class="empty">這段期間還沒有支出紀錄</div>';
  var sum = rows.reduce(function(s,r){ return s+r.total; }, 0);
  var body = rows.slice().reverse().map(function(r){
    var pct = sum ? (r.total/sum*100) : 0;
    return '<tr><td class="t-date">' + esc(fmtLong(r.key)) + '</td>'
      + '<td class="t-num">' + pct.toFixed(1) + '%</td>'
      + '<td class="t-amt">' + nf0(r.total) + '</td></tr>';
  }).join('');
  return '<table><thead><tr><th>' + label + '</th><th style="text-align:right">佔比</th>'
    + '<th style="text-align:right">金額</th></tr></thead><tbody>' + body + '</tbody>'
    + '<tfoot><tr><td>合計</td><td></td><td class="t-amt">' + nf0(sum) + '</td></tr></tfoot></table>';
}

function renderTrend(){
  var t = DATA.trend, box = el('trendBox');
  var cfg = {
    day:   { rows:t.day,   short:fmtDay,   long:fmtDayFull,   every:5, label:'日期', sub:'最近 30 天（含沒有支出的日子）' },
    month: { rows:t.month, short:fmtMonth, long:fmtMonthFull, every:1, label:'月份', sub:'最近 12 個月' },
    year:  { rows:t.year,  short:fmtYear,  long:fmtYear,      every:1, label:'年份', sub:'所有有紀錄的年份' }
  }[STATE.trend];
  el('trendSub').textContent = cfg.sub;
  el('trendView').textContent = STATE.trendView === 'chart' ? '表格' : '圖表';
  box.innerHTML = STATE.trendView === 'chart'
    ? columnChart(cfg.rows, cfg.short, cfg.long, cfg.every)
    : trendTable(cfg.rows, cfg.long, cfg.label);
}

/* ---------- 橫向長條清單 ---------- */
function barList(rows, unitFmt){
  if(!rows || !rows.length) return '<div class="empty">這段期間還沒有紀錄</div>';
  var max = rows[0].total || 1;
  return '<div class="bl">' + rows.map(function(r){
    var w = Math.max(2, (r.total/max)*100);
    return '<div class="bl-row" data-k="' + esc(r.name) + '（' + r.count + ' 筆）" data-v="' + nf0(r.total) + '">'
      + '<div class="bl-name">' + esc(r.name) + '</div>'
      + '<div class="bl-track"><div class="bl-fill" style="width:' + w + '%"></div></div>'
      + '<div class="bl-val">' + nf0(r.total) + '</div>'
      + '<div class="bl-pct">' + r.pct.toFixed(0) + '%</div></div>';
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
        + (list.length
          ? '<div class="pt-list">' + list.map(function(t){
              return '<div class="pt-item"><span class="pt-date">' + esc(fmtDay(t.date)) + '</span>'
                + '<span class="pt-name">' + esc(t.item) + '</span>'
                + '<span class="pt-meta">' + esc(t.category) + ' · ' + esc(t.payment || '未指定') + '</span>'
                + '<span class="pt-amt">NT$ ' + nf0(t.amount) + '</span></div>';
            }).join('') + '</div>'
          : '<div class="empty" style="padding:8px 0">這個月沒有這位的明細</div>')
        + '</td></tr>';
    }
    return '<tr class="pt-row' + (canExpand ? ' pt-clickable' : '') + '" data-idx="' + idx + '">'
      + chevTd + '<td>' + esc(r.name) + '</td>'
      + '<td class="hide-sm" style="width:30%"><div class="bl-track"><div class="bl-fill" style="width:' + w + '%"></div></div></td>'
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
  var out = {};
  (rows || []).forEach(function(t){
    var name = String(t.person || '').trim() || '未填';
    (out[name] = out[name] || []).push(t);
  });
  return out;
}

/* ---------- 經手人月度明細：月份選擇與快取 ---------- */
var monthCache = {};      // ym -> /api/expenses/month 回傳結果
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

function goToMonth(ym){
  var r = DATA.monthRange;
  if(ym < r.min || ym > r.max) return;
  STATE.ym = ym;
  STATE.scope = 'month';
  Array.prototype.forEach.call(el('scopeSeg').querySelectorAll('button'), function(x){
    x.setAttribute('aria-pressed', 'false');
  });
  updateMonthNav();
  renderBreakdown();
}

function renderBreakdown(){
  if(STATE.scope === 'month'){
    updateMonthNav();
    var seq = ++monthReqSeq, ym = STATE.ym;
    el('catBox').innerHTML = '<div class="loading">載入中…</div>';
    el('payBox').innerHTML = '<div class="loading">載入中…</div>';
    el('personBox').innerHTML = '<div class="loading">載入中…</div>';
    el('personHint').textContent = '';
    loadMonth(ym).then(function(d){
      if(seq !== monthReqSeq) return;   // 使用者已經切到別的月份，這筆回應過期了
      el('scopeSub').textContent = ymLabel(ym) + '共 ' + nf(d.count) + ' 筆 · NT$ ' + nf0(d.total);
      el('catBox').innerHTML = barList(d.cat);
      el('payBox').innerHTML = barList(d.pay);
      el('personHint').textContent = d.count ? '（點一列看逐筆明細）' : '';
      el('personBox').innerHTML = personTable(d.person, groupByPerson(d.rows));
    }).catch(function(err){
      if(seq !== monthReqSeq) return;
      var msg = '<div class="empty">載入失敗：' + esc(err.message) + '</div>';
      el('catBox').innerHTML = msg; el('payBox').innerHTML = msg; el('personBox').innerHTML = msg;
    });
    return;
  }
  el('mLabel').setAttribute('aria-pressed', 'false');
  var s = DATA.scopes[STATE.scope];
  var name = { year: '今年', all: '全部期間' }[STATE.scope];
  el('scopeSub').textContent = name + '共 ' + nf(s.count) + ' 筆 · NT$ ' + nf0(s.total);
  el('personHint').textContent = '';
  el('catBox').innerHTML = barList(s.cat);
  el('payBox').innerHTML = barList(s.pay);
  el('personBox').innerHTML = personTable(s.person);
}

el('mPrev').addEventListener('click', function(){ goToMonth(shiftYm(STATE.ym, -1)); });
el('mNext').addEventListener('click', function(){ goToMonth(shiftYm(STATE.ym, 1)); });
el('mLabel').addEventListener('click', function(){ goToMonth(STATE.ym); });
el('mToday').addEventListener('click', function(){ goToMonth(DATA.today.slice(0,7)); });

el('personBox').addEventListener('click', function(e){
  var row = e.target.closest ? e.target.closest('.pt-clickable') : null;
  if(!row) return;
  var detail = document.getElementById('pd-' + row.getAttribute('data-idx'));
  if(!detail) return;
  detail.hidden = !detail.hidden;
  row.classList.toggle('open', !detail.hidden);
});

/* ---------- 紀錄明細（可編輯／刪除） ---------- */
var ROWS = {};   // id -> 紀錄，編輯時直接取用

function renderList(list, emptyText){
  var box = el('recentBox');
  ROWS = {};
  if(!list || !list.length){ box.innerHTML = '<div class="empty">' + esc(emptyText) + '</div>'; return; }
  var rows = list.map(function(r){
    ROWS[r.id] = r;
    var meta = [r.category, r.payment, r.person].filter(function(v){ return v; }).join(' · ');
    return '<tr><td class="t-date">' + esc(fmtDay(r.date)) + '</td>'
      + '<td class="hide-sm"><span class="t-cat">' + esc(r.category) + '</span></td>'
      + '<td>' + esc(r.item)
      + '<div class="t-meta">' + esc(meta) + '</div>'
      + (r.note ? '<div class="t-note">' + esc(r.note) + '</div>' : '') + '</td>'
      + '<td class="hide-sm">' + esc(r.payment) + '</td>'
      + '<td class="hide-sm">' + esc(r.person) + '</td>'
      + '<td class="t-amt">' + nf0(r.amount) + '</td>'
      + '<td class="t-act"><button class="rbtn" data-edit="' + r.id + '">編輯</button>'
      + '<button class="rbtn del" data-del="' + r.id + '">刪除</button></td></tr>';
  }).join('');
  box.innerHTML = '<table><thead><tr><th>日期</th><th class="hide-sm">類別</th><th>品名</th>'
    + '<th class="hide-sm">支付</th><th class="hide-sm">經手人</th>'
    + '<th style="text-align:right">金額</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderRecent(list){
  renderList(list, '還沒有任何紀錄，從上面記第一筆吧');
}

/* ---------- 搜尋 ---------- */
var searchTimer = null;
el('search').addEventListener('input', function(){
  var q = this.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function(){
    if(!q){
      el('listSub').textContent = '最新 50 筆，可直接編輯或刪除';
      renderRecent(DATA.recent);
      return;
    }
    el('listSub').textContent = '搜尋「' + q + '」…';
    fetch('/api/expenses?q=' + encodeURIComponent(q))
      .then(function(r){ return r.json(); })
      .then(function(d){
        el('listSub').textContent = '搜尋「' + q + '」：' + d.rows.length + ' 筆'
          + (d.rows.length >= 100 ? '（只顯示前 100 筆）' : '');
        renderList(d.rows, '找不到符合「' + q + '」的紀錄');
      })
      .catch(function(err){ el('listSub').textContent = '搜尋失敗：' + err.message; });
  }, 250);
});

/* ---------- 編輯 / 刪除 ---------- */
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

function syncEditItems(current){
  var cat = el('e_category').value;
  var items = (DATA.categories[cat] || []).slice();
  // 舊資料的品名可能已經不在目前的清單裡，保留它才不會一存就被改掉
  if(current && items.indexOf(current) < 0) items.unshift(current);
  // 沒有既有品名時（例如剛改類別），有預設品名的類別直接帶入
  var pick = current || (DATA.defaultItems || {})[cat] || '';
  fillSelect(el('e_item'), items, pick);
}

var editingId = null;
function openEdit(id){
  var r = ROWS[id];
  if(!r) return;
  editingId = id;
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
  el('editModal').hidden = false;
  el('e_amount').focus();
}
function closeEdit(){ el('editModal').hidden = true; editingId = null; }

el('e_category').addEventListener('change', function(){ syncEditItems(''); });
bindPersonToggle('e_person', 'e_personOther');
el('editCancel').addEventListener('click', closeEdit);
el('editModal').addEventListener('click', function(e){ if(e.target === this) closeEdit(); });
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape' && !el('editModal').hidden) closeEdit();
});

el('editSave').addEventListener('click', function(){
  var rec = { date: el('e_date').value, category: el('e_category').value, item: el('e_item').value,
    amount: el('e_amount').value, payment: el('e_payment').value,
    person: getPersonValue('e_person', 'e_personOther'), note: el('e_note').value };
  if(!rec.date || !rec.category || !rec.item || rec.amount === ''){
    var m = el('editMsg'); m.textContent = '日期、費用類別、品名、金額都要填。'; m.className = 'modal-msg on'; return;
  }
  var btn = this; btn.disabled = true; btn.textContent = '儲存中…';
  fetch('/api/expenses/' + editingId, { method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(rec) })
    .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, data:d}; }); })
    .then(function(res){
      if(!res.ok) throw new Error(res.data.error || '儲存失敗');
      closeEdit();
      render(res.data);
      el('search').value = '';
      showMsg('已更新：' + rec.category + ' / ' + rec.item + ' / NT$' + nf0(rec.amount), 'ok');
    })
    .catch(function(err){
      var m = el('editMsg'); m.textContent = err.message; m.className = 'modal-msg on';
    })
    .finally(function(){ btn.disabled = false; btn.textContent = '儲存變更'; });
});

el('recentBox').addEventListener('click', function(e){
  var b = e.target.closest ? e.target.closest('button') : null;
  if(!b) return;
  var editId = b.getAttribute('data-edit');
  if(editId){ openEdit(editId); return; }
  var delId = b.getAttribute('data-del');
  if(!delId) return;
  var r = ROWS[delId];
  if(!confirm('確定刪除這筆？\n' + fmtDayFull(r.date) + '　' + r.item + '　NT$' + nf0(r.amount))) return;
  b.disabled = true;
  fetch('/api/expenses/' + delId, { method:'DELETE' })
    .then(function(res){ return res.json().then(function(d){ return {ok:res.ok, data:d}; }); })
    .then(function(res){
      if(!res.ok) throw new Error(res.data.error || '刪除失敗');
      render(res.data);
      el('search').value = '';
      el('listSub').textContent = '最新 50 筆，可直接編輯或刪除';
      showMsg('已刪除：' + r.item + ' / NT$' + nf0(r.amount), 'ok');
    })
    .catch(function(err){ b.disabled = false; showMsg(err.message, 'err'); });
});

/* ---------- 主渲染 ---------- */
function render(data){
  DATA = data;
  if(!STATE.ym) STATE.ym = data.today.slice(0,7);
  var s = data.stats;

  el('kMonthLbl').textContent = data.monthLabel + '支出';
  el('kMonth').textContent = nf0(s.monthTotal);
  var dl = el('kDelta');
  if(s.monthDeltaPct === null || s.monthDeltaPct === undefined){
    dl.className = 'delta flat'; dl.textContent = '上月沒有紀錄可比較';
  } else {
    var up = s.monthDeltaPct >= 0;
    dl.className = 'delta ' + (Math.abs(s.monthDeltaPct) < 0.05 ? 'flat' : (up ? 'up' : 'down'));
    dl.textContent = (up ? '▲ ' : '▼ ') + Math.abs(s.monthDeltaPct).toFixed(0) + '% 較上月（NT$ '
      + nf0(s.prevMonthTotal) + '）';
  }
  el('kAvg').textContent = nf0(s.dayAvg);
  el('kAvgSub').textContent = data.monthLabel + '至今每日平均';
  el('kYear').textContent = nf0(s.yearTotal);
  el('kYearSub').textContent = '今年到目前為止';
  el('kCount').textContent = nf(s.count);
  el('kCountSub').textContent = data.monthLabel + '新增 ' + nf(s.monthCount) + ' 筆';

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

  renderTrend();
  renderBreakdown();
  renderRecent(data.recent);
}

/* ---------- 互動 ---------- */
function segBind(segId, key, after){
  el(segId).addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('button') : null;
    if(!b) return;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function(x){
      x.setAttribute('aria-pressed', String(x === b));
    });
    STATE[key] = b.getAttribute('data-mode') || b.getAttribute('data-scope');
    if(DATA) after();
  });
}
segBind('trendSeg', 'trend', renderTrend);
segBind('scopeSeg', 'scope', renderBreakdown);

el('trendView').addEventListener('click', function(){
  STATE.trendView = STATE.trendView === 'chart' ? 'table' : 'chart';
  if(DATA) renderTrend();
});

el('category').addEventListener('change', function(){
  var itemSel = el('item'); itemSel.innerHTML=''; var cat = this.value;
  if(!cat){ itemSel.disabled=true; itemSel.innerHTML='<option value="">先選類別</option>'; return; }
  itemSel.disabled = false; itemSel.innerHTML = '<option value="">請選擇</option>';
  DATA.categories[cat].forEach(function(i){
    var o=document.createElement('option'); o.value=i; o.textContent=i; itemSel.appendChild(o);
  });
  if(DATA.categories[cat].length === 1) itemSel.value = DATA.categories[cat][0];
  // 像「餐費」這種類別，品名就是同一個名字，直接帶進去省一次點選
  var def = (DATA.defaultItems || {})[cat];
  if(def && DATA.categories[cat].indexOf(def) >= 0) itemSel.value = def;
});

function showMsg(text, type){
  var m = el('msg'); m.textContent = text; m.className = type;
  if(type === 'ok') setTimeout(function(){ m.className=''; }, 4000);
}

bindPersonToggle('person', 'personOther');

el('saveBtn').addEventListener('click', function(){
  var rec = { date: el('date').value, category: el('category').value, item: el('item').value,
    amount: el('amount').value, payment: el('payment').value,
    person: getPersonValue('person', 'personOther'), note: el('note').value };
  if(!rec.date || !rec.category || !rec.item || rec.amount === ''){ showMsg('日期、費用類別、品名、金額都要填。','err'); return; }
  var btn = this; btn.disabled = true; btn.textContent = '儲存中…';
  fetch('/api/expenses', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(rec) })
    .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, data:d}; }); })
    .then(function(res){
      if(!res.ok){ throw new Error(res.data.error || '儲存失敗'); }
      render(res.data);
      el('search').value = ''; el('listSub').textContent = '最新 50 筆，可直接編輯或刪除';
      el('amount').value=''; el('person').value=''; el('personOther').hidden=true; el('personOther').value='';
      el('note').value=''; el('date').value = res.data.today;
      showMsg('已存入：' + rec.category + ' / ' + rec.item + ' / NT$' + nf0(rec.amount), 'ok');
      el('amount').focus();
    })
    .catch(function(err){ showMsg('存不進去：' + err.message, 'err'); })
    .finally(function(){ btn.disabled=false; btn.textContent='儲存這筆'; });
});

fetch('/api/bootstrap').then(function(r){ return r.json(); })
  .then(function(d){ render(d); if(!el('date').value) el('date').value = d.today; })
  .catch(function(err){
    ['trendBox','catBox','payBox','personBox','recentBox'].forEach(function(id){
      el(id).innerHTML = '<div class="empty">載入失敗：' + esc(err.message) + '</div>';
    });
  });
</script>
</body>
</html>`;
