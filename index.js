/**
 * 冷凍空調公司 · 每日開銷記帳 — Cloudflare Worker
 * 資料庫：D1 (cooling-expense-db)
 */

const CATEGORIES = {
  "機器款項": ["緯昇機器", "和美機器"],
  "冷氣材料": ["銅管", "安裝架", "落地架", "冷煤", "排水軟管", "排水硬管", "管槽", "角鐵", "矽利康", "控制線", "電源線"],
  "水電材料": ["馬達", "電線", "開關/插座", "水管/排水配件"],
  "木工材料": ["角材", "木板"],
  "車輛與交通": ["加油費", "停車費", "過路費"],
  "工具與設備": ["耗材", "手工具", "工業扇"],
  "人力與點工": ["冷氣點工", "水電點工", "木工點工"],
  "公司固定雜支": ["餐費", "勞健保", "車子分期"],
  "其他": ["其他"],
};
const PAYMENTS = ["現金", "轉帳", "信用卡", "其他"];

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

    // ---- API ----
    if (path === "/api/bootstrap" && request.method === "GET") {
      return handleBootstrap(env);
    }
    if (path === "/api/expenses" && request.method === "POST") {
      return handleAdd(request, env);
    }
    if (path === "/api/expenses/last" && request.method === "DELETE") {
      return handleDeleteLast(env);
    }
    if (path === "/api/export.csv" && request.method === "GET") {
      return handleExportCsv(env);
    }

    return json({ error: "Not found" }, 404);
  },
};

async function handleBootstrap(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM expenses ORDER BY date ASC, id ASC"
  ).all();

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based

  let monthTotal = 0, yearTotal = 0;
  const monthByCat = {};

  for (const r of results) {
    const d = new Date(r.date + "T00:00:00");
    const amt = Number(r.amount) || 0;
    if (d.getFullYear() === y) {
      yearTotal += amt;
      if (d.getMonth() === m) {
        monthTotal += amt;
        monthByCat[r.category] = (monthByCat[r.category] || 0) + amt;
      }
    }
  }

  const recent = results
    .slice(-15)
    .reverse()
    .map((r) => ({
      date: r.date.slice(5).replace("-", "/"),
      category: r.category,
      item: r.item,
      amount: r.amount,
      payment: r.payment,
      person: r.person,
      note: r.note,
    }));

  return json({
    categories: CATEGORIES,
    payments: PAYMENTS,
    monthTotal,
    yearTotal,
    count: results.length,
    monthLabel: `${m + 1}月`,
    monthByCat,
    recent,
  });
}

async function handleAdd(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "格式錯誤" }, 400);
  }

  const { date, category, item, amount, payment, person, note } = body;
  if (!date || !category || !item || amount === undefined || amount === null || amount === "") {
    return json({ error: "日期、費用類別、品名、金額為必填" }, 400);
  }
  const amt = Number(amount);
  if (Number.isNaN(amt)) {
    return json({ error: "金額必須是數字" }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO expenses (date, category, item, amount, payment, person, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(date, category, item, amt, payment || "", person || "", note || "")
    .run();

  return handleBootstrap(env);
}

async function handleDeleteLast(env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM expenses ORDER BY id DESC LIMIT 1"
  ).all();
  if (!results.length) {
    return json({ error: "目前沒有可刪除的紀錄" }, 400);
  }
  await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(results[0].id).run();
  return handleBootstrap(env);
}

async function handleExportCsv(env) {
  const { results } = await env.DB.prepare(
    "SELECT date, category, item, amount, payment, person, note FROM expenses ORDER BY date ASC, id ASC"
  ).all();

  const headers = ["日期", "費用類別", "品名", "金額", "支付方式", "經手人 / 代墊", "發票 / 備註"];
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of results) {
    lines.push(
      [r.date, r.category, r.item, r.amount, r.payment, r.person, r.note]
        .map(csvEscape)
        .join(",")
    );
  }
  const csv = "\uFEFF" + lines.join("\r\n"); // 加 BOM 讓 Excel 開啟中文不亂碼

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="expenses.csv"',
    },
  });
}

