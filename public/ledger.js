// Know Your Numbers — ledger: CSV import, categories, annual view, waterfall
// Extracted from the original single-file index.html; behaviour unchanged.
(function(){
  "use strict";

  var DATE_HINTS = ["date","transaction date","posted date","posting date"];
  var DESC_HINTS = ["description","desc","memo","name","payee","merchant","transaction"];
  var AMOUNT_HINTS = ["amount","transaction amount","amt"];

  // ---------- state ----------
  var db = null;
  var dbAvailable = null; // null = unknown yet, true/false once resolved
  var categories = { expenseGroups: [], incomeSources: [], taxRate: 0.30 };
  var monthData = { transactions: [], imports: [] };
  var currentMonthKey = null;
  var files = []; // staged import files, cleared once each one is imported into monthData
  var nextFileId = 1;
  var sectionTab = "ledger"; // 'data' | 'categories' | 'ledger'
  var sourceFilter = null; // an import batch id, to view just that file's rows in the ledger
  var learnedPatterns = {}; // normalizeDesc(desc) -> { bucket, monthKey } — learned from your own past categorizing
  var selectedIds = {}; // transaction id -> true, for bulk category assignment
  var lastClickedId = null; // anchor row id for shift+click range-select
  var addingTxn = false; // whether the inline "add transaction" row is showing
  // keyboard-only categorizing: after a category select commits (Enter/change), remember which
  // transaction's row should receive focus once renderAll() rebuilds the table, and in what state
  // (so a following Enter advances to the next row instead of reopening the dropdown)
  var focusBucketSelectAfterRender = null; // { txnId, state: "justCommitted" } | null
  var sortKey = "date";
  var sortDir = "asc";
  var activeFilter = null;
  var saveTimer = null;

  var currentYear = new Date().getFullYear();
  var viewMode = "month"; // 'month' | 'annual'
  var monthsIndex = {}; // "YYYY-MM" -> transaction count, mirrored to settings/monthsIndex
  var toastEl = document.getElementById("biz-toast");
  var fileInput = document.getElementById("biz-fileInput");
  var dropzone = document.getElementById("biz-dropzone");
  var filelistEl = document.getElementById("biz-filelist");
  var emptyNote = document.getElementById("biz-emptyNote");

  var toastTimer = null;
  function showToast(msg, duration){
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove("show"); }, duration || 1900);
  }
  window.addEventListener("error", function(e){
    try{ showToast("⚠ Script error: " + (e && e.message ? e.message : "unknown error"), 8000); }catch(_){}
  });
  window.addEventListener("unhandledrejection", function(e){
    try{
      var reason = e && e.reason;
      var msg = (reason && reason.message) ? reason.message : String(reason);
      showToast("⚠ Script error: " + msg, 8000);
    }catch(_){}
  });

  function uid(prefix){
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  }
  function esc(s){
    return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
  // db.doc(...).data() returns read-only/frozen data — always deep-clone before
  // storing it in our own mutable state, or later pushes/edits throw
  // "object is not extensible".
  function deepClone(v){
    if(v == null) return v;
    try{ return JSON.parse(JSON.stringify(v)); }catch(e){ return v; }
  }

  // ---------- learned patterns: predict a category from how you've categorized
  // similar-looking transactions before, no lookups or AI, just your own history ----------
  function normalizeDesc(desc){
    var raw = desc || "";
    var s;
    var starIdx = raw.indexOf("*");
    if(starIdx !== -1){
      // card-network descriptors like "DD *DOORDASH BLUEBOTTL" or "SQ *JOES COFFEE" put a fixed
      // aggregator prefix before the "*" and an app/brand name right after it, with the actual
      // highly-variable bit (restaurant, specific merchant) trailing after that — keep just the
      // prefix + that one brand token, e.g. "DD *DOORDASH BLUEBOTTL"/"DD *DOORDASH RALPHS" -> "DD DOORDASH"
      var before = raw.slice(0, starIdx);
      var afterToken = raw.slice(starIdx + 1).trim().split(/\s+/)[0] || "";
      s = before + " " + afterToken;
    } else {
      s = raw;
    }
    s = s.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(/\s\d{2,}$/, ""); // drop a trailing store/reference number, e.g. "TRADER JOE S #453" -> "TRADER JOE S"
    return s;
  }
  function learnPattern(desc, bucket, monthKey){
    if(!bucket || !monthKey) return;
    var key = normalizeDesc(desc);
    if(!key) return;
    var existing = learnedPatterns[key];
    if(!existing || monthKey >= existing.monthKey){
      learnedPatterns[key] = { bucket: bucket, monthKey: monthKey };
    }
  }
  function ingestPatternsFromTransactions(txns, monthKey){
    (txns || []).forEach(function(t){
      if(t.confirmed && t.bucket) learnPattern(t.desc, t.bucket, monthKey);
    });
  }
  function ingestAllMonthsInBackground(){
    if(!dbAvailable) return;
    Object.keys(monthsIndex).forEach(function(key){
      db.doc("biz-months/" + key).get().then(function(snap){
        if(!snap.exists) return;
        var data = deepClone(snap.data());
        ingestPatternsFromTransactions((data.transactions || []).map(reviveTxn), key);
      }).catch(function(){ /* best-effort */ });
    });
  }

  // ---------- section tabs (Data / Categories / Ledger) ----------
  function setSectionTab(tab){
    sectionTab = tab;
    document.querySelectorAll(".biz-inner-tab").forEach(function(btn){
      btn.classList.toggle("active", btn.getAttribute("data-section") === tab);
    });
    document.getElementById("biz-sectionData").hidden = tab !== "data";
    document.getElementById("biz-sectionCategories").hidden = tab !== "categories";
    document.getElementById("biz-sectionLedger").hidden = tab !== "ledger";
  }
  document.querySelectorAll(".biz-inner-tab").forEach(function(btn){
    btn.addEventListener("click", function(){ setSectionTab(btn.getAttribute("data-section")); });
  });
  setSectionTab(sectionTab);

  // ---------- CSV / parsing helpers ----------
  function parseCSV(text){
    var rows = [], row = [], field = "", inQuotes = false;
    for(var i=0;i<text.length;i++){
      var c = text[i];
      if(inQuotes){
        if(c === '"'){ if(text[i+1] === '"'){ field += '"'; i++; } else { inQuotes = false; } }
        else field += c;
      } else {
        if(c === '"') inQuotes = true;
        else if(c === ',') { row.push(field); field=""; }
        else if(c === '\n'){ row.push(field); rows.push(row); row=[]; field=""; }
        else if(c === '\r'){ /* skip */ }
        else field += c;
      }
    }
    if(field.length || row.length){ row.push(field); rows.push(row); }
    while(rows.length && rows[rows.length-1].every(function(c){return c.trim()==="";})) rows.pop();
    return rows;
  }
  function guessColumn(headers, hints){
    var lower = headers.map(function(h){ return (h||"").trim().toLowerCase(); });
    for(var h=0; h<hints.length; h++){ for(var i=0;i<lower.length;i++){ if(lower[i] === hints[h]) return i; } }
    for(var h2=0; h2<hints.length; h2++){ for(var i2=0;i2<lower.length;i2++){ if(lower[i2].indexOf(hints[h2]) !== -1) return i2; } }
    return -1;
  }
  function parseAmount(raw){
    if(raw == null) return null;
    var s = String(raw).trim();
    if(s === "") return null;
    var neg = false;
    if(/^\(.*\)$/.test(s)){ neg = true; s = s.slice(1,-1); }
    s = s.replace(/[$,\s]/g, "");
    if(/^-/.test(s)){ neg = true; }
    s = s.replace(/^[-+]/, "");
    var n = parseFloat(s);
    if(isNaN(n)) return null;
    return neg ? -Math.abs(n) : Math.abs(n);
  }
  function parseDate(raw){
    if(raw == null) return null;
    var s = String(raw).trim();
    if(s === "") return null;
    var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if(m){
      var mo = parseInt(m[1],10), da = parseInt(m[2],10), yr = parseInt(m[3],10);
      if(yr < 100) yr += 2000;
      var d = new Date(yr, mo-1, da);
      if(!isNaN(d.getTime())) return d;
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(m){
      var d2 = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
      if(!isNaN(d2.getTime())) return d2;
    }
    var d3 = new Date(s);
    if(!isNaN(d3.getTime())) return d3;
    return null;
  }
  function fmtDate(d){ return (d.getMonth()+1) + "/" + d.getDate() + "/" + d.getFullYear(); }
  function fmtDateISO(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
  function fmtMoney(n){
    var sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(n).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2});
  }

  // ---------- db bootstrap ----------
  function setSyncStatus(state, label){
    var el = document.getElementById("syncStatus");
    el.className = "sync-status " + state;
    document.getElementById("syncLabel").textContent = label;
  }

  // Gina's standard chart of accounts — seeded the first time there's no saved
  // category list yet (either offline, or an empty settings doc). Fully editable
  // afterward through the Categories tab, same as everything else here.
  function cat(id, name){ return { id: id, name: name }; }
  function defaultExpenseGroups(){
    return [
      {
        id: "grp_tax_deductible",
        name: "Tax deductible expenses",
        categories: [
          cat("cat_advertising_marketing", "Advertising & Marketing"),
          cat("cat_affiliate_payments", "Affiliate Payments"),
          cat("cat_bank_fees", "Bank Fees"),
          cat("cat_car_expenses", "Car Expenses"),
          cat("cat_contractor_payments", "Contractor Payments"),
          cat("cat_cogs", "Cost of Goods Sold"),
          cat("cat_conferences_seminars", "Conferences/Seminars"),
          cat("cat_coaching", "Coaching"),
          cat("cat_credit_card_interest", "Credit Card Interest"),
          cat("cat_equipment", "Equipment"),
          cat("cat_insurance", "Insurance"),
          cat("cat_job_supplies", "Job Supplies"),
          cat("cat_legal_accounting", "Legal / Accounting Services"),
          cat("cat_licenses", "Licenses"),
          cat("cat_meals", "Meals"),
          cat("cat_software_expenses", "Software Expenses"),
          cat("cat_office_supplies", "Office Supplies"),
          cat("cat_rent_lease", "Rent/ Lease"),
          cat("cat_payroll", "Payroll"),
          cat("cat_payroll_taxes", "Payroll Taxes"),
          cat("cat_reimbursable_expenses", "Reimbursable Expenses"),
          cat("cat_processor_fees", "Stripe/Paypal/Shopify/Square Fee's"),
          cat("cat_travel", "Travel"),
          cat("cat_utilities", "Utilities")
        ]
      },
      {
        id: "grp_non_deductible",
        name: "Non-tax deductible expenses",
        categories: [
          cat("cat_owners_distributions", "Owners distributions"),
          cat("cat_debt_minimum_payments", "Debt minimum payments"),
          cat("cat_debt_extra_payments", "Debt extra payments"),
          cat("cat_estimated_taxes_paid", "Estimated Taxes Paid")
        ]
      }
    ];
  }

  async function initDb(){
    try{
      db = window.__kynDb();
    }catch(e){ db = null; }
    dbAvailable = !!db;
    document.getElementById("biz-dbWarning").hidden = dbAvailable;
    if(!dbAvailable){
      setSyncStatus("offline", "Not saving (this tab only)");
      categories.expenseGroups = defaultExpenseGroups();
      initMonthPicker();
      renderCategoryEditor();
      renderAll();
      return;
    }
    setSyncStatus("saving", "Loading…");
    var hadSavedCategories = false;
    var categoriesFetchFailed = false;
    try{
      var snap = await db.doc("biz-settings/categories").get();
      if(snap.exists){
        var data = deepClone(snap.data());
        categories.expenseGroups = data.expenseGroups || [];
        categories.incomeSources = data.incomeSources || [];
        categories.taxRate = (typeof data.taxRate === "number" && data.taxRate >= 0) ? data.taxRate : 0.30;
        hadSavedCategories = true;
      }
    }catch(e){ categoriesFetchFailed = true; }
    if(!hadSavedCategories && !categoriesFetchFailed){
      // confirmed there's genuinely nothing saved yet — safe to seed the defaults and persist them
      categories.expenseGroups = defaultExpenseGroups();
      saveCategoriesNow();
    } else if(!hadSavedCategories && categoriesFetchFailed){
      // couldn't confirm whether saved categories exist — show defaults for this session only,
      // never overwrite what might already be stored
      categories.expenseGroups = defaultExpenseGroups();
    }
    try{
      var idxSnap = await db.doc("biz-settings/monthsIndex").get();
      if(idxSnap.exists) monthsIndex = deepClone(idxSnap.data()) || {};
    }catch(e){ /* keep empty */ }
    var lastMonthKey = null;
    try{
      var prefsSnap = await db.doc("biz-settings/prefs").get();
      if(prefsSnap.exists){
        var prefsData = prefsSnap.data();
        if(prefsData && /^\d{4}-\d{2}$/.test(prefsData.lastMonthKey || "")) lastMonthKey = prefsData.lastMonthKey;
      }
    }catch(e){ /* keep null */ }
    setSyncStatus("saved", "Saved");
    initMonthPicker(lastMonthKey);
    renderCategoryEditor();
    ingestAllMonthsInBackground();
    await loadMonth(currentMonthKey);
  }

  function initMonthPicker(startingMonthKey){
    if(startingMonthKey){
      currentYear = parseInt(startingMonthKey.split("-")[0], 10) || new Date().getFullYear();
      currentMonthKey = startingMonthKey;
    } else {
      var d = new Date();
      currentYear = d.getFullYear();
      currentMonthKey = currentYear + "-" + String(d.getMonth()+1).padStart(2,"0");
    }
    renderMonthTabs();
  }

  function setViewMode(mode){
    viewMode = mode;
    renderMonthTabs();
  }

  var MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function renderMonthTabs(){
    var container = document.getElementById("biz-monthTabs");
    container.innerHTML = "";
    for(var m=1;m<=12;m++){
      var mm = String(m).padStart(2,"0");
      var key = currentYear + "-" + mm;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "month-tab" + ((viewMode==="month" && key===currentMonthKey) ? " active" : "");
      var label = document.createElement("span"); label.textContent = MONTH_ABBR[m-1];
      btn.appendChild(label);
      if(monthsIndex[key] > 0){
        var dot = document.createElement("span"); dot.className = "has-data";
        btn.appendChild(dot);
      }
      btn.addEventListener("click", (function(k){ return function(){ setViewMode("month"); loadMonth(k); }; })(key));
      container.appendChild(btn);
    }
    document.getElementById("biz-yearLabel").textContent = currentYear;
  }

  document.getElementById("biz-yearPrev").addEventListener("click", function(){
    currentYear--; renderMonthTabs();
  });
  document.getElementById("biz-yearNext").addEventListener("click", function(){
    currentYear++; renderMonthTabs();
  });

  async function updateMonthIndex(){
    if(!currentMonthKey) return;
    var count = monthData.transactions.length;
    if(count > 0) monthsIndex[currentMonthKey] = count;
    else delete monthsIndex[currentMonthKey];
    renderMonthTabs();
    if(!dbAvailable) return;
    try{ await db.doc("biz-settings/monthsIndex").set(monthsIndex); }catch(e){ /* non-critical */ }
  }

  async function loadMonth(key){
    currentMonthKey = key;
    currentYear = parseInt(key.split("-")[0], 10) || currentYear;
    files = [];
    activeFilter = null;
    sourceFilter = null;
    selectedIds = {};
    lastClickedId = null;
    addingTxn = false;
    document.getElementById("biz-ledgerMonthLabel").textContent = monthLabel(key) + "'s ledger";
    monthData = { transactions: [], imports: [] };
    if(dbAvailable){
      setSyncStatus("saving", "Loading…");
      try{
        var snap = await db.doc("biz-months/" + key).get();
        if(snap.exists){
          var data = deepClone(snap.data());
          monthData.transactions = (data.transactions || []).map(reviveTxn);
          monthData.imports = data.imports || [];
        }
        ingestPatternsFromTransactions(monthData.transactions, key);
        setSyncStatus("saved", "Saved");
      }catch(e){
        setSyncStatus("offline", "Couldn't load this month");
      }
      try{ await db.doc("biz-settings/prefs").update({ lastMonthKey: key }); }
      catch(e){ try{ await db.doc("biz-settings/prefs").set({ lastMonthKey: key }); }catch(e2){ /* non-critical */ } }
    }
    setSectionTab(monthData.transactions.length ? "ledger" : "data");
    renderFileCards();
    renderAll();
    renderMonthTabs();
  }

  function monthLabel(key){
    if(!key) return "This month";
    var parts = key.split("-");
    var d = new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, 1);
    return d.toLocaleDateString("en-US", { month:"long", year:"numeric" });
  }

  function reviveTxn(t){
    return {
      id: t.id, dateISO: t.dateISO, desc: t.desc, amount: t.amount, source: t.source,
      importId: t.importId || null,
      raw: t.raw || {}, bucket: t.bucket, flagged: !!t.flagged, confirmed: !!t.confirmed, predicted: !!t.predicted, reason: t.reason || ""
    };
  }
  // which import batch a transaction belongs to, falling back to a synthetic
  // key grouped by source filename for transactions saved before batches existed
  function effectiveBatchKey(t){
    return t.importId || ("legacy:" + (t.source || "Unknown file"));
  }

  function scheduleSave(){
    if(!dbAvailable) return;
    setSyncStatus("saving", "Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 700);
  }
  async function doSave(){
    if(!dbAvailable || !currentMonthKey) return;
    try{
      await db.doc("biz-months/" + currentMonthKey).set({ transactions: monthData.transactions, imports: monthData.imports || [], updatedAt: new Date().toISOString() });
      setSyncStatus("saved", "Saved");
    }catch(e){
      setSyncStatus("offline", "Couldn't save — retrying next edit");
    }
  }
  async function saveCategoriesNow(){
    if(!dbAvailable) return;
    setSyncStatus("saving", "Saving…");
    try{
      await db.doc("biz-settings/categories").set(categories);
      setSyncStatus("saved", "Saved");
    }catch(e){
      setSyncStatus("offline", "Couldn't save categories");
    }
  }

  // ---------- categories editor ----------
  function renderCategoryEditor(){
    try{ renderCategoryEditorInner(); }
    catch(e){
      console.error("renderCategoryEditor failed", e);
      showToast("⚠ Couldn't display categories: " + (e && e.message ? e.message : e), 8000);
    }
  }
  function renderCategoryEditorInner(){
    var groupsEl = document.getElementById("biz-expenseGroups");
    groupsEl.innerHTML = "";
    categories.expenseGroups.forEach(function(group){
      var g = document.createElement("div");
      g.className = "cat-group";

      var head = document.createElement("div");
      head.className = "cat-group-head";
      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = group.name;
      nameInput.addEventListener("change", function(){ group.name = nameInput.value.trim() || "Untitled"; saveCategoriesNow(); renderAll(); });
      var rmGroup = document.createElement("button");
      rmGroup.type = "button"; rmGroup.className = "icon-btn"; rmGroup.textContent = "Remove group";
      rmGroup.addEventListener("click", function(){
        categories.expenseGroups = categories.expenseGroups.filter(function(gr){ return gr.id !== group.id; });
        saveCategoriesNow(); renderCategoryEditor(); renderAll();
      });
      head.appendChild(nameInput); head.appendChild(rmGroup);
      g.appendChild(head);

      var chipList = document.createElement("div");
      chipList.className = "cat-chip-list";
      group.categories.forEach(function(cat){
        var chip = document.createElement("div");
        chip.className = "cat-chip";
        var catName = document.createElement("input");
        catName.type = "text"; catName.value = cat.name; catName.title = "Category name";
        catName.addEventListener("change", function(){ cat.name = catName.value.trim() || "Untitled"; saveCategoriesNow(); renderAll(); });
        var catKw = document.createElement("input");
        catKw.type = "text"; catKw.className = "kw"; catKw.value = cat.keywords || ""; catKw.placeholder = "vendor names to always match this category";
        catKw.addEventListener("change", function(){ cat.keywords = catKw.value; saveCategoriesNow(); renderAll(); });
        var rmCat = document.createElement("button");
        rmCat.type = "button"; rmCat.className = "icon-btn"; rmCat.textContent = "✕";
        rmCat.addEventListener("click", function(){
          group.categories = group.categories.filter(function(c){ return c.id !== cat.id; });
          saveCategoriesNow(); renderCategoryEditor(); renderAll();
        });
        chip.appendChild(catName); chip.appendChild(catKw); chip.appendChild(rmCat);
        chipList.appendChild(chip);
      });
      g.appendChild(chipList);

      var addRow = document.createElement("div");
      addRow.className = "add-row";
      var addInput = document.createElement("input");
      addInput.type = "text"; addInput.placeholder = "New category name";
      var addBtn = document.createElement("button");
      addBtn.type = "button"; addBtn.textContent = "Add";
      function doAdd(){
        var name = addInput.value.trim();
        if(!name) return;
        group.categories.push({ id: uid("cat"), name: name, keywords: "" });
        addInput.value = "";
        saveCategoriesNow(); renderCategoryEditor(); renderAll();
      }
      addBtn.addEventListener("click", doAdd);
      addInput.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); doAdd(); } });
      addRow.appendChild(addInput); addRow.appendChild(addBtn);
      g.appendChild(addRow);

      groupsEl.appendChild(g);
    });

    var incEl = document.getElementById("biz-incomeSources");
    incEl.innerHTML = "";
    categories.incomeSources.forEach(function(src){
      var row = document.createElement("div");
      row.className = "income-row";
      var nameInput = document.createElement("input");
      nameInput.type = "text"; nameInput.value = src.name;
      nameInput.addEventListener("change", function(){ src.name = nameInput.value.trim() || "Untitled"; saveCategoriesNow(); renderAll(); });
      var kwInput = document.createElement("input");
      kwInput.type = "text"; kwInput.className = "kw"; kwInput.value = src.keywords || ""; kwInput.placeholder = "vendor names to always match this category";
      kwInput.addEventListener("change", function(){ src.keywords = kwInput.value; saveCategoriesNow(); renderAll(); });
      var rmBtn = document.createElement("button");
      rmBtn.type = "button"; rmBtn.className = "icon-btn"; rmBtn.textContent = "✕";
      rmBtn.addEventListener("click", function(){
        categories.incomeSources = categories.incomeSources.filter(function(s){ return s.id !== src.id; });
        saveCategoriesNow(); renderCategoryEditor(); renderAll();
      });
      row.appendChild(nameInput); row.appendChild(kwInput); row.appendChild(rmBtn);
      incEl.appendChild(row);
    });

    document.getElementById("biz-addIncomeBtn").onclick = function(){
      var input = document.getElementById("biz-newIncomeName");
      var name = input.value.trim();
      if(!name) return;
      categories.incomeSources.push({ id: uid("inc"), name: name, keywords: "" });
      input.value = "";
      saveCategoriesNow(); renderCategoryEditor(); renderAll();
    };
  }

  // ---------- classification ----------
  function keywordList(str){
    return (str||"").split(",").map(function(k){ return k.trim().toLowerCase(); }).filter(function(k){ return k.length>0; });
  }
  function matchesAny(descLower, list){
    for(var i=0;i<list.length;i++){ if(descLower.indexOf(list[i]) !== -1) return true; }
    return false;
  }
  function categoryLookup(){
    var map = {};
    categories.expenseGroups.forEach(function(g){
      g.categories.forEach(function(c){ map[c.id] = { label: c.name, group: g.name, kind:"expense" }; });
    });
    categories.incomeSources.forEach(function(s){ map[s.id] = { label: s.name, group:"Income", kind:"income" }; });
    map.otherIncome = { label:"Other income", group:"Income", kind:"income" };
    map.uncategorized = { label:"Uncategorized", group:"Review", kind:"uncategorized" };
    return map;
  }

  function classify(desc, amt){
    var descLower = (desc||"").toLowerCase();

    // learned from your own past categorizing takes priority over generic keyword rules —
    // if you've already told the tool what "PAY*CROSSTOWN PROPERTI" or "TRADER JOE S #___" is, trust that
    var learned = learnedPatterns[normalizeDesc(desc)];
    if(learned){
      var entry = categoryLookup()[learned.bucket];
      var mismatch = entry && ((entry.kind === "income" && amt < 0) || (entry.kind === "expense" && amt > 0));
      return {
        bucket: learned.bucket,
        flagged: !!mismatch,
        reason: mismatch ? "predicted \"" + (entry ? entry.label : learned.bucket) + "\" from a previous month, but the amount sign looks off" : "",
        predicted: true
      };
    }

    for(var i=0;i<categories.incomeSources.length;i++){
      var src = categories.incomeSources[i];
      var list = keywordList(src.name + "," + (src.keywords||""));
      if(matchesAny(descLower, list)){
        return { bucket: src.id, flagged: amt<0, reason: amt<0 ? "matched \""+src.name+"\" but amount is negative" : "", predicted:false };
      }
    }
    for(var g=0; g<categories.expenseGroups.length; g++){
      var group = categories.expenseGroups[g];
      for(var c=0;c<group.categories.length;c++){
        var cat = group.categories[c];
        var list2 = keywordList(cat.name + "," + (cat.keywords||""));
        if(matchesAny(descLower, list2)){
          return { bucket: cat.id, flagged: amt>0, reason: amt>0 ? "matched \""+cat.name+"\" but amount is positive" : "", predicted:false };
        }
      }
    }
    return amt >= 0
      ? { bucket:"otherIncome", flagged:true, reason:"no income source matched", predicted:false }
      : { bucket:"uncategorized", flagged:true, reason:"no category matched", predicted:false };
  }

  // ---------- import ----------
  function addFile(name, text){
    var rows = parseCSV(text);
    if(!rows.length){ showToast(name + ": couldn't find any rows"); return; }
    var headers = rows[0];
    var body = rows.slice(1);
    var file = {
      id: nextFileId++, name: name, headers: headers, rows: body,
      map: { date: guessColumn(headers, DATE_HINTS), desc: guessColumn(headers, DESC_HINTS), amount: guessColumn(headers, AMOUNT_HINTS) },
      flip: 1
    };
    files.push(file);
    renderFileCards();
  }
  function removeFile(id){ files = files.filter(function(f){ return f.id !== id; }); renderFileCards(); }
  function handleFileList(list){
    Array.prototype.slice.call(list).forEach(function(f){
      var reader = new FileReader();
      reader.onload = function(){ addFile(f.name, String(reader.result)); };
      reader.onerror = function(){ showToast("Couldn't read " + f.name); };
      reader.readAsText(f);
    });
  }
  fileInput.addEventListener("change", function(){ handleFileList(fileInput.files); fileInput.value = ""; });
  dropzone.addEventListener("click", function(){ fileInput.click(); });
  dropzone.addEventListener("keydown", function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); fileInput.click(); } });
  ["dragenter","dragover"].forEach(function(ev){ dropzone.addEventListener(ev, function(e){ e.preventDefault(); dropzone.classList.add("drag"); }); });
  ["dragleave","drop"].forEach(function(ev){ dropzone.addEventListener(ev, function(e){ e.preventDefault(); dropzone.classList.remove("drag"); }); });
  dropzone.addEventListener("drop", function(e){ e.preventDefault(); dropzone.classList.remove("drag"); if(e.dataTransfer && e.dataTransfer.files) handleFileList(e.dataTransfer.files); });

  function labelizeHeaders(headers){
    return headers.map(function(h, hi){ return (h && h.trim()) ? h.trim() : "Column " + (hi+1); });
  }
  function guessField(headers, hints){
    var idx = guessColumn(headers, hints);
    return idx >= 0 ? headers[idx] : null;
  }
  function buildPreviewRows(f, limit){
    var out = [];
    if(f.map.date < 0 || f.map.desc < 0 || f.map.amount < 0) return out;
    for(var i=0; i<f.rows.length && out.length<limit; i++){
      var r = f.rows[i];
      var rawDate = r[f.map.date], rawDesc = r[f.map.desc], rawAmount = r[f.map.amount];
      if((rawDate==null||String(rawDate).trim()==="") && (rawDesc==null||String(rawDesc).trim()==="") && (rawAmount==null||String(rawAmount).trim()==="")) continue;
      var d = parseDate(rawDate);
      var amt = parseAmount(rawAmount);
      if(amt !== null) amt = amt * f.flip;
      out.push({ date: d ? fmtDate(d) : (rawDate || "—"), desc: (rawDesc||"").toString().trim() || "(no description)", amount: amt });
    }
    return out;
  }
  function renderPreviewTable(container, previewRows, totalRowCount){
    container.innerHTML = "";
    if(!previewRows.length){
      var note = document.createElement("div");
      note.className = "preview-note";
      note.textContent = "Set the column mapping above to see a preview.";
      container.appendChild(note);
      return;
    }
    var table = document.createElement("table");
    table.className = "preview-table";
    var thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Date</th><th>Description</th><th style=\"text-align:right;\">Amount</th></tr>";
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    previewRows.forEach(function(row){
      var tr = document.createElement("tr");
      var tdD = document.createElement("td"); tdD.className = "mono"; tdD.textContent = row.date;
      var tdDesc = document.createElement("td"); tdDesc.textContent = row.desc;
      var tdA = document.createElement("td"); tdA.className = "num"; tdA.textContent = row.amount===null ? "—" : fmtMoney(row.amount);
      tr.appendChild(tdD); tr.appendChild(tdDesc); tr.appendChild(tdA);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
    var note = document.createElement("div");
    note.className = "preview-note";
    note.textContent = "Showing first " + previewRows.length + " of " + totalRowCount + " row" + (totalRowCount===1?"":"s") + ", with the sign rule above already applied.";
    container.appendChild(note);
  }

  function renderFileCards(){
    filelistEl.innerHTML = "";
    files.forEach(function(f){
      var card = document.createElement("div");
      card.className = "filecard";
      var head = document.createElement("div");
      head.className = "filecard-head";
      var nameEl = document.createElement("div");
      nameEl.className = "filecard-name"; nameEl.title = f.name; nameEl.textContent = f.name;
      var rmBtn = document.createElement("button");
      rmBtn.className = "icon-btn"; rmBtn.textContent = "Remove";
      rmBtn.addEventListener("click", function(){ removeFile(f.id); });
      head.appendChild(nameEl); head.appendChild(rmBtn);

      var body = document.createElement("div");
      body.className = "filecard-body";
      var mapped = f.map.date>=0 && f.map.desc>=0 && f.map.amount>=0;
      var badge = document.createElement("span");
      badge.className = "badge " + (mapped ? "ok" : "warn");
      badge.textContent = mapped ? "Columns matched" : "Check column mapping";
      body.appendChild(badge);

      [["date","Date"],["desc","Description"],["amount","Amount"]].forEach(function(pair){
        var key = pair[0], label = pair[1];
        var row = document.createElement("div");
        row.className = "maprow";
        var lab = document.createElement("label"); lab.textContent = label;
        var sel = document.createElement("select");
        var noneOpt = document.createElement("option"); noneOpt.value = "-1"; noneOpt.textContent = "— not set —";
        sel.appendChild(noneOpt);
        f.headers.forEach(function(h, idx){
          var opt = document.createElement("option");
          opt.value = String(idx);
          opt.textContent = (h && h.trim()) ? h.trim() : "(column " + (idx+1) + ")";
          if(idx === f.map[key]) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener("change", function(){ f.map[key] = parseInt(sel.value,10); renderFileCards(); });
        row.appendChild(lab); row.appendChild(sel);
        body.appendChild(row);
      });

      var signRow = document.createElement("div");
      signRow.className = "sign-row";
      var signLabel = document.createElement("span");
      signLabel.textContent = f.flip === -1 ? "Signs flipped for this file" : "Trusting this file's signs as-is";
      var flipBtn = document.createElement("button");
      flipBtn.type = "button"; flipBtn.className = "icon-btn"; flipBtn.textContent = "Flip signs";
      flipBtn.addEventListener("click", function(){ f.flip = f.flip === -1 ? 1 : -1; renderFileCards(); });
      signRow.appendChild(signLabel); signRow.appendChild(flipBtn);
      body.appendChild(signRow);

      var previewTitle = document.createElement("div");
      previewTitle.className = "cat-section-label"; previewTitle.style.margin = "6px 0 0";
      previewTitle.textContent = "Preview";
      body.appendChild(previewTitle);
      var previewWrap = document.createElement("div");
      body.appendChild(previewWrap);
      renderPreviewTable(previewWrap, buildPreviewRows(f, 6), f.rows.length);

      var importBtn = document.createElement("button");
      importBtn.type = "button"; importBtn.className = "icon-btn";
      importBtn.style.border = "1px solid var(--surface-ink)"; importBtn.style.color = "var(--surface-ink)"; importBtn.style.fontWeight = "700";
      importBtn.textContent = "Import into " + monthLabel(currentMonthKey);
      importBtn.addEventListener("click", function(){ importFile(f); });
      body.appendChild(importBtn);

      card.appendChild(head); card.appendChild(body);
      filelistEl.appendChild(card);
    });
  }

  function selectedMonthRange(){
    if(!currentMonthKey) return null;
    var parts = currentMonthKey.split("-");
    var y = parseInt(parts[0],10), m = parseInt(parts[1],10);
    return { start: new Date(y, m-1, 1), end: new Date(y, m, 0, 23, 59, 59) };
  }

  function importFile(f){
    if(f.map.date < 0 || f.map.desc < 0 || f.map.amount < 0){ showToast("Set the column mapping first"); return; }
    var range = selectedMonthRange();
    var existingIds = {};
    monthData.transactions.forEach(function(t){ existingIds[t.id] = true; });
    var added = 0, skippedOutOfMonth = 0, skippedDupe = 0;
    var headerLabels = labelizeHeaders(f.headers);
    var batchId = uid("batch");

    f.rows.forEach(function(r){
      var rawDate = r[f.map.date], rawDesc = r[f.map.desc], rawAmount = r[f.map.amount];
      if((rawDate==null||String(rawDate).trim()==="") && (rawDesc==null||String(rawDesc).trim()==="") && (rawAmount==null||String(rawAmount).trim()==="")) return;
      var d = parseDate(rawDate);
      var amt = parseAmount(rawAmount);
      if(amt !== null) amt = amt * f.flip;
      var desc = (rawDesc||"").toString().trim() || "(no description)";
      if(d && range && (d < range.start || d > range.end)){ skippedOutOfMonth++; return; }

      var dateISO = d ? fmtDateISO(d) : (rawDate || "");
      var dupeKey = "t_" + dateISO + "_" + (amt===null?"na":amt.toFixed(2)) + "_" + desc.slice(0,40) + "_" + f.name;
      var id = simpleHash(dupeKey);
      if(existingIds[id]){ skippedDupe++; return; }

      var raw = {};
      headerLabels.forEach(function(label, hi){ raw[label] = r[hi]; });

      var missing = !d || amt === null;
      var cls = missing
        ? { bucket: (amt!==null && amt>=0) ? "otherIncome" : "uncategorized", flagged:true, reason:"missing date or amount", predicted:false }
        : classify(desc, amt);

      monthData.transactions.push({
        id: id, dateISO: dateISO, desc: desc, amount: amt, source: f.name, importId: batchId, raw: raw,
        bucket: cls.bucket, flagged: cls.flagged, confirmed: !!(cls.predicted && !cls.flagged), predicted: !!cls.predicted, reason: cls.reason
      });
      existingIds[id] = true;
      added++;
    });

    if(added > 0){
      if(!monthData.imports) monthData.imports = [];
      monthData.imports.push({
        id: batchId, source: f.name, headers: headerLabels,
        dateField: headerLabels[f.map.date], descField: headerLabels[f.map.desc], amountField: headerLabels[f.map.amount],
        flip: f.flip, importedAt: new Date().toISOString()
      });
    }

    files = files.filter(function(ff){ return ff.id !== f.id; });
    renderFileCards();
    scheduleSave();
    updateMonthIndex();
    renderAll();
    var msg = "Imported " + added + " transaction" + (added===1?"":"s");
    if(skippedDupe) msg += " · " + skippedDupe + " already in this month";
    if(skippedOutOfMonth) msg += " · " + skippedOutOfMonth + " outside " + monthLabel(currentMonthKey);
    showToast(msg);
  }

  function simpleHash(str){
    var h = 0;
    for(var i=0;i<str.length;i++){ h = ((h<<5)-h) + str.charCodeAt(i); h |= 0; }
    return "id" + Math.abs(h).toString(36);
  }

  // ---------- imported files (batches): view / re-map / delete ----------
  function txnsForBatch(batch){
    return monthData.transactions.filter(function(t){ return effectiveBatchKey(t) === batch.id; });
  }
  function getImportBatches(){
    var known = {};
    (monthData.imports || []).forEach(function(b){ known[b.id] = Object.assign({ legacy:false }, b); });
    monthData.transactions.forEach(function(t){
      var key = effectiveBatchKey(t);
      if(known[key]) return;
      var headers = Object.keys(t.raw || {});
      known[key] = {
        id: key, source: t.source || "Unknown file", legacy: true, headers: headers,
        dateField: guessField(headers, DATE_HINTS), descField: guessField(headers, DESC_HINTS), amountField: guessField(headers, AMOUNT_HINTS),
        flip: 1, importedAt: null
      };
    });
    var list = Object.keys(known).map(function(k){ return known[k]; });
    list.sort(function(a,b){
      if(a.importedAt && b.importedAt) return b.importedAt.localeCompare(a.importedAt);
      if(a.importedAt) return -1;
      if(b.importedAt) return 1;
      return (a.source||"").localeCompare(b.source||"");
    });
    return list;
  }

  function renderImportedFiles(){
    var wrap = document.getElementById("biz-importedFiles");
    var emptyNote = document.getElementById("biz-importedFilesEmpty");
    var batches = getImportBatches();
    wrap.innerHTML = "";
    emptyNote.hidden = batches.length > 0;
    batches.forEach(function(batch){ wrap.appendChild(buildBatchCard(batch)); });
  }

  function buildBatchCard(batch){
    var txns = txnsForBatch(batch);
    var total = 0;
    txns.forEach(function(t){ if(t.amount !== null) total += t.amount; });

    var card = document.createElement("div");
    card.className = "filecard";

    var head = document.createElement("div");
    head.className = "filecard-head";
    var nameWrap = document.createElement("div");
    nameWrap.className = "batch-name-wrap";
    var nameEl = document.createElement("div");
    nameEl.className = "filecard-name"; nameEl.title = batch.source; nameEl.textContent = batch.source;
    var meta = document.createElement("span");
    meta.className = "batch-meta";
    var whenText = batch.importedAt ? new Date(batch.importedAt).toLocaleDateString("en-US", { month:"short", day:"numeric" }) : "from before file tracking";
    meta.textContent = txns.length + " txn" + (txns.length===1?"":"s") + " · " + fmtMoney(Math.abs(total)) + " · " + whenText;
    nameWrap.appendChild(nameEl); nameWrap.appendChild(meta);
    head.appendChild(nameWrap);
    card.appendChild(head);

    var body = document.createElement("div");
    body.className = "filecard-body";

    var actions = document.createElement("div");
    actions.className = "batch-actions";

    var viewBtn = document.createElement("button");
    viewBtn.type = "button"; viewBtn.className = "icon-btn"; viewBtn.textContent = "View rows";
    viewBtn.addEventListener("click", function(){
      sourceFilter = batch.id; activeFilter = null;
      setSectionTab("ledger");
      renderAll();
    });

    var editBtn = document.createElement("button");
    editBtn.type = "button"; editBtn.className = "icon-btn"; editBtn.textContent = "Edit mapping";
    var editWrap = document.createElement("div");
    editWrap.className = "batch-edit"; editWrap.hidden = true;
    editBtn.addEventListener("click", function(){
      editWrap.hidden = !editWrap.hidden;
      if(!editWrap.hidden) renderBatchEditForm(editWrap, batch);
    });

    var delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.className = "icon-btn danger"; delBtn.textContent = "Delete this file's data";
    var delArmed = false, delTimer = null;
    delBtn.addEventListener("click", function(){
      if(!delArmed){
        delArmed = true; delBtn.textContent = "Click again to confirm";
        clearTimeout(delTimer);
        delTimer = setTimeout(function(){ delArmed = false; delBtn.textContent = "Delete this file's data"; }, 3500);
        return;
      }
      clearTimeout(delTimer);
      var removedCount = txns.length;
      monthData.transactions = monthData.transactions.filter(function(t){ return effectiveBatchKey(t) !== batch.id; });
      if(monthData.imports) monthData.imports = monthData.imports.filter(function(b){ return b.id !== batch.id; });
      if(sourceFilter === batch.id) sourceFilter = null;
      scheduleSave(); updateMonthIndex(); renderAll();
      showToast("Deleted " + removedCount + " transaction" + (removedCount===1?"":"s") + " from " + batch.source);
    });

    actions.appendChild(viewBtn); actions.appendChild(editBtn); actions.appendChild(delBtn);
    body.appendChild(actions);
    body.appendChild(editWrap);

    card.appendChild(body);
    return card;
  }

  function renderBatchEditForm(container, batch){
    container.innerHTML = "";
    var state = { dateField: batch.dateField, descField: batch.descField, amountField: batch.amountField, flip: batch.flip || 1 };
    var txns = txnsForBatch(batch);

    [["dateField","Date"],["descField","Description"],["amountField","Amount"]].forEach(function(pair){
      var key = pair[0], label = pair[1];
      var row = document.createElement("div");
      row.className = "maprow";
      var lab = document.createElement("label"); lab.textContent = label;
      var sel = document.createElement("select");
      var noneOpt = document.createElement("option"); noneOpt.value = ""; noneOpt.textContent = "— not set —";
      sel.appendChild(noneOpt);
      batch.headers.forEach(function(h){
        var opt = document.createElement("option"); opt.value = h; opt.textContent = h;
        if(h === state[key]) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", function(){ state[key] = sel.value || null; updatePreview(); });
      row.appendChild(lab); row.appendChild(sel);
      container.appendChild(row);
    });

    var signRow = document.createElement("div");
    signRow.className = "sign-row";
    var signLabel = document.createElement("span");
    signLabel.textContent = state.flip === -1 ? "Signs flipped for this file" : "Trusting this file's signs as-is";
    var flipBtn = document.createElement("button");
    flipBtn.type = "button"; flipBtn.className = "icon-btn"; flipBtn.textContent = "Flip signs";
    flipBtn.addEventListener("click", function(){
      state.flip = state.flip === -1 ? 1 : -1;
      signLabel.textContent = state.flip === -1 ? "Signs flipped for this file" : "Trusting this file's signs as-is";
      updatePreview();
    });
    signRow.appendChild(signLabel); signRow.appendChild(flipBtn);
    container.appendChild(signRow);

    var previewTitle = document.createElement("div");
    previewTitle.className = "cat-section-label"; previewTitle.style.margin = "6px 0 0";
    previewTitle.textContent = "Preview";
    container.appendChild(previewTitle);
    var previewWrap = document.createElement("div");
    container.appendChild(previewWrap);

    function updatePreview(){
      var rows = txns.slice(0, 6).map(function(t){
        var rawDate = state.dateField ? t.raw[state.dateField] : null;
        var rawDesc = state.descField ? t.raw[state.descField] : null;
        var rawAmount = state.amountField ? t.raw[state.amountField] : null;
        var d = parseDate(rawDate);
        var amt = parseAmount(rawAmount);
        if(amt !== null) amt = amt * state.flip;
        return { date: d ? fmtDate(d) : (rawDate || "—"), desc: (rawDesc||"").toString().trim() || "(no description)", amount: amt };
      });
      renderPreviewTable(previewWrap, rows, txns.length);
    }
    updatePreview();

    var actionsRow = document.createElement("div");
    actionsRow.style.display = "flex"; actionsRow.style.gap = "8px"; actionsRow.style.marginTop = "12px";
    var applyBtn = document.createElement("button");
    applyBtn.type = "button"; applyBtn.className = "icon-btn";
    applyBtn.style.border = "1px solid var(--surface-ink)"; applyBtn.style.color = "var(--surface-ink)"; applyBtn.style.fontWeight = "700";
    applyBtn.textContent = "Apply changes";
    applyBtn.addEventListener("click", function(){
      if(!state.dateField || !state.descField || !state.amountField){ showToast("Choose a column for date, description, and amount"); return; }
      applyBatchRemap(batch, state);
    });
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "icon-btn"; cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function(){ container.hidden = true; });
    actionsRow.appendChild(applyBtn); actionsRow.appendChild(cancelBtn);
    container.appendChild(actionsRow);
  }

  function applyBatchRemap(batch, state){
    var txns = txnsForBatch(batch);
    var preserved = 0;
    txns.forEach(function(t){
      var rawDate = t.raw[state.dateField], rawDesc = t.raw[state.descField], rawAmount = t.raw[state.amountField];
      var d = parseDate(rawDate);
      var amt = parseAmount(rawAmount);
      if(amt !== null) amt = amt * state.flip;
      var desc = (rawDesc||"").toString().trim() || "(no description)";
      t.dateISO = d ? fmtDateISO(d) : (rawDate || "");
      t.desc = desc;
      t.amount = amt;
      // a row you've already confirmed or manually categorized keeps that
      // categorization — remapping only fixes how the date/desc/amount are read,
      // it shouldn't undo work you've already done sorting this file.
      if(t.confirmed){ preserved++; return; }
      var missing = !d || amt === null;
      var cls = missing
        ? { bucket: (amt!==null && amt>=0) ? "otherIncome" : "uncategorized", flagged:true, reason:"missing date or amount", predicted:false }
        : classify(desc, amt);
      t.bucket = cls.bucket; t.flagged = cls.flagged; t.reason = cls.reason; t.predicted = !!cls.predicted;
      t.confirmed = !!(cls.predicted && !cls.flagged);
    });

    if(!batch.legacy){
      var existing = (monthData.imports || []).filter(function(x){ return x.id === batch.id; })[0];
      if(existing){
        existing.dateField = state.dateField; existing.descField = state.descField;
        existing.amountField = state.amountField; existing.flip = state.flip;
      }
    } else {
      if(!monthData.imports) monthData.imports = [];
      monthData.imports.push({
        id: batch.id, source: batch.source, headers: batch.headers,
        dateField: state.dateField, descField: state.descField, amountField: state.amountField,
        flip: state.flip, importedAt: new Date().toISOString()
      });
      txns.forEach(function(t){ t.importId = batch.id; });
    }

    scheduleSave();
    updateMonthIndex();
    renderAll();
    var msg = "Updated " + txns.length + " transaction" + (txns.length===1?"":"s") + " from " + batch.source;
    if(preserved) msg += " · kept your categorization on " + preserved + " already-reviewed row" + (preserved===1?"":"s");
    showToast(msg, 4500);
  }

  function defaultDateForCurrentMonth(){
    var today = new Date();
    var todayKey = today.getFullYear() + "-" + String(today.getMonth()+1).padStart(2,"0");
    if(todayKey === currentMonthKey) return fmtDateISO(today);
    return currentMonthKey + "-01";
  }
  function buildAddTxnRow(){
    var tr = document.createElement("tr");
    tr.className = "add-txn-row";

    var tdCheck = document.createElement("td");

    var tdAmt = document.createElement("td");
    var amtInput = document.createElement("input");
    amtInput.type = "text"; amtInput.className = "mono"; amtInput.placeholder = "-42.10";
    tdAmt.appendChild(amtInput);

    var tdBucket = document.createElement("td");
    var sel = document.createElement("select");
    sel.className = "bucket-select";
    buildBucketOptions(sel, "uncategorized");
    tdBucket.appendChild(sel);

    var tdDesc = document.createElement("td");
    var descInput = document.createElement("input");
    descInput.type = "text"; descInput.placeholder = "Description";
    tdDesc.appendChild(descInput);

    var tdDate = document.createElement("td");
    var dateInput = document.createElement("input");
    dateInput.type = "date"; dateInput.value = defaultDateForCurrentMonth();
    tdDate.appendChild(dateInput);

    var tdActions = document.createElement("td");
    tdActions.style.whiteSpace = "nowrap";
    var saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.className = "icon-btn"; saveBtn.textContent = "✓"; saveBtn.title = "Add this transaction";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "icon-btn"; cancelBtn.textContent = "✕"; cancelBtn.title = "Cancel";
    tdActions.appendChild(saveBtn); tdActions.appendChild(cancelBtn);

    function commit(){
      var raw = amtInput.value.trim().replace(/,/g, "").replace(/^\$/, "");
      var amt = parseFloat(raw);
      if(isNaN(amt)){ showToast("Enter an amount — negative for spending, positive for income"); amtInput.focus(); return; }
      var desc = descInput.value.trim() || "(no description)";
      var dateISO = dateInput.value || defaultDateForCurrentMonth();
      var bucket = sel.value;
      var entry = categoryLookup()[bucket];
      var mismatch = !!entry && ((entry.kind === "income" && amt < 0) || (entry.kind === "expense" && amt > 0));
      monthData.transactions.push({
        id: uid("txn"), dateISO: dateISO, desc: desc, amount: amt, source: "Manual entry", importId: null, raw: {},
        bucket: bucket, flagged: mismatch, confirmed: !mismatch, predicted: false,
        reason: mismatch ? "amount sign looks off for \"" + entry.label + "\"" : ""
      });
      if(!mismatch) learnPattern(desc, bucket, currentMonthKey);
      addingTxn = false;
      scheduleSave(); updateMonthIndex(); renderAll();
      showToast("Added transaction");
    }
    saveBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", function(){ addingTxn = false; renderAll(); });
    [amtInput, descInput, dateInput].forEach(function(el){
      el.addEventListener("keydown", function(e){
        if(e.key === "Enter"){ e.preventDefault(); commit(); }
        else if(e.key === "Escape"){ e.preventDefault(); addingTxn = false; renderAll(); }
      });
    });

    tdBucket.classList.add("cat-col");
    tr.appendChild(tdCheck); tr.appendChild(tdBucket); tr.appendChild(tdAmt); tr.appendChild(tdDesc); tr.appendChild(tdDate); tr.appendChild(tdActions);
    setTimeout(function(){ amtInput.focus(); }, 0);
    return tr;
  }
  document.getElementById("biz-addTxnBtn").addEventListener("click", function(){
    addingTxn = true;
    renderAll();
  });

  var clearMonthArmed = false, clearMonthArmTimer = null;
  var clearMonthBtn = document.getElementById("biz-clearMonthBtn");
  clearMonthBtn.addEventListener("click", function(){
    if(!monthData.transactions.length) return;
    if(!clearMonthArmed){
      clearMonthArmed = true;
      clearMonthBtn.textContent = "Click again to confirm delete";
      clearMonthBtn.classList.add("danger");
      clearTimeout(clearMonthArmTimer);
      clearMonthArmTimer = setTimeout(function(){
        clearMonthArmed = false;
        clearMonthBtn.textContent = "Delete this month's data";
        clearMonthBtn.classList.remove("danger");
      }, 3500);
      return;
    }
    clearTimeout(clearMonthArmTimer);
    clearMonthArmed = false;
    clearMonthBtn.textContent = "Delete this month's data";
    clearMonthBtn.classList.remove("danger");
    monthData.transactions = [];
    monthData.imports = [];
    activeFilter = null;
    sourceFilter = null;
    scheduleSave();
    updateMonthIndex();
    renderAll();
    showToast("Deleted all transactions in " + monthLabel(currentMonthKey));
  });

  // ---------- sorting ----------
  document.querySelectorAll("th.sortable").forEach(function(th){
    th.addEventListener("click", function(){
      var key = th.getAttribute("data-sort");
      if(sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = key; sortDir = "asc"; }
      renderAll();
    });
  });
  function applySort(list){
    var dir = sortDir === "asc" ? 1 : -1;
    var lookup = categoryLookup();
    var sorted = list.slice();
    sorted.sort(function(a,b){
      var av, bv;
      if(sortKey === "amount"){ av = a.amount===null?-Infinity:a.amount; bv = b.amount===null?-Infinity:b.amount; }
      else if(sortKey === "desc"){ av = (a.desc||"").toLowerCase(); bv = (b.desc||"").toLowerCase(); }
      else if(sortKey === "category"){
        av = ((lookup[a.bucket]||{}).label || "").toLowerCase();
        bv = ((lookup[b.bucket]||{}).label || "").toLowerCase();
      }
      else { av = a.dateISO || ""; bv = b.dateISO || ""; }
      if(av < bv) return -1*dir;
      if(av > bv) return 1*dir;
      return 0;
    });
    return sorted;
  }
  function updateSortHeaders(){
    document.querySelectorAll("th.sortable").forEach(function(th){
      var active = th.getAttribute("data-sort") === sortKey;
      th.classList.toggle("active", active);
      th.querySelector(".arrow").textContent = active ? (sortDir==="asc"?"▲":"▼") : "";
    });
  }

  document.getElementById("biz-filterChipClear").addEventListener("click", function(){ activeFilter = null; sourceFilter = null; renderAll(); });

  // ---------- bulk category assignment ----------
  document.getElementById("biz-selectAllCheckbox").addEventListener("change", function(){
    var box = this;
    var viewing = applySort(getFilteredRows(monthData.transactions));
    if(box.checked){ viewing.forEach(function(t){ selectedIds[t.id] = true; }); }
    else { viewing.forEach(function(t){ delete selectedIds[t.id]; }); }
    renderAll();
  });
  document.getElementById("biz-bulkClearBtn").addEventListener("click", function(){ selectedIds = {}; renderAll(); });
  document.getElementById("biz-bulkApplyBtn").addEventListener("click", function(){
    var bucket = document.getElementById("biz-bulkBucketSelect").value;
    if(!bucket) return;
    var ids = selectedIds;
    var n = 0;
    monthData.transactions.forEach(function(t){
      if(!ids[t.id]) return;
      t.bucket = bucket; t.flagged = false; t.confirmed = true; t.reason = ""; t.predicted = false;
      learnPattern(t.desc, t.bucket, currentMonthKey);
      n++;
    });
    if(!n) return;
    selectedIds = {};
    scheduleSave();
    renderAll();
    showToast("Assigned " + n + " transaction" + (n===1?"":"s"));
  });

  // ---------- render ----------
  function computeTotals(transactions, lookup){
    var totals = {}, counts = {};
    var reviewTotal = 0, reviewCount = 0, income = 0, expense = 0;
    transactions.forEach(function(t){
      var entry = lookup[t.bucket];
      var validBucket = !!entry;
      var flagged = t.flagged || !validBucket;
      counts[t.bucket] = (counts[t.bucket]||0) + 1;
      if(flagged && !t.confirmed) reviewCount++;
      if(t.amount === null) return;
      totals[t.bucket] = (totals[t.bucket]||0) + t.amount;
      if(flagged && !t.confirmed) reviewTotal += t.amount;
      if(validBucket){
        if(entry.kind === "income") income += t.amount;
        else if(entry.kind === "expense") expense += t.amount;
      }
    });
    return { totals:totals, counts:counts, reviewTotal:reviewTotal, reviewCount:reviewCount, income:income, expense:expense };
  }

  function getFilteredRows(all){
    var rows = all;
    if(sourceFilter){
      rows = rows.filter(function(t){ return effectiveBatchKey(t) === sourceFilter; });
    }
    if(!activeFilter) return rows;
    if(activeFilter === "__review") return rows.filter(function(t){ return (t.flagged || !categoryLookup()[t.bucket]) && !t.confirmed; });
    return rows.filter(function(t){ return t.bucket === activeFilter; });
  }

  function renderAll(){
    renderImportedFiles();
    var lookup = categoryLookup();
    var all = monthData.transactions;
    var placeholder = document.getElementById("biz-placeholder");
    var tableWrap = document.getElementById("biz-tableWrap");
    var summaryBar = document.getElementById("biz-summaryBar");
    var catTotals = document.getElementById("biz-catTotals");
    var filterChip = document.getElementById("biz-filterChip");

    if(!all.length && !addingTxn){
      placeholder.hidden = false;
      tableWrap.hidden = true;
      summaryBar.hidden = true;
      catTotals.hidden = true;
      filterChip.hidden = true;
      document.getElementById("biz-bulkBar").hidden = true;
      catTotals.innerHTML = "";
      return;
    }
    placeholder.hidden = true;
    tableWrap.hidden = false;
    summaryBar.hidden = !all.length;
    catTotals.hidden = !all.length;
    if(!all.length) catTotals.innerHTML = "";

    var res = computeTotals(all, lookup);
    document.getElementById("biz-sumIncome").textContent = fmtMoney(res.income);
    document.getElementById("biz-sumExpense").textContent = fmtMoney(Math.abs(res.expense));
    document.getElementById("biz-sumNet").textContent = fmtMoney(res.income + res.expense);

    // category totals, grouped — each group its own horizontal bar chart, sorted highest to lowest.
    // bars scale within their own group/section, not the whole ledger, so a group's internal
    // ranking (its actual job here) stays legible instead of getting swamped by income.
    catTotals.innerHTML = "";

    function addSection(label){
      var s = document.createElement("div");
      s.className = "cat-totals-section";
      s.textContent = label;
      catTotals.appendChild(s);
    }
    function addBarRow(bucketId, label, amount, localMax, isActive, onClick){
      var row = document.createElement("button");
      row.type = "button";
      row.className = "cat-totals-row" + (isActive ? " active" : "");
      var lbl = document.createElement("span"); lbl.className = "bar-label"; lbl.textContent = label;
      var track = document.createElement("span"); track.className = "bar-track";
      var fill = document.createElement("span"); fill.className = "bar-fill";
      fill.style.width = Math.max(1.5, (Math.abs(amount)/Math.max(localMax,1))*100) + "%";
      track.appendChild(fill);
      var val = document.createElement("span"); val.className = "bar-value num"; val.textContent = fmtMoney(Math.abs(amount));
      row.appendChild(lbl); row.appendChild(track); row.appendChild(val);
      row.addEventListener("click", onClick);
      catTotals.appendChild(row);
    }
    function sortByAmountDesc(items, idOf){
      return items.slice().sort(function(a,b){ return Math.abs(res.totals[idOf(b)]||0) - Math.abs(res.totals[idOf(a)]||0); });
    }
    function addTotalRow(label, amount){
      var row = document.createElement("div");
      row.className = "cat-totals-total";
      var lbl = document.createElement("span"); lbl.className = "label"; lbl.textContent = label;
      var n = document.createElement("span"); n.className = "n num"; n.textContent = fmtMoney(Math.abs(amount));
      row.appendChild(lbl); row.appendChild(n);
      catTotals.appendChild(row);
    }

    var hasIncome = categories.incomeSources.some(function(s){ return res.counts[s.id]>0; }) || res.counts.otherIncome>0;
    if(hasIncome){
      addSection("Income");
      var incomeItems = sortByAmountDesc(
        categories.incomeSources.concat([{ id:"otherIncome", name:"Other income" }]).filter(function(s){ return res.counts[s.id]>0; }),
        function(s){ return s.id; }
      );
      var incomeMax = incomeItems.reduce(function(m,s){ return Math.max(m, Math.abs(res.totals[s.id]||0)); }, 0);
      var incomeTotal = 0;
      incomeItems.forEach(function(s){
        addBarRow(s.id, s.name, res.totals[s.id]||0, incomeMax, activeFilter===s.id, function(){
          activeFilter = (activeFilter===s.id) ? null : s.id; sourceFilter = null; renderAll();
        });
        incomeTotal += (res.totals[s.id]||0);
      });
      addTotalRow("Total income", incomeTotal);
    }
    var hasExpense = categories.expenseGroups.some(function(g){ return g.categories.some(function(c){ return res.counts[c.id]>0; }); });
    if(hasExpense){
      categories.expenseGroups.forEach(function(g){
        var groupCats = g.categories.filter(function(c){ return res.counts[c.id]>0; });
        if(!groupCats.length) return;
        addSection(g.name);
        var sorted = sortByAmountDesc(groupCats, function(c){ return c.id; });
        var groupMax = sorted.reduce(function(m,c){ return Math.max(m, Math.abs(res.totals[c.id]||0)); }, 0);
        var groupTotal = 0;
        sorted.forEach(function(c){
          addBarRow(c.id, c.name, res.totals[c.id]||0, groupMax, activeFilter===c.id, function(){
            activeFilter = (activeFilter===c.id) ? null : c.id; sourceFilter = null; renderAll();
          });
          groupTotal += (res.totals[c.id]||0);
        });
        addTotalRow("Total " + g.name + " spending", groupTotal);
      });
    }
    if(res.counts.uncategorized>0 || res.reviewCount>0){
      addSection("Needs attention");
      var attnItems = [];
      if(res.counts.uncategorized>0) attnItems.push({ id:"uncategorized", name:"Uncategorized", amount: res.totals.uncategorized||0 });
      if(res.reviewCount>0) attnItems.push({ id:"__review", name:"To review", amount: res.reviewTotal||0 });
      attnItems.sort(function(a,b){ return Math.abs(b.amount) - Math.abs(a.amount); });
      var attnMax = attnItems.reduce(function(m,x){ return Math.max(m, Math.abs(x.amount)); }, 0);
      attnItems.forEach(function(item){
        addBarRow(item.id, item.name, item.amount, attnMax, activeFilter===item.id, function(){
          activeFilter = (activeFilter===item.id) ? null : item.id; sourceFilter = null; renderAll();
        });
      });
    }

    if(activeFilter || sourceFilter){
      filterChip.hidden = false;
      var chipParts = [];
      if(sourceFilter){
        var srcBatch = getImportBatches().filter(function(b){ return b.id === sourceFilter; })[0];
        chipParts.push("rows from <b>" + esc(srcBatch ? srcBatch.source : "a removed file") + "</b>");
      }
      if(activeFilter){
        var flabel = activeFilter === "__review" ? "items to review" : (lookup[activeFilter] ? lookup[activeFilter].label : "unknown");
        chipParts.push("<b>" + esc(flabel) + "</b> only");
      }
      document.getElementById("biz-filterChipLabel").innerHTML = chipParts.join(" · ");
    } else {
      filterChip.hidden = true;
    }

    var viewing = applySort(getFilteredRows(all));
    updateSortHeaders();
    buildBucketOptions(document.getElementById("biz-bulkBucketSelect"), null);

    var tbody = document.getElementById("biz-tbody");
    tbody.innerHTML = "";
    if(addingTxn){
      tbody.appendChild(buildAddTxnRow());
    }
    if(!viewing.length && !addingTxn){
      var trEmpty = document.createElement("tr");
      var tdEmpty = document.createElement("td");
      tdEmpty.colSpan = 6; tdEmpty.style.color = "var(--muted-surface)"; tdEmpty.style.padding = "22px 14px";
      tdEmpty.textContent = "Nothing here.";
      trEmpty.appendChild(tdEmpty);
      tbody.appendChild(trEmpty);
    }

    viewing.forEach(function(t){
      var entry = lookup[t.bucket];
      var isFlagged = (t.flagged || !entry) && !t.confirmed;
      var tr = document.createElement("tr");
      tr.className = "txn-row";
      if(isFlagged) tr.className += " flag";
      if(t.confirmed) tr.className += " confirmed";
      tr.addEventListener("click", function(){ openModal(t); });

      var tdCheck = document.createElement("td");
      tdCheck.className = "check-cell";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!selectedIds[t.id];
      tdCheck.appendChild(cb);
      tdCheck.addEventListener("click", function(e){
        e.stopPropagation();
        e.preventDefault();
        if(e.shiftKey && lastClickedId != null){
          var ids = viewing.map(function(x){ return x.id; });
          var i1 = ids.indexOf(lastClickedId), i2 = ids.indexOf(t.id);
          if(i1 !== -1 && i2 !== -1){
            var lo = Math.min(i1,i2), hi = Math.max(i1,i2);
            for(var k=lo; k<=hi; k++){ selectedIds[ids[k]] = true; }
          } else {
            if(selectedIds[t.id]) delete selectedIds[t.id]; else selectedIds[t.id] = true;
          }
        } else {
          if(selectedIds[t.id]) delete selectedIds[t.id]; else selectedIds[t.id] = true;
        }
        lastClickedId = t.id;
        renderAll();
      });

      var tdAmt = document.createElement("td");
      tdAmt.className = "num";
      tdAmt.textContent = t.amount === null ? "—" : fmtMoney(t.amount);

      var tdBucket = document.createElement("td");
      var sel = document.createElement("select");
      sel.className = "bucket-select";
      sel.dataset.txnId = t.id;
      buildBucketOptions(sel, t.bucket);
      sel.addEventListener("click", function(e){ e.stopPropagation(); });
      sel.addEventListener("mousedown", function(){ sel.dataset.kbOpened = "1"; });
      sel.addEventListener("blur", function(){ sel.dataset.kbOpened = "0"; sel.dataset.kbState = "idle"; });
      // keyboard-only categorizing, mirroring a spreadsheet's data-validation flow:
      // Enter #1 opens the dropdown, typing jumps to a category (native typeahead),
      // Enter #2 commits it (native), Enter #3 moves down to the next row's category cell —
      // never touching the mouse. See buildBucketOptions/showPicker below.
      sel.addEventListener("keydown", function(e){
        if(e.key === "Escape"){ sel.dataset.kbOpened = "0"; return; }
        if(e.key !== "Enter") return;
        if(sel.dataset.kbOpened === "1") return; // dropdown is open — let the browser commit + close it natively
        e.preventDefault();
        if(sel.dataset.kbState === "justCommitted"){
          var trEl = sel.closest("tr");
          var nextTr = trEl && trEl.nextElementSibling;
          while(nextTr && !nextTr.querySelector("select.bucket-select")) nextTr = nextTr.nextElementSibling;
          var nextSel = nextTr ? nextTr.querySelector("select.bucket-select") : null;
          if(nextSel){ nextSel.dataset.kbState = "idle"; nextSel.dataset.kbOpened = "0"; nextSel.focus(); }
          return;
        }
        if(sel.showPicker){ try{ sel.showPicker(); sel.dataset.kbOpened = "1"; }catch(err){} }
      });
      sel.addEventListener("change", function(){
        t.bucket = sel.value; t.flagged = false; t.confirmed = true; t.reason = ""; t.predicted = false;
        learnPattern(t.desc, t.bucket, currentMonthKey);
        scheduleSave();
        sel.dataset.kbOpened = "0";
        focusBucketSelectAfterRender = { txnId: t.id, state: "justCommitted" };
        renderAll();
      });
      tdBucket.appendChild(sel);
      if(isFlagged){
        var badge = document.createElement("span");
        badge.className = "flag-badge"; badge.textContent = "review";
        badge.title = entry ? (t.reason||"") : "category was deleted";
        tdBucket.appendChild(badge);
        var confirmBtn = document.createElement("button");
        confirmBtn.type = "button"; confirmBtn.className = "confirm-btn"; confirmBtn.textContent = "Confirm";
        confirmBtn.addEventListener("click", function(e){
          e.stopPropagation(); t.confirmed = true; t.predicted = false;
          learnPattern(t.desc, t.bucket, currentMonthKey);
          scheduleSave(); renderAll();
        });
        tdBucket.appendChild(confirmBtn);
      } else if(t.flagged && t.confirmed){
        var tag = document.createElement("span"); tag.className = "confirmed-tag"; tag.textContent = "✓ reviewed";
        tdBucket.appendChild(tag);
      } else if(t.predicted){
        var predTag = document.createElement("span"); predTag.className = "predicted-tag"; predTag.textContent = "predicted";
        predTag.title = "Guessed from how you categorized a similar transaction before — click the dropdown to fix it";
        tdBucket.appendChild(predTag);
      }

      var tdDesc = document.createElement("td");
      tdDesc.className = "desc"; tdDesc.textContent = t.desc;
      if(t.reason) tdDesc.title = t.reason;

      var tdDate = document.createElement("td");
      tdDate.className = "mono";
      tdDate.textContent = t.dateISO ? fmtDate(new Date(t.dateISO + "T00:00:00")) : "—";

      var tdDel = document.createElement("td");
      var delBtn = document.createElement("button");
      delBtn.type = "button"; delBtn.className = "icon-btn"; delBtn.textContent = "✕";
      delBtn.title = "Delete this transaction";
      delBtn.addEventListener("click", function(e){
        e.stopPropagation();
        monthData.transactions = monthData.transactions.filter(function(x){ return x.id !== t.id; });
        scheduleSave(); updateMonthIndex(); renderAll();
      });
      tdDel.appendChild(delBtn);

      tdBucket.classList.add("cat-col");
      tr.appendChild(tdCheck); tr.appendChild(tdBucket); tr.appendChild(tdAmt); tr.appendChild(tdDesc); tr.appendChild(tdDate); tr.appendChild(tdDel);
      tbody.appendChild(tr);
    });

    if(focusBucketSelectAfterRender){
      var wantFocus = focusBucketSelectAfterRender;
      focusBucketSelectAfterRender = null;
      var targetSel = tbody.querySelector('select.bucket-select[data-txn-id="' + wantFocus.txnId + '"]');
      if(targetSel){
        targetSel.dataset.kbState = wantFocus.state;
        targetSel.dataset.kbOpened = "0";
        targetSel.focus();
      }
    }

    updateSelectAllState(viewing);
    updateBulkBar();
  }

  function updateBulkBar(){
    var bar = document.getElementById("biz-bulkBar");
    var n = Object.keys(selectedIds).filter(function(id){ return selectedIds[id]; }).length;
    if(n > 0){
      bar.hidden = false;
      document.getElementById("biz-bulkCount").textContent = n + " selected";
    } else {
      bar.hidden = true;
    }
  }
  function updateSelectAllState(viewing){
    var box = document.getElementById("biz-selectAllCheckbox");
    if(!viewing || !viewing.length){ box.checked = false; box.indeterminate = false; return; }
    var allSelected = viewing.every(function(t){ return selectedIds[t.id]; });
    var someSelected = viewing.some(function(t){ return selectedIds[t.id]; });
    box.checked = allSelected;
    box.indeterminate = !allSelected && someSelected;
  }

  function buildBucketOptions(sel, currentBucket){
    sel.innerHTML = "";
    function addOpt(group, value, label){
      var opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      if(value === currentBucket) opt.selected = true;
      group.appendChild(opt);
    }
    if(categories.incomeSources.length){
      var incGroup = document.createElement("optgroup"); incGroup.label = "Income";
      categories.incomeSources.forEach(function(s){ addOpt(incGroup, s.id, s.name); });
      addOpt(incGroup, "otherIncome", "Other income");
      sel.appendChild(incGroup);
    } else {
      var incGroup2 = document.createElement("optgroup"); incGroup2.label = "Income";
      addOpt(incGroup2, "otherIncome", "Other income");
      sel.appendChild(incGroup2);
    }
    categories.expenseGroups.forEach(function(g){
      if(!g.categories.length) return;
      var grp = document.createElement("optgroup"); grp.label = g.name;
      g.categories.forEach(function(c){ addOpt(grp, c.id, c.name); });
      sel.appendChild(grp);
    });
    var revGroup = document.createElement("optgroup"); revGroup.label = "Review";
    addOpt(revGroup, "uncategorized", "Uncategorized");
    sel.appendChild(revGroup);
    if(!categoryLookup()[currentBucket]){
      var missing = document.createElement("option");
      missing.value = currentBucket; missing.textContent = "⚠ deleted category"; missing.selected = true;
      sel.insertBefore(missing, sel.firstChild);
    }
  }


  // ---------- copy as CSV ----------
  document.getElementById("biz-copyCsvBtn").addEventListener("click", function(){
    var lookup = categoryLookup();
    var lines = ["Date,Category,Description,Amount"];
    applySort(monthData.transactions).forEach(function(t){
      var cat = lookup[t.bucket] ? lookup[t.bucket].label : "Uncategorized";
      var amt = t.amount===null ? "" : t.amount.toFixed(2);
      var desc = '"' + (t.desc||"").replace(/"/g,'""') + '"';
      lines.push([t.dateISO||"", cat, desc, amt].join(","));
    });
    copyText(lines.join("\n"), "Copied " + monthData.transactions.length + " rows as CSV");
  });
  function copyText(text, msg){
    function fallbackCopy(){
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try{ document.execCommand("copy"); }catch(e){}
      document.body.removeChild(ta);
    }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ showToast(msg); }, fallbackCopy);
    } else { fallbackCopy(); showToast(msg); }
  }

  // ---------- detail modal ----------
  var modalBackdrop = document.getElementById("biz-modalBackdrop");
  document.getElementById("biz-modalClose").addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", function(e){ if(e.target === modalBackdrop) closeModal(); });
  document.addEventListener("keydown", function(e){ if(e.key === "Escape" && !modalBackdrop.hidden) closeModal(); });
  function closeModal(){ modalBackdrop.hidden = true; }

  function openModal(t){
    var lookup = categoryLookup();
    document.getElementById("biz-modalAmount").textContent = t.amount === null ? "—" : fmtMoney(t.amount);
    document.getElementById("biz-modalDesc").textContent = t.desc;
    var body = document.getElementById("biz-modalBody");
    body.innerHTML = "";
    function addRow(container, k, v){
      var row = document.createElement("div"); row.className = "detail-row";
      var kEl = document.createElement("span"); kEl.className = "k"; kEl.textContent = k;
      var vEl = document.createElement("span"); vEl.className = "v"; vEl.textContent = (v==null||v==="") ? "—" : v;
      row.appendChild(kEl); row.appendChild(vEl);
      container.appendChild(row);
    }
    var srcTitle = document.createElement("div"); srcTitle.className = "modal-section-title"; srcTitle.textContent = "Source";
    body.appendChild(srcTitle);
    var pill = document.createElement("span"); pill.className = "source-pill"; pill.textContent = t.source;
    body.appendChild(pill);

    var parsedTitle = document.createElement("div"); parsedTitle.className = "modal-section-title"; parsedTitle.textContent = "As classified";
    body.appendChild(parsedTitle);
    var parsedBox = document.createElement("div");
    addRow(parsedBox, "Amount", t.amount===null?"—":fmtMoney(t.amount));
    addRow(parsedBox, "Description", t.desc);
    addRow(parsedBox, "Date", t.dateISO ? fmtDate(new Date(t.dateISO+"T00:00:00")) : "—");
    addRow(parsedBox, "Category", lookup[t.bucket] ? lookup[t.bucket].label : "⚠ deleted category");
    if(t.reason) addRow(parsedBox, "Flagged because", t.reason);
    body.appendChild(parsedBox);

    var rawTitle = document.createElement("div"); rawTitle.className = "modal-section-title"; rawTitle.textContent = "All columns from the original CSV";
    body.appendChild(rawTitle);
    var rawBox = document.createElement("div");
    Object.keys(t.raw || {}).forEach(function(k){ addRow(rawBox, k, t.raw[k]); });
    body.appendChild(rawBox);

    modalBackdrop.hidden = false;
  }

  // ---------- annual view (True P&L on top, Non-Deductible Expenses below) ----------
  var annualYear = new Date().getFullYear();
  var annualLoadToken = 0;

  document.getElementById("biz-annualYearPrev").addEventListener("click", function(){
    annualYear--; document.getElementById("biz-annualYearLabel").textContent = annualYear; renderAnnualView();
  });
  document.getElementById("biz-annualYearNext").addEventListener("click", function(){
    annualYear++; document.getElementById("biz-annualYearLabel").textContent = annualYear; renderAnnualView();
  });
  document.getElementById("biz-annualRefreshBtn").addEventListener("click", function(){ renderAnnualView(); });

  // ---------- cash flow waterfall (one static set of buckets, not per-month) ----------
  var wfLoadToken = 0;
  var wfTaxTarget = null;

  function parseMoneyInput(str){
    if(str == null) return null;
    var cleaned = String(str).replace(/[^0-9.\-]/g,"");
    if(cleaned === "" || cleaned === "-") return null;
    var v = parseFloat(cleaned);
    return isNaN(v) ? null : v;
  }

  document.getElementById("biz-wfRefreshBtn").addEventListener("click", function(){ renderWaterfall(); });

  async function saveWaterfallSettings(patch){
    if(!dbAvailable) return;
    try{ await db.doc("biz-settings/waterfall").update(patch); }
    catch(e){
      try{ await db.doc("biz-settings/waterfall").set(patch); }
      catch(e2){ showToast("⚠ Couldn't save that", 4000); }
    }
  }
  function wireWaterfallInputs(){
    document.querySelectorAll(".wf-balance-input").forEach(function(input){
      input.addEventListener("click", function(e){ e.stopPropagation(); });
      input.addEventListener("change", function(){
        var bucket = input.getAttribute("data-bucket");
        var v = parseMoneyInput(input.value);
        var patch = {}; patch[bucket] = v;
        saveWaterfallSettings(patch).then(function(){ renderWaterfall(); });
      });
    });
    var taxTargetInput = document.getElementById("biz-wfTaxTarget");
    if(taxTargetInput){
      taxTargetInput.addEventListener("click", function(e){ e.stopPropagation(); });
      taxTargetInput.addEventListener("change", function(){
        var v = parseMoneyInput(taxTargetInput.value);
        saveWaterfallSettings({ taxTarget: v }).then(function(){ renderWaterfall(); });
      });
    }
  }

  function trailingMonthKeysFromToday(count){
    var d = new Date();
    var y = d.getFullYear(), m = d.getMonth();
    var keys = [];
    for(var i=count-1;i>=0;i--){
      var dd = new Date(y, m-i, 1);
      keys.push(dd.getFullYear() + "-" + String(dd.getMonth()+1).padStart(2,"0"));
    }
    return keys;
  }

  async function renderWaterfall(){
    var grid = document.getElementById("biz-wfGrid");
    var token = ++wfLoadToken;

    if(!dbAvailable){
      grid.innerHTML = "<div style=\"padding:20px; color:var(--muted-surface); grid-column:1/-1;\">Connect storage to track your cash flow waterfall.</div>";
      return;
    }
    grid.innerHTML = "<div style=\"padding:20px; color:var(--muted-surface); grid-column:1/-1;\">Loading…</div>";

    var lookup = categoryLookup();
    var trailingKeys = trailingMonthKeysFromToday(6);

    var settingsPromise;
    try{
      settingsPromise = db.doc("biz-settings/waterfall").get().then(function(snap){ return snap.exists ? snap.data() : {}; }).catch(function(){ return {}; });
    }catch(e){ settingsPromise = Promise.resolve({}); }

    var monthPromises = trailingKeys.map(function(mk){
      try{
        return db.doc("biz-months/" + mk).get().then(function(snap){
          var txns = [];
          if(snap.exists){
            var data = snap.data();
            txns = (data.transactions || []).map(reviveTxn);
          }
          return computeTotals(txns, lookup);
        }).catch(function(){ return computeTotals([], lookup); });
      }catch(e){ return Promise.resolve(computeTotals([], lookup)); }
    });

    var results = await Promise.all(monthPromises);
    var settings = await settingsPromise;
    if(token !== wfLoadToken) return;

    wfTaxTarget = (typeof settings.taxTarget === "number") ? settings.taxTarget : null;

    var deductibleGroup = categories.expenseGroups[0] || { name:"Tax deductible expenses", categories: [] };
    var monthlyDed = results.map(function(r){
      return Math.abs(deductibleGroup.categories.reduce(function(s,c){ return s + (r.totals[c.id]||0); }, 0));
    });
    var monthsWithData = monthlyDed.filter(function(v){ return v > 0; });
    var avgDed = monthsWithData.length ? (monthsWithData.reduce(function(a,b){ return a+b; }, 0) / monthsWithData.length) : 0;
    var hasEnoughData = monthsWithData.length > 0;

    function roundToThousand(n){ return Math.round(n / 1000) * 1000; }
    var checkingTarget = hasEnoughData ? roundToThousand(avgDed * 1) : null;
    var wcTarget = hasEnoughData ? roundToThousand(avgDed * 2) : null;

    var checkingBalance = (typeof settings.checking === "number") ? settings.checking : null;
    var wcBalance = (typeof settings.workingCapital === "number") ? settings.workingCapital : null;
    var taxBalance = (typeof settings.tax === "number") ? settings.tax : null;

    function statusFor(balance, target){
      if(target === null) return "unset";
      if(balance === null) return "pending";
      return balance >= target ? "good" : "under";
    }
    function statusLabel(status){
      if(status === "good") return "Funded";
      if(status === "under") return "Under target";
      if(status === "pending") return "Add a balance";
      return "No target yet";
    }
    function gaugePct(balance, target){
      if(balance === null || target === null || target <= 0) return 0;
      return Math.max(0, Math.min(100, (balance/target) * 100));
    }
    function deltaLine(balance, target){
      if(balance === null || target === null) return "";
      var diff = balance - target;
      if(diff >= 0) return "<b>" + fmtMoney(diff) + "</b> over target";
      return "<b>" + fmtMoney(Math.abs(diff)) + "</b> under target";
    }
    function moneyInputHtml(cls, extraAttr, value){
      return "<div class=\"wf-input-wrap\"><span>$</span><input type=\"text\" inputmode=\"decimal\" class=\"" + cls + "\" " + extraAttr + " value=\"" + (value!==null ? value.toFixed(2) : "") + "\" placeholder=\"0.00\"></div>";
    }
    function card(opts){
      var status = statusFor(opts.balance, opts.target);
      var pct = gaugePct(opts.balance, opts.target);
      var targetCell = opts.targetEditable
        ? moneyInputHtml("wf-target-input", "id=\"biz-wfTaxTarget\"", opts.target)
        : "<div class=\"wf-target-line\"><span>Target</span><span><b>" + (opts.target!==null ? fmtMoney(opts.target) : "—") + "</b>" + (opts.targetNote ? " · " + esc(opts.targetNote) : "") + "</span></div>";
      return "" +
        "<div class=\"wf-card\">" +
          "<div class=\"wf-card-head\"><div class=\"wf-card-name\">" + esc(opts.name) + "</div>" +
            "<div class=\"wf-status-pill " + status + "\">" + statusLabel(status) + "</div>" +
          "</div>" +
          "<div class=\"wf-balance-row\"><label>Balance</label>" + moneyInputHtml("wf-balance-input", "data-bucket=\"" + opts.id + "\"", opts.balance) + "</div>" +
          (opts.targetEditable
            ? "<div class=\"wf-balance-row\"><label>Target</label>" + targetCell + "</div>"
            : targetCell) +
          "<div class=\"wf-gauge\"><div class=\"wf-gauge-fill " + status + "\" style=\"width:" + pct + "%;\"></div></div>" +
          "<div class=\"wf-sweep" + (opts.sweepHtml ? "" : " muted") + "\">" + (opts.sweepHtml || deltaLine(opts.balance, opts.target) || "Enter a balance to see how it compares.") + "</div>" +
          (opts.footnote ? "<div class=\"wf-footnote\">" + opts.footnote + "</div>" : "") +
        "</div>";
    }

    // Checking only ever sweeps UP into Working Capital when it's over buffer — a shortfall
    // just sits and rebuilds on its own rather than pulling cash back and forth.
    var checkingSweepHtml = "";
    if(checkingBalance !== null && checkingTarget !== null){
      var diff = checkingBalance - checkingTarget;
      if(diff > 0) checkingSweepHtml = "Move <b>" + fmtMoney(diff) + "</b> to Working Capital";
      else if(diff < 0) checkingSweepHtml = "Below buffer — let it rebuild, no transfer needed";
      else checkingSweepHtml = "Right at target";
    }
    var wcSweepHtml = "";
    if(wcBalance !== null && wcTarget !== null){
      var wdiff = wcBalance - wcTarget;
      if(wdiff > 0) wcSweepHtml = "<b>" + fmtMoney(wdiff) + "</b> above target — clear for distributions or investment";
      else if(wdiff < 0) wcSweepHtml = "<b>" + fmtMoney(Math.abs(wdiff)) + "</b> below target — draw on this only if you need it";
      else wcSweepHtml = "Right at target";
    }
    var taxSweepHtml = "";
    if(taxBalance !== null && wfTaxTarget !== null){
      var tdiff = taxBalance - wfTaxTarget;
      if(tdiff >= 0) taxSweepHtml = "Fully covered for what you've set aside to owe";
      else taxSweepHtml = "<b>" + fmtMoney(Math.abs(tdiff)) + "</b> short of your tax target";
    }

    var grossProfitByMonth = results.map(function(r){
      return r.income + deductibleGroup.categories.reduce(function(s,c){ return s + (r.totals[c.id]||0); }, 0);
    });
    var taxRate = (typeof categories.taxRate === "number" && categories.taxRate >= 0) ? categories.taxRate : 0.30;
    var accruedTax = grossProfitByMonth.reduce(function(sum, gp){ return sum + Math.max(0, gp) * taxRate; }, 0);
    var taxFootnote = accruedTax > 0
      ? ("For reference: your P&L's estimated taxes over the past 6 months add up to " + fmtMoney(accruedTax) + ".")
      : "This target is yours to set — it doesn't pull from the P&L.";

    grid.innerHTML =
      card({ id:"checking", name:"Checking", balance:checkingBalance, target:checkingTarget,
        targetNote: hasEnoughData ? "1 mo. avg (6mo trailing)" : "add transactions to calculate", sweepHtml:checkingSweepHtml }) +
      card({ id:"workingCapital", name:"Working Capital", balance:wcBalance, target:wcTarget,
        targetNote: hasEnoughData ? "2 mo. avg (6mo trailing)" : "add transactions to calculate", sweepHtml:wcSweepHtml }) +
      card({ id:"tax", name:"Tax", balance:taxBalance, target:wfTaxTarget, targetEditable:true,
        sweepHtml:taxSweepHtml, footnote:taxFootnote });

    wireWaterfallInputs();
  }

  async function renderAnnualView(){
    document.getElementById("biz-annualYearLabel").textContent = annualYear;
    document.getElementById("biz-annualTitle").textContent = annualYear + " P&L";
    var table = document.getElementById("biz-annualTable");
    var lookup = categoryLookup();
    var year = annualYear;
    var token = ++annualLoadToken;

    if(!dbAvailable){
      table.innerHTML = "<tbody><tr><td style=\"padding:20px; color:var(--muted-surface);\">Connect storage to see the annual rollup across saved months.</td></tr></tbody>";
      return;
    }
    table.innerHTML = "<tbody><tr><td style=\"padding:20px; color:var(--muted-surface);\">Loading…</td></tr></tbody>";

    var promises = [];
    for(var m=1;m<=12;m++){
      var mm = String(m).padStart(2,"0");
      var monthPromise;
      try{
        monthPromise = db.doc("biz-months/" + year + "-" + mm).get().then(function(snap){
          var txns = [];
          if(snap.exists){
            var data = snap.data();
            txns = (data.transactions || []).map(reviveTxn);
          }
          return computeTotals(txns, lookup);
        }).catch(function(){ return computeTotals([], lookup); });
      }catch(e){
        monthPromise = Promise.resolve(computeTotals([], lookup));
      }
      promises.push(monthPromise);
    }
    var results = await Promise.all(promises);
    if(token !== annualLoadToken) return; // a newer year/refresh started while this was loading

    var totalCols = MONTH_ABBR.length + 2;
    function td(content, cls){ return "<td class=\"" + (cls||"") + "\">" + content + "</td>"; }
    function moneyOrBlank(n){ return n ? fmtMoney(Math.abs(n)) : ""; }
    function blankSection(label){
      return "<tr class=\"section-row\"><td class=\"sticky-col\">" + esc(label) + "</td><td></td>" +
        MONTH_ABBR.map(function(){ return "<td></td>"; }).join("") + "</tr>";
    }
    function dataRow(bucketId, label){
      var any = results.some(function(r){ return r.counts[bucketId] > 0; });
      if(!any) return "";
      var rowSum = 0;
      var cells = results.map(function(r){ var v = r.totals[bucketId] || 0; rowSum += v; return td(moneyOrBlank(v), "num"); }).join("");
      return "<tr class=\"data-row\"><td class=\"sticky-col\">" + esc(label) + "</td>" + td(fmtMoney(Math.abs(rowSum)), "num total-col") + cells + "</tr>";
    }
    function withClass(rowHtml, cls){
      var m = rowHtml.match(/^<tr class="([^"]*)"/);
      if(m) return rowHtml.replace(/^<tr class="([^"]*)"/, "<tr class=\"$1 " + cls + "\"");
      return rowHtml.replace(/^<tr/, "<tr class=\"" + cls + "\"");
    }
    var blocksHtml = "";
    function addBlock(rows){
      rows = rows.filter(function(r){ return r; });
      if(!rows.length) return;
      rows[0] = withClass(rows[0], "blk-first");
      rows[rows.length-1] = withClass(rows[rows.length-1], "blk-last");
      if(blocksHtml) blocksHtml += "<tr class=\"block-gap\"><td colspan=\"" + totalCols + "\"></td></tr>";
      blocksHtml += rows.join("");
    }

    var head = "<thead><tr><th class=\"sticky-col\">Category</th><th class=\"total-col\">Total</th>" +
      MONTH_ABBR.map(function(mn){ return "<th>" + mn + "</th>"; }).join("") +
      "</tr></thead><tbody>";

    // ---- Income ----
    var hasIncome = categories.incomeSources.some(function(s){ return results.some(function(r){ return r.counts[s.id]>0; }); }) ||
      results.some(function(r){ return r.counts.otherIncome > 0; });
    if(hasIncome){
      var incomeRows = [blankSection("Income")];
      categories.incomeSources.forEach(function(s){ incomeRows.push(dataRow(s.id, s.name)); });
      incomeRows.push(dataRow("otherIncome", "Other income"));
      var incTotalSum = 0;
      var incCells = results.map(function(r){ incTotalSum += r.income; return td(fmtMoney(Math.abs(r.income)), "num"); }).join("");
      incomeRows.push("<tr class=\"total-row\"><td class=\"sticky-col\">Total income</td>" + td(fmtMoney(Math.abs(incTotalSum)), "num total-col") + incCells + "</tr>");
      addBlock(incomeRows);
    }

    // ---- Tax deductible expenses (the first category group) ----
    var deductibleGroup = categories.expenseGroups[0] || { name: "Tax deductible expenses", categories: [] };
    var deductibleByMonth = results.map(function(r){
      return deductibleGroup.categories.reduce(function(s,c){ return s + (r.totals[c.id]||0); }, 0);
    });
    var anyDeductible = deductibleGroup.categories.some(function(c){ return results.some(function(r){ return r.counts[c.id]>0; }); });

    // Estimated Gross Profit = income − tax deductible expenses (deductibleByMonth is already negative)
    var grossProfitByMonth = results.map(function(r, idx){ return r.income + deductibleByMonth[idx]; });
    var taxRate = (typeof categories.taxRate === "number" && categories.taxRate >= 0) ? categories.taxRate : 0.30;
    var estTaxByMonth = grossProfitByMonth.map(function(v){ return v * taxRate; });

    if(anyDeductible){
      var dedRows = [blankSection(deductibleGroup.name)];
      deductibleGroup.categories.forEach(function(c){ dedRows.push(dataRow(c.id, c.name)); });
      var dedTotalSum = 0;
      var dedCells = deductibleByMonth.map(function(v){ dedTotalSum += v; return td(fmtMoney(Math.abs(v)), "num"); }).join("");
      dedRows.push("<tr class=\"total-row\"><td class=\"sticky-col\">Total " + esc(deductibleGroup.name.toLowerCase()) + "</td>" + td(fmtMoney(Math.abs(dedTotalSum)), "num total-col") + dedCells + "</tr>");

      var gpSum = 0;
      var gpCells = grossProfitByMonth.map(function(v){ gpSum += v; return td(fmtMoney(v), "num"); }).join("");
      dedRows.push("<tr class=\"subtotal-row\"><td class=\"sticky-col\">Estimated Gross Profit</td>" + td(fmtMoney(gpSum), "num total-col") + gpCells + "</tr>");

      var taxSum = 0;
      var taxCells = estTaxByMonth.map(function(v){ taxSum += v; return td(fmtMoney(v), "num"); }).join("");
      var rateLabel = "Estimated taxes (<input type=\"text\" inputmode=\"decimal\" class=\"rate-input\" id=\"biz-taxRateInput\" value=\"" + (Math.round(taxRate*1000)/10) + "\">%)";
      dedRows.push("<tr class=\"subtotal-row\"><td class=\"sticky-col\">" + rateLabel + "</td>" + td(fmtMoney(taxSum), "num total-col") + taxCells + "</tr>");

      addBlock(dedRows);
    }

    // ---- Non-tax deductible expenses (the second category group) ----
    var nonDedGroup = categories.expenseGroups[1] || { name: "Non-tax deductible expenses", categories: [] };
    var nonDedByMonth = results.map(function(r){
      return nonDedGroup.categories.reduce(function(s,c){ return s + (r.totals[c.id]||0); }, 0);
    });
    var anyNonDed = nonDedGroup.categories.some(function(c){ return results.some(function(r){ return r.counts[c.id]>0; }); });

    // Total cash out = tax deductible + non-tax deductible + estimated taxes (all as outflow magnitudes)
    var cashOutByMonth = results.map(function(r, idx){
      return Math.abs(deductibleByMonth[idx]) + Math.abs(nonDedByMonth[idx]) + estTaxByMonth[idx];
    });
    var cashLeftByMonth = results.map(function(r, idx){ return r.income - cashOutByMonth[idx]; });

    if(anyNonDed){
      var nonDedRows = [blankSection(nonDedGroup.name)];
      nonDedGroup.categories.forEach(function(c){ nonDedRows.push(dataRow(c.id, c.name)); });
      var nonDedTotalSum = 0;
      var nonDedCells = nonDedByMonth.map(function(v){ nonDedTotalSum += v; return td(fmtMoney(Math.abs(v)), "num"); }).join("");
      nonDedRows.push("<tr class=\"total-row\"><td class=\"sticky-col\">Total " + esc(nonDedGroup.name.toLowerCase()) + "</td>" + td(fmtMoney(Math.abs(nonDedTotalSum)), "num total-col") + nonDedCells + "</tr>");

      var cashOutSum = 0;
      var cashOutCells = cashOutByMonth.map(function(v){ cashOutSum += v; return td(fmtMoney(v), "num"); }).join("");
      nonDedRows.push("<tr class=\"subtotal-row\"><td class=\"sticky-col\">Total cash out</td>" + td(fmtMoney(cashOutSum), "num total-col") + cashOutCells + "</tr>");

      var cashLeftSum = 0;
      var cashLeftCells = cashLeftByMonth.map(function(v){ cashLeftSum += v; return td(fmtMoney(v), "num"); }).join("");
      nonDedRows.push("<tr class=\"subtotal-row\"><td class=\"sticky-col\">Total cash left</td>" + td(fmtMoney(cashLeftSum), "num total-col") + cashLeftCells + "</tr>");

      addBlock(nonDedRows);
    }

    table.innerHTML = head + blocksHtml + "</tbody>";

    var rateInput = document.getElementById("biz-taxRateInput");
    if(rateInput){
      rateInput.addEventListener("click", function(e){ e.stopPropagation(); });
      rateInput.addEventListener("change", function(){
        var v = parseFloat(rateInput.value);
        if(isNaN(v) || v < 0) v = 0;
        if(v > 100) v = 100;
        categories.taxRate = v / 100;
        saveCategoriesNow();
        renderAnnualView();
      });
    }
  }

  window.__bizRenderAnnualView = renderAnnualView;
  window.__bizRenderWaterfall = renderWaterfall;

  initDb();
})();
