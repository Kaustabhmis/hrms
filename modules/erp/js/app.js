/* MAX ERP - inventory, purchase, stores, quality (modules 1-4 plus dashboard).
 * Same visual system as the MAX ERP console (css/styles.css). Talks to Supabase
 * project nmoajpbkcvcxuplojhtp. Every stock change goes through database functions
 * (post_grn, record_iqc, create_purchase_return, issue_material), which run in one
 * transaction and refuse negative stock. Plain JS, no build step. */
(function () {
  "use strict";

  const SUPABASE_URL = "https://nmoajpbkcvcxuplojhtp.supabase.co";
  // Public anon key (safe in the browser; access is controlled by row-level security).
  const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tb2FqcGJrY3ZjeHVwbG9qaHRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1ODkzMTQsImV4cCI6MjA5OTE2NTMxNH0.40rFu6ajun-5uo808QeNRcF1Q_tvUs1y3onN344jFEY";

  const UNITS = ["Unit 1", "Unit 2", "Unit 3"];
  const TYPES = ["RM", "BOP", "SFG", "FG", "Consumable"];
  const BUCKETS = ["Unrestricted", "QI", "Blocked", "Reserved", "WIP", "FG"];
  const LINES = 8;

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const main = document.getElementById("main");
  const $ = (s, root) => (root || document).querySelector(s);

  // ---------- helpers ----------
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 }));
  const money = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const dt = (v) => (v ? new Date(v).toLocaleDateString("en-IN") : "—");
  const today = () => new Date().toISOString().slice(0, 10);
  const itemLabel = (i) => (i ? `${i.item_code} ${i.short_name}` : "—");

  function must(res) {
    if (res.error) throw res.error;
    return res.data;
  }

  function friendly(e) {
    const m = (e && e.message) || String(e);
    if (/po_creator_cannot_release/.test(m)) return "You created this PO, so another approver must release it.";
    if (/item_item_code_check/.test(m)) return "Item code must look like 10-100-01-01-01 (digits and dashes).";
    if (/stock_balance_qty_check/.test(m)) return "That would take stock below zero in that unit and bucket.";
    if (/duplicate key/.test(m)) return "That code or number already exists.";
    return m;
  }

  // Styled toast, same markup as the MAX ERP console.
  const TOAST_ICON = {
    success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="10.5" x2="12" y2="16"/></svg>',
  };
  function toast(message, type) {
    type = type === "err" ? "error" : type === "ok" ? "success" : type || "info";
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.innerHTML = `
      <div class="toast-bar"></div>
      <div class="toast-icon">${TOAST_ICON[type] || TOAST_ICON.info}</div>
      <div class="toast-body">
        <div class="toast-title">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
        <div class="toast-msg"></div>
      </div>
      <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>`;
    el.querySelector(".toast-msg").textContent = message;
    document.body.appendChild(el);
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    };
    el.querySelector(".toast-close").addEventListener("click", dismiss);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(dismiss, 4000);
  }

  // Styled confirm dialog (resolves true/false).
  function confirmDialog(message, opts) {
    const o = Object.assign({ title: "Are you sure?", confirmText: "Confirm", cancelText: "Cancel", danger: false }, opts || {});
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal confirm-modal">
          <div class="confirm-icon ${o.danger ? "confirm-icon-danger" : ""}">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/></svg>
          </div>
          <div class="confirm-body"><h4></h4><p></p></div>
          <div class="form-actions">
            <button type="button" class="btn ${o.danger ? "danger" : ""}" id="cd-ok"></button>
            <button type="button" class="btn secondary" id="cd-cancel"></button>
          </div>
        </div>`;
      overlay.querySelector("h4").textContent = o.title;
      overlay.querySelector("p").textContent = message;
      overlay.querySelector("#cd-ok").textContent = o.confirmText;
      overlay.querySelector("#cd-cancel").textContent = o.cancelText;
      document.body.appendChild(overlay);
      const settle = (v) => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(v);
      };
      const onKey = (e) => { if (e.key === "Escape") settle(false); };
      document.addEventListener("keydown", onKey);
      overlay.querySelector("#cd-ok").addEventListener("click", () => settle(true));
      overlay.querySelector("#cd-cancel").addEventListener("click", () => settle(false));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) settle(false); });
    });
  }

  function badge(text, tone) {
    return `<span class="badge badge-${tone || "gray"}">${esc(text)}</span>`;
  }
  const PLAIN_STATUS = {
    "Received": "New order", "Accepted": "Accepted", "In production": "Being made", "Ready for sale": "Ready for sale",
    "Draft": "Not released yet", "Pending verification": "Waiting for verification", "Verified": "Verified",
    "Released": "Sent to supplier", "Cancelled": "Cancelled", "Closed": "All done",
    "Open": "Waiting to compare", "Ordered": "PO made",
    "Posted": "Checked in", "Reversed": "Undone", "OK": "Count right", "Returned": "Sent back",
    "Pending": "Waiting", "Passed": "Pass", "Partially passed": "Part pass", "Failed": "Fail",
  };
  const STATUS_TONE = {
    "Received": "amber", "Accepted": "blue", "In production": "blue", "Ready for sale": "green",
    "Draft": "gray", "Pending verification": "amber", "Verified": "blue", "Released": "green", "Cancelled": "red", "Closed": "green",
    "Open": "amber", "Ordered": "green", "Posted": "green", "Reversed": "red", "OK": "green", "Returned": "red",
    "Pending": "amber", "Passed": "green", "Partially passed": "amber", "Failed": "red",
  };
  const BUCKET_NAME = {
    "Unrestricted": "Ready to use", "QI": "Waiting for check", "Blocked": "Not good, send back",
    "Reserved": "Kept for a job", "WIP": "In the workshop", "FG": "Finished",
  };
  function statusBadge(s) {
    return badge(PLAIN_STATUS[s] || s, STATUS_TONE[s] || "gray");
  }


  function pageHeader(title, subtitle, actions) {
    const act = actions || '<a class="btn-ghost" href="#dashboard">🏠 Home</a>';
    return `<div class="page-header"><div><h1 class="page-title">${esc(title)}</h1>${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ""}</div><div class="actions">${act}</div></div>`;
  }
  function panel(title, body, actions) {
    return `<section class="panel"><div class="panel-header"><h3>${esc(title)}</h3>${actions ? `<div class="actions">${actions}</div>` : ""}</div><div class="panel-body">${body}</div></section>`;
  }

  function opts(list, valueKey, labelFn, selected, blankLabel) {
    let h = blankLabel !== undefined ? `<option value="">${esc(blankLabel)}</option>` : "";
    for (const row of list) {
      const v = row[valueKey];
      h += `<option value="${esc(v)}"${String(v) === String(selected) ? " selected" : ""}>${esc(labelFn(row))}</option>`;
    }
    return h;
  }
  const unitOpts = (sel) => opts(UNITS.map((u) => ({ u })), "u", (r) => r.u, sel || UNITS[0]);

  // Read a form's named fields into an object. Blank values become null.
  function collect(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === "number") out[el.name] = el.value === "" ? null : Number(el.value);
      else out[el.name] = el.value.trim() === "" ? null : el.value.trim();
    }
    return out;
  }

  // Read numbered line rows (names like l3_item_id, l3_qty); keep rows that have an item.
  function readLines(form, prefix) {
    const rows = [];
    for (let i = 1; i <= LINES; i++) {
      const r = {};
      for (const el of form.querySelectorAll(`[name^="${prefix}${i}_"]`)) {
        const key = el.name.slice(`${prefix}${i}_`.length);
        r[key] = el.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value.trim() || null;
      }
      if (r.item_id) rows.push(r);
    }
    return rows;
  }

  // Line-entry table. cols: [{k, label, type}]; k === "item_id" gives an item picker.
  function lineInputs(prefix, items, cols) {
    let h = '<div class="table-wrap"><table><thead><tr><th>#</th>';
    for (const c of cols) h += `<th>${esc(c.label)}</th>`;
    h += "</tr></thead><tbody>";
    for (let i = 1; i <= LINES; i++) {
      h += `<tr><td>${i}</td>`;
      for (const c of cols) {
        const name = `${prefix}${i}_${c.k}`;
        if (c.k === "item_id") h += `<td><select name="${name}"><option value="">—</option>${opts(items, "id", itemLabel, "")}</select></td>`;
        else if (c.type === "number") h += `<td><input name="${name}" type="number" step="any" min="0"></td>`;
        else h += `<td><input name="${name}" type="text"></td>`;
      }
      h += "</tr>";
    }
    return h + "</tbody></table></div>";
  }
  const LINE_COLS_ITEM = [
    { k: "item_id", label: "Thing" },
    { k: "qty", label: "How many", type: "number" },
    { k: "rate", label: "Price each", type: "number" },
  ];

  async function currentUserId() {
    const { data } = await sb.auth.getUser();
    return data.user ? data.user.id : null;
  }

  // ---------- shell ----------
  function showLogin() {
    document.getElementById("login").hidden = false;
    document.getElementById("app").hidden = true;
  }
  async function showApp(user) {
    document.getElementById("login").hidden = true;
    document.getElementById("app").hidden = false;
    const email = user ? user.email || "" : "";
    document.getElementById("who").textContent = email;
    document.getElementById("avatar").textContent = email.charAt(0).toUpperCase() || "?";
    await route();
  }

  // ---------- views ----------
  const VIEWS = {};

  // ---------- Theory of Constraints (Goldratt) helpers ----------
  // Buffers are split into thirds. Green = safe, Yellow = watch, Red = act now, Black = already out / late.
  // Work is always done in buffer order: Black, then Red, then Yellow, then Green.
  const DAY = 86400000;
  const ZONE_RANK = { black: 0, red: 1, yellow: 2, green: 3 };
  const ZONE_TONE = { black: "gray", red: "red", yellow: "amber", green: "green" };
  const TIME_WORDS = { black: "Late!", red: "Hurry", yellow: "Watch", green: "On time" };
  const STOCK_WORDS = { black: "None left", red: "Very low", yellow: "Getting low", green: "Enough" };
  const zoneBadge = (zone, words) => `<span class="badge badge-${ZONE_TONE[zone]} zone zone-${zone}">${esc(words[zone])}</span>`;
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);
  const addDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
  const roundUp = (need, moq) => (need <= 0 ? 0 : moq > 0 ? Math.ceil(need / moq) * moq : Math.ceil(need * 1000) / 1000);

  // Time buffer of a customer order = days from order date to due date.
  function timeBuffer(o) {
    const total = Math.max(1, daysBetween(o.order_date, o.due_date));
    const used = daysBetween(o.order_date, today());
    const pen = used / total;
    const zone = pen > 1 ? "black" : pen > 2 / 3 ? "red" : pen > 1 / 3 ? "yellow" : "green";
    return { pen, zone, left: daysBetween(today(), o.due_date) };
  }

  // Latest active recipe (BOM) for each finished item.
  function recipeMap(boms) {
    const map = {};
    for (const b of boms) if (!map[b.fg_item_id] || b.version > map[b.fg_item_id].version) map[b.fg_item_id] = b;
    return map;
  }
  const perUnit = (l) => Number(l.qty_per) * (1 + Number(l.scrap_pct || 0) / 100);

  async function loadOpenOrders() {
    const rows = must(await sb.from("customer_order")
      .select("id, order_no, order_date, due_date, unit, status, customer:customer_id(name), lines:customer_order_line(id, item_id, ordered_qty, accepted_qty, kitted_qty, produced_qty, item:item_id(item_code, short_name))")
      .in("status", ["Accepted", "In production"]));
    rows.forEach((o) => (o.tb = timeBuffer(o)));
    rows.sort((a, b) => b.tb.pen - a.tb.pen); // most urgent first (drum sequence)
    return rows;
  }

  // Full-kit plan: share out ready-to-use stock to order lines in buffer order, unit by unit.
  async function loadKitPlan() {
    const [orders, boms, bal, items] = await Promise.all([
      loadOpenOrders(),
      sb.from("bom_header").select("id, fg_item_id, version, lines:bom_line(component_item_id, qty_per, scrap_pct)").eq("is_active", true),
      sb.from("stock_balance").select("item_id, unit, qty").eq("bucket", "Unrestricted"),
      sb.from("item").select("id, item_code, short_name"),
    ]);
    const recipes = recipeMap(must(boms));
    const names = {};
    for (const i of must(items)) names[i.id] = itemLabel(i);
    const pool = {};
    for (const r of must(bal)) pool[r.unit + "|" + r.item_id] = Number(r.qty);
    const plan = [];
    for (const o of orders) {
      for (const ln of o.lines) {
        const remaining = Number(ln.accepted_qty || 0) - Number(ln.kitted_qty || 0);
        if (remaining <= 0) continue;
        const rec = recipes[ln.item_id];
        const row = { o, ln, remaining, kits: 0, status: "No recipe", constraint: null };
        if (rec && rec.lines.length) {
          let possible = Infinity;
          for (const l of rec.lines) {
            const have = pool[o.unit + "|" + l.component_item_id] || 0;
            const can = Math.floor(have / perUnit(l));
            if (can < possible) { possible = can; row.constraint = names[l.component_item_id]; }
          }
          row.kits = Math.max(0, Math.min(remaining, possible));
          row.status = row.kits >= remaining ? "Full kit" : row.kits > 0 ? "Part kit" : "No kit";
          if (row.status === "Full kit") row.constraint = null;
          for (const l of rec.lines) pool[o.unit + "|" + l.component_item_id] = (pool[o.unit + "|" + l.component_item_id] || 0) - row.kits * perUnit(l);
        }
        plan.push(row);
      }
    }
    return plan;
  }

  // Stock buffers for materials (all units together), with 7/14/30-day need from accepted orders.
  async function loadMaterialBuffers() {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const [items, bal, use, pol, orders, boms, prs] = await Promise.all([
      sb.from("item").select("*").order("item_code"),
      sb.from("stock_balance").select("item_id, bucket, qty"),
      sb.from("stock_ledger").select("item_id, qty").eq("movement_code", "ISS").eq("bucket", "Unrestricted").gte("posted_at", since),
      sb.from("po_line").select("item_id, qty, received_qty, po:po_id(status)"),
      loadOpenOrders(),
      sb.from("bom_header").select("id, fg_item_id, version, lines:bom_line(component_item_id, qty_per, scrap_pct)").eq("is_active", true),
      sb.from("purchase_requisition").select("item_id").eq("status", "Open"),
    ]);
    const recipes = recipeMap(must(boms));
    const onHand = {}, onOrder = {}, used = {}, openPr = {};
    for (const r of must(bal)) if (r.bucket === "Unrestricted" || r.bucket === "QI") onHand[r.item_id] = (onHand[r.item_id] || 0) + Number(r.qty);
    for (const r of must(use)) used[r.item_id] = (used[r.item_id] || 0) - Number(r.qty);
    for (const l of must(pol)) {
      if (l.po && ["Draft", "Pending verification", "Verified", "Released"].includes(l.po.status)) {
        onOrder[l.item_id] = (onOrder[l.item_id] || 0) + Math.max(0, Number(l.qty) - Number(l.received_qty || 0));
      }
    }
    for (const p of must(prs)) openPr[p.item_id] = true;
    const need = { 7: {}, 14: {}, 30: {} };
    for (const o of orders) {
      for (const ln of o.lines) {
        const remaining = Number(ln.accepted_qty || 0) - Number(ln.kitted_qty || 0);
        const rec = recipes[ln.item_id];
        if (remaining <= 0 || !rec) continue;
        for (const h of [7, 14, 30]) {
          if (o.tb.left > h) continue;
          for (const l of rec.lines) need[h][l.component_item_id] = (need[h][l.component_item_id] || 0) + remaining * perUnit(l);
        }
      }
    }
    const list = must(items).filter((i) => i.item_type !== "FG").map((i) => {
      const adu = (used[i.id] || 0) / 30;
      let target, how;
      if (i.buffer_qty != null) { target = Number(i.buffer_qty); how = "set by you"; }
      else if (adu > 0) { target = Math.ceil(adu * i.lead_time_days * 1.5); how = "daily use x lead time x 1.5"; }
      else { target = Number(i.safety_stock || 0); how = "safety amount"; }
      const have = onHand[i.id] || 0;
      const coming = onOrder[i.id] || 0;
      let zone;
      if (target > 0) zone = have <= 0 ? "black" : have < target / 3 ? "red" : have < (2 * target) / 3 ? "yellow" : "green";
      else zone = have + coming >= (need[30][i.id] || 0) ? "green" : have <= 0 ? "black" : "red";
      const pen = target > 0 ? Math.max(0, 1 - have / target) : zone === "green" ? 0 : 1;
      const buy = {};
      for (const h of [7, 14, 30]) buy[h] = roundUp((need[h][i.id] || 0) + target - (have + coming), Number(i.moq || 0));
      return { i, adu, target, how, have, coming, need: { 7: need[7][i.id] || 0, 14: need[14][i.id] || 0, 30: need[30][i.id] || 0 }, zone, pen, buy, openPr: !!openPr[i.id] };
    });
    list.sort((a, b) => ZONE_RANK[a.zone] - ZONE_RANK[b.zone] || b.pen - a.pen);
    const byItem = {};
    for (const r of list) byItem[r.i.id] = r;
    return { list, byItem };
  }

  // ---------- Home: the 15 steps, plus today's TOC picture ----------
  const FLOW = [
    ["Sell", [
      ["1", "📩", "Order from customer", "orders", "Write down a new customer order."],
      ["2", "✅", "Accept quantity", "accept", "Say how many we will make."],
    ]],
    ["Plan", [
      ["3", "📒", "Open stock ledger", "stock", "See what we have now."],
      ["4", "🧩", "Full kit check", "kitting", "Can we make every order?"],
      ["5", "🔮", "Material forecast", "forecast", "What we need in 7, 14 and 30 days."],
    ]],
    ["Buy", [
      ["6", "📝", "PO requisition", "pr", "Ask to buy what is missing."],
      ["7", "⚖️", "Compare and choose", "compare", "Last price, supplier and payment terms."],
      ["8", "🧾", "Release and verify PO", "po", "Release the PO and get it verified."],
      ["9", "📞", "PO follow-up", "followup", "Chase the supplier, write remarks with the date."],
    ]],
    ["Store", [
      ["10", "📥", "Material received", "grn", "Write down what came in."],
      ["11", "🔢", "Store check", "storecheck", "Is the count right? Yes or no."],
      ["12", "🔬", "Quality check (IQC)", "iqc", "Pass goes on, fail goes back."],
    ]],
    ["Make", [
      ["13", "🏭", "Send to production", "issue", "Send full kits only."],
      ["14", "🛠️", "Production record", "production", "How many in process, how many finished."],
      ["15", "🎉", "Ready for sale", "ready", "Finished goods to send to the customer."],
    ]],
  ];

  VIEWS.dashboard = async () => {
    const [plan, buf] = await Promise.all([loadKitPlan(), loadMaterialBuffers()]);
    const orderZones = {};
    for (const r of plan) orderZones[r.o.id] = r.o.tb.zone;
    const lateOrders = Object.values(orderZones).filter((z) => z === "red" || z === "black").length;
    const redMaterials = buf.list.filter((r) => r.zone === "red" || r.zone === "black").length;
    const fullKits = plan.filter((r) => r.status === "Full kit").length;
    const blockers = {};
    for (const r of plan) if (r.constraint) blockers[r.constraint] = (blockers[r.constraint] || 0) + 1;
    const top = Object.entries(blockers).sort((a, b) => b[1] - a[1])[0];
    const card = (label, value, sub) => `<div class="card"><div class="card-body"><div class="card-label">${label}</div><div class="card-value">${fmt(value)}</div><div class="sub">${sub}</div></div></div>`;
    const stage = (name, steps) => `<p class="flow-stage">${esc(name)}</p><div class="kid-steps">${steps.map((st) => `<a class="kid-step" href="#${st[3]}"><span class="kid-num">${st[0]}</span><span class="kid-emoji">${st[1]}</span><span class="kid-words"><strong>${esc(st[2])}</strong><span class="muted small">${esc(st[4])}</span></span></a>`).join("")}</div>`;
    return `
      <div class="page-header"><div><h1 class="page-title">Hello! 👋</h1><p class="page-subtitle">Follow the steps from 1 to 15. Always do red jobs first.</p></div></div>
      <div class="cards-row">
        ${card("Orders in red or late", lateOrders, "Make these first")}
        ${card("Materials very low", redMaterials, "Buy or chase these first")}
        ${card("Full kits ready", fullKits, "Can go to production now")}
        ${card("Orders waiting for parts", plan.filter((r) => r.status !== "Full kit").length, "Not a full kit yet")}
      </div>
      ${panel("Today's constraint (the part holding us back)", top
        ? `<p style="font-size:16px"><strong>${esc(top[0])}</strong> is stopping ${top[1]} order line(s). Buy and chase this part first. <a href="#forecast">See the forecast</a></p>`
        : `<p class="muted">Nothing is holding back the open orders right now.</p>`)}
      ${FLOW.map(([name, steps]) => stage(name, steps)).join("")}
      ${panel("More", `<div class="kid-extras">
        <a class="kid-extra" href="#returns">↩️ Send back to supplier</a>
        <a class="kid-extra" href="#customers">🧑‍💼 Customers</a>
        <a class="kid-extra" href="#vendors">🤝 Suppliers</a>
        <a class="kid-extra" href="#items">📦 Things we use</a>
        <a class="kid-extra" href="#bom">🧩 Recipes</a>
        <a class="kid-extra" href="#ledger">📒 History</a>
      </div>`)}
      ${panel("Sample data (for practice)", `<p class="muted small" style="margin-bottom:10px">Sample records use item codes starting with 99-9 and customer or supplier codes starting with DEMO-. Removing them also removes their orders, POs, deliveries, checks and stock. Your real data is not touched.</p>
        <div class="row">
          <button class="btn secondary" data-act="demo-load" data-confirm="Add sample customers, suppliers, fans, parts, stock and orders for practice?" data-title="Add sample data" data-done="Sample data added!">Add sample data</button>
          <button class="btn danger" data-act="demo-delete" data-confirm="Remove ALL sample data (codes 99-9… and DEMO-…) and everything linked to it? This cannot be undone." data-title="Remove sample data" data-danger="1" data-done="Sample data removed.">Remove sample data</button>
        </div>`)}`;
  };

  // ---------- 1. Order from customer ----------
  VIEWS.orders = async (id) => {
    if (id) return orderDetail(id);
    const [custs, items, orders] = await Promise.all([
      sb.from("customer").select("id, name, customer_code").order("name"),
      sb.from("item").select("id, item_code, short_name, item_type").order("item_code"),
      sb.from("customer_order").select("*, customer:customer_id(name)").order("created_at", { ascending: false }).limit(200),
    ]);
    const cs = must(custs), its = must(items).filter((i) => i.item_type === "FG" || i.item_type === "SFG"), os = must(orders);
    const form = `
      <form id="f-order">
        <div class="form-grid">
          <div class="field"><label>Customer</label><select name="customer_id" required>${opts(cs, "id", (c) => c.name, "", "Choose a customer")}</select></div>
          <div class="field"><label>Customer's PO number</label><input name="customer_po_no" /></div>
          <div class="field"><label>Place to make it</label><select name="unit">${unitOpts()}</select></div>
          <div class="field"><label>When do they need it?</label><input name="due_date" type="date" required value="${addDays(14)}" /></div>
        </div>
        <div style="margin-top:14px">${lineInputs("l", its, [{ k: "item_id", label: "What they want" }, { k: "qty", label: "How many", type: "number" }])}</div>
        <div class="form-actions"><button class="btn">Save the order</button></div>
        ${cs.length ? "" : '<p class="muted small" style="margin-top:8px">No customers yet. <a href="#customers">Add a customer first.</a></p>'}
      </form>`;
    const rows = os.map((o) => `<tr><td class="mono"><a href="#orders/${o.id}">${esc(o.order_no)}</a></td><td>${esc(o.customer && o.customer.name)}</td><td>${dt(o.due_date)}</td><td>${["Closed", "Cancelled"].includes(o.status) ? "—" : zoneBadge(timeBuffer(o).zone, TIME_WORDS)}</td><td>${statusBadge(o.status)}</td></tr>`).join("")
      || '<tr><td colspan="5" class="muted">No orders yet.</td></tr>';
    return pageHeader("1. Order from customer", "Write down what the customer wants and when they need it.") + `
      ${panel("New order", form)}
      ${panel("Orders", `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Due</th><th>Time left</th><th>How it is</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  async function orderDetail(id) {
    const o = must(await sb.from("customer_order")
      .select("*, customer:customer_id(name), lines:customer_order_line(id, ordered_qty, accepted_qty, kitted_qty, produced_qty, item:item_id(item_code, short_name))")
      .eq("id", id).single());
    const rows = o.lines.map((l) => `<tr><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.ordered_qty)}</td><td class="num">${fmt(l.accepted_qty)}</td><td class="num">${fmt(l.kitted_qty)}</td><td class="num">${fmt(l.produced_qty)}</td></tr>`).join("");
    const tb = timeBuffer(o);
    return pageHeader(`Order ${o.order_no}`, `${o.customer ? o.customer.name : ""} · ${o.unit} · due ${dt(o.due_date)}`, '<a class="btn-ghost" href="#orders">All orders</a>') + `
      ${panel("Status", `<div class="row">${statusBadge(o.status)} ${["Closed", "Cancelled"].includes(o.status) ? "" : zoneBadge(tb.zone, TIME_WORDS) + ` <span class="muted">${tb.left >= 0 ? tb.left + " day(s) left" : -tb.left + " day(s) late"}</span>`}</div>`)}
      ${panel("Lines", `<div class="table-wrap"><table><thead><tr><th>What</th><th class="num">Ordered</th><th class="num">Accepted</th><th class="num">Sent to production</th><th class="num">Finished</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  }

  // ---------- 2. Accept quantity ----------
  VIEWS.accept = async () => {
    const os = must(await sb.from("customer_order")
      .select("*, customer:customer_id(name), lines:customer_order_line(id, ordered_qty, item:item_id(item_code, short_name))")
      .eq("status", "Received").order("due_date"));
    const blocks = os.map((o) => {
      const rows = o.lines.map((l) => `<tr><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.ordered_qty)}</td><td><input data-line="${l.id}" type="number" min="0" max="${l.ordered_qty}" step="any" value="${l.ordered_qty}" /></td></tr>`).join("");
      return `<section class="panel"><div class="panel-header"><h3>${esc(o.order_no)} · ${esc(o.customer && o.customer.name)}</h3><div class="actions">${zoneBadge(timeBuffer(o).zone, TIME_WORDS)}</div></div><div class="panel-body">
        <p class="muted small">Due ${dt(o.due_date)} at ${esc(o.unit)}</p>
        <div class="table-wrap"><table><thead><tr><th>What</th><th class="num">They asked for</th><th>We accept</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="form-actions"><button class="btn" data-act="accept-order" data-id="${o.id}" data-done="Order accepted!">Accept</button></div></div></section>`;
    }).join("");
    return pageHeader("2. Accept quantity", "Say how many we will really make for each new order.") + (blocks || panel("Nothing to accept", '<p class="muted">No new orders. <a href="#orders">Write down an order first.</a></p>'));
  };

  // ---------- 4. Full kit check ----------
  VIEWS.kitting = async () => {
    const plan = await loadKitPlan();
    const tone = { "Full kit": "green", "Part kit": "amber", "No kit": "red", "No recipe": "gray" };
    const rows = plan.map((r) => `<tr><td class="mono"><a href="#orders/${r.o.id}">${esc(r.o.order_no)}</a></td><td>${esc(itemLabel(r.ln.item))}</td><td>${esc(r.o.unit)}</td><td>${zoneBadge(r.o.tb.zone, TIME_WORDS)}</td><td class="num">${fmt(r.remaining)}</td><td class="num">${fmt(r.kits)}</td><td>${badge(r.status, tone[r.status])}</td><td>${r.constraint ? esc(r.constraint) : "—"}</td></tr>`).join("")
      || '<tr><td colspan="8" class="muted">No accepted orders waiting for parts.</td></tr>';
    return pageHeader("4. Full kit check", "The most urgent order gets the parts first. A job only starts when every part is there.") + `
      ${panel("Can we make every order?", `<div class="table-wrap"><table><thead><tr><th>Order</th><th>What</th><th>Place</th><th>Time left</th><th class="num">Still to make</th><th class="num">Full kits now</th><th>Kit</th><th>Part holding us back</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="muted small" style="margin-top:10px">"Part holding us back" is the constraint: the one part that stops more kits. Buy and chase it first. <a href="#issue">Send full kits to production</a></p>`)}`;
  };

  // ---------- 5. Material forecast (7 / 14 / 30 days) with stock buffers ----------
  VIEWS.forecast = async (_id, params) => {
    const h = [7, 14, 30].includes(Number(params.get("h"))) ? Number(params.get("h")) : 14;
    const unit = params.get("unit") || UNITS[0];
    const { list } = await loadMaterialBuffers();
    const filter = `<form id="f-forecastfilter" class="inline-form">
      <div class="field"><label>Look ahead</label><select name="h">${[7, 14, 30].map((d) => `<option value="${d}"${d === h ? " selected" : ""}>${d} days</option>`).join("")}</select></div>
      <div class="field"><label>Deliver to</label><select name="unit">${UNITS.map((u) => `<option value="${u}"${u === unit ? " selected" : ""}>${u}</option>`).join("")}</select></div></form>`;
    const rows = list.map((r) => {
      const buy = r.buy[h];
      const action = r.openPr
        ? '<span class="muted small">Requisition open</span>'
        : buy > 0
          ? `<button class="btn" data-act="make-pr" data-id="${r.i.id}" data-qty="${buy}" data-unit="${esc(unit)}" data-days="${r.i.lead_time_days}" data-reason="Forecast ${h} days, buffer ${STOCK_WORDS[r.zone]}" data-done="Requisition made!">Ask to buy ${fmt(buy)}</button>`
          : '<span class="muted small">Nothing to buy</span>';
      const dbm = r.target > 0
        ? `<button class="btn-ghost" data-act="buf-up" data-id="${r.i.id}" data-target="${r.target}" data-done="Buffer made bigger" title="Use when it keeps going red">+⅓</button> <button class="btn-ghost" data-act="buf-down" data-id="${r.i.id}" data-target="${r.target}" data-done="Buffer made smaller" title="Use when it stays green for a long time">−⅓</button>`
        : "";
      return `<tr><td>${esc(itemLabel(r.i))}</td><td>${zoneBadge(r.zone, STOCK_WORDS)}</td><td class="num">${fmt(r.have)}</td><td class="num">${fmt(r.coming)}</td><td class="num">${fmt(r.need[7])}</td><td class="num">${fmt(r.need[14])}</td><td class="num">${fmt(r.need[30])}</td><td class="num" title="${esc(r.how)}">${fmt(r.target)}</td><td class="num">${fmt(r.adu)}</td><td>${action}</td><td>${dbm}</td></tr>`;
    }).join("") || '<tr><td colspan="11" class="muted">No materials yet. <a href="#items">Add the things we use.</a></td></tr>';
    return pageHeader("5. Material forecast", "What we need for accepted orders in 7, 14 and 30 days, from the recipes and what we have.") + `
      ${panel("Materials, most urgent first", `${filter}<div class="table-wrap"><table><thead><tr><th>Thing</th><th>Buffer</th><th class="num">Have now</th><th class="num">On order</th><th class="num">Need 7 days</th><th class="num">Need 14 days</th><th class="num">Need 30 days</th><th class="num">Buffer size</th><th class="num">Used per day</th><th></th><th>Buffer size</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="muted small" style="margin-top:10px">Buffer size = used per day x lead time x 1.5 (or the size you set). Buffer colours: Enough (top third), Getting low (middle third), Very low (bottom third), None left. Buy = need in ${h} days + buffer size - (have now + on order), rounded up to the smallest order amount. If a buffer keeps going red, press +⅓. If it stays green for a long time, press −⅓.</p>`)}`;
  };

  // ---------- 6. PO requisition ----------
  VIEWS.pr = async () => {
    const [prs, items, buf] = await Promise.all([
      sb.from("purchase_requisition").select("*, item:item_id(item_code, short_name, stock_uom), po:po_id(po_no)").order("created_at", { ascending: false }).limit(300),
      sb.from("item").select("id, item_code, short_name, item_type").order("item_code"),
      loadMaterialBuffers(),
    ]);
    const list = must(prs);
    list.sort((a, b) => (a.status === "Open" ? 0 : 1) - (b.status === "Open" ? 0 : 1) || ZONE_RANK[(buf.byItem[a.item_id] || {}).zone || "green"] - ZONE_RANK[(buf.byItem[b.item_id] || {}).zone || "green"]);
    const form = `
      <form id="f-pr" class="form-grid">
        <div class="field" style="grid-column:1/-1"><label>Thing</label><select name="item_id" required>${opts(must(items).filter((i) => i.item_type !== "FG"), "id", itemLabel, "", "Choose a thing")}</select></div>
        <div class="field"><label>How many</label><input name="qty" type="number" step="any" min="0.001" required /></div>
        <div class="field"><label>Deliver to</label><select name="unit">${unitOpts()}</select></div>
        <div class="field"><label>Needed by</label><input name="needed_by" type="date" value="${addDays(7)}" /></div>
        <div class="field"><label>Why</label><input name="reason" placeholder="For example: order SO/2627/00001" /></div>
        <div class="form-actions"><button class="btn">Make requisition</button></div>
      </form>`;
    const rows = list.map((p) => {
      const z = buf.byItem[p.item_id];
      return `<tr><td class="mono">${esc(p.pr_no)}</td><td>${esc(itemLabel(p.item))}</td><td class="num">${fmt(p.qty)}</td><td>${p.item ? p.item.stock_uom : ""}</td><td>${dt(p.needed_by)}</td><td>${z ? zoneBadge(z.zone, STOCK_WORDS) : "—"}</td><td>${esc(p.reason) || "—"}</td><td>${statusBadge(p.status)}</td><td>${p.status === "Open" ? `<a class="btn" href="#compare">Compare</a> <button class="btn-ghost" data-act="pr-cancel" data-id="${p.id}" data-confirm="Cancel this requisition?" data-title="Cancel requisition" data-done="Requisition cancelled">Cancel</button>` : p.po ? `<span class="muted small">${esc(p.po.po_no)}</span>` : ""}</td></tr>`;
    }).join("") || '<tr><td colspan="9" class="muted">No requisitions yet. Make them from the <a href="#forecast">forecast</a> or here.</td></tr>';
    return pageHeader("6. PO requisition", "A list of things we need to buy. Most are made from the forecast with one click.") + `
      ${panel("Ask to buy something", form)}
      ${panel("Requisitions", `<div class="table-wrap"><table><thead><tr><th>No</th><th>Thing</th><th class="num">How many</th><th>Unit</th><th>Needed by</th><th>Buffer</th><th>Why</th><th>How it is</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  // ---------- 7. Compare last purchase: vendor, rate and payment terms ----------
  VIEWS.compare = async () => {
    const [prs, vendors, history, buf] = await Promise.all([
      sb.from("purchase_requisition").select("*, item:item_id(item_code, short_name, stock_uom)").eq("status", "Open").order("needed_by"),
      sb.from("vendor").select("id, name, vendor_code, payment_terms").order("name"),
      sb.from("po_line").select("item_id, qty, rate, po:po_id(po_no, po_date, status, vendor:vendor_id(id, name, payment_terms))"),
      loadMaterialBuffers(),
    ]);
    const vs = must(vendors);
    const hist = {};
    for (const l of must(history)) {
      if (!l.po || ["Draft", "Cancelled"].includes(l.po.status)) continue;
      (hist[l.item_id] = hist[l.item_id] || []).push(l);
    }
    const list = must(prs);
    list.sort((a, b) => ZONE_RANK[(buf.byItem[a.item_id] || {}).zone || "green"] - ZONE_RANK[(buf.byItem[b.item_id] || {}).zone || "green"]);
    const blocks = list.map((p) => {
      const past = (hist[p.item_id] || []).sort((a, b) => String(b.po.po_date).localeCompare(String(a.po.po_date))).slice(0, 5);
      const last = past[0];
      const cheapest = past.reduce((m, l) => (m == null || Number(l.rate) < Number(m.rate) ? l : m), null);
      const z = buf.byItem[p.item_id];
      const histRows = past.map((l) => `<tr><td>${dt(l.po.po_date)}</td><td class="mono">${esc(l.po.po_no)}</td><td>${esc(l.po.vendor && l.po.vendor.name)}${l === cheapest ? " " + badge("Cheapest", "green") : ""}${l === last ? " " + badge("Last", "blue") : ""}</td><td class="num">${money(l.rate)}</td><td class="num">${fmt(l.qty)}</td><td>${esc(l.po.vendor && l.po.vendor.payment_terms) || "—"}</td></tr>`).join("")
        || '<tr><td colspan="6" class="muted">Never bought before.</td></tr>';
      const vendorSel = `<select name="vendor" required>${opts(vs, "id", (v) => `${v.name}${v.payment_terms ? " (" + v.payment_terms + ")" : ""}`, last && last.po.vendor ? last.po.vendor.id : "", "Choose a supplier")}</select>`;
      return `<section class="panel"><div class="panel-header"><h3>${esc(p.pr_no)} · ${esc(itemLabel(p.item))} · ${fmt(p.qty)} ${p.item ? p.item.stock_uom : ""}</h3><div class="actions">${z ? zoneBadge(z.zone, STOCK_WORDS) : ""}</div></div><div class="panel-body">
        <p class="muted small">Needed by ${dt(p.needed_by)} at ${esc(p.unit)}. ${esc(p.reason || "")}</p>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>PO</th><th>Supplier</th><th class="num">Price each</th><th class="num">How many</th><th>Payment terms</th></tr></thead><tbody>${histRows}</tbody></table></div>
        <div class="inline-form" style="margin-top:12px">
          <div class="field" style="min-width:280px"><label>Choose supplier</label>${vendorSel}</div>
          <div class="field"><label>Price each</label><input name="rate" type="number" step="any" min="0" value="${last ? last.rate : ""}" /></div>
          <div class="form-actions"><button class="btn" data-act="pr-to-po" data-id="${p.id}" data-done="PO made! Now release it for verification.">Make PO</button></div>
        </div></div></section>`;
    }).join("");
    return pageHeader("7. Compare and choose", "Look at the last purchases of the same thing: supplier, price and payment terms. Then make the PO.") + (blocks || panel("Nothing to compare", '<p class="muted">No open requisitions. <a href="#pr">Make a requisition first.</a></p>'));
  };

  // ---------- 8. Release PO and send for verification ----------
  VIEWS.po = async (id) => {
    if (id) return poDetail(id);
    const [pos, uid] = await Promise.all([
      sb.from("purchase_order").select("*, vendor:vendor_id(name), lines:po_line(qty, rate, item:item_id(item_code, short_name))").order("created_at", { ascending: false }).limit(300),
      currentUserId(),
    ]);
    const order = { "Draft": 0, "Pending verification": 1, "Verified": 2, "Released": 3, "Closed": 4, "Cancelled": 5 };
    const ps = must(pos).sort((a, b) => order[a.status] - order[b.status]);
    const who = await peopleNames(ps.flatMap((p) => [p.created_by, p.verified_by]));
    const actionFor = (p) => {
      if (p.status === "Draft") return `<button class="btn" data-act="po-submit" data-id="${p.id}" data-done="Released for verification!">Release for verification</button>`;
      if (p.status === "Pending verification") return `<a class="btn" href="#po/${p.id}">Check and verify</a>`;
      if (p.status === "Verified") return p.created_by === uid
        ? '<span class="muted small">Someone else must send it (you made it)</span>'
        : `<button class="btn" data-act="po-release" data-id="${p.id}" data-confirm="Send this PO to the supplier now?" data-title="Send PO" data-done="Sent to the supplier!">Send to supplier</button>`;
      if (p.status === "Released") return '<a class="btn-ghost" href="#followup">Follow up</a>';
      return "";
    };
    const rows = ps.map((p) => {
      const total = (p.lines || []).reduce((s, l) => s + Number(l.qty) * Number(l.rate), 0);
      const what = (p.lines || []).map((l) => `${itemLabel(l.item)} x ${fmt(l.qty)}`).join(", ");
      return `<tr><td class="mono"><a href="#po/${p.id}">${esc(p.po_no)}</a></td><td>${esc(p.vendor && p.vendor.name)}</td><td>${esc(what)}</td><td class="num">${money(total)}</td><td>${dt(p.expected_date)}</td><td>${statusBadge(p.status)}</td><td class="small">${esc(who(p.created_by)) || "—"}</td><td class="small">${esc(who(p.verified_by)) || "—"}</td><td>${actionFor(p)}</td></tr>`;
    }).join("") || '<tr><td colspan="9" class="muted">No POs yet. Make one on <a href="#compare">Compare and choose</a>.</td></tr>';
    return pageHeader("8. Release and verify PO", "Release the PO for verification. Someone checks supplier, price and terms. Then it is sent to the supplier.") + `
      ${panel("Purchase orders", `<div class="table-wrap"><table><thead><tr><th>PO</th><th>Supplier</th><th>What</th><th class="num">Money</th><th>Expected</th><th>How it is</th><th>Made by</th><th>Verified by</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="muted small" style="margin-top:10px">The person who made a PO cannot be the one who sends it to the supplier.</p>`)}`;
  };

  // ---------- 9. PO follow-up and remarks with date (PO tracking) ----------
  VIEWS.followup = async () => {
    const [pos, fus, buf] = await Promise.all([
      sb.from("purchase_order").select("*, vendor:vendor_id(name), lines:po_line(item_id, qty, received_qty, item:item_id(item_code, short_name))").eq("status", "Released"),
      sb.from("po_followup").select("*").order("created_at", { ascending: false }),
      loadMaterialBuffers(),
    ]);
    const notes = {};
    for (const f of must(fus)) (notes[f.po_id] = notes[f.po_id] || []).push(f);
    const rows = must(pos).map((p) => {
      const open = (p.lines || []).filter((l) => Number(l.received_qty || 0) < Number(l.qty));
      const zone = open.reduce((z, l) => { const b = buf.byItem[l.item_id]; return b && ZONE_RANK[b.zone] < ZONE_RANK[z] ? b.zone : z; }, "green");
      const last = (notes[p.id] || [])[0];
      const promised = (last && last.promised_date) || p.expected_date;
      const late = promised ? daysBetween(promised, today()) : 0;
      return { p, open, zone, last, promised, late, all: notes[p.id] || [] };
    }).sort((a, b) => ZONE_RANK[a.zone] - ZONE_RANK[b.zone] || b.late - a.late);
    const body = rows.map((r) => `<tr>
      <td class="mono"><a href="#po/${r.p.id}">${esc(r.p.po_no)}</a></td><td>${esc(r.p.vendor && r.p.vendor.name)}</td>
      <td>${esc(r.open.map((l) => `${itemLabel(l.item)}: ${fmt(Number(l.qty) - Number(l.received_qty || 0))} to come`).join(", "))}</td>
      <td>${zoneBadge(r.zone, STOCK_WORDS)}</td>
      <td>${dt(r.promised)}${r.late > 0 ? " " + badge(r.late + " day(s) late", "red") : ""}</td>
      <td>${r.all.slice(0, 3).map((f) => `<div class="small"><strong>${dt(f.followup_date)}</strong> ${esc(f.remarks)}</div>`).join("") || '<span class="muted small">No follow-up yet</span>'}</td>
      <td><input name="remarks" type="text" placeholder="What did the supplier say?" /></td>
      <td><input name="promised" type="date" /></td>
      <td><button class="btn" data-act="fu-save" data-id="${r.p.id}" data-done="Follow-up saved!">Save</button></td></tr>`).join("")
      || '<tr><td colspan="9" class="muted">No POs to chase. POs appear here after they are sent to the supplier.</td></tr>';
    return pageHeader("9. PO follow-up", "Chase the supplier and write what they said, with the date. Chase red ones first.") + `
      ${panel("POs waiting for material", `<div class="table-wrap"><table><thead><tr><th>PO</th><th>Supplier</th><th>Still to come</th><th>Buffer</th><th>Promised</th><th>Last remarks</th><th>New remark</th><th>New promised date</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`)}`;
  };

  // ---------- 10. Material received at store ----------
  VIEWS.grn = async (id) => {
    if (id) return grnDetail(id);
    const [vendors, items, pos, grns] = await Promise.all([
      sb.from("vendor").select("id, name, vendor_code").order("name"),
      sb.from("item").select("id, item_code, short_name").order("item_code"),
      sb.from("purchase_order").select("id, po_no, vendor:vendor_id(name)").eq("status", "Released").order("po_no"),
      sb.from("grn").select("*, vendor:vendor_id(name)").order("created_at", { ascending: false }).limit(200),
    ]);
    const vs = must(vendors), its = must(items), ps = must(pos), gs = must(grns);
    const form = `
      <form id="f-grn">
        <div class="form-grid">
          <div class="field"><label>Which PO did it come for?</label><select name="po_id">${opts(ps, "id", (p) => `${p.po_no} (${p.vendor ? p.vendor.name : ""})`, "", "No PO")}</select></div>
          <div class="field"><label>Supplier</label><select name="vendor_id" required>${opts(vs, "id", (v) => v.name, "", "Choose a supplier")}</select></div>
          <div class="field"><label>Place</label><select name="unit">${unitOpts()}</select></div>
          <div class="field"><label>Date it came</label><input name="received_on" type="date" value="${today()}" required /></div>
        </div>
        <p class="muted small" style="margin-top:8px">Choose the PO and the list fills itself.</p>
        <div style="margin-top:10px">${lineInputs("l", its, [{ k: "item_id", label: "Thing" }, { k: "qty", label: "How many on the challan", type: "number" }, { k: "batch_no", label: "Batch (optional)" }])}</div>
        <div class="form-actions"><button class="btn">Save the delivery</button></div>
      </form>`;
    const rows = gs.map((g) => `<tr><td class="mono"><a href="#grn/${g.id}">${esc(g.grn_no)}</a></td><td>${dt(g.received_on)}</td><td>${esc(g.vendor && g.vendor.name)}</td><td>${esc(g.unit)}</td><td>${g.status === "Draft" ? '<a class="btn" href="#storecheck">Count it</a>' : statusBadge(g.status)}</td></tr>`).join("")
      || '<tr><td colspan="5" class="muted">No deliveries yet.</td></tr>';
    return pageHeader("10. Material received", "Write down what came in from the supplier.") + `
      ${panel("New delivery", form)}
      ${panel("Deliveries", `<div class="table-wrap"><table><thead><tr><th>No</th><th>Came on</th><th>Supplier</th><th>Place</th><th>How it is</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  async function grnDetail(id) {
    const [head, lines] = await Promise.all([
      sb.from("grn").select("*, vendor:vendor_id(name), po:po_id(po_no)").eq("id", id).single(),
      sb.from("grn_line").select("*, item:item_id(item_code, short_name), lot:inspection_lot(status, accepted_qty, rejected_qty)").eq("grn_id", id),
    ]);
    const g = must(head);
    const rows = must(lines).map((l) => {
      const lot = l.lot && l.lot.length ? l.lot[0] : null;
      return `<tr><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.qty)}</td><td>${statusBadge(l.store_check)}${l.store_remarks ? ` <span class="muted small">${esc(l.store_remarks)}</span>` : ""}</td><td>${lot ? statusBadge(lot.status) : "—"}</td><td class="num">${lot ? fmt(lot.accepted_qty) : "—"}</td><td class="num">${lot ? fmt(lot.rejected_qty) : "—"}</td></tr>`;
    }).join("");
    return pageHeader(`Delivery ${g.grn_no}`, `${g.vendor ? g.vendor.name : ""} · ${g.unit} · came ${dt(g.received_on)} · PO ${g.po ? g.po.po_no : "none"}`, '<a class="btn-ghost" href="#grn">All deliveries</a>') + `
      ${g.status === "Draft" ? panel("Next step", '<a class="btn" href="#storecheck">11. Store check: count it</a>') : ""}
      ${panel("Lines", `<div class="table-wrap"><table><thead><tr><th>Thing</th><th class="num">On challan</th><th>Store count</th><th>Quality</th><th class="num">Pass</th><th class="num">Fail</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  }

  // ---------- 11. Store entry: verify quantity (yes -> IQC, no -> back to vendor) ----------
  VIEWS.storecheck = async () => {
    const [drafts, returned] = await Promise.all([
      sb.from("grn").select("*, vendor:vendor_id(name), lines:grn_line(id, qty, batch_no, item:item_id(item_code, short_name))").eq("status", "Draft").order("received_on"),
      sb.from("grn_line").select("qty, store_remarks, item:item_id(item_code, short_name), grn:grn_id(grn_no, received_on, vendor:vendor_id(name))").eq("store_check", "Returned"),
    ]);
    const blocks = must(drafts).map((g) => {
      const rows = g.lines.map((l) => `<tr><td>${esc(itemLabel(l.item))}</td><td>${esc(l.batch_no) || "—"}</td><td class="num">${fmt(l.qty)}</td>
        <td><label class="yn"><input type="radio" name="ok_${l.id}" value="yes" checked /> Yes</label> <label class="yn"><input type="radio" name="ok_${l.id}" value="no" data-line="${l.id}" /> No</label></td></tr>`).join("");
      return `<section class="panel"><div class="panel-header"><h3>${esc(g.grn_no)} · ${esc(g.vendor && g.vendor.name)}</h3></div><div class="panel-body">
        <p class="muted small">Came on ${dt(g.received_on)} at ${esc(g.unit)}. Count each thing. Is it the same as the challan?</p>
        <div class="table-wrap"><table><thead><tr><th>Thing</th><th>Batch</th><th class="num">On challan</th><th>Count is right?</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="inline-form" style="margin-top:12px"><div class="field" style="min-width:280px"><label>Note for "No" lines</label><input name="remarks" placeholder="For example: 5 short" /></div>
        <div class="form-actions"><button class="btn" data-act="grn-check" data-id="${g.id}" data-confirm="Yes lines go to quality check. No lines go back to the supplier. Save?" data-title="Save store check" data-done="Store check saved! Yes lines are waiting for IQC.">Save store check</button></div></div>
      </div></section>`;
    }).join("");
    const back = must(returned).map((l) => `<tr><td>${dt(l.grn && l.grn.received_on)}</td><td class="mono">${esc(l.grn && l.grn.grn_no)}</td><td>${esc(l.grn && l.grn.vendor && l.grn.vendor.name)}</td><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.qty)}</td><td>${esc(l.store_remarks) || "—"}</td></tr>`).join("")
      || '<tr><td colspan="6" class="muted">Nothing sent back at the store.</td></tr>';
    return pageHeader("11. Store check", "Count what came in. Right count goes to quality check (IQC). Wrong count goes back to the supplier.") +
      (blocks || panel("Nothing to count", '<p class="muted">No new deliveries. <a href="#grn">Write down a delivery first.</a></p>')) +
      panel("Sent back at the store (wrong count)", `<div class="table-wrap"><table><thead><tr><th>Came on</th><th>Delivery</th><th>Supplier</th><th>Thing</th><th class="num">How many</th><th>Note</th></tr></thead><tbody>${back}</tbody></table></div>`);
  };

  // ---------- 13. Send material for production (full kits only) ----------
  VIEWS.issue = async () => {
    const plan = await loadKitPlan();
    const rows = plan.map((r) => {
      const can = r.kits > 0;
      return `<tr><td class="mono"><a href="#orders/${r.o.id}">${esc(r.o.order_no)}</a></td><td>${esc(itemLabel(r.ln.item))}</td><td>${esc(r.o.unit)}</td><td>${zoneBadge(r.o.tb.zone, TIME_WORDS)}</td><td class="num">${fmt(r.remaining)}</td><td class="num">${fmt(r.kits)}</td>
        <td>${can ? `<input name="qty" type="number" min="1" step="1" max="${r.kits}" value="${r.kits}" />` : `<span class="muted small">${r.constraint ? "Waiting for " + esc(r.constraint) : esc(r.status)}</span>`}</td>
        <td>${can ? `<button class="btn" data-act="kit-issue" data-id="${r.ln.id}" data-unit="${esc(r.o.unit)}" data-done="Full kit sent to production!">Send full kit</button>` : ""}</td></tr>`;
    }).join("") || '<tr><td colspan="8" class="muted">No accepted orders waiting. <a href="#accept">Accept an order first.</a></td></tr>';
    return pageHeader("13. Send to production", "Only send complete kits, most urgent order first. Half kits make jobs stop in the middle.") + `
      ${panel("Orders, most urgent first", `<div class="table-wrap"><table><thead><tr><th>Order</th><th>What</th><th>Place</th><th>Time left</th><th class="num">Still to make</th><th class="num">Full kits now</th><th>How many to send</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  // ---------- 14. Production record (WIP <-> process, FG) ----------
  VIEWS.production = async () => {
    const [orders, recs] = await Promise.all([
      loadOpenOrders(),
      sb.from("production_record").select("*, item:item_id(item_code, short_name), line:order_line_id(order:order_id(order_no))").order("created_at", { ascending: false }).limit(50),
    ]);
    const rows = [];
    for (const o of orders) for (const ln of o.lines) {
      const inProcess = Number(ln.kitted_qty || 0) - Number(ln.produced_qty || 0);
      if (inProcess <= 0) continue;
      rows.push(`<tr><td class="mono"><a href="#orders/${o.id}">${esc(o.order_no)}</a></td><td>${esc(itemLabel(ln.item))}</td><td>${esc(o.unit)}</td><td>${zoneBadge(o.tb.zone, TIME_WORDS)}</td><td class="num">${fmt(ln.kitted_qty)}</td><td class="num">${fmt(ln.produced_qty)}</td><td class="num">${fmt(inProcess)}</td>
        <td><input name="fg" type="number" min="0" step="1" max="${inProcess}" value="0" /></td>
        <td><input name="wip" type="number" min="0" step="1" value="${inProcess}" /></td>
        <td><input name="rem" type="text" /></td>
        <td><button class="btn" data-act="prod-save" data-id="${ln.id}" data-unit="${esc(o.unit)}" data-done="Production saved!">Save</button></td></tr>`);
    }
    const hist = must(recs).map((r) => `<tr><td>${dt(r.record_date)}</td><td class="mono">${esc(r.line && r.line.order && r.line.order.order_no)}</td><td>${esc(itemLabel(r.item))}</td><td class="num">${fmt(r.wip_qty)}</td><td class="num">${fmt(r.fg_qty)}</td><td>${esc(r.remarks) || "—"}</td></tr>`).join("")
      || '<tr><td colspan="6" class="muted">No production records yet.</td></tr>';
    return pageHeader("14. Production record", "Each day, write how many are still being made (WIP) and how many are finished (FG).") + `
      ${panel("In the workshop, most urgent first", `<div class="table-wrap"><table><thead><tr><th>Order</th><th>What</th><th>Place</th><th>Time left</th><th class="num">Kits sent</th><th class="num">Finished so far</th><th class="num">In process</th><th>Finished today</th><th>Still in process</th><th>Note</th><th></th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="11" class="muted">Nothing in the workshop. <a href="#issue">Send a full kit first.</a></td></tr>'}</tbody></table></div>`)}
      ${panel("Recent records", `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Order</th><th>What</th><th class="num">In process</th><th class="num">Finished</th><th>Note</th></tr></thead><tbody>${hist}</tbody></table></div>`)}`;
  };

  // ---------- 15. Ready for sale ----------
  VIEWS.ready = async () => {
    const [orders, fg] = await Promise.all([
      sb.from("customer_order").select("*, customer:customer_id(name), lines:customer_order_line(accepted_qty, produced_qty, item:item_id(item_code, short_name))").eq("status", "Ready for sale").order("due_date"),
      sb.from("stock_balance").select("unit, qty, item:item_id(item_code, short_name)").eq("bucket", "FG").gt("qty", 0),
    ]);
    const blocks = must(orders).map((o) => `<tr><td class="mono"><a href="#orders/${o.id}">${esc(o.order_no)}</a></td><td>${esc(o.customer && o.customer.name)}</td><td>${esc(o.lines.map((l) => `${itemLabel(l.item)} x ${fmt(l.accepted_qty)}`).join(", "))}</td><td>${dt(o.due_date)}</td><td>${zoneBadge(timeBuffer(o).zone, TIME_WORDS)}</td>
      <td><button class="btn" data-act="dispatch" data-id="${o.id}" data-confirm="Send these finished goods to the customer?" data-title="Send to customer" data-done="Sent to the customer!">Send to customer</button></td></tr>`).join("")
      || '<tr><td colspan="6" class="muted">No orders are ready yet.</td></tr>';
    const stock = must(fg).map((r) => `<tr><td>${esc(r.unit)}</td><td>${esc(itemLabel(r.item))}</td><td class="num">${fmt(r.qty)}</td></tr>`).join("")
      || '<tr><td colspan="3" class="muted">No finished goods in stock.</td></tr>';
    return pageHeader("15. Ready for sale", "Finished goods waiting to go to the customer.") + `
      ${panel("Orders ready to send", `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>What</th><th>Due</th><th>Time left</th><th></th></tr></thead><tbody>${blocks}</tbody></table></div>`)}
      ${panel("Finished goods in stock", `<div class="table-wrap"><table><thead><tr><th>Place</th><th>What</th><th class="num">How many</th></tr></thead><tbody>${stock}</tbody></table></div>`)}`;
  };

  // ---------- Customers ----------
  VIEWS.customers = async () => {
    const list = must(await sb.from("customer").select("*").order("name"));
    const form = `
      <form id="f-customer" class="form-grid">
        <div class="field"><label>Customer code</label><input name="customer_code" required /></div>
        <div class="field"><label>Name</label><input name="name" required /></div>
        <div class="field"><label>GSTIN</label><input name="gstin" maxlength="15" /></div>
        <div class="field" style="grid-column:1/-1"><label>Address</label><input name="address" /></div>
        <div class="form-actions"><button class="btn">Save customer</button></div>
      </form>`;
    const rows = list.map((c) => `<tr><td class="mono">${esc(c.customer_code)}</td><td>${esc(c.name)}</td><td>${esc(c.gstin) || "—"}</td><td>${esc(c.address) || "—"}</td></tr>`).join("")
      || '<tr><td colspan="4" class="muted">No customers yet.</td></tr>';
    return pageHeader("Customers", "The companies that buy our fans.") + panel("New customer", form) + panel(`${list.length} customers`, `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>GSTIN</th><th>Address</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  };

  VIEWS.items = async () => {
    const [items, uoms] = await Promise.all([
      sb.from("item").select("*").order("item_code"),
      sb.from("uom").select("*").order("code"),
    ]);
    const list = must(items);
    const units = must(uoms);
    const form = `
      <form id="f-item" class="form-grid">
        <div class="field"><label>Code (leave empty and we make one)</label><input name="item_code" placeholder="Leave empty" pattern="[0-9]{2}-[0-9]{3}-[0-9]{2}-[0-9]{2}-[0-9]{2}" /></div>
        <div class="field"><label>Name</label><input name="short_name" required maxlength="31" /></div>
        <div class="field"><label>Unit (like pieces or kg)</label><select name="stock_uom" required>${opts(units, "code", (u) => `${u.code} - ${u.name}`, "")}</select></div>
        <div class="field"><label>Kind</label><select name="item_type">${TYPES.map((t) => `<option>${t}</option>`).join("")}</select></div>
        <details class="more" style="grid-column:1/-1"><summary>More settings (for experts, you can skip these)</summary>
          <div class="form-grid" style="margin-top:12px">
            <div class="field"><label>Description</label><input name="description" /></div>
            <div class="field"><label>Buy in another unit (optional)</label><select name="purchase_uom"><option value="">Same as stock</option>${opts(units, "code", (u) => `${u.code} - ${u.name}`, "")}</select></div>
            <div class="field"><label>Conversion (buy unit to stock unit)</label><input name="conversion_factor" type="number" step="any" min="0.001" value="1" /></div>
            <div class="field"><label>Safety amount</label><input name="safety_stock" type="number" step="any" min="0" value="0" /></div>
            <div class="field"><label>Smallest order amount</label><input name="moq" type="number" step="any" min="0" value="0" /></div>
            <div class="field"><label>Lead time (days to get it)</label><input name="lead_time_days" type="number" step="1" min="1" value="7" /></div>
            <div class="field"><label>Buffer size (leave empty to work it out)</label><input name="buffer_qty" type="number" step="any" min="0" /></div>
          </div>
        </details>
        <div class="form-actions"><button class="btn">Save</button></div>
      </form>`;
    const rows = list.map((i) => `<tr><td class="mono">${esc(i.item_code)}</td><td>${esc(i.short_name)}</td><td>${i.item_type}</td><td>${i.stock_uom}</td><td>${i.purchase_uom || "—"}</td><td class="num">${fmt(i.conversion_factor)}</td><td class="num">${fmt(i.safety_stock)}</td><td class="num">${fmt(i.moq)}</td></tr>`).join("")
      || '<tr><td colspan="8" class="muted">No items yet.</td></tr>';
    return pageHeader("Things we use", "Write down every thing we buy or make, like a fan blade or a motor.") + `
      ${panel("New item", form)}
      ${panel(`${list.length} items`, `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Stock UOM</th><th>Purchase UOM</th><th class="num">Conv.</th><th class="num">Safety</th><th class="num">MOQ</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  VIEWS.bom = async (id) => {
    if (id) return bomDetail(id);
    const [items, heads] = await Promise.all([
      sb.from("item").select("id,item_code,short_name,item_type").order("item_code"),
      sb.from("bom_header").select("*, fg:fg_item_id(item_code, short_name)").order("fg_item_id"),
    ]);
    const itemList = must(items);
    const headList = must(heads);
    const form = `
      <form id="f-bom">
        <div class="form-grid">
          <div class="field" style="grid-column:1/-1"><label>Finished or sub-assembly item</label><select name="fg_item_id" required>${opts(itemList, "id", itemLabel, "", "Choose a thing")}</select></div>
          <div class="field"><label>Version</label><input name="version" type="number" min="1" step="1" value="1" required /></div>
        </div>
        <div style="margin-top:14px">${lineInputs("c", itemList, [
          { k: "item_id", label: "Component" },
          { k: "qty", label: "Qty per unit", type: "number" },
          { k: "scrap", label: "Scrap %", type: "number" },
        ])}</div>
        <div class="form-actions"><button class="btn">Save BOM</button></div>
      </form>`;
    const rows = headList.map((h) => `<tr><td>${h.fg ? esc(itemLabel(h.fg)) : "—"}</td><td class="num">${h.version}</td><td>${h.is_active ? badge("Active", "green") : badge("Inactive", "gray")}</td><td><a href="#bom/${h.id}">Open</a></td></tr>`).join("")
      || '<tr><td colspan="4" class="muted">No BOMs yet.</td></tr>';
    return pageHeader("Recipes", "Which parts go into one finished fan, and how many of each.") + `
      ${panel("New BOM", form)}
      ${panel(`${headList.length} BOMs`, `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Version</th><th>How it is</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  async function bomDetail(id) {
    const [head, lines] = await Promise.all([
      sb.from("bom_header").select("*, fg:fg_item_id(item_code, short_name)").eq("id", id).single(),
      sb.from("bom_line").select("*, component:component_item_id(item_code, short_name, stock_uom)").eq("bom_id", id),
    ]);
    const h = must(head);
    const ls = must(lines);
    const rows = ls.map((l) => `<tr><td>${esc(itemLabel(l.component))}</td><td>${l.component.stock_uom}</td><td class="num">${fmt(l.qty_per)}</td><td class="num">${fmt(l.scrap_pct)}</td><td class="num calc" data-per="${l.qty_per}" data-scrap="${l.scrap_pct}">—</td></tr>`).join("")
      || '<tr><td colspan="5" class="muted">No components.</td></tr>';
    const calc = `<form id="f-calc" class="inline-form" style="margin-bottom:14px"><div class="field"><label>How many?</label><input name="units" type="number" min="0" step="any" value="100" /></div></form>`;
    return `
      ${pageHeader(`BOM: ${itemLabel(h.fg)} v${h.version}`, "Required quantity per component, including scrap.", `<a class="btn-ghost" href="#bom">All BOMs</a>`)}
      ${panel("Components", calc + `<div class="table-wrap"><table><thead><tr><th>Component</th><th>Unit</th><th class="num">Qty per unit</th><th class="num">Scrap %</th><th class="num">Required</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted small" style="margin-top:10px">Required = units x qty per unit x (1 + scrap %), before stock is netted off.</p>`)}`;
  }

  VIEWS.vendors = async () => {
    const list = must(await sb.from("vendor").select("*").order("vendor_code"));
    const form = `
      <form id="f-vendor" class="form-grid">
        <div class="field"><label>Supplier code</label><input name="vendor_code" required /></div>
        <div class="field"><label>Name</label><input name="name" required /></div>
        <div class="field"><label>GSTIN</label><input name="gstin" maxlength="15" /></div>
        <div class="field"><label>Payment terms</label><input name="payment_terms" placeholder="30 days" /></div>
        <div class="field" style="grid-column:1/-1"><label>Address</label><input name="address" /></div>
        <div class="form-actions"><button class="btn">Save supplier</button></div>
      </form>`;
    const rows = list.map((v) => `<tr><td class="mono">${esc(v.vendor_code)}</td><td>${esc(v.name)}</td><td>${esc(v.gstin) || "—"}</td><td>${esc(v.payment_terms) || "—"}</td><td>${esc(v.address) || "—"}</td></tr>`).join("")
      || '<tr><td colspan="5" class="muted">No vendors yet.</td></tr>';
    return pageHeader("Suppliers", "The shops and companies we buy things from.") + `
      ${panel("New vendor", form)}
      ${panel(`${list.length} vendors`, `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>GSTIN</th><th>Payment terms</th><th>Address</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  // ---------- PO preview: who made it, who verified it, who sent it; verifier can edit ----------
  const COMPANY = { name: "Dynamic Engineers Private Limited", address: "28 Barrackpore Trunk Road, Kolkata 700002", gstin: "19AABCD0345D1Z5" };
  const STAND_IN_APPROVER = "00000000-0000-0000-0000-00000000d3e0";
  const dtm = (v) => (v ? new Date(v).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "");
  async function peopleNames(ids) {
    const list = [...new Set(ids.filter(Boolean))];
    const map = { [STAND_IN_APPROVER]: "Second approver (sample data)" };
    if (list.length) {
      const { data } = await sb.rpc("user_emails", { p_ids: list });
      for (const r of data || []) map[r.id] = r.email;
    }
    return (id) => (id ? map[id] || "Unknown user" : "");
  }

  async function poDetail(id) {
    const [head, lines, logs, vendors, uid] = await Promise.all([
      sb.from("purchase_order").select("*, vendor:vendor_id(name, vendor_code, gstin, address, payment_terms)").eq("id", id).single(),
      sb.from("po_line").select("*, item:item_id(item_code, short_name, stock_uom)").eq("po_id", id).order("id"),
      sb.from("po_change_log").select("*").eq("po_id", id).order("changed_at", { ascending: false }),
      sb.from("vendor").select("id, name, payment_terms").order("name"),
      currentUserId(),
    ]);
    const p = must(head), ls = must(lines), changes = must(logs);
    const who = await peopleNames([p.created_by, p.verified_by, p.released_by, ...changes.map((c) => c.changed_by)]);
    const editable = p.status === "Draft" || p.status === "Pending verification";
    const isMaker = p.created_by === uid;

    let taxable = 0, gst = 0;
    const docRows = ls.map((l, i) => {
      const amt = Number(l.qty) * Number(l.rate);
      const tax = amt * Number(l.gst_rate || 0) / 100;
      taxable += amt; gst += tax;
      return `<tr><td>${i + 1}</td><td class="mono">${esc(l.item.item_code)}</td><td>${esc(l.item.short_name)}</td><td class="num">${fmt(l.qty)}</td><td>${esc(l.item.stock_uom)}</td><td class="num">${money(l.rate)}</td><td class="num">${fmt(l.gst_rate)}</td><td class="num">${money(amt)}</td><td class="num">${money(tax)}</td><td class="num">${money(amt + tax)}</td></tr>`;
    }).join("");
    const sign = (label, person, when, waiting) => `<div class="po-sign-box"><div class="po-label">${label}</div>${person ? `<strong>${esc(person)}</strong><div class="muted small">${esc(when)}</div>` : `<span class="muted">${waiting}</span>`}</div>`;
    const doc = `
      <div class="po-doc po-sheet">
        <div class="po-head">
          <div class="po-co"><img src="assets/DEPL_logo.png" alt="" class="po-logo" /><div><strong>${esc(COMPANY.name)}</strong><div>${esc(COMPANY.address)}</div><div>GSTIN: ${esc(COMPANY.gstin)}</div></div></div>
          <div class="po-title"><div class="po-word">PURCHASE ORDER</div><div><strong>${esc(p.po_no)}</strong></div><div>Date: ${dt(p.po_date)}</div><div>${statusBadge(p.status)}</div></div>
        </div>
        <div class="po-parties">
          <div><div class="po-label">Supplier</div><strong>${esc(p.vendor && p.vendor.name)}</strong><div>${esc(p.vendor && p.vendor.address) || ""}</div>${p.vendor && p.vendor.gstin ? `<div>GSTIN: ${esc(p.vendor.gstin)}</div>` : ""}</div>
          <div><div class="po-label">Deliver to</div><strong>${esc(COMPANY.name)}</strong><div>${esc(p.unit)}</div><div>Expected by: ${dt(p.expected_date)}</div><div>Payment terms: ${esc(p.payment_terms) || "—"}</div></div>
        </div>
        <table class="po-lines"><thead><tr><th>#</th><th>Code</th><th>Thing</th><th class="num">Qty</th><th>Unit</th><th class="num">Price</th><th class="num">GST %</th><th class="num">Amount</th><th class="num">GST</th><th class="num">Total</th></tr></thead>
          <tbody>${docRows || '<tr><td colspan="10" class="muted">No lines.</td></tr>'}</tbody>
          <tfoot>
            <tr><td colspan="9" class="num">Amount before GST</td><td class="num">${money(taxable)}</td></tr>
            <tr><td colspan="9" class="num">GST</td><td class="num">${money(gst)}</td></tr>
            <tr class="po-grand"><td colspan="9" class="num">Total</td><td class="num">${money(taxable + gst)}</td></tr>
          </tfoot></table>
        ${p.remarks ? `<div class="po-remarks"><div class="po-label">Remarks</div>${esc(p.remarks)}</div>` : ""}
        <div class="po-sign">
          ${sign("Made by", who(p.created_by), dtm(p.created_at), "")}
          ${sign("Verified by", who(p.verified_by), dtm(p.verified_at), "Waiting for verification")}
          ${sign("Sent to supplier by", who(p.released_by), dtm(p.released_at), "Not sent yet")}
        </div>
      </div>`;

    let action = "", hint = "";
    if (p.status === "Draft") {
      action = `<button class="btn" data-act="po-submit" data-id="${id}" data-done="Released for verification!">Release for verification</button>`;
      hint = "The maker can still edit it. After releasing, the verifier checks it and can change it.";
    } else if (p.status === "Pending verification") {
      action = `<button class="btn" data-act="po-verify" data-id="${id}" data-confirm="Have you checked supplier, price, GST, quantity and terms? Verified POs cannot be changed." data-title="Verify PO" data-done="Verified!">Verify</button>`;
      hint = "Verifier: check the preview. Fix anything below, save, then press Verify.";
    } else if (p.status === "Verified") {
      action = isMaker
        ? `<button class="btn" disabled>Send to supplier</button>`
        : `<button class="btn" data-act="po-release" data-id="${id}" data-done="Sent to the supplier!" data-confirm="Send this PO to the supplier now?" data-title="Send to supplier">Send to supplier</button>`;
      hint = isMaker ? "You made this PO, so someone else must send it to the supplier." : "Verified and locked. Send it to the supplier.";
    } else if (p.status === "Released") {
      action = '<a class="btn-ghost" href="#followup">Follow up</a>';
      hint = "Sent to the supplier. Chase it on PO follow-up.";
    }

    const editPanel = editable ? `
      <section class="panel no-print"><div class="panel-header"><h3>${p.status === "Draft" ? "Edit before releasing" : "Verifier: check and edit"}</h3></div><div class="panel-body">
        <form id="f-poedit" data-id="${id}">
          <div class="form-grid">
            <div class="field"><label>Supplier</label><select name="vendor_id">${opts(must(vendors), "id", (v) => `${v.name}${v.payment_terms ? " (" + v.payment_terms + ")" : ""}`, p.vendor_id)}</select></div>
            <div class="field"><label>Expected by</label><input name="expected_date" type="date" value="${p.expected_date || ""}" /></div>
            <div class="field"><label>Payment terms</label><input name="payment_terms" value="${esc(p.payment_terms || "")}" placeholder="30 days" /></div>
            <div class="field" style="grid-column:1/-1"><label>Remarks</label><input name="remarks" value="${esc(p.remarks || "")}" placeholder="For example: price agreed on phone" /></div>
          </div>
          <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Thing</th><th>How many</th><th>Price each</th><th>GST %</th></tr></thead><tbody>
            ${ls.map((l) => `<tr><td>${esc(itemLabel(l.item))}</td><td><input type="number" step="any" min="0.001" data-line="${l.id}" data-field="qty" value="${Number(l.qty)}" /></td><td><input type="number" step="any" min="0" data-line="${l.id}" data-field="rate" value="${Number(l.rate)}" /></td><td><input type="number" step="any" min="0" data-line="${l.id}" data-field="gst_rate" value="${Number(l.gst_rate || 0)}" /></td></tr>`).join("")}
          </tbody></table></div>
          <div class="form-actions"><button class="btn">Save changes</button></div>
          <p class="muted small" style="margin-top:8px">Every change is saved in the history below with your name and the time.</p>
        </form>
      </div></section>` : "";

    const history = changes.map((c) => `<tr><td>${dtm(c.changed_at)}</td><td>${esc(who(c.changed_by))}</td><td>${esc(c.field)}</td><td>${esc(c.old_value) || "—"}</td><td>${esc(c.new_value) || "—"}</td></tr>`).join("")
      || '<tr><td colspan="5" class="muted">No changes made.</td></tr>';
    const receipts = ["Released", "Closed"].includes(p.status)
      ? panel("Deliveries", `<div class="table-wrap"><table><thead><tr><th>Thing</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Still to come</th></tr></thead><tbody>${ls.map((l) => `<tr><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.qty)}</td><td class="num">${fmt(l.received_qty)}</td><td class="num">${fmt(Math.max(0, Number(l.qty) - Number(l.received_qty || 0)))}</td></tr>`).join("")}</tbody></table></div>`).replace('class="panel"', 'class="panel no-print"')
      : "";

    return `
      ${pageHeader(`PO ${p.po_no}`, `${p.vendor ? p.vendor.name : ""} · ${p.unit}`, `<button class="btn-ghost" data-act="print">🖨️ Print</button> <a class="btn-ghost" href="#po">All POs</a>`)}
      <section class="panel no-print"><div class="panel-body"><div class="row" style="justify-content:space-between"><span>${esc(hint)}</span><div class="row">${action}</div></div></div></section>
      <section class="panel po-panel"><div class="panel-body">${doc}</div></section>
      ${editPanel}
      ${receipts}
      ${panel("Change history", `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Old</th><th>New</th></tr></thead><tbody>${history}</tbody></table></div>`).replace('class="panel"', 'class="panel no-print"')}`;
  }

  VIEWS.iqc = async () => {
    const rows = must(await sb.from("inspection_lot")
      .select("*, line:grn_line_id(qty, batch_no, item:item_id(item_code, short_name), grn:grn_id(grn_no, unit))")
      .order("id", { ascending: false })
      .limit(300));
    rows.sort((a, b) => (a.status === "Pending" ? 0 : 1) - (b.status === "Pending" ? 0 : 1));
    const body = rows.map((r) => {
      const grn = r.line && r.line.grn;
      const base = `<td class="mono">${esc(grn && grn.grn_no)}</td><td>${grn ? grn.unit : "—"}</td><td>${esc(r.line && itemLabel(r.line.item))}</td><td>${esc(r.line && r.line.batch_no) || "—"}</td><td class="num">${fmt(r.line && r.line.qty)}</td><td>${statusBadge(r.status)}</td>`;
      if (r.status !== "Pending") return `<tr>${base}<td class="num">${fmt(r.accepted_qty)}</td><td class="num">${fmt(r.rejected_qty)}</td><td>${esc(r.remarks) || "—"}</td><td></td></tr>`;
      const qty = r.line ? r.line.qty : 0;
      return `<tr>${base}
        <td><input name="acc" type="number" step="any" min="0" max="${qty}" value="${qty}" /></td>
        <td><input name="rej" type="number" step="any" min="0" max="${qty}" value="0" /></td>
        <td><input name="rem" type="text" /></td>
        <td><button class="btn" data-act="iqc-save" data-id="${r.id}" data-done="Check saved">Save the check</button></td></tr>`;
    }).join("") || '<tr><td colspan="10" class="muted">No inspection lots yet. Post a goods receipt to create them.</td></tr>';
    return pageHeader("12. Quality check (IQC)", "Pass goes on to production. Fail goes back to the supplier.") + `
      ${panel("Inspection lots", `<div class="table-wrap"><table><thead><tr><th>GRN</th><th>Place</th><th>Item</th><th>Batch</th><th class="num">Received</th><th>How it is</th><th class="num">Good</th><th class="num">Not good</th><th>Note</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`)}`;
  };

  VIEWS.returns = async () => {
    const [lots, returns] = await Promise.all([
      sb.from("inspection_lot")
        .select("*, line:grn_line_id(batch_no, item:item_id(item_code, short_name), grn:grn_id(grn_no, unit, vendor_id, vendor:vendor_id(name)))")
        .gt("rejected_qty", 0)
        .order("id", { ascending: false }),
      sb.from("purchase_return").select("*, vendor:vendor_id(name)").order("created_at", { ascending: false }),
    ]);
    const lotList = must(lots);
    const retList = must(returns);
    const returned = {};
    for (const r of retList) returned[r.inspection_lot_id] = (returned[r.inspection_lot_id] || 0) + Number(r.qty);
    const body = lotList.map((l) => {
      const done = returned[l.id] || 0;
      const remaining = Number(l.rejected_qty) - done;
      if (remaining <= 0) return "";
      const grn = l.line && l.line.grn;
      return `<tr><td class="mono">${esc(grn && grn.grn_no)}</td><td>${esc(grn && grn.vendor && grn.vendor.name)}</td><td>${esc(l.line && itemLabel(l.line.item))}</td><td class="num">${fmt(l.rejected_qty)}</td><td class="num">${fmt(done)}</td><td class="num">${fmt(remaining)}</td>
        <td><input name="qty" type="number" step="any" min="0" max="${remaining}" value="${remaining}" /></td>
        <td><input name="rem" type="text" /></td>
        <td><button class="btn" data-act="ret-save" data-id="${l.id}" data-done="Sent back!" data-confirm="Send these bad things back to the supplier?" data-title="Send it back">Send it back</button></td></tr>`;
    }).join("") || '<tr><td colspan="9" class="muted">No rejected stock is waiting for a return.</td></tr>';
    const past = retList.map((r) => `<tr><td>${dt(r.created_at)}</td><td>${esc(r.vendor && r.vendor.name)}</td><td class="num">${fmt(r.qty)}</td><td>${esc(r.remarks) || "—"}</td></tr>`).join("")
      || '<tr><td colspan="4" class="muted">No returns yet.</td></tr>';
    return pageHeader("Send bad things back", "Send the not good things back to the supplier they came from.") + `
      ${panel("Waiting for return", `<div class="table-wrap"><table><thead><tr><th>GRN</th><th>Vendor</th><th>Item</th><th class="num">Not good</th><th class="num">Returned</th><th class="num">Remaining</th><th>How many to send back</th><th>Note</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`)}
      ${panel("Returns made", `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Vendor</th><th class="num">How many</th><th>Note</th></tr></thead><tbody>${past}</tbody></table></div>`)}`;
  };

  VIEWS.stock = async (_id, params) => {
    const unit = params.get("unit") || "";
    let q = sb.from("stock_balance").select("unit, bucket, qty, item:item_id(item_code, short_name, stock_uom)").gt("qty", 0);
    if (unit) q = q.eq("unit", unit);
    const rows = must(await q);
    rows.sort((a, b) => a.unit.localeCompare(b.unit) || a.item.item_code.localeCompare(b.item.item_code) || BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));
    const filter = `<form id="f-stockfilter" class="inline-form"><div class="field"><label>Place</label><select name="unit"><option value="">All units</option>${UNITS.map((u) => `<option value="${u}"${u === unit ? " selected" : ""}>${u}</option>`).join("")}</select></div></form>`;
    const body = rows.map((r) => `<tr><td>${r.unit}</td><td>${esc(itemLabel(r.item))}</td><td>${badge(BUCKET_NAME[r.bucket] || r.bucket, r.bucket === "Blocked" ? "red" : r.bucket === "QI" ? "amber" : r.bucket === "Unrestricted" ? "green" : "gray")}</td><td class="num">${fmt(r.qty)}</td><td>${r.item.stock_uom}</td></tr>`).join("")
      || '<tr><td colspan="5" class="muted">No stock with a quantity above zero.</td></tr>';
    return pageHeader("3. Open stock ledger", "How many of each thing we have, and where it is.", '<a class="btn-ghost" href="#ledger">📒 History</a> <a class="btn-ghost" href="#dashboard">🏠 Home</a>') + `
      ${panel("Stock on hand", `${filter}<div class="table-wrap"><table><thead><tr><th>Place</th><th>Item</th><th>Where it is</th><th class="num">How many</th><th>Unit</th></tr></thead><tbody>${body}</tbody></table></div>`)}`;
  };

  VIEWS.ledger = async (_id, params) => {
    const item = params.get("item") || "";
    let q = sb.from("stock_ledger").select("*, item:item_id(item_code, short_name)").order("id", { ascending: false }).limit(300);
    if (item) q = q.eq("item_id", item);
    const [rows, items] = await Promise.all([q, sb.from("item").select("id,item_code,short_name").order("item_code")]);
    const list = must(rows);
    const its = must(items);
    const filter = `<form id="f-ledgerfilter" class="inline-form"><div class="field" style="min-width:320px"><label>Thing</label><select name="item"><option value="">Latest 300 movements (all items)</option>${opts(its, "id", itemLabel, item)}</select></div></form>`;
    const body = list.map((r) => `<tr><td>${new Date(r.posted_at).toLocaleString("en-IN")}</td><td>${esc(itemLabel(r.item))}</td><td>${r.unit}</td><td>${BUCKET_NAME[r.bucket] || r.bucket}</td><td class="mono">${r.movement_code}</td><td class="num">${fmt(r.qty)}</td><td class="mono">${esc(r.source_doc) || "—"}</td><td>${esc(r.remarks) || "—"}</td></tr>`).join("")
      || '<tr><td colspan="8" class="muted">No movements yet.</td></tr>';
    return pageHeader("History", "Every time something came in, went out, or was checked.") + `
      ${panel("Movements", `${filter}<div class="table-wrap"><table><thead><tr><th>When</th><th>Item</th><th>Place</th><th>Where it is</th><th>Code</th><th class="num">How many</th><th>Why</th><th>Note</th></tr></thead><tbody>${body}</tbody></table></div>`)}`;
  };


  // ---------- form submissions ----------
  const FORMS = {};

  FORMS["f-item"] = async (f) => {
    const v = collect(f);
    v.conversion_factor = v.conversion_factor || 1;
    v.safety_stock = v.safety_stock || 0;
    v.moq = v.moq || 0;
    v.lead_time_days = v.lead_time_days || 7;
    if (!v.item_code) {
      const n = (await sb.from("item").select("id", { count: "exact", head: true })).count || 0;
      v.item_code = `10-${String(100 + n).padStart(3, "0")}-01-01-01`;
    }
    must(await sb.from("item").insert(v));
  };

  FORMS["f-vendor"] = async (f) => {
    must(await sb.from("vendor").insert(collect(f)));
  };

  FORMS["f-bom"] = async (f) => {
    const v = collect(f);
    const lines = readLines(f, "c");
    if (!v.fg_item_id) throw new Error("Choose the fan this recipe is for.");
    if (!lines.length) throw new Error("Add at least one part.");
    const head = must(await sb.from("bom_header").insert({ fg_item_id: v.fg_item_id, version: v.version || 1 }).select("id").single());
    const res = await sb.from("bom_line").insert(lines.map((l) => ({ bom_id: head.id, component_item_id: l.item_id, qty_per: l.qty, scrap_pct: l.scrap || 0 })));
    if (res.error) {
      await sb.from("bom_header").delete().eq("id", head.id);
      throw res.error;
    }
    toast("Recipe saved!", "success");
    location.hash = "#bom/" + head.id;
    return "skip-route";
  };

  FORMS["f-customer"] = async (f) => {
    must(await sb.from("customer").insert(collect(f)));
  };

  FORMS["f-order"] = async (f) => {
    const v = collect(f);
    const lines = readLines(f, "l");
    if (!v.customer_id) throw new Error("Choose a customer.");
    if (!lines.length) throw new Error("Add at least one thing the customer wants.");
    if (lines.some((l) => !(l.qty > 0))) throw new Error("Write how many for every line.");
    const order_no = must(await sb.rpc("next_doc_no", { p_prefix: "SO" }));
    const head = must(await sb.from("customer_order").insert({ order_no, customer_id: v.customer_id, customer_po_no: v.customer_po_no, unit: v.unit, due_date: v.due_date }).select("id").single());
    const res = await sb.from("customer_order_line").insert(lines.map((l) => ({ order_id: head.id, item_id: l.item_id, ordered_qty: l.qty })));
    if (res.error) {
      await sb.from("customer_order").delete().eq("id", head.id);
      throw res.error;
    }
    toast(`Order ${order_no} saved. Next: accept the quantity.`, "success");
    location.hash = "#accept";
    return "skip-route";
  };

  FORMS["f-pr"] = async (f) => {
    const v = collect(f);
    if (!v.item_id) throw new Error("Choose a thing.");
    const pr_no = must(await sb.rpc("next_doc_no", { p_prefix: "PR" }));
    must(await sb.from("purchase_requisition").insert({ pr_no, item_id: v.item_id, qty: v.qty, unit: v.unit, needed_by: v.needed_by, reason: v.reason }));
  };

  FORMS["f-grn"] = async (f) => {
    const v = collect(f);
    const lines = readLines(f, "l");
    if (!v.vendor_id) throw new Error("Choose a supplier.");
    if (!lines.length) throw new Error("Add at least one thing that came in.");
    if (lines.some((l) => !(l.qty > 0))) throw new Error("Write how many for every line.");
    const grn_no = must(await sb.rpc("next_doc_no", { p_prefix: "GRN" }));
    const head = must(await sb.from("grn").insert({ grn_no, vendor_id: v.vendor_id, unit: v.unit, received_on: v.received_on, po_id: v.po_id || null }).select("id").single());
    const res = await sb.from("grn_line").insert(lines.map((l) => ({ grn_id: head.id, item_id: l.item_id, qty: l.qty, batch_no: l.batch_no })));
    if (res.error) {
      await sb.from("grn").delete().eq("id", head.id);
      throw res.error;
    }
    toast(`Delivery ${grn_no} saved. Next: count it.`, "success");
    location.hash = "#storecheck";
    return "skip-route";
  };

  FORMS["f-forecastfilter"] = async () => "skip-route";

  FORMS["f-poedit"] = async (f) => {
    const v = collect(f);
    const lines = {};
    f.querySelectorAll("input[data-line]").forEach((i) => {
      (lines[i.dataset.line] = lines[i.dataset.line] || { line_id: i.dataset.line })[i.dataset.field] = i.value === "" ? null : Number(i.value);
    });
    const n = must(await sb.rpc("edit_po", {
      p_po_id: f.dataset.id, p_vendor_id: v.vendor_id, p_expected_date: v.expected_date,
      p_payment_terms: v.payment_terms || "", p_remarks: v.remarks || "", p_lines: Object.values(lines),
    }));
    toast(n ? `${n} change(s) saved` : "Nothing was changed", n ? "success" : "info");
    await route();
    return "skip-route";
  };

  // Material received: choosing a PO fills in the supplier and what is still to come.
  document.addEventListener("change", async (e) => {
    const f = e.target.form;
    if (!f || f.id !== "f-grn" || e.target.name !== "po_id" || !e.target.value) return;
    try {
      const po = must(await sb.from("purchase_order").select("vendor_id, unit, lines:po_line(item_id, qty, received_qty)").eq("id", e.target.value).single());
      f.vendor_id.value = po.vendor_id;
      f.unit.value = po.unit;
      const open = po.lines.filter((l) => Number(l.received_qty || 0) < Number(l.qty));
      for (let i = 1; i <= LINES; i++) {
        const l = open[i - 1];
        f[`l${i}_item_id`].value = l ? l.item_id : "";
        f[`l${i}_qty`].value = l ? Number(l.qty) - Number(l.received_qty || 0) : "";
      }
    } catch (err) {
      toast(friendly(err), "error");
    }
  });

  // Filters and the BOM calculator are handled by change/input listeners below.
  FORMS["f-stockfilter"] = FORMS["f-ledgerfilter"] = FORMS["f-calc"] = async () => "skip-route";

  document.addEventListener("change", (e) => {
    const f = e.target.form;
    if (!f) return;
    if (f.id === "f-stockfilter") location.hash = "#stock?unit=" + encodeURIComponent(f.unit.value);
    if (f.id === "f-ledgerfilter") location.hash = "#ledger?item=" + encodeURIComponent(f.item.value);
    if (f.id === "f-forecastfilter") location.hash = "#forecast?h=" + encodeURIComponent(f.h.value) + "&unit=" + encodeURIComponent(f.unit.value);
  });

  document.addEventListener("input", (e) => {
    const f = e.target.form;
    if (!f || f.id !== "f-calc") return;
    const units = Number(f.units.value) || 0;
    document.querySelectorAll("td.calc").forEach((td) => {
      td.textContent = fmt(units * Number(td.dataset.per) * (1 + Number(td.dataset.scrap) / 100));
    });
  });

  // ---------- row actions ----------
  const ACTIONS = {
    // 2. Accept quantity
    "accept-order": async (id, el) => {
      const lines = [...el.closest("section").querySelectorAll("input[data-line]")].map((i) => ({ line_id: i.dataset.line, qty: Number(i.value) }));
      must(await sb.rpc("accept_order", { p_order_id: id, p_lines: lines }));
    },
    // 5. Forecast -> 6. Requisition
    "make-pr": async (id, el) => {
      const pr_no = must(await sb.rpc("next_doc_no", { p_prefix: "PR" }));
      must(await sb.from("purchase_requisition").insert({
        pr_no, item_id: id, qty: Number(el.dataset.qty), unit: el.dataset.unit,
        needed_by: addDays(Number(el.dataset.days) || 7), reason: el.dataset.reason,
      }));
    },
    // TOC dynamic buffer management: +1/3 when it keeps going red, -1/3 when it stays green.
    "buf-up": async (id, el) => must(await sb.from("item").update({ buffer_qty: Math.ceil(Number(el.dataset.target) * 4 / 3) }).eq("id", id)),
    "buf-down": async (id, el) => must(await sb.from("item").update({ buffer_qty: Math.max(0, Math.floor(Number(el.dataset.target) * 2 / 3)) }).eq("id", id)),
    "pr-cancel": async (id) => must(await sb.from("purchase_requisition").update({ status: "Cancelled" }).eq("id", id).eq("status", "Open")),
    // 7. Compare -> PO
    "pr-to-po": async (id, el) => {
      const box = el.closest("section");
      const vendor = box.querySelector('[name="vendor"]').value;
      const rate = box.querySelector('[name="rate"]').value;
      if (!vendor) throw new Error("Choose a supplier.");
      must(await sb.rpc("make_po_from_pr", { p_pr_id: id, p_vendor_id: vendor, p_rate: rate === "" ? 0 : Number(rate) }));
    },
    // 8. Release for verification -> verify -> send to supplier
    "po-submit": async (id) => must(await sb.from("purchase_order").update({ status: "Pending verification" }).eq("id", id)),
    "po-verify": async (id) => must(await sb.from("purchase_order").update({ status: "Verified", verified_by: await currentUserId() }).eq("id", id)),
    "po-release": async (id) => must(await sb.from("purchase_order").update({ status: "Released", released_by: await currentUserId() }).eq("id", id)),
    // 9. Follow-up with date
    "fu-save": async (id, el) => {
      const tr = el.closest("tr");
      const remarks = tr.querySelector('[name="remarks"]').value.trim();
      const promised = tr.querySelector('[name="promised"]').value || null;
      if (!remarks) throw new Error("Write what the supplier said.");
      must(await sb.from("po_followup").insert({ po_id: id, remarks, promised_date: promised }));
      if (promised) must(await sb.from("purchase_order").update({ expected_date: promised }).eq("id", id));
    },
    // 11. Store check
    "grn-check": async (id, el) => {
      const box = el.closest("section");
      const returned = [...box.querySelectorAll('input[type="radio"][value="no"]:checked')].map((r) => r.dataset.line);
      const remarks = box.querySelector('[name="remarks"]').value.trim() || null;
      must(await sb.rpc("post_grn_checked", { p_grn_id: id, p_returned: returned, p_remarks: remarks }));
    },
    // 12. IQC
    "iqc-save": async (id, el) => {
      const tr = el.closest("tr");
      const acc = Number(tr.querySelector('[name="acc"]').value);
      const rej = Number(tr.querySelector('[name="rej"]').value);
      const rem = tr.querySelector('[name="rem"]').value.trim() || null;
      must(await sb.rpc("record_iqc", { p_lot_id: id, p_accepted: acc, p_rejected: rej, p_remarks: rem }));
    },
    "ret-save": async (id, el) => {
      const tr = el.closest("tr");
      const qty = Number(tr.querySelector('[name="qty"]').value);
      const rem = tr.querySelector('[name="rem"]').value.trim() || null;
      must(await sb.rpc("create_purchase_return", { p_lot_id: id, p_qty: qty, p_remarks: rem }));
    },
    // 13. Full kit to production
    "kit-issue": async (id, el) => {
      const qty = Number(el.closest("tr").querySelector('[name="qty"]').value);
      must(await sb.rpc("issue_kit", { p_order_line_id: id, p_unit: el.dataset.unit, p_qty: qty }));
    },
    // 14. Production record
    "prod-save": async (id, el) => {
      const tr = el.closest("tr");
      must(await sb.rpc("record_production", {
        p_order_line_id: id, p_unit: el.dataset.unit,
        p_fg_qty: Number(tr.querySelector('[name="fg"]').value) || 0,
        p_wip_qty: Number(tr.querySelector('[name="wip"]').value) || 0,
        p_remarks: tr.querySelector('[name="rem"]').value.trim() || null,
      }));
    },
    // 15. Send to customer
    "dispatch": async (id) => must(await sb.rpc("dispatch_order", { p_order_id: id })),
    // Sample data for practice
    "demo-load": async () => must(await sb.rpc("load_demo_data")),
    "demo-delete": async () => must(await sb.rpc("delete_demo_data")),
  };

  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === "signup" || act === "signout") return;
    if (act === "print") { window.print(); return; }
    e.preventDefault();
    if (el.dataset.confirm) {
      const ok = await confirmDialog(el.dataset.confirm, { title: el.dataset.title || "Are you sure?", confirmText: el.textContent.trim(), danger: el.dataset.danger === "1" });
      if (!ok) return;
    }
    el.disabled = true;
    try {
      await ACTIONS[act](el.dataset.id, el);
      toast(el.dataset.done || "Saved!", "success");
      await route();
    } catch (err) {
      toast(friendly(err), "error");
      el.disabled = false;
    }
  });

  // Sign-in and sign-out.
  document.getElementById("f-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = document.getElementById("login-error");
    err.hidden = true;
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) {
      err.textContent = error.message;
      err.hidden = false;
    }
  });
  document.querySelector('[data-act="signup"]').addEventListener("click", async () => {
    const f = document.getElementById("f-login");
    if (!f.reportValidity()) return;
    const { data, error } = await sb.auth.signUp({ email: f.email.value.trim(), password: f.password.value });
    if (error) return toast(error.message, "error");
    toast(data.session ? "Account created" : "Account created. Confirm your email, then sign in.", "success");
  });
  document.querySelector('[data-act="signout"]').addEventListener("click", async () => {
    await sb.auth.signOut();
  });

  // Form submissions inside the app.
  main.addEventListener("submit", async (e) => {
    const f = e.target;
    const h = FORMS[f.id];
    if (!h) return;
    e.preventDefault();
    const btn = f.querySelector("button");
    if (btn) btn.disabled = true;
    try {
      const result = await h(f);
      if (result !== "skip-route") {
        toast("Saved!", "success");
        f.reset();
        await route();
      }
    } catch (err) {
      toast(friendly(err), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ---------- router ----------
  async function route() {
    const raw = location.hash.replace(/^#/, "") || "dashboard";
    const [path, query = ""] = raw.split("?");
    const [name, id] = path.split("/");
    const params = new URLSearchParams(query);
    document.querySelectorAll(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
    const view = VIEWS[name];
    if (!view) {
      main.innerHTML = pageHeader("Page not found", "") ;
      return;
    }
    main.innerHTML = '<p class="muted">Loading…</p>';
    try {
      main.innerHTML = await view(id, params);
    } catch (e) {
      main.innerHTML = `<section class="panel"><div class="panel-body">Could not load this page: ${esc(friendly(e))}</div></section>`;
    }
  }

  window.addEventListener("hashchange", () => {
    if (!document.getElementById("app").hidden) route();
  });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" || !session) showLogin();
    else if (document.getElementById("app").hidden) showApp(session.user);
  });

  (async function boot() {
    const { data } = await sb.auth.getSession();
    if (data.session) showApp(data.session.user);
    else showLogin();
  })();
})();
