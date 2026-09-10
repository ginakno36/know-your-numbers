// Know Your Numbers — app shell: mode + section chrome, sync status
// Extracted from the original single-file index.html; behaviour unchanged.
(function(){
  var db = null, dbAvailable = null;
  var currentMode = "business";
  var currentSection = "transactions";

  function setSyncStatus(state, label){
    var el = document.getElementById("syncStatus");
    el.className = "sync-status " + state;
    document.getElementById("syncLabel").textContent = label;
  }

  function maybeRenderBizAnnual(){
    if(currentMode === "business" && currentSection === "annual" && window.__bizRenderAnnualView){
      window.__bizRenderAnnualView();
    }
  }
  function maybeRenderBizWaterfall(){
    if(currentMode === "business" && currentSection === "waterfall" && window.__bizRenderWaterfall){
      window.__bizRenderWaterfall();
    }
  }

  function applyMode(mode){
    currentMode = mode;
    document.documentElement.setAttribute("data-mode", mode);
    // Mode is shown by the toggle itself; no separate label to update.
    document.querySelectorAll(".mode-btn").forEach(function(btn){
      btn.classList.toggle("active", btn.getAttribute("data-mode") === mode);
    });
    document.querySelectorAll(".mode-panel").forEach(function(panel){
      panel.hidden = !(panel.getAttribute("data-mode") === mode && panel.getAttribute("data-section") === currentSection);
    });
    maybeRenderBizAnnual();
    maybeRenderBizWaterfall();
  }
  function applySection(section){
    currentSection = section;
    document.querySelectorAll(".section-tab").forEach(function(btn){
      btn.classList.toggle("active", btn.getAttribute("data-section") === section);
    });
    document.querySelectorAll(".mode-panel").forEach(function(panel){
      panel.hidden = !(panel.getAttribute("data-mode") === currentMode && panel.getAttribute("data-section") === section);
    });
    maybeRenderBizAnnual();
    maybeRenderBizWaterfall();
  }

  document.querySelectorAll(".mode-btn").forEach(function(btn){
    btn.addEventListener("click", function(){
      applyMode(btn.getAttribute("data-mode"));
      persistPrefs();
    });
  });
  document.querySelectorAll(".section-tab").forEach(function(btn){
    btn.addEventListener("click", function(){
      applySection(btn.getAttribute("data-section"));
    });
  });

  applyMode(currentMode);

  async function persistPrefs(){
    if(!dbAvailable) return;
    try{ await db.doc("settings/prefs").set({ mode: currentMode }); }catch(e){ /* non-critical */ }
  }

  async function initDb(){
    try{
      db = window.__kynDb();
    }catch(e){ db = null; }
    dbAvailable = !!db;
    if(!dbAvailable){
      setSyncStatus("offline", "Not saving (this tab only)");
      return;
    }
    setSyncStatus("saved", "Saved");
    try{
      var snap = await db.doc("settings/prefs").get();
      if(snap.exists){
        var data = snap.data();
        if(data && (data.mode === "business" || data.mode === "personal")) applyMode(data.mode);
      }
    }catch(e){ /* best-effort */ }
  }
  initDb();
})();
