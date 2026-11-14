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
    "Draft": "Not sent yet", "Pending verification": "Waiting to be checked", "Verified": "Checked",
    "Released": "Sent to supplier", "Cancelled": "Cancelled", "Closed": "All done",
    "Posted": "Got it", "Reversed": "Undone", "Pending": "Waiting", "Passed": "Good",
    "Partially passed": "Some good", "Failed": "Not good",
  };
  const BUCKET_NAME = {
    "Unrestricted": "Ready to use", "QI": "Waiting for check", "Blocked": "Not good, send back",
    "Reserved": "Kept for a job", "WIP": "In the workshop", "FG": "Finished",
  };
  function statusBadge(s) {
    const tone = /Released|Verified|Passed|Posted|Closed/.test(s) ? "green" : /Failed|Blocked|Cancelled|Reversed/.test(s) ? "red" : /Pending|Partially/.test(s) ? "amber" : "gray";
    return badge(PLAIN_STATUS[s] || s, tone);
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

  VIEWS.dashboard = async () => {
    const steps = [
      ["1", "📦", "Write down the things we use", "items", "Add each thing we buy or make."],
      ["2", "🤝", "Write down our suppliers", "vendors", "Add the shops we buy from."],
      ["3", "🧾", "Order from a supplier", "po", "Make an order and send it."],
      ["4", "📥", "Got a delivery?", "grn", "Write down what came in."],
      ["5", "🔬", "Check it is good", "iqc", "Say how many are good."],
      ["6", "🏭", "Send to the workshop", "issue", "Send good things to make fans."],
    ];
    const extras = [
      ["📊", "What we have", "stock"],
      ["📈", "Can we make it?", "planning"],
      ["↩️", "Send bad things back", "returns"],
      ["📒", "History", "ledger"],
    ];
    return `
      <div class="page-header"><div><h1 class="page-title">Hello! 👋</h1><p class="page-subtitle">Follow the steps in order, from 1 to 6.</p></div></div>
      <div class="kid-steps">
        ${steps.map((st) => `<a class="kid-step" href="#${st[3]}"><span class="kid-num">${st[0]}</span><span class="kid-emoji">${st[1]}</span><span class="kid-words"><strong>${esc(st[2])}</strong><span class="muted small">${esc(st[4])}</span></span></a>`).join("")}
      </div>
      ${panel("Other things you can do", `<div class="kid-extras">${extras.map((x) => `<a class="kid-extra" href="#${x[2]}"><span>${x[0]}</span> ${esc(x[1])}</a>`).join("")}</div>`)}`;
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
          </div>
        </details>
        <div class="form-actions"><button class="btn">Save</button></div>
      </form>`;
    const rows = list.map((i) => `<tr><td class="mono">${esc(i.item_code)}</td><td>${esc(i.short_name)}</td><td>${i.item_type}</td><td>${i.stock_uom}</td><td>${i.purchase_uom || "—"}</td><td class="num">${fmt(i.conversion_factor)}</td><td class="num">${fmt(i.safety_stock)}</td><td class="num">${fmt(i.moq)}</td></tr>`).join("")
      || '<tr><td colspan="8" class="muted">No items yet.</td></tr>';
    return pageHeader("1. Things we use", "Write down every thing we buy or make, like a fan blade or a motor.") + `
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
    return pageHeader("2. Our suppliers", "The shops and companies we buy things from.") + `
      ${panel("New vendor", form)}
      ${panel(`${list.length} vendors`, `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>GSTIN</th><th>Payment terms</th><th>Address</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  VIEWS.po = async (id) => {
    if (id) return poDetail(id);
    const [vendors, items, pos, uid] = await Promise.all([
      sb.from("vendor").select("id,name,vendor_code").order("name"),
      sb.from("item").select("id,item_code,short_name").order("item_code"),
      sb.from("purchase_order").select("*, vendor:vendor_id(name)").order("created_at", { ascending: false }),
      currentUserId(),
    ]);
    const vs = must(vendors), its = must(items), ps = must(pos);
    const form = `
      <form id="f-po">
        <div class="form-grid">
          <div class="field"><label>Supplier</label><select name="vendor_id" required>${opts(vs, "id", (v) => `${v.name} (${v.vendor_code})`, "", "Choose a supplier")}</select></div>
          <div class="field"><label>Place</label><select name="unit">${unitOpts()}</select></div>
          <div class="field"><label>PO date</label><input name="po_date" type="date" value="${today()}" required /></div>
        </div>
        <div style="margin-top:14px">${lineInputs("l", its, LINE_COLS_ITEM)}</div>
        <div class="form-actions"><button class="btn">Make the order</button></div>
      </form>`;
    const rows = ps.map((p) => `<tr><td class="mono">${esc(p.po_no)}</td><td>${dt(p.po_date)}</td><td>${esc(p.vendor && p.vendor.name)}</td><td>${p.unit}</td><td>${statusBadge(p.status)}</td><td>${p.created_by === uid ? "You" : "Someone else"}</td><td><a href="#po/${p.id}">Open</a></td></tr>`).join("")
      || '<tr><td colspan="7" class="muted">No purchase orders yet.</td></tr>';
    return pageHeader("3. Order from a supplier", "Make an order, get it checked, then send it to the supplier.") + `
      ${panel("New purchase order", form)}
      ${panel(`${ps.length} purchase orders`, `<div class="table-wrap"><table><thead><tr><th>PO no</th><th>Date</th><th>Vendor</th><th>Place</th><th>How it is</th><th>Who made it</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  async function poDetail(id) {
    const [head, lines, grns, uid] = await Promise.all([
      sb.from("purchase_order").select("*, vendor:vendor_id(name, vendor_code)").eq("id", id).single(),
      sb.from("po_line").select("*, item:item_id(item_code, short_name, stock_uom)").eq("po_id", id),
      sb.from("grn").select("grn_line(item_id, qty)").eq("po_id", id),
      currentUserId(),
    ]);
    const p = must(head);
    const ls = must(lines);
    const received = {};
    for (const g of must(grns)) for (const gl of g.grn_line || []) received[gl.item_id] = (received[gl.item_id] || 0) + Number(gl.qty);

    const isCreator = p.created_by === uid;
    let action = "";
    if (p.status === "Draft") action = `<button class="btn" data-act="po-submit" data-id="${id}" data-done="Sent for checking!">Send for checking</button>`;
    else if (p.status === "Pending verification") action = `<button class="btn" data-act="po-verify" data-id="${id}" data-done="Checked!">Check it is right</button>`;
    else if (p.status === "Verified") {
      action = isCreator
        ? `<button class="btn" disabled>Send to supplier</button><p class="muted small" style="margin-top:8px">You created this PO, so another approver must release it.</p>`
        : `<button class="btn" data-act="po-release" data-id="${id}" data-done="Sent to the supplier!" data-confirm="Send this order to the supplier now?" data-title="Send to supplier">Send to supplier</button>`;
    }
    const rows = ls.map((l) => {
      const rec = received[l.item_id] || 0;
      return `<tr><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.qty)}</td><td class="num">${money(l.rate)}</td><td class="num">${fmt(l.gst_rate)}</td><td class="num">${money(l.qty * l.rate)}</td><td class="num">${fmt(rec)}</td><td class="num">${fmt(Math.max(0, l.qty - rec))}</td></tr>`;
    }).join("") || '<tr><td colspan="7" class="muted">No lines.</td></tr>';

    return `
      ${pageHeader(p.po_no, `${p.vendor ? p.vendor.name : ""} · Unit ${p.unit} · ${dt(p.po_date)}`, `<a class="btn-ghost" href="#po">All POs</a>`)}
      ${panel("Status", `<div class="row" style="justify-content:space-between">${statusBadge(p.status)}<div class="row">${action}</div></div>`)}
      ${panel("Lines", `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">How many</th><th class="num">Price each</th><th class="num">GST %</th><th class="num">Money</th><th class="num">Received</th><th class="num">Outstanding</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  }

  VIEWS.grn = async (id) => {
    if (id) return grnDetail(id);
    const [vendors, items, pos, grns] = await Promise.all([
      sb.from("vendor").select("id,name,vendor_code").order("name"),
      sb.from("item").select("id,item_code,short_name").order("item_code"),
      sb.from("purchase_order").select("id,po_no,status").in("status", ["Released", "Verified"]).order("po_no"),
      sb.from("grn").select("*, vendor:vendor_id(name)").order("created_at", { ascending: false }),
    ]);
    const vs = must(vendors), its = must(items), ps = must(pos), gs = must(grns);
    const form = `
      <form id="f-grn">
        <div class="form-grid">
          <div class="field"><label>Supplier</label><select name="vendor_id" required>${opts(vs, "id", (v) => `${v.name} (${v.vendor_code})`, "", "Choose a supplier")}</select></div>
          <div class="field"><label>Place</label><select name="unit">${unitOpts()}</select></div>
          <div class="field"><label>From an order (optional)</label><select name="po_id">${opts(ps, "id", (p) => `${p.po_no} (${p.status})`, "", "No PO")}</select></div>
          <div class="field"><label>Date it came</label><input name="received_on" type="date" value="${today()}" required /></div>
        </div>
        <div style="margin-top:14px">${lineInputs("l", its, [
          { k: "item_id", label: "Thing" },
          { k: "qty", label: "How many came", type: "number" },
        ])}</div>
        <div class="form-actions"><button class="btn">Save the delivery</button></div>
        <p class="muted small" style="margin-top:8px">Press "Yes, we got it" to finish.</p>
      </form>`;
    const rows = gs.map((g) => `<tr><td class="mono">${esc(g.grn_no)}</td><td>${dt(g.received_on)}</td><td>${esc(g.vendor && g.vendor.name)}</td><td>${g.unit}</td><td>${statusBadge(g.status)}</td><td><a href="#grn/${g.id}">Open</a></td></tr>`).join("")
      || '<tr><td colspan="6" class="muted">No goods receipts yet.</td></tr>';
    return pageHeader("4. Got a delivery?", "Write down what came in. Then press the button to say we got it.") + `
      ${panel("New goods receipt", form)}
      ${panel(`${gs.length} goods receipts`, `<div class="table-wrap"><table><thead><tr><th>GRN no</th><th>Received</th><th>Vendor</th><th>Place</th><th>How it is</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
  };

  async function grnDetail(id) {
    const [head, lines] = await Promise.all([
      sb.from("grn").select("*, vendor:vendor_id(name), po:po_id(po_no)").eq("id", id).single(),
      sb.from("grn_line").select("*, item:item_id(item_code, short_name, stock_uom), lot:inspection_lot(status, accepted_qty, rejected_qty)").eq("grn_id", id),
    ]);
    const g = must(head);
    const ls = must(lines);
    const post = g.status === "Draft"
      ? `<button class="btn" data-act="grn-post" data-id="${id}" data-done="Yes, we got it!" data-confirm="Did these things really come in?" data-title="Post GRN">Yes, we got it</button>`
      : "";
    const rows = ls.map((l) => {
      const lot = l.lot && l.lot.length ? l.lot[0] : null;
      return `<tr><td>${esc(itemLabel(l.item))}</td><td>${esc(l.batch_no) || "—"}</td><td class="num">${fmt(l.qty)}</td><td class="num">${money(l.rate)}</td><td>${lot ? statusBadge(lot.status) : "—"}</td><td class="num">${lot ? fmt(lot.accepted_qty) : "—"}</td><td class="num">${lot ? fmt(lot.rejected_qty) : "—"}</td></tr>`;
    }).join("") || '<tr><td colspan="7" class="muted">No lines.</td></tr>';
    return `
      ${pageHeader(g.grn_no, `${g.vendor ? g.vendor.name : ""} · Unit ${g.unit} · Received ${dt(g.received_on)} · PO ${g.po ? g.po.po_no : "none"}`, `<a class="btn-ghost" href="#grn">All GRNs</a>`)}
      ${panel("Status", `<div class="row" style="justify-content:space-between">${statusBadge(g.status)}<div class="row">${post}</div></div>`)}
      ${panel("Lines", `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Batch</th><th class="num">How many</th><th class="num">Price each</th><th>Check</th><th class="num">Good</th><th class="num">Not good</th></tr></thead><tbody>${rows}</tbody></table></div>`)}`;
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
    return pageHeader("5. Check it is good", "Look at what came in. Say how many are good and how many are not good.") + `
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
    return pageHeader("What we have", "How many of each thing we have, and where it is.") + `
      ${panel("Stock on hand", `${filter}<div class="table-wrap"><table><thead><tr><th>Place</th><th>Item</th><th>Where it is</th><th class="num">How many</th><th>Unit</th></tr></thead><tbody>${body}</tbody></table></div>`)}`;
  };

  VIEWS.issue = async () => {
    const items = must(await sb.from("item").select("id,item_code,short_name").order("item_code"));
    const form = `
      <form id="f-issue" class="form-grid">
        <div class="field" style="grid-column:1/-1"><label>Thing</label><select name="item_id" required>${opts(items, "id", itemLabel, "", "Choose a thing")}</select></div>
        <div class="field"><label>Place</label><select name="unit">${unitOpts()}</select></div>
        <div class="field"><label>How many</label><input name="qty" type="number" step="any" min="0.001" required /></div>
        <div class="field"><label>Job name (optional)</label><input name="ref" /></div>
        <div class="form-actions"><button class="btn">Send to the workshop</button></div>
      </form>`;
    return pageHeader("6. Send to the workshop", "Send the good things we have to the workshop to make fans.") + panel("Send to the workshop", form + `<p class="muted small" style="margin-top:10px">We can only send what is ready to use.</p>`);
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


  // ---------- planning: stock status, kitting check, purchase suggestions, valuation ----------
  // Reorder point = safety stock + MOQ (an assumption; adjust if the planning rule changes).
  const reorderPoint = (item) => Number(item.safety_stock || 0) + Number(item.moq || 0);
  function stockStatus(qty, item) {
    if (qty <= Number(item.safety_stock || 0)) return ["Very low", "red"];
    if (qty <= reorderPoint(item)) return ["Low", "amber"];
    return ["Fine", "green"];
  }
  async function unitBalances(unit, itemIds) {
    let q = sb.from("stock_balance").select("item_id, bucket, qty").eq("unit", unit);
    if (itemIds) q = q.in("item_id", itemIds);
    const map = {};
    for (const r of must(await q)) {
      map[r.item_id] = map[r.item_id] || {};
      map[r.item_id][r.bucket] = Number(r.qty);
    }
    return map;
  }
  const balOf = (map, id, bucket) => (map[id] && map[id][bucket]) || 0;
  const suggestQty = (need, moq) => (need <= 0 ? 0 : moq > 0 ? Math.ceil(need / moq) * moq : need);

  VIEWS.planning = async (_id, params) => {
    const unit = params.get("unit") || UNITS[0];
    const [items, boms, grnLines] = await Promise.all([
      sb.from("item").select("*").order("item_code"),
      sb.from("bom_header").select("id, version, fg:fg_item_id(item_code, short_name)").eq("is_active", true).order("fg_item_id"),
      sb.from("grn_line").select("item_id, rate, grn:grn_id(created_at)"),
    ]);
    const itemList = must(items);
    const bomList = must(boms);
    const bal = await unitBalances(unit);

    // Stock status: items that have a safety level or stock in this unit.
    const statusRows = itemList
      .filter((i) => Number(i.safety_stock || 0) > 0 || balOf(bal, i.id, "Unrestricted") > 0 || balOf(bal, i.id, "QI") > 0)
      .map((i) => {
        const u = balOf(bal, i.id, "Unrestricted");
        const [label, tone] = stockStatus(u, i);
        return { i, u, q: balOf(bal, i.id, "QI"), label, tone };
      })
      .sort((a, b) => ["Very low", "Low", "Fine"].indexOf(a.label) - ["Very low", "Low", "Fine"].indexOf(b.label));
    const statusBody = statusRows.map((r) => `<tr><td class="mono">${esc(r.i.item_code)}</td><td>${esc(r.i.short_name)}</td><td class="num">${fmt(r.u)}</td><td class="num">${fmt(r.q)}</td><td class="num">${fmt(r.i.safety_stock)}</td><td class="num">${fmt(reorderPoint(r.i))}</td><td>${badge(r.label, r.tone)}</td></tr>`).join("")
      || '<tr><td colspan="7" class="muted">No items with a safety level or stock in this unit.</td></tr>';

    // Current inventory report with valuation at the last purchase rate.
    const lastRate = {};
    const lastAt = {};
    for (const l of grnLines.data || []) {
      const at = l.grn ? l.grn.created_at : null;
      if (at && (!lastAt[l.item_id] || at > lastAt[l.item_id])) { lastAt[l.item_id] = at; lastRate[l.item_id] = Number(l.rate || 0); }
    }
    let totalValue = 0;
    const valRows = itemList.map((i) => {
      const u = balOf(bal, i.id, "Unrestricted");
      if (!u) return "";
      const rate = lastRate[i.id] || 0;
      const value = u * rate;
      totalValue += value;
      return `<tr><td class="mono">${esc(i.item_code)}</td><td>${esc(i.short_name)}</td><td>${i.stock_uom}</td><td class="num">${fmt(u)}</td><td class="num">${money(rate)}</td><td class="num">${money(value)}</td></tr>`;
    }).join("") || '<tr><td colspan="6" class="muted">No unrestricted stock in this unit.</td></tr>';

    const unitSel = `<form id="f-planfilter" class="inline-form"><div class="field"><label>Place</label><select name="unit">${UNITS.map((u) => `<option value="${u}"${u === unit ? " selected" : ""}>${u}</option>`).join("")}</select></div></form>`;
    const kitForm = `
      <form id="f-kit" class="inline-form">
        <div class="field" style="min-width:320px"><label>Which fan?</label><select name="bom_id" required>${opts(bomList, "id", (b) => `${b.fg ? itemLabel(b.fg) : "BOM"} v${b.version}`, "", "Choose a BOM")}</select></div>
        <div class="field"><label>How many do we want to make?</label><input name="units" type="number" min="1" step="1" value="100" required /></div>
        <div class="field"><label>Place</label><select name="unit">${UNITS.map((u) => `<option value="${u}"${u === unit ? " selected" : ""}>${u}</option>`).join("")}</select></div>
        <div class="form-actions"><button class="btn">Can we make it?</button></div>
      </form>
      <div id="kit-result" style="margin-top:14px"></div>`;

    return pageHeader("Can we make it?", "Pick a fan, say how many you want, and we will check if we have enough.") + `
      ${panel("Stock status", `${unitSel}<div class="table-wrap"><table><thead><tr><th>Code</th><th>Item</th><th class="num">Ready to use</th><th class="num">QI</th><th class="num">Safety</th><th class="num">Reorder point</th><th>How it is</th></tr></thead><tbody>${statusBody}</tbody></table></div><p class="muted small" style="margin-top:10px">Very low: at or below the safety amount. Low: time to order. Fine: enough for now.</p>`)}
      ${panel("Kitting check", kitForm + `<p class="muted small" style="margin-top:10px">Shows how many kits the unit can build now from unrestricted stock, and what to buy for the shortfall. Suggestions = required - available - QI + safety stock, rounded up to MOQ.</p>`)}
      ${panel("Current inventory report", `<div class="row" style="justify-content:flex-end;margin-bottom:10px"><button class="btn-ghost" data-act="print">Print</button></div><div class="table-wrap"><table><thead><tr><th>Code</th><th>Item</th><th>Unit</th><th class="num">How many</th><th class="num">Last rate</th><th class="num">Value</th></tr></thead><tbody>${valRows}</tbody><tfoot><tr><th colspan="5">Total value (${esc(unit)})</th><th class="num">${money(totalValue)}</th></tr></tfoot></table></div><p class="muted small" style="margin-top:10px">Valued at the most recent goods receipt rate for each item.</p>`)}`;
  };

  // ---------- form submissions ----------
  const FORMS = {};

  FORMS["f-item"] = async (f) => {
    const v = collect(f);
    v.conversion_factor = v.conversion_factor || 1;
    v.safety_stock = v.safety_stock || 0;
    v.moq = v.moq || 0;
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

  FORMS["f-po"] = async (f) => {
    const v = collect(f);
    const lines = readLines(f, "l");
    if (!v.vendor_id) throw new Error("Choose a supplier.");
    if (!lines.length) throw new Error("Add at least one thing to the list.");
    const po_no = must(await sb.rpc("next_doc_no", { p_prefix: "PO" }));
    const head = must(await sb.from("purchase_order").insert({ po_no, vendor_id: v.vendor_id, unit: v.unit, po_date: v.po_date }).select("id").single());
    const res = await sb.from("po_line").insert(lines.map((l) => ({ po_id: head.id, item_id: l.item_id, qty: l.qty, rate: l.rate || 0, gst_rate: l.gst_rate || 0 })));
    if (res.error) {
      await sb.from("purchase_order").delete().eq("id", head.id);
      throw res.error;
    }
    toast(`Order ${po_no} made. Send it when ready.`, "success");
    location.hash = "#po/" + head.id;
    return "skip-route";
  };

  FORMS["f-grn"] = async (f) => {
    const v = collect(f);
    const lines = readLines(f, "l");
    if (!v.vendor_id) throw new Error("Choose a supplier.");
    if (!lines.length) throw new Error("Add at least one thing to the list.");
    const grn_no = must(await sb.rpc("next_doc_no", { p_prefix: "GRN" }));
    const head = must(await sb.from("grn").insert({ grn_no, vendor_id: v.vendor_id, unit: v.unit, received_on: v.received_on, po_id: v.po_id || null }).select("id").single());
    const res = await sb.from("grn_line").insert(lines.map((l) => ({ grn_id: head.id, item_id: l.item_id, qty: l.qty, rate: l.rate || 0, batch_no: l.batch_no })));
    if (res.error) {
      await sb.from("grn").delete().eq("id", head.id);
      throw res.error;
    }
    toast(`Delivery ${grn_no} saved. Press "Yes, we got it" to finish.`, "success");
    location.hash = "#grn/" + head.id;
    return "skip-route";
  };

  FORMS["f-issue"] = async (f) => {
    const v = collect(f);
    must(await sb.rpc("issue_material", { p_item_id: v.item_id, p_unit: v.unit, p_qty: v.qty, p_ref: v.ref }));
    toast("Sent to the workshop!", "success");
    f.reset();
    return "skip-route";
  };


  FORMS["f-kit"] = async (f) => {
    const v = collect(f);
    const units = Number(v.units) || 0;
    if (!v.bom_id) throw new Error("Choose a BOM.");
    if (units <= 0) throw new Error("How many do we want to make? must be at least 1.");
    const lines = must(await sb.from("bom_line").select("qty_per, scrap_pct, component:component_item_id(id, item_code, short_name, stock_uom, safety_stock, moq)").eq("bom_id", v.bom_id));
    if (!lines.length) throw new Error("This BOM has no components.");
    const bal = await unitBalances(v.unit, lines.map((l) => l.component.id));
    let maxKits = Infinity;
    const rows = [];
    const buys = [];
    for (const l of lines) {
      const c = l.component;
      const per = Number(l.qty_per) * (1 + Number(l.scrap_pct || 0) / 100);
      const req = units * per;
      const avail = balOf(bal, c.id, "Unrestricted");
      const qi = balOf(bal, c.id, "QI");
      maxKits = Math.min(maxKits, per > 0 ? Math.floor(avail / per) : Infinity);
      const short = Math.max(0, req - avail);
      const sugg = suggestQty(req - avail - qi + Number(c.safety_stock || 0), Number(c.moq || 0));
      rows.push(`<tr><td>${esc(itemLabel(c))}</td><td>${c.stock_uom}</td><td class="num">${fmt(req)}</td><td class="num">${fmt(avail)}</td><td class="num">${fmt(qi)}</td><td class="num">${fmt(short)}</td><td>${short > 0 ? badge("Short", "red") : badge("OK", "green")}</td></tr>`);
      if (sugg > 0) buys.push(`<tr><td>${esc(itemLabel(c))}</td><td class="num">${fmt(sugg)}</td><td>${c.stock_uom}</td></tr>`);
    }
    const ok = maxKits >= units;
    const verdict = ok
      ? `<p><strong>Yes, you can produce ${units} kit(s) in ${esc(v.unit)}.</strong></p>`
      : `<p><strong>No, you can only produce ${maxKits} of ${units} kit(s) in ${esc(v.unit)}.</strong></p>`;
    const buyTable = buys.length
      ? `<h3 style="margin-top:16px">Suggested purchase</h3><div class="table-wrap"><table><thead><tr><th>Component</th><th class="num">Suggested qty</th><th>Unit</th></tr></thead><tbody>${buys.join("")}</tbody></table></div>`
      : "";
    document.getElementById("kit-result").innerHTML = `${verdict}<div class="table-wrap"><table><thead><tr><th>Component</th><th>Unit</th><th class="num">Required</th><th class="num">Available</th><th class="num">In QI</th><th class="num">Short</th><th>How it is</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>${buyTable}`;
    return "skip-route";
  };

  FORMS["f-planfilter"] = async () => "skip-route";

  // Filters and the BOM calculator are handled by change/input listeners below.
  FORMS["f-stockfilter"] = FORMS["f-ledgerfilter"] = FORMS["f-calc"] = async () => "skip-route";

  document.addEventListener("change", (e) => {
    const f = e.target.form;
    if (!f) return;
    if (f.id === "f-stockfilter") location.hash = "#stock?unit=" + encodeURIComponent(f.unit.value);
    if (f.id === "f-ledgerfilter") location.hash = "#ledger?item=" + encodeURIComponent(f.item.value);
    if (f.id === "f-planfilter") location.hash = "#planning?unit=" + encodeURIComponent(f.unit.value);
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
    "po-submit": async (id) => must(await sb.from("purchase_order").update({ status: "Pending verification" }).eq("id", id)),
    "po-verify": async (id) => must(await sb.from("purchase_order").update({ status: "Verified", verified_by: await currentUserId() }).eq("id", id)),
    "po-release": async (id) => must(await sb.from("purchase_order").update({ status: "Released", released_by: await currentUserId() }).eq("id", id)),
    "grn-post": async (id) => must(await sb.rpc("post_grn", { p_grn_id: id })),
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
  };

  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === "signup" || act === "signout") return;
    if (act === "print") { window.print(); return; }
    e.preventDefault();
    if (el.dataset.confirm) {
      const ok = await confirmDialog(el.dataset.confirm, { title: el.dataset.title || "Are you sure?", confirmText: el.textContent.trim(), danger: false });
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
