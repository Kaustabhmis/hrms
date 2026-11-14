/* MAX ERP - inventory, purchase, stores and quality (modules 1-4).
 * Talks to Supabase project nmoajpbkcvcxuplojhtp. Every stock change goes through
 * database functions (post_grn, record_iqc, create_purchase_return, issue_material),
 * which run in one transaction and refuse negative stock. Plain JS, no build step. */
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

  // ---------- helpers ----------
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 }));
  const money = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const dt = (v) => (v ? new Date(v).toLocaleDateString("en-IN") : "—");
  const today = () => new Date().toISOString().slice(0, 10);

  function toast(msg, kind) {
    const t = document.createElement("div");
    t.className = "toast " + (kind || "ok");
    t.textContent = msg;
    document.getElementById("toasts").appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

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

  async function currentUser() {
    const { data } = await sb.auth.getUser();
    return data.user ? data.user.id : null;
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
  const itemLabel = (i) => `${i.item_code} ${i.short_name}`;

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

  // Read numbered line rows (names like l3_item_id, l3_qty) and keep rows with an item.
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

  // Line-entry table. cols: [{k, label, type}] ; k === "item_id" gives an item picker.
  function lineInputs(prefix, items, cols) {
    let h = '<div class="table-wrap"><table><thead><tr><th>#</th>';
    for (const c of cols) h += `<th>${esc(c.label)}</th>`;
    h += "</tr></thead><tbody>";
    for (let i = 1; i <= LINES; i++) {
      h += `<tr><td>${i}</td>`;
      for (const c of cols) {
        const name = `${prefix}${i}_${c.k}`;
        if (c.k === "item_id") {
          h += `<td><select name="${name}" style="min-width:260px"><option value="">—</option>${opts(items, "id", itemLabel, "")}</select></td>`;
        } else if (c.type === "number") {
          h += `<td><input name="${name}" type="number" step="any" min="0" style="min-width:100px"></td>`;
        } else {
          h += `<td><input name="${name}" type="text" style="min-width:120px"></td>`;
        }
      }
      h += "</tr>";
    }
    return h + "</tbody></table></div>";
  }

  const LINE_COLS_ITEM = [
    { k: "item_id", label: "Item" },
    { k: "qty", label: "Qty", type: "number" },
    { k: "rate", label: "Rate", type: "number" },
    { k: "gst_rate", label: "GST %", type: "number" },
  ];

  // ---------- auth ----------
  function showLogin() {
    document.getElementById("login").hidden = false;
    document.getElementById("app").hidden = true;
  }
  async function showApp(user) {
    document.getElementById("login").hidden = true;
    document.getElementById("app").hidden = false;
    document.getElementById("who").textContent = user ? user.email : "";
    await route();
  }

  // ---------- views ----------
  const VIEWS = {};

  VIEWS.items = async () => {
    const [items, uoms] = await Promise.all([
      sb.from("item").select("*").order("item_code"),
      sb.from("uom").select("*").order("code"),
    ]);
    const list = must(items);
    const units = must(uoms);
    const uomSel = (blank) => opts(units, "code", (u) => `${u.code} - ${u.name}`, "", blank ? "—" : undefined);
    return `
      <h2>Items</h2>
      <section class="panel"><h3>New item</h3>
        <form id="f-item" class="grid">
          <label>Item code<input name="item_code" required placeholder="10-100-01-01-01" pattern="[0-9]{2}-[0-9]{3}-[0-9]{2}-[0-9]{2}-[0-9]{2}"></label>
          <label>Short name (max 31)<input name="short_name" required maxlength="31"></label>
          <label>Description<input name="description"></label>
          <label>Stock UOM<select name="stock_uom" required>${uomSel(false)}</select></label>
          <label>Purchase UOM<select name="purchase_uom">${uomSel(true)}</select></label>
          <label>Conversion (purchase to stock)<input name="conversion_factor" type="number" step="any" min="0.001" value="1"></label>
          <label>Type<select name="item_type">${TYPES.map((t) => `<option>${t}</option>`).join("")}</select></label>
          <label>Safety stock<input name="safety_stock" type="number" step="any" min="0" value="0"></label>
          <label>MOQ<input name="moq" type="number" step="any" min="0" value="0"></label>
          <div><button class="btn">Save item</button></div>
        </form>
      </section>
      <section class="panel"><h3>${list.length} items</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Stock UOM</th><th>Purchase UOM</th><th class="num">Conv.</th><th class="num">Safety</th><th class="num">MOQ</th></tr></thead>
          <tbody>${list.map((i) => `<tr><td>${esc(i.item_code)}</td><td>${esc(i.short_name)}</td><td>${i.item_type}</td><td>${i.stock_uom}</td><td>${i.purchase_uom || "—"}</td><td class="num">${fmt(i.conversion_factor)}</td><td class="num">${fmt(i.safety_stock)}</td><td class="num">${fmt(i.moq)}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">No items yet.</td></tr>'}</tbody>
        </table></div>
      </section>`;
  };

  VIEWS.bom = async (id) => {
    if (id) return bomDetail(id);
    const [items, heads] = await Promise.all([
      sb.from("item").select("id,item_code,short_name,item_type").order("item_code"),
      sb.from("bom_header").select("*, fg:fg_item_id(item_code, short_name)").order("fg_item_id"),
    ]);
    const itemList = must(items);
    const headList = must(heads);
    return `
      <h2>Bill of materials</h2>
      <section class="panel"><h3>New BOM</h3>
        <form id="f-bom">
          <div class="grid">
            <label class="full">Finished or sub-assembly item<select name="fg_item_id" required>${opts(itemList, "id", itemLabel, "", "Choose an item")}</select></label>
            <label>Version<input name="version" type="number" min="1" step="1" value="1" required></label>
          </div>
          <div style="margin-top:12px">${lineInputs("c", itemList, [
            { k: "item_id", label: "Component" },
            { k: "qty", label: "Qty per unit", type: "number" },
            { k: "scrap", label: "Scrap %", type: "number" },
          ])}</div>
          <p><button class="btn">Save BOM</button></p>
        </form>
      </section>
      <section class="panel"><h3>${headList.length} BOMs</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Item</th><th class="num">Version</th><th>Active</th><th></th></tr></thead>
          <tbody>${headList.map((h) => `<tr><td>${h.fg ? esc(itemLabel(h.fg)) : "—"}</td><td class="num">${h.version}</td><td>${h.is_active ? "Yes" : "No"}</td><td><a href="#bom/${h.id}">Open</a></td></tr>`).join("") || '<tr><td colspan="4" class="muted">No BOMs yet.</td></tr>'}</tbody>
        </table></div>
      </section>`;
  };

  async function bomDetail(id) {
    const [head, lines] = await Promise.all([
      sb.from("bom_header").select("*, fg:fg_item_id(item_code, short_name)").eq("id", id).single(),
      sb.from("bom_line").select("*, component:component_item_id(item_code, short_name, stock_uom)").eq("bom_id", id),
    ]);
    const h = must(head);
    const ls = must(lines);
    return `
      <p><a href="#bom">&larr; All BOMs</a></p>
      <h2>BOM: ${esc(itemLabel(h.fg))} v${h.version}</h2>
      <section class="panel"><h3>Components per unit</h3>
        <form id="f-calc" class="row" style="margin-bottom:12px"><label>Units to build<input name="units" type="number" min="0" step="any" value="100" style="width:160px"></label></form>
        <div class="table-wrap"><table>
          <thead><tr><th>Component</th><th>UOM</th><th class="num">Qty per unit</th><th class="num">Scrap %</th><th class="num">Required</th></tr></thead>
          <tbody>${ls.map((l) => `<tr><td>${esc(itemLabel(l.component))}</td><td>${l.component.stock_uom}</td><td class="num">${fmt(l.qty_per)}</td><td class="num">${fmt(l.scrap_pct)}</td><td class="num calc" data-per="${l.qty_per}" data-scrap="${l.scrap_pct}">—</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No components.</td></tr>'}</tbody>
        </table></div>
        <p class="muted small">Required = units x qty per unit x (1 + scrap %). Gross requirement before stock is netted off.</p>
      </section>`;
  }

  VIEWS.vendors = async () => {
    const list = must(await sb.from("vendor").select("*").order("vendor_code"));
    return `
      <h2>Vendors</h2>
      <section class="panel"><h3>New vendor</h3>
        <form id="f-vendor" class="grid">
          <label>Vendor code<input name="vendor_code" required></label>
          <label>Name<input name="name" required></label>
          <label>GSTIN<input name="gstin" maxlength="15"></label>
          <label>Payment terms<input name="payment_terms" placeholder="30 days"></label>
          <label class="full">Address<input name="address"></label>
          <div><button class="btn">Save vendor</button></div>
        </form>
      </section>
      <section class="panel"><h3>${list.length} vendors</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Code</th><th>Name</th><th>GSTIN</th><th>Payment terms</th><th>Address</th></tr></thead>
          <tbody>${list.map((v) => `<tr><td>${esc(v.vendor_code)}</td><td>${esc(v.name)}</td><td>${esc(v.gstin) || "—"}</td><td>${esc(v.payment_terms) || "—"}</td><td>${esc(v.address) || "—"}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No vendors yet.</td></tr>'}</tbody>
        </table></div>
      </section>`;
  };

  VIEWS.po = async (id) => {
    if (id) return poDetail(id);
    const [vendors, items, pos, uid] = await Promise.all([
      sb.from("vendor").select("id,name,vendor_code").order("name"),
      sb.from("item").select("id,item_code,short_name").order("item_code"),
      sb.from("purchase_order").select("*, vendor:vendor_id(name)").order("created_at", { ascending: false }),
      currentUser(),
    ]);
    const vs = must(vendors), its = must(items), ps = must(pos);
    return `
      <h2>Purchase orders</h2>
      <section class="panel"><h3>New purchase order</h3>
        <form id="f-po">
          <div class="grid">
            <label>Vendor<select name="vendor_id" required>${opts(vs, "id", (v) => `${v.name} (${v.vendor_code})`, "", "Choose a vendor")}</select></label>
            <label>Unit<select name="unit">${unitOpts()}</select></label>
            <label>PO date<input name="po_date" type="date" value="${today()}" required></label>
          </div>
          <div style="margin-top:12px">${lineInputs("l", its, LINE_COLS_ITEM)}</div>
          <p><button class="btn">Create PO as draft</button></p>
        </form>
      </section>
      <section class="panel"><h3>${ps.length} purchase orders</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>PO no</th><th>Date</th><th>Vendor</th><th>Unit</th><th>Status</th><th>Created by</th><th></th></tr></thead>
          <tbody>${ps.map((p) => `<tr><td>${esc(p.po_no)}</td><td>${dt(p.po_date)}</td><td>${esc(p.vendor && p.vendor.name)}</td><td>${p.unit}</td><td>${statusBadge(p.status)}</td><td>${p.created_by === uid ? "You" : "Someone else"}</td><td><a href="#po/${p.id}">Open</a></td></tr>`).join("") || '<tr><td colspan="7" class="muted">No purchase orders yet.</td></tr>'}</tbody>
        </table></div>
      </section>`;
  };

  async function poDetail(id) {
    const [head, lines, grns, uid] = await Promise.all([
      sb.from("purchase_order").select("*, vendor:vendor_id(name, vendor_code)").eq("id", id).single(),
      sb.from("po_line").select("*, item:item_id(item_code, short_name, stock_uom)").eq("po_id", id),
      sb.from("grn").select("grn_line(item_id, qty)").eq("po_id", id),
      currentUser(),
    ]);
    const p = must(head);
    const ls = must(lines);
    const received = {};
    for (const g of must(grns)) for (const gl of g.grn_line || []) received[gl.item_id] = (received[gl.item_id] || 0) + Number(gl.qty);

    const isCreator = p.created_by === uid;
    let action = "";
    if (p.status === "Draft") action = `<button class="btn" data-act="po-submit" data-id="${id}" data-done="Sent for verification">Submit for verification</button>`;
    else if (p.status === "Pending verification") action = `<button class="btn" data-act="po-verify" data-id="${id}" data-done="PO verified">Verify PO</button>`;
    else if (p.status === "Verified") {
      action = isCreator
        ? `<button class="btn" disabled>Release PO</button><p class="muted small">You created this PO; another approver must release it.</p>`
        : `<button class="btn" data-act="po-release" data-id="${id}" data-done="PO released">Release PO</button>`;
    }

    return `
      <p><a href="#po">&larr; All purchase orders</a></p>
      <h2>${esc(p.po_no)} ${statusBadge(p.status)}</h2>
      <section class="panel">
        <p><strong>${esc(p.vendor && p.vendor.name)}</strong> (${esc(p.vendor && p.vendor.vendor_code)}) &middot; Unit: ${p.unit} &middot; Date: ${dt(p.po_date)}</p>
        <div class="row">${action}</div>
      </section>
      <section class="panel"><h3>Lines</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST %</th><th class="num">Amount</th><th class="num">Received</th><th class="num">Outstanding</th></tr></thead>
          <tbody>${ls.map((l) => {
            const rec = received[l.item_id] || 0;
            return `<tr><td>${esc(itemLabel(l.item))}</td><td class="num">${fmt(l.qty)}</td><td class="num">${money(l.rate)}</td><td class="num">${fmt(l.gst_rate)}</td><td class="num">${money(l.qty * l.rate)}</td><td class="num">${fmt(rec)}</td><td class="num">${fmt(Math.max(0, l.qty - rec))}</td></tr>`;
          }).join("") || '<tr><td colspan="7" class="muted">No lines.</td></tr>'}</tbody>
        </table></div>
      </section>`;
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
    return `
      <h2>Goods receipts</h2>
      <section class="panel"><h3>New goods receipt (draft)</h3>
        <form id="f-grn">
          <div class="grid">
            <label>Vendor<select name="vendor_id" required>${opts(vs, "id", (v) => `${v.name} (${v.vendor_code})`, "", "Choose a vendor")}</select></label>
            <label>Unit<select name="unit">${unitOpts()}</select></label>
            <label>Against PO (optional)<select name="po_id">${opts(ps, "id", (p) => `${p.po_no} (${p.status})`, "", "No PO")}</select></label>
            <label>Received on<input name="received_on" type="date" value="${today()}" required></label>
          </div>
          <div style="margin-top:12px">${lineInputs("l", its, [
            { k: "item_id", label: "Item" },
            { k: "qty", label: "Qty received", type: "number" },
            { k: "rate", label: "Rate", type: "number" },
            { k: "batch_no", label: "Batch no" },
          ])}</div>
          <p><button class="btn">Save draft GRN</button> <span class="muted small">Stock moves into QI only when you post the GRN.</span></p>
        </form>
      </section>
      <section class="panel"><h3>${gs.length} goods receipts</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>GRN no</th><th>Received</th><th>Vendor</th><th>Unit</th><th>Status</th><th></th></tr></thead>
          <tbody>${gs.map((g) => `<tr><td>${esc(g.grn_no)}</td><td>${dt(g.received_on)}</td><td>${esc(g.vendor && g.vendor.name)}</td><td>${g.unit}</td><td>${statusBadge(g.status)}</td><td><a href="#grn/${g.id}">Open</a></td></tr>`).join("") || '<tr><td colspan="6" class="muted">No goods receipts yet.</td></tr>'}</tbody>
        </table></div>
      </section>`;
  };

  async function grnDetail(id) {
    const [head, lines] = await Promise.all([
      sb.from("grn").select("*, vendor:vendor_id(name), po:po_id(po_no)").eq("id", id).single(),
      sb.from("grn_line").select("*, item:item_id(item_code, short_name, stock_uom), lot:inspection_lot(status, accepted_qty, rejected_qty)").eq("grn_id", id),
    ]);
    const g = must(head);
    const ls = must(lines);
    const post = g.status === "Draft"
      ? `<button class="btn" data-act="grn-post" data-id="${id}" data-confirm="Post this GRN? Stock moves into QI for inspection." data-done="GRN posted to QI">Post GRN to QI</button>`
      : "";
    return `
      <p><a href="#grn">&larr; All goods receipts</a></p>
      <h2>${esc(g.grn_no)} ${statusBadge(g.status)}</h2>
      <section class="panel">
        <p><strong>${esc(g.vendor && g.vendor.name)}</strong> &middot; Unit: ${g.unit} &middot; Received: ${dt(g.received_on)} &middot; PO: ${esc(g.po && g.po.po_no) || "none"}</p>
        <div class="row">${post}</div>
      </section>
      <section class="panel"><h3>Lines</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Item</th><th>Batch</th><th class="num">Qty</th><th class="num">Rate</th><th>Inspection</th><th class="num">Accepted</th><th class="num">Rejected</th></tr></thead>
          <tbody>${ls.map((l) => `<tr><td>${esc(itemLabel(l.item))}</td><td>${esc(l.batch_no) || "—"}</td><td class="num">${fmt(l.qty)}</td><td class="num">${money(l.rate)}</td><td>${l.lot && l.lot.length ? statusBadge(l.lot[0].status) : "—"}</td><td class="num">${l.lot && l.lot.length ? fmt(l.lot[0].accepted_qty) : "—"}</td><td class="num">${l.lot && l.lot.length ? fmt(l.lot[0].rejected_qty) : "—"}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No lines.</td></tr>'}</tbody>
        </table></div>
      </section>`;
  }

  VIEWS.stock = async (_id, params) => {
    const unit = params.get("unit") || "";
    let q = sb.from("stock_balance").select("unit, bucket, qty, item:item_id(item_code, short_name, stock_uom)").gt("qty", 0);
    if (unit) q = q.eq("unit", unit);
    const rows = must(await q);
    rows.sort((a, b) => a.unit.localeCompare(b.unit) || a.item.item_code.localeCompare(b.item.item_code) || BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));
    return `
      <h2>Stock</h2>
      <section class="panel">
        <form class="row" id="f-stockfilter"><label>Unit<select name="unit"><option value="">All units</option>${UNITS.map((u) => `<option value="${u}"${u === unit ? " selected" : ""}>${u}</option>`).join("")}</select></label></form>
        <div class="table-wrap"><table>
          <thead><tr><th>Unit</th><th>Item</th><th>Bucket</th><th class="num">Qty</th><th>UOM</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${r.unit}</td><td>${esc(itemLabel(r.item))}</td><td>${r.bucket}</td><td class="num">${fmt(r.qty)}</td><td>${r.item.stock_uom}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No stock with a quantity above zero.</td></tr>'}</tbody>
        </table></div>
        <p class="muted small">Only buckets with stock are listed. QI is awaiting inspection; Blocked is rejected stock waiting for a purchase return.</p>
      </section>`;
  };

  VIEWS.issue = async () => {
    const items = must(await sb.from("item").select("id,item_code,short_name").order("item_code"));
    return `
      <h2>Issue to production</h2>
      <section class="panel"><h3>Issue material</h3>
        <form id="f-issue" class="grid">
          <label class="full">Item<select name="item_id" required>${opts(items, "id", itemLabel, "", "Choose an item")}</select></label>
          <label>Unit<select name="unit">${unitOpts()}</select></label>
          <label>Qty to issue<input name="qty" type="number" step="any" min="0.001" required></label>
          <label>Reference (job / order)<input name="ref"></label>
          <div><button class="btn">Issue to WIP</button></div>
        </form>
        <p class="muted small">Moves unrestricted stock into WIP. Fails if the unit does not have enough unrestricted stock.</p>
      </section>`;
  };

  VIEWS.ledger = async (_id, params) => {
    const item = params.get("item") || "";
    let q = sb.from("stock_ledger").select("*, item:item_id(item_code, short_name)").order("id", { ascending: false }).limit(300);
    if (item) q = q.eq("item_id", item);
    const [rows, items] = await Promise.all([q, sb.from("item").select("id,item_code,short_name").order("item_code")]);
    const list = must(rows);
    const its = must(items);
    return `
      <h2>Stock ledger</h2>
      <section class="panel">
        <form class="row" id="f-ledgerfilter"><label>Item<select name="item"><option value="">Latest 300 movements (all items)</option>${opts(its, "id", itemLabel, item)}</select></label></form>
        <div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Item</th><th>Unit</th><th>Bucket</th><th>Code</th><th class="num">Qty</th><th>Source</th><th>Remarks</th></tr></thead>
          <tbody>${list.map((r) => `<tr><td>${new Date(r.posted_at).toLocaleString("en-IN")}</td><td>${esc(itemLabel(r.item))}</td><td>${r.unit}</td><td>${r.bucket}</td><td>${r.movement_code}</td><td class="num">${fmt(r.qty)}</td><td>${esc(r.source_doc) || "—"}</td><td>${esc(r.remarks) || "—"}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">No movements yet.</td></tr>'}</tbody>
        </table></div>
        <p class="muted small">The ledger is append-only. Corrections are made with new movements, never edits.</p>
      </section>`;
  };

  VIEWS.iqc = async () => {
    const rows = must(await sb.from("inspection_lot")
      .select("*, line:grn_line_id(qty, batch_no, item:item_id(item_code, short_name), grn:grn_id(grn_no, unit))")
      .order("id", { ascending: false })
      .limit(300));
    rows.sort((a, b) => (a.status === "Pending" ? 0 : 1) - (b.status === "Pending" ? 0 : 1));
    return `
      <h2>Inspections (IQC)</h2>
      <section class="panel">
        <div class="table-wrap"><table>
          <thead><tr><th>GRN</th><th>Unit</th><th>Item</th><th>Batch</th><th class="num">Received</th><th>Status</th><th class="num">Accepted</th><th class="num">Rejected</th><th>Remarks</th><th></th></tr></thead>
          <tbody>${rows.map((r) => {
            const base = `<td>${esc(r.line && r.line.grn && r.line.grn.grn_no)}</td><td>${r.line && r.line.grn && r.line.grn.unit}</td><td>${esc(r.line && itemLabel(r.line.item))}</td><td>${esc(r.line && r.line.batch_no) || "—"}</td><td class="num">${fmt(r.line && r.line.qty)}</td><td>${statusBadge(r.status)}</td>`;
            if (r.status !== "Pending") {
              return `<tr>${base}<td class="num">${fmt(r.accepted_qty)}</td><td class="num">${fmt(r.rejected_qty)}</td><td>${esc(r.remarks) || "—"}</td><td></td></tr>`;
            }
            const qty = r.line ? r.line.qty : 0;
            return `<tr>${base}
              <td><input name="acc" type="number" step="any" min="0" max="${qty}" value="${qty}" style="width:110px"></td>
              <td><input name="rej" type="number" step="any" min="0" max="${qty}" value="0" style="width:110px"></td>
              <td><input name="rem" type="text" style="min-width:160px"></td>
              <td><button class="btn small" data-act="iqc-save" data-id="${r.id}" data-done="Inspection recorded">Record</button></td></tr>`;
          }).join("") || '<tr><td colspan="10" class="muted">No inspection lots yet. Post a goods receipt to create them.</td></tr>'}</tbody>
        </table></div>
        <p class="muted small">Accepted + rejected must equal the quantity received. Accepted moves to Unrestricted; rejected moves to Blocked.</p>
      </section>`;
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
    return `
      <h2>Purchase returns</h2>
      <section class="panel"><h3>Return rejected stock to the vendor</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>GRN</th><th>Vendor</th><th>Item</th><th class="num">Rejected</th><th class="num">Returned</th><th class="num">Remaining</th><th>Qty to return</th><th>Remarks</th><th></th></tr></thead>
          <tbody>${lotList.map((l) => {
            const done = returned[l.id] || 0;
            const remaining = Number(l.rejected_qty) - done;
            if (remaining <= 0) return "";
            return `<tr><td>${esc(l.line && l.line.grn && l.line.grn.grn_no)}</td><td>${esc(l.line && l.line.grn && l.line.grn.vendor && l.line.grn.vendor.name)}</td><td>${esc(l.line && itemLabel(l.line.item))}</td><td class="num">${fmt(l.rejected_qty)}</td><td class="num">${fmt(done)}</td><td class="num">${fmt(remaining)}</td>
              <td><input name="qty" type="number" step="any" min="0" max="${remaining}" value="${remaining}" style="width:110px"></td>
              <td><input name="rem" type="text" style="min-width:160px"></td>
              <td><button class="btn small" data-act="ret-save" data-id="${l.id}" data-done="Purchase return created">Create return</button></td></tr>`;
          }).join("") || '<tr><td colspan="9" class="muted">No rejected stock waiting for a return.</td></tr>'}</tbody>
        </table></div>
      </section>
      <section class="panel"><h3>Returns made</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Vendor</th><th class="num">Qty</th><th>Remarks</th></tr></thead>
          <tbody>${retList.map((r) => `<tr><td>${dt(r.created_at)}</td><td>${esc(r.vendor && r.vendor.name)}</td><td class="num">${fmt(r.qty)}</td><td>${esc(r.remarks) || "—"}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No returns yet.</td></tr>'}</tbody>
        </table></div>
      </section>`;
  };

  function statusBadge(s) {
    const tone = /Released|Verified|Passed|Posted|Closed/.test(s) ? "ok" : /Failed|Blocked|Cancelled|Reversed/.test(s) ? "err" : /Pending|Partially/.test(s) ? "warn" : "";
    return `<span class="badge ${tone}">${esc(s)}</span>`;
  }

  // ---------- form submissions ----------
  const FORMS = {};

  FORMS["f-login"] = async (f) => {
    const v = collect(f);
    const { error } = await sb.auth.signInWithPassword({ email: v.email, password: v.password });
    if (error) toast(error.message, "err");
  };

  FORMS["f-item"] = async (f) => {
    const v = collect(f);
    v.conversion_factor = v.conversion_factor || 1;
    v.safety_stock = v.safety_stock || 0;
    v.moq = v.moq || 0;
    must(await sb.from("item").insert(v));
    toast("Item saved");
  };

  FORMS["f-vendor"] = async (f) => {
    must(await sb.from("vendor").insert(collect(f)));
    toast("Vendor saved");
  };

  FORMS["f-bom"] = async (f) => {
    const v = collect(f);
    const lines = readLines(f, "c");
    if (!v.fg_item_id) throw new Error("Choose the finished or sub-assembly item.");
    if (!lines.length) throw new Error("Add at least one component.");
    const head = must(await sb.from("bom_header").insert({ fg_item_id: v.fg_item_id, version: v.version || 1 }).select("id").single());
    const rows = lines.map((l) => ({ bom_id: head.id, component_item_id: l.item_id, qty_per: l.qty, scrap_pct: l.scrap || 0 }));
    const res = await sb.from("bom_line").insert(rows);
    if (res.error) {
      await sb.from("bom_header").delete().eq("id", head.id);
      throw res.error;
    }
    toast("BOM saved");
    location.hash = "#bom/" + head.id;
    return "skip-route";
  };

  FORMS["f-po"] = async (f) => {
    const v = collect(f);
    const lines = readLines(f, "l");
    if (!v.vendor_id) throw new Error("Choose a vendor.");
    if (!lines.length) throw new Error("Add at least one line.");
    const po_no = must(await sb.rpc("next_doc_no", { p_prefix: "PO" }));
    const head = must(await sb.from("purchase_order").insert({ po_no, vendor_id: v.vendor_id, unit: v.unit, po_date: v.po_date }).select("id").single());
    const res = await sb.from("po_line").insert(lines.map((l) => ({ po_id: head.id, item_id: l.item_id, qty: l.qty, rate: l.rate, gst_rate: l.gst_rate || 0 })));
    if (res.error) {
      await sb.from("purchase_order").delete().eq("id", head.id);
      throw res.error;
    }
    toast(`${po_no} created as draft`);
    location.hash = "#po/" + head.id;
    return "skip-route";
  };

  FORMS["f-grn"] = async (f) => {
    const v = collect(f);
    const lines = readLines(f, "l");
    if (!v.vendor_id) throw new Error("Choose a vendor.");
    if (!lines.length) throw new Error("Add at least one line.");
    const grn_no = must(await sb.rpc("next_doc_no", { p_prefix: "GRN" }));
    const head = must(await sb.from("grn").insert({ grn_no, vendor_id: v.vendor_id, unit: v.unit, received_on: v.received_on, po_id: v.po_id || null }).select("id").single());
    const res = await sb.from("grn_line").insert(lines.map((l) => ({ grn_id: head.id, item_id: l.item_id, qty: l.qty, rate: l.rate || 0, batch_no: l.batch_no })));
    if (res.error) {
      await sb.from("grn").delete().eq("id", head.id);
      throw res.error;
    }
    toast(`${grn_no} saved as draft`);
    location.hash = "#grn/" + head.id;
    return "skip-route";
  };

  FORMS["f-issue"] = async (f) => {
    const v = collect(f);
    must(await sb.rpc("issue_material", { p_item_id: v.item_id, p_unit: v.unit, p_qty: v.qty, p_ref: v.ref }));
    toast("Material issued to WIP");
    f.reset();
  };

  FORMS["f-stockfilter"] = async () => {};
  FORMS["f-ledgerfilter"] = async () => {};
  FORMS["f-calc"] = async () => {};

  // Filters re-route with a query parameter.
  document.addEventListener("change", (e) => {
    const f = e.target.form;
    if (!f) return;
    if (f.id === "f-stockfilter") location.hash = "#stock?unit=" + encodeURIComponent(f.unit.value);
    if (f.id === "f-ledgerfilter") location.hash = "#ledger?item=" + encodeURIComponent(f.item.value);
  });

  // Live "required quantity" on the BOM detail page.
  document.addEventListener("input", (e) => {
    const f = e.target.form;
    if (!f || f.id !== "f-calc") return;
    const units = Number(f.units.value) || 0;
    document.querySelectorAll("td.calc").forEach((td) => {
      const req = units * Number(td.dataset.per) * (1 + Number(td.dataset.scrap) / 100);
      td.textContent = fmt(req);
    });
  });

  // ---------- row actions ----------
  const ACTIONS = {
    "po-submit": async (id) => must(await sb.from("purchase_order").update({ status: "Pending verification" }).eq("id", id)),
    "po-verify": async (id) => must(await sb.from("purchase_order").update({ status: "Verified", verified_by: await currentUser() }).eq("id", id)),
    "po-release": async (id) => must(await sb.from("purchase_order").update({ status: "Released", released_by: await currentUser() }).eq("id", id)),
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
    if (el.dataset.confirm && !window.confirm(el.dataset.confirm)) return;
    e.preventDefault();
    el.disabled = true;
    try {
      await ACTIONS[act](el.dataset.id, el);
      toast(el.dataset.done || "Saved");
      await route();
    } catch (err) {
      toast(friendly(err), "err");
      el.disabled = false;
    }
  });

  // Login page buttons and sign-out.
  document.getElementById("f-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    await FORMS["f-login"](e.target);
  });
  document.querySelector('[data-act="signup"]').addEventListener("click", async () => {
    const f = document.getElementById("f-login");
    if (!f.reportValidity()) return;
    const v = collect(f);
    const { data, error } = await sb.auth.signUp({ email: v.email, password: v.password });
    if (error) return toast(error.message, "err");
    toast(data.session ? "Account created" : "Account created. Confirm your email, then sign in.");
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
    const btn = f.querySelector('button[type="submit"], button:not([type])');
    if (btn) btn.disabled = true;
    try {
      const result = await h(f);
      if (result !== "skip-route") {
        if (!/^f-(stockfilter|ledgerfilter|calc)$/.test(f.id)) toast("Saved");
        if (f.id !== "f-issue") f.reset();
        await route();
      }
    } catch (err) {
      toast(friendly(err), "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ---------- router ----------
  async function route() {
    const raw = location.hash.replace(/^#/, "") || "items";
    const [path, query = ""] = raw.split("?");
    const [name, id] = path.split("/");
    const params = new URLSearchParams(query);
    document.querySelectorAll(".side a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + name));
    const view = VIEWS[name];
    if (!view) {
      main.innerHTML = '<p class="muted">Page not found.</p>';
      return;
    }
    main.innerHTML = '<p class="muted">Loading…</p>';
    try {
      main.innerHTML = await view(id, params);
    } catch (e) {
      main.innerHTML = `<section class="panel">Could not load this page: ${esc(friendly(e))}</section>`;
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
