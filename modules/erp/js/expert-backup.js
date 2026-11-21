/* Reads an Expert accounts backup (BKUPEXP.DAT: a zip of FoxPro/dBase .DBF tables) and turns it
 * into rows for MAX ERP: items, suppliers, customers, purchase bill lines and store challans.
 * Pure functions: runs in the browser (window.ExpertBackup) and in Node for testing. */
(function (root) {
  "use strict";

  const ACCOUNT_GROUPS = {
    suppliers: ["100004", "100036", "100037"], // Sundry Creditors, Processor, Supplier
    customers: ["100003", "100039"],           // Sundry Debtors, Cash Party
  };
  const UNIT_MAP = { PCS: "PCS", PC: "PCS", NOS: "NOS", NO: "NOS", KG: "KG", KGS: "KG", MTR: "MTR", MTRS: "MTR", MT: "MTR",
    LTR: "LTR", LTRS: "LTR", SET: "SET", SETS: "SET", ROLL: "ROLL", ROLLS: "ROLL", GM: "GM", GMS: "GM" };

  function normUnit(u) {
    const k = String(u || "").trim().toUpperCase().replace(/\.$/, "");
    return UNIT_MAP[k] || k.slice(0, 10) || "PCS";
  }

  // Kind of item from the Expert product group name.
  function itemType(groupName) {
    const g = String(groupName || "").toUpperCase();
    if (/RESALE/.test(g)) return "BOP";
    if (/SCRAP|EXPENSE|LABOUR|P & M/.test(g)) return "Consumable";
    if (/SALE/.test(g)) return "FG";
    if (/ASSY|MOTOR/.test(g)) return "SFG";
    return "RM";
  }

  // Expert code 100001 -> item code 70-100-00-01-00 (70 = imported from Expert).
  function itemCode(c) {
    return `70-${c.slice(0, 3)}-${c.slice(3, 5)}-0${c.slice(5, 6)}-00`;
  }

  // Minimal dBase III / FoxPro reader. keep = field names to read (faster).
  function readDbf(buffer, keep) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(4, true), hlen = dv.getUint16(8, true), rlen = dv.getUint16(10, true);
    const dec = new TextDecoder("windows-1252");
    const fields = [];
    for (let p = 32; p < hlen && bytes[p] !== 0x0d; p += 32) {
      let name = "";
      for (let i = 0; i < 11 && bytes[p + i]; i++) name += String.fromCharCode(bytes[p + i]);
      fields.push({ name, type: String.fromCharCode(bytes[p + 11]), len: bytes[p + 16] });
    }
    let o = 1;
    for (const f of fields) { f.off = o; o += f.len; }
    const use = keep ? fields.filter((f) => keep.includes(f.name)) : fields;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const base = hlen + i * rlen;
      if (base + rlen > bytes.length) break;
      if (bytes[base] === 0x2a) continue; // deleted record
      const row = {};
      for (const f of use) {
        const s = dec.decode(bytes.subarray(base + f.off, base + f.off + f.len)).trim();
        if (f.type === "N" || f.type === "F") row[f.name] = s === "" ? 0 : Number(s) || 0;
        else if (f.type === "D") row[f.name] = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
        else if (f.type === "L") row[f.name] = /^[TtYy]$/.test(s);
        else row[f.name] = s;
      }
      rows.push(row);
    }
    return rows;
  }

  const joinAddress = (a) => [a.ADD1, a.ADD2, a.ADD3, a.PINCODE ? "PIN " + a.PINCODE : ""].map((x) => String(x || "").trim()).filter(Boolean).join(", ");

  // zip: a loaded JSZip instance of BKUPEXP.DAT.
  async function readBackup(zip) {
    const file = async (name) => {
      const f = zip.file(new RegExp("^" + name + "\\.DBF$", "i"))[0];
      if (!f) throw new Error(`This backup has no ${name}.DBF. Choose the BKUPEXP.DAT file from an Expert backup.`);
      return f.async("uint8array");
    };
    const [pg, prod, act, chln, stock] = await Promise.all([file("PGROUP"), file("PRODUCT"), file("ACT"), file("CHLN"), file("STOCK")]);
    const groups = {};
    for (const g of readDbf(pg, ["CODE", "NAME"])) groups[g.CODE] = g.NAME;

    const items = readDbf(prod, ["CODE", "GROUP", "NAME", "DESC", "UNIT1", "CL_QTY", "MINLEVEL", "HSN_CODE", "BLOCKED"])
      .filter((p) => /^\d{6}$/.test(p.CODE) && p.NAME)
      .map((p) => ({
        expert_code: p.CODE,
        item_code: itemCode(p.CODE),
        short_name: p.NAME.slice(0, 31),
        description: p.DESC ? `${p.NAME} - ${p.DESC}` : p.NAME,
        uom: normUnit(p.UNIT1),
        item_type: itemType(groups[p.GROUP]),
        group: groups[p.GROUP] || "",
        hsn: p.HSN_CODE || "",
        safety: Math.max(0, p.MINLEVEL || 0),
        active: !p.BLOCKED,
        qty: p.CL_QTY || 0,
      }));

    const accounts = readDbf(act, ["CODE", "NAME", "GROUP", "ADD1", "ADD2", "ADD3", "PINCODE", "GSTNO", "CR_DAYS"]);
    const party = (a) => ({
      expert_code: a.CODE,
      code: "EXP-" + a.CODE,
      name: a.NAME,
      gstin: (a.GSTNO || "").slice(0, 15),
      address: joinAddress(a),
      payment_terms: a.CR_DAYS > 0 ? `${a.CR_DAYS} days` : "",
    });
    const suppliers = accounts.filter((a) => ACCOUNT_GROUPS.suppliers.includes(a.GROUP) && a.NAME).map(party);
    const customers = accounts.filter((a) => ACCOUNT_GROUPS.customers.includes(a.GROUP) && a.NAME).map(party);

    const lines = readDbf(stock, ["LINK", "VTYPE", "CODE", "BATCHNO", "QTY", "STK_QTY", "UNIT", "DOCNO", "DATE", "CV_CODE", "RATE", "VALUE"]);
    const lineNo = {};
    const purchases = [];
    const challanLines = {};
    for (const s of lines) {
      if (s.VTYPE === "PU" || s.VTYPE === "PR") {
        lineNo[s.LINK] = (lineNo[s.LINK] || 0) + 1;
        purchases.push({ link: s.LINK, line_no: lineNo[s.LINK], kind: s.VTYPE, bill_no: s.DOCNO, date: s.DATE,
          vendor_code: s.CV_CODE, item_code: s.CODE, qty: Math.abs(s.QTY), unit: normUnit(s.UNIT), rate: s.RATE, value: Math.abs(s.VALUE) });
      } else if (s.VTYPE === "PC") {
        (challanLines[s.LINK] = challanLines[s.LINK] || []).push({ item_code: s.CODE, qty: Math.abs(s.STK_QTY || s.QTY), rate: s.RATE, batch: s.BATCHNO });
      }
    }
    const challans = readDbf(chln, ["LINK", "DOCNO", "DATE", "CODE", "VTYPE"])
      .filter((c) => c.VTYPE === "PC")
      .map((c) => ({ link: c.LINK, doc_no: c.DOCNO, date: c.DATE, vendor_code: c.CODE, lines: challanLines[c.LINK] || [] }));

    const dates = challans.map((c) => c.date).filter(Boolean).sort();
    return {
      label: zip.comment || "Expert backup",
      items, suppliers, customers, purchases, challans,
      period: dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "",
    };
  }

  const api = { readBackup, readDbf, itemType, itemCode, normUnit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ExpertBackup = api;
})(typeof window !== "undefined" ? window : globalThis);