const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>冷凍空調 · 每日開銷</title>
<style>
  :root{
    --sky:#2E86AB; --sky-deep:#1B5E7A; --sky-pale:#F2F9FC; --sky-line:#D6E9F3;
    --ink:#16323D; --muted:#6B8794; --amber:#E8963C; --paper:#FFFFFF; --bg:#F7FBFD;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;padding-bottom:48px}
  .wrap{max-width:960px;margin:0 auto;padding:0 16px}
  header{background:linear-gradient(160deg,var(--sky) 0%,var(--sky-deep) 100%);color:#fff;padding:26px 0 30px;margin-bottom:-18px}
  header h1{font-size:19px;font-weight:700;letter-spacing:.02em}
  header p{font-size:12.5px;opacity:.82;margin-top:4px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:22px}
  .stat{background:var(--paper);border:1px solid var(--sky-line);border-radius:12px;padding:14px 12px;box-shadow:0 1px 3px rgba(46,134,171,.06)}
  .stat .lbl{font-size:11.5px;color:var(--muted);letter-spacing:.04em}
  .stat .num{font-size:23px;font-weight:700;color:var(--sky-deep);margin-top:5px;font-variant-numeric:tabular-nums;line-height:1.1}
  .stat .num small{font-size:13px;font-weight:500;color:var(--muted);margin-right:2px}
  .card{background:var(--paper);border:1px solid var(--sky-line);border-radius:14px;padding:20px;margin-bottom:18px}
  .card h2{font-size:14.5px;font-weight:700;color:var(--sky-deep);margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .card h2::before{content:"";width:3px;height:15px;background:var(--sky);border-radius:2px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}
  .full{grid-column:1/-1}
  label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px;font-weight:500}
  label .req{color:var(--amber)}
  input,select,textarea{width:100%;font-family:inherit;font-size:14.5px;color:var(--ink);background:var(--sky-pale);border:1px solid var(--sky-line);border-radius:9px;padding:10px 11px;transition:border-color .15s,background .15s}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--sky);background:#fff;box-shadow:0 0 0 3px rgba(46,134,171,.11)}
  select:disabled{opacity:.5;cursor:not-allowed}
  textarea{resize:vertical;min-height:44px}
  #amount{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
  .btn-row{display:flex;gap:10px;margin-top:18px}
  button{font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;border:none;border-radius:10px;padding:13px 18px;transition:opacity .15s,transform .1s}
  button:active{transform:translateY(1px)}
  button:disabled{opacity:.55;cursor:wait}
  .primary{flex:1;background:var(--sky);color:#fff}
  .primary:hover:not(:disabled){background:var(--sky-deep)}
  .ghost{background:var(--sky-pale);color:var(--muted);border:1px solid var(--sky-line)}
  .ghost:hover:not(:disabled){color:var(--sky-deep)}
  #msg{display:none;padding:11px 14px;border-radius:9px;font-size:13.5px;margin-top:14px;line-height:1.5}
  #msg.ok{display:block;background:#EAF6EF;color:#1E6E43;border:1px solid #BFE3CE}
  #msg.err{display:block;background:#FDF0EC;color:#A6402A;border:1px solid #F2CFC4}
  .bars{display:flex;flex-direction:column;gap:9px}
  .bar-row{display:grid;grid-template-columns:88px 1fr 76px;align-items:center;gap:10px;font-size:12.5px}
  .bar-name{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar-track{height:7px;background:var(--sky-pale);border-radius:4px;overflow:hidden}
  .bar-fill{height:100%;background:var(--sky);border-radius:4px;transition:width .5s ease}
  .bar-val{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:var(--sky-deep)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:11.5px;color:var(--muted);font-weight:600;padding:0 8px 9px;border-bottom:1px solid var(--sky-line)}
  td{padding:10px 8px;border-bottom:1px solid #EEF6FA;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .t-date{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .t-cat{display:inline-block;font-size:11px;padding:2px 7px;border-radius:5px;background:var(--sky-pale);color:var(--sky-deep);white-space:nowrap}
  .t-amt{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
  .t-note{color:var(--muted);font-size:12px}
  .empty,.loading{text-align:center;color:var(--muted);font-size:13px;padding:26px 0}
  .export{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--sky);text-decoration:none;font-weight:600}
  .export:hover{color:var(--sky-deep);text-decoration:underline}
  @media(max-width:600px){
    .stats{grid-template-columns:1fr;gap:8px}
    .stat{display:flex;align-items:baseline;justify-content:space-between;padding:12px 14px}
    .stat .num{font-size:19px;margin-top:0}
    .grid{grid-template-columns:1fr}
    .bar-row{grid-template-columns:76px 1fr 68px}
    .hide-sm{display:none}
  }
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
  <div class="card" style="margin-top:34px">
    <div class="stats">
      <div class="stat"><div class="lbl" id="monthLbl">本月支出</div><div class="num"><small>NT$</small><span id="monthTotal">—</span></div></div>
      <div class="stat"><div class="lbl">今年累計</div><div class="num"><small>NT$</small><span id="yearTotal">—</span></div></div>
      <div class="stat"><div class="lbl">總筆數</div><div class="num"><span id="count">—</span></div></div>
    </div>
    <a class="export" href="/api/export.csv">↓ 下載成 Excel 可開的 CSV 檔</a>
  </div>

  <div class="card">
    <h2>記一筆支出</h2>
    <div class="grid">
      <div><label>日期 <span class="req">*</span></label><input type="date" id="date"></div>
      <div><label>金額 <span class="req">*</span></label><input type="number" id="amount" inputmode="numeric" placeholder="0"></div>
      <div><label>費用類別 <span class="req">*</span></label><select id="category"><option value="">請選擇</option></select></div>
      <div><label>品名 <span class="req">*</span></label><select id="item" disabled><option value="">先選類別</option></select></div>
      <div><label>支付方式</label><select id="payment"><option value="">未指定</option></select></div>
      <div><label>經手人 / 代墊</label><input type="text" id="person" placeholder="例：阿明代墊"></div>
      <div class="full"><label>發票 / 備註</label><textarea id="note" rows="1" placeholder="發票號碼、工地名稱、其他說明"></textarea></div>
    </div>
    <div class="btn-row">
      <button class="primary" id="saveBtn">儲存這筆</button>
      <button class="ghost" id="undoBtn">刪除最後一筆</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card">
    <h2><span id="catTitle">本月各類別支出</span></h2>
    <div class="bars" id="bars"><div class="loading">載入中…</div></div>
  </div>

  <div class="card">
    <h2>最近紀錄</h2>
    <div id="recentBox"><div class="loading">載入中…</div></div>
  </div>
</div>

<script>
var DATA = null;
function nf(n){ return (Number(n)||0).toLocaleString('en-US'); }
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
function todayStr(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

function showMsg(text, type){
  var m = el('msg'); m.textContent = text; m.className = type;
  if(type === 'ok') setTimeout(function(){ m.className=''; }, 4000);
}

function render(data){
  DATA = data;
  el('monthLbl').textContent = data.monthLabel + '支出';
  el('catTitle').textContent = data.monthLabel + '各類別支出';
  el('monthTotal').textContent = nf(data.monthTotal);
  el('yearTotal').textContent = nf(data.yearTotal);
  el('count').textContent = nf(data.count);

  var catSel = el('category');
  if(catSel.options.length <= 1){
    Object.keys(data.categories).forEach(function(c){
      var o = document.createElement('option'); o.value=c; o.textContent=c; catSel.appendChild(o);
    });
    var paySel = el('payment');
    data.payments.forEach(function(p){
      var o = document.createElement('option'); o.value=p; o.textContent=p; paySel.appendChild(o);
    });
  }
  renderBars(data);
  renderRecent(data.recent);
}

function renderBars(data){
  var box = el('bars');
  var entries = Object.keys(data.monthByCat).map(function(k){return [k,data.monthByCat[k]];})
    .filter(function(e){return e[1]>0;}).sort(function(a,b){return b[1]-a[1];});
  if(!entries.length){ box.innerHTML = '<div class="empty">這個月還沒有支出紀錄</div>'; return; }
  var max = entries[0][1];
  box.innerHTML = entries.map(function(e){
    var pct = Math.max(3, (e[1]/max)*100);
    return '<div class="bar-row"><div class="bar-name">'+esc(e[0])+'</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%"></div></div>'
      + '<div class="bar-val">'+nf(e[1])+'</div></div>';
  }).join('');
}

function renderRecent(list){
  var box = el('recentBox');
  if(!list || !list.length){ box.innerHTML = '<div class="empty">還沒有任何紀錄，從上面記第一筆吧</div>'; return; }
  var rows = list.map(function(r){
    return '<tr><td class="t-date">'+esc(r.date)+'</td>'
      + '<td><span class="t-cat">'+esc(r.category)+'</span></td>'
      + '<td>'+esc(r.item) + (r.note ? '<div class="t-note">'+esc(r.note)+'</div>' : '') + '</td>'
      + '<td class="hide-sm">'+esc(r.payment)+'</td>'
      + '<td class="hide-sm">'+esc(r.person)+'</td>'
      + '<td class="t-amt">'+nf(r.amount)+'</td></tr>';
  }).join('');
  box.innerHTML = '<table><thead><tr><th>日期</th><th>類別</th><th>品名</th><th class="hide-sm">支付</th><th class="hide-sm">經手人</th><th style="text-align:right">金額</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

el('category').addEventListener('change', function(){
  var itemSel = el('item'); itemSel.innerHTML=''; var cat = this.value;
  if(!cat){ itemSel.disabled=true; itemSel.innerHTML='<option value="">先選類別</option>'; return; }
  itemSel.disabled = false; itemSel.innerHTML = '<option value="">請選擇</option>';
  DATA.categories[cat].forEach(function(i){ var o=document.createElement('option'); o.value=i; o.textContent=i; itemSel.appendChild(o); });
  if(DATA.categories[cat].length === 1) itemSel.value = DATA.categories[cat][0];
});

el('saveBtn').addEventListener('click', function(){
  var rec = { date: el('date').value, category: el('category').value, item: el('item').value,
    amount: el('amount').value, payment: el('payment').value, person: el('person').value, note: el('note').value };
  if(!rec.date || !rec.category || !rec.item || rec.amount === ''){ showMsg('日期、費用類別、品名、金額都要填。','err'); return; }
  var btn = this; btn.disabled = true; btn.textContent = '儲存中…';
  fetch('/api/expenses', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(rec) })
    .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, data:d}; }); })
    .then(function(res){
      if(!res.ok){ throw new Error(res.data.error || '儲存失敗'); }
      render(res.data);
      el('amount').value=''; el('person').value=''; el('note').value=''; el('date').value = todayStr();
      showMsg('已存入 Cloudflare D1：' + rec.category + ' / ' + rec.item + ' / NT$' + nf(rec.amount), 'ok');
      el('amount').focus();
    })
    .catch(function(err){ showMsg('存不進去：' + err.message, 'err'); })
    .finally(function(){ btn.disabled=false; btn.textContent='儲存這筆'; });
});

el('undoBtn').addEventListener('click', function(){
  if(!confirm('要刪除資料庫最後一筆紀錄嗎？')) return;
  var btn = this; btn.disabled = true;
  fetch('/api/expenses/last', { method:'DELETE' })
    .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, data:d}; }); })
    .then(function(res){
      if(!res.ok){ throw new Error(res.data.error || '刪除失敗'); }
      render(res.data);
      showMsg('已刪除最後一筆。','ok');
    })
    .catch(function(err){ showMsg(err.message,'err'); })
    .finally(function(){ btn.disabled=false; });
});

el('date').value = todayStr();
fetch('/api/bootstrap').then(function(r){ return r.json(); }).then(render)
  .catch(function(err){ el('bars').innerHTML = '<div class="empty">載入失敗：'+err.message+'</div>'; el('recentBox').innerHTML=''; });
</script>
</body>
</html>`;
