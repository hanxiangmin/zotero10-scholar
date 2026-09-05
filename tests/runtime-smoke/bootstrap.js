/* Development-only integration harness. This file must never be in the product XPI. */
"use strict";

var smokeTimer = null;
var smokeStopping = false;
var smokeConfig = null;
var smokeContext = null;
var smokeReport = null;
var smokeReportQueue = Promise.resolve();
var smokePreviews = new Set();
var smokeAutoCloseAttempted = false;
const SMOKE_ID = "zotero10-scholar-runtime-smoke@local";
const PRODUCT_ID = "zotero10-scholar@local";
const MARKER_KIND = "zotero10-scholar-isolated-smoke-v1";
const MARKER_NAME = "SCHOLAR_SMOKE_TEST_ONLY.json";
const REPORT_NAME = "runtime-report.json";

function install() {}
function uninstall() {}
function onMainWindowLoad() {}
function onMainWindowUnload() {}

function startup({ id, rootURI }) {
  if (id !== SMOKE_ID) return;
  // Do not await other add-ons inside startup: Zotero starts add-ons serially.
  smokeTimer = setTimeout(() => {
    smokeTimer = null;
    runSmoke(rootURI).catch(async error => {
      Zotero.logError(error);
      if (smokeContext && smokeReport && !smokeStopping) {
        await completeSmoke(error).catch(e => Zotero.logError(e));
      }
      // With no trusted context, only log. Never write a report into another library.
    });
  }, 1200);
}

function shutdown() {
  smokeStopping = true;
  if (smokeTimer !== null) clearTimeout(smokeTimer);
  smokeTimer = null;
  // Do not close Zotero, erase fixtures, or wait for tests during app shutdown.
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function same(actual, expected, label) {
  const canonicalize = value => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])) : value;
  check(JSON.stringify(canonicalize(actual)) === JSON.stringify(canonicalize(expected)),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function errorInfo(error) {
  return { message: String(error?.message || error), stack: String(error?.stack || "").slice(0, 10000) };
}

function canonical(path) {
  check(typeof path === "string" && PathUtils.isAbsolute(path), "Smoke path must be absolute");
  const file = Zotero.File.pathToFile(path);
  file.normalize(); // nsIFile canonicalization also resolves filesystem indirection.
  let result = file.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return Zotero.isWin ? result.toLowerCase() : result;
}

async function verifyIsolation(config) {
  check(!smokeStopping, "Smoke test was stopped");
  check(config?.schemaVersion === 1 && config.markerKind === MARKER_KIND, "Invalid smoke configuration");
  check(typeof config.withData === "boolean" && typeof config.autoClose === "boolean", "Missing explicit smoke mode/auto-close settings");
  check(config.productID === PRODUCT_ID && config.testID === SMOKE_ID, "Unexpected add-on IDs");
  check(config.markerName === MARKER_NAME && config.reportName === REPORT_NAME, "Unexpected report/marker filename");
  check(/^[a-f0-9]{64}$/.test(config.token), "Missing random smoke token");
  const project = canonical(config.projectDir);
  const session = canonical(config.sessionDir);
  const data = canonical(Zotero.DataDirectory.dir);
  const profile = canonical(Zotero.Profile.dir);
  const relative = session.slice(project.length + 1);
  check(session.startsWith(project + "/") && /^work\/smoke-\d{8}t\d{6}z-[a-f0-9]{12}$/i.test(relative),
    "Session must be an immediate project work/smoke-* directory");
  check(data === session + "/data" && data === canonical(config.dataDir), "Refusing to touch a non-smoke data directory");
  check(profile === session + "/profile" && profile === canonical(config.profileDir), "Refusing to touch a non-smoke profile");
  check(Zotero.Prefs.get("useDataDir") === true, "Custom isolated data directory is not enabled");
  check(canonical(Zotero.Prefs.get("dataDir")) === data, "Data-directory preference differs from the active directory");
  check(Zotero.Prefs.get("sync.autoSync") === false, "Automatic sync must be disabled in the smoke profile");
  check(Zotero.Prefs.get("httpServer.enabled") === false, "Local HTTP server must be disabled in the smoke profile");
  const markerPath = PathUtils.join(Zotero.DataDirectory.dir, MARKER_NAME);
  check(await IOUtils.exists(markerPath), "No isolated-test marker: refusing all test writes");
  const canonicalMarkerName = Zotero.isWin ? MARKER_NAME.toLowerCase() : MARKER_NAME;
  check(canonical(markerPath) === data + "/" + canonicalMarkerName, "Smoke marker redirects outside the test data directory");
  const marker = await IOUtils.readJSON(markerPath);
  check(marker.markerKind === MARKER_KIND && marker.token === config.token, "Smoke marker token mismatch");
  check(marker.withData === config.withData && marker.autoClose === config.autoClose,
    "Smoke mode/auto-close settings differ from the trusted marker");
  for (const field of ["projectDir", "sessionDir", "dataDir", "profileDir"]) {
    check(canonical(marker[field]) === canonical(config[field]), "Smoke marker path mismatch: " + field);
  }
  return { projectDir: project, sessionDir: session, dataDir: data, profileDir: profile,
    reportPath: PathUtils.join(Zotero.DataDirectory.dir, REPORT_NAME) };
}

async function guard() {
  const current = await verifyIsolation(smokeConfig);
  check(!smokeContext || current.dataDir === smokeContext.dataDir, "Smoke data directory changed while running");
  return current;
}

async function persistReport() {
  if (!smokeReport || !smokeContext) return;
  const payload = JSON.parse(JSON.stringify(smokeReport));
  smokeReportQueue = smokeReportQueue.then(async () => {
    const context = await guard();
    await IOUtils.writeJSON(context.reportPath, payload, { tmpPath: context.reportPath + ".tmp" });
  });
  return smokeReportQueue;
}

async function autoCloseSmoke() {
  if (!smokeConfig.autoClose || smokeAutoCloseAttempted || smokeStopping) return;
  smokeAutoCloseAttempted = true;
  // The completed report is already on disk. Revalidate the live profile/data
  // and random marker before closing only dialogs created by this harness.
  await guard();
  let closedPreviews = 0;
  for (const dialog of smokePreviews) {
    if (!dialog.closed) {
      dialog.close();
      closedPreviews++;
    }
  }
  smokeReport.autoClose = {
    enabled: true, closedPreviews, quitMethod: "eAttemptQuit",
    quitIntentRecordedAt: new Date().toISOString()
  };
  // Record intent, not a claim that exit succeeded: a normal quit can be vetoed.
  await persistReport();
  await guard();
  Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
}

async function completeSmoke(error = null) {
  if (error) smokeReport.fatalError = errorInfo(error);
  smokeReport.status = smokeReport.fatalError || smokeReport.steps.some(entry => entry.status !== "passed") ? "failed" : "passed";
  smokeReport.completedAt = new Date().toISOString();
  smokeReport.summary = {
    total: smokeReport.steps.length,
    passed: smokeReport.steps.filter(entry => entry.status === "passed").length,
    failed: smokeReport.steps.filter(entry => entry.status === "failed").length
  };
  await persistReport();
  Zotero.debug(`Scholar runtime smoke test ${smokeReport.status}: ${smokeContext.reportPath}`);
  await autoCloseSmoke();
}

async function waitFor(label, predicate, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    check(!smokeStopping, "Stopped while waiting for " + label);
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for " + label);
}

async function step(name, action, fatal = false) {
  await guard();
  const entry = { name, status: "running", startedAt: new Date().toISOString() };
  smokeReport.steps.push(entry);
  await persistReport();
  try {
    entry.details = await action();
    entry.status = "passed";
  } catch (error) {
    entry.status = "failed";
    entry.error = errorInfo(error);
    Zotero.logError(error);
    if (fatal) throw error;
  } finally {
    entry.completedAt = new Date().toISOString();
    await persistReport();
  }
  return entry;
}

async function menuState(win, items, refresh = true) {
  // Close prior synthetic popups, just as a real context-menu interaction does.
  // Zotero retires command handlers on popuphidden, then in an idle callback.
  for (const id of ["zotero-itemmenu", "menu_ToolsPopup"]) {
    const popup = win.document.getElementById(id);
    for (const nested of popup?.querySelectorAll("menupopup") || []) nested.dispatchEvent(new win.Event("popuphidden", { bubbles: true }));
    popup?.dispatchEvent(new win.Event("popuphidden", { bubbles: true }));
  }
  await new Promise(resolve => win.requestIdleCallback(resolve, { timeout: 1000 }));
  const targets = [["main/library/item", "zotero-itemmenu"], ["main/menubar/tools", "menu_ToolsPopup"]];
  const registrations = [];
  for (const [target, popupID] of targets) {
    // Zotero 10 exposes no public enumeration API. Read the implementation's
    // registrations, but create/refresh menu DOM through its public API.
    const options = Zotero.MenuManager._menuManager.getCustomMenuOptions(target);
    registrations.push(...options.filter(option => option.pluginID === PRODUCT_ID)
      .map(option => ({ target: option.target, menuID: option.menuID })));
    if (refresh) {
      const popup = win.document.getElementById(popupID);
      check(popup, "Missing Zotero menu popup " + popupID);
      Zotero.MenuManager.updateMenuPopup(popup, target, {
        getContext: () => ({ items, libraryID: Zotero.Libraries.userLibraryID }), tabType: "library"
      });
    }
  }
  // Nested commands are built lazily when the submenu opens, not when the
  // parent library popup is refreshed.
  if (refresh) {
    const submenu = win.document.querySelector('[data-l10n-id="zsr10-menu"] menupopup');
    submenu?.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
  }
  return {
    registrations,
    itemNodes: win.document.querySelectorAll('[data-l10n-id="zsr10-menu"]').length,
    toolNodes: win.document.querySelectorAll('[data-l10n-id="zsr10-settings"]').length
  };
}

function invokeMenu(win, id) {
  const node = win.document.querySelector(`[data-l10n-id="${id}"]`);
  check(node && !node.disabled, "Missing or disabled command: " + id);
  // doCommand() requires an actually open native popup. Dispatch the same
  // command event to the real DOM listener in this hidden integration run.
  node.dispatchEvent(new win.Event("command", { bubbles: true }));
}

function syntheticVenues() {
  const suffix = smokeConfig.token.slice(0, 12);
  return {
    journal: "Fictional Journal of Scholar Smoke Tests " + suffix,
    conference: "Fictional Scholar Smoke Conference " + suffix
  };
}

function syntheticDatasets() {
  const venues = syntheticVenues();
  const source = "SYNTHETIC ISOLATED SMOKE TEST ONLY — fictional venues and invented metrics, not scientific ranking data";
  const common = { schemaVersion: 1, source, synthetic: true };
  return [
    { ...common, kind: "ccf", edition: "2026-test", records: [
      { title: venues.journal, type: "journal", rank: "C", aliases: [], issns: [] },
      { title: venues.conference, type: "conference", rank: "B", aliases: [], issns: [] }
    ] },
    { ...common, kind: "jcr", edition: 2026, metricYear: 2025, records: [
      { title: venues.journal, aliases: [], issns: [], jif: 2.5, quartiles: [{ category: "Fictional test category", quartile: "Q2" }] }
    ] },
    { ...common, kind: "cas", edition: 2025, system: "CAS", categoryLevel: "major", records: [
      { title: venues.journal, aliases: [], issns: [], division: 3, top: false }
    ] }
  ];
}

async function runSmoke(rootURI) {
  await Zotero.initializationPromise;
  smokeConfig = JSON.parse(await Zotero.File.getResourceAsync(rootURI + "smoke-config.json"));
  smokeContext = await verifyIsolation(smokeConfig);
  if (await IOUtils.exists(smokeContext.reportPath)) {
    Zotero.debug("Scholar smoke report already exists; prepare a fresh profile to run again.");
    return;
  }
  smokeReport = {
    schemaVersion: 1, status: "running", startedAt: new Date().toISOString(),
    zoteroVersion: Zotero.version, safety: smokeContext,
    product: { id: PRODUCT_ID, version: smokeConfig.productVersion, stagedSha256: smokeConfig.productSha256 },
    withData: smokeConfig.withData, mode: smokeConfig.withData ? "personal-data" : "public-no-data",
    autoClose: { enabled: smokeConfig.autoClose }, fixtures: {}, steps: [], previewReady: false
  };
  await persistReport();
  let plugin, win, productAddon, collection;
  const fixtures = {};
  const allItems = () => Object.values(fixtures);
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

  await step("product-startup-and-data", async () => {
    plugin = await waitFor("ScholarRank10 catalog", () => Zotero.ScholarRank10?.catalog && Zotero.ScholarRank10);
    await waitFor("product menu and preference registration", () => plugin.menuIDs?.length === 2 && plugin.prefID);
    win = await waitFor("Zotero library window", () => {
      const window = Zotero.getMainWindow();
      return window?.ZoteroPane?.itemsView && window.document.getElementById("zotero-itemmenu") && window;
    });
    productAddon = await AddonManager.getAddonByID(PRODUCT_ID);
    check(productAddon?.isActive, "Product add-on was not enabled by standard AddonManager");
    same(productAddon.version, smokeConfig.productVersion, "Loaded product version");
    same(plugin.catalog.list().map(data => data.kind).sort(), smokeConfig.withData ? ["cas", "ccf", "jcr"] : [], "Loaded dataset kinds");
    if (smokeConfig.withData) check(plugin.loadWarnings.length === 0, "Unexpected dataset loading warnings");
    else {
      for (const kind of ["CCF", "JCR", "CAS"]) {
        check(plugin.loadWarnings.some(warning => warning.startsWith(kind)), "Missing no-data warning for " + kind);
      }
      check(plugin.dataSummary().includes("导入"), "Empty catalog must explain how to import data");
    }
    check(plugin.pref("autoNew") === false, "Automatic updates must stay disabled for deterministic tests");
    const menus = await menuState(win, []);
    same(menus.registrations.length, 2, "Startup menu registrations");
    same([menus.itemNodes, menus.toolNodes], [1, 1], "Startup menu DOM instances");
    return { rootURI: productAddon.getResourceURI().spec, datasets: plugin.catalog.list(),
      warnings: [...plugin.loadWarnings], menuIDs: [...plugin.menuIDs], menus };
  }, true);


  const extra = "User note\r\nCitation Key: keep";
  const metadataFields = ["title", "DOI", "publicationTitle", "pages", "volume", "issue", "language", "journalAbbreviation", "date", "callNumber", "extra"];
  const snapshot = async item => {
    await item.reload(null, true);
    return { ...Object.fromEntries(metadataFields.map(field => [field, String(item.getField(field) || "")])), creators: item.getCreatorsJSON() };
  };
  const create = async fields => {
    await guard();
    const item = new Zotero.Item("journalArticle"); item.libraryID = Zotero.Libraries.userLibraryID;
    for (const [name,value] of Object.entries(fields)) item.setField(name,value);
    await item.saveTx({skipSelect:true}); return item;
  };
  const alerts = [], originalAlert = plugin.alert;
  plugin.alert = message => alerts.push(message); // informational result dialogs only
  await step("load-catalog-and-create-test-items", async () => {
    if (!smokeConfig.withData) {
      const empty = await create({title:"No-data protection",callNumber:"C",extra});
      const result = await plugin.apply([empty],{silent:true}); same(result["no-data"],1,"No data leaves existing fields");
      same(empty.getField("callNumber"),"C","No data does not clear rank");
      await IOUtils.makeDirectory(plugin.storageDir,{ignoreExisting:true});
      for (const data of syntheticDatasets()) {
        await IOUtils.writeJSON(PathUtils.join(plugin.storageDir,data.kind+".json"),data);
        plugin.catalog.replace(data);
      }
    }
    const venue = smokeConfig.withData ? "IEEE Transactions on Pattern Analysis and Machine Intelligence" : syntheticVenues().journal;
    fixtures.journal = await create({title:"  A fictional study of  BRCA1 and p53",DOI:"doi:10.12345/cleanup-test",publicationTitle:venue,volume:"002",pages:"S10 - S19",callNumber:"Old manual value",extra});
    fixtures.unknown = await create({title:"An unmatched fixture",publicationTitle:"Fictional Unlisted Journal",callNumber:"Keep",extra});
    fixtures.conference = new Zotero.Item("conferencePaper"); fixtures.conference.libraryID = Zotero.Libraries.userLibraryID;
    fixtures.conference.setField("title", "Fictional conference fixture");
    fixtures.conference.setField("conferenceName", smokeConfig.withData ? "CVPR" : syntheticVenues().conference);
    fixtures.conference.setField("proceedingsTitle", smokeConfig.withData ? "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition" : "Proceedings of " + syntheticVenues().conference);
    fixtures.conference.setField("extra",extra); await fixtures.conference.saveTx({skipSelect:true});
    return {fixtureIDs:allItems().map(item=>item.id),scientificData:smokeConfig.withData};
  },true);

  await step("exactly-three-menu-actions-and-direct-metadata-cleanup", async () => {
    await win.ZoteroPane.selectItems([fixtures.journal.id]); await menuState(win,[fixtures.journal]);
    const node=win.document.querySelector('[data-l10n-id="zsr10-menu"]');
    const ids=Array.from(node.querySelectorAll("menuitem"),item=>item.getAttribute("data-l10n-id"));
    same(ids,["zsr10-metadata","zsr10-doi","zsr10-update"],"Only three item commands");
    invokeMenu(win,"zsr10-metadata");
    await waitFor("direct metadata update",()=>!plugin.busy && fixtures.journal.getField("DOI")==="10.12345/cleanup-test",12000);
    const value=await snapshot(fixtures.journal);
    same(value.title,"A fictional study of BRCA1 and p53","Conservative cleanup");
    same(value.volume,"2","Volume cleanup"); same(value.pages,"S10–S19","Page cleanup");
    same(value.callNumber,"Old manual value","Metadata does not also update rank"); same(value.extra,extra,"No Extra writes");
    return {menuIDs:ids,viaMenuDOM:true};
  });

  await step("direct-rank-overwrite-native-undo-and-redo", async () => {
    const before=await snapshot(fixtures.journal); Zotero.UndoHistory.clear();
    await menuState(win,[fixtures.journal]);
    invokeMenu(win,"zsr10-update");
    await waitFor("direct rank update",()=>!plugin.busy && fixtures.journal.getField("callNumber")===smokeConfig.expectedJournal,12000);
    const after=await snapshot(fixtures.journal); same(after.extra,extra,"Rank never adds backup records");
    same(await Zotero.UndoHistory.undo(),true,"Native undo"); same(await snapshot(fixtures.journal),before,"Undo rank only");
    same(await Zotero.UndoHistory.redo(),true,"Native redo"); same(await snapshot(fixtures.journal),after,"Redo rank only");
    same((await plugin.apply([fixtures.journal],{silent:true})).unchanged,1,"Idempotent update");
    same((await plugin.apply([fixtures.unknown],{silent:true}))["no-data"],1,"Unknown venue does not clear values");
    same((await plugin.apply([fixtures.conference],{silent:true})).written,1,"Conference update");
    same(fixtures.conference.getField("callNumber"),smokeConfig.expectedConference,"Conference only has CCF rank");
    same(fixtures.conference.getField("extra"),extra,"Conference Extra unchanged");
    return {rank:after.callNumber,viaMenuDOM:true,undoRedo:true};
  });

  await step("settings-three-buttons-and-independent-automatic-controls", async () => {
    plugin.showSettings();
    const preferences=await waitFor("new settings",()=>{
      const windows=Services.wm.getEnumerator(null);
      while(windows.hasMoreElements()) { const candidate=windows.getNext(); if(candidate.document?.getElementById("zsr10-doi")) return candidate; }
    },12000);
    smokePreviews.add(preferences);
    const doc=preferences.document;
    for(const id of ["zsr10-metadata","zsr10-doi","zsr10-ranks"]) check(doc.getElementById(id),"Missing management action "+id);
    check(!doc.getElementById("zsr10-restore-manual") && !doc.getElementById("zsr10-manual"),"Retired controls removed");
    same(doc.querySelectorAll("#zsr10-metadata-rules input").length,7,"Individual rule switches");
    doc.getElementById("zsr10-auto-new").click(); doc.getElementById("zsr10-metadata-auto").click();
    same(plugin.pref("autoNew"),true,"Auto ranks saved"); same(plugin.pref("metadata.auto"),true,"Auto cleanup saved");
    check(doc.getElementById("zsr10-auto-status").textContent.includes("自动整理 → 自动更新分区指标"),"Combined status");
    doc.getElementById("zsr10-auto-new").click(); doc.getElementById("zsr10-metadata-auto").click();
    fixtures.journal.setField("callNumber","Another manual value"); await fixtures.journal.saveTx({skipSelect:true});
    await win.ZoteroPane.selectItems([fixtures.journal.id]); doc.getElementById("zsr10-ranks").click();
    await waitFor("settings updates main-window selection",()=>!plugin.busy && fixtures.journal.getField("callNumber")===smokeConfig.expectedJournal,12000);
    preferences.close(); return {threeActions:true,toggles:true,selectionFromMainWindow:true};
  });

  await step("automatic-processing-is-offline-and-preserves-existing-call-number", async () => {
    const lookup=plugin.lookupDOI; let lookups=0; plugin.lookupDOI=async()=>{lookups++;throw new Error("Auto mode must not query DOI");};
    plugin.setPref("metadata.auto",true);plugin.setPref("autoNew",true);
    try {
      const record=await create({title:"A fictional automatic study of cells",DOI:"doi:10.12345/automatic-test",publicationTitle:fixtures.journal.getField("publicationTitle"),callNumber:"Auto must keep",extra});
      await waitFor("automatic cleanup",()=>!plugin.busy && record.getField("DOI")==="10.12345/automatic-test",12000); await plugin.pendingAuto;
      same(record.getField("callNumber"),"Auto must keep","Keep existing rank in automatic mode"); same(record.getField("extra"),extra,"Auto does not write Extra"); same(lookups,0,"No DOI network call");
      return {networkCalls:lookups,extraUntouched:true};
    } finally {plugin.setPref("metadata.auto",false);plugin.setPref("autoNew",false);plugin.lookupDOI=lookup;}
  });

  await step("DOI-command-direct-overwrite-preserves-unrelated-data-and-supports-undo", async () => {
    const record=await create({title:"Old bibliographic title",DOI:"10.12345/manual-test",publicationTitle:"Old Journal",pages:"Keep pages",callNumber:"Keep metrics",extra});
    record.setCreators([{creatorType:"author",name:"Old Group"}]); await record.saveTx({skipSelect:true});
    const before=await snapshot(record), lookup=plugin.lookupDOI;
    const source={itemType:"journalArticle",DOI:"10.12345/manual-test",title:"Returned DOI title",publicationTitle:"Returned Journal",date:"2026",creators:[{creatorType:"author",firstName:"First",lastName:"Author"}],extra:"Do not import",tags:["Do not import"],attachments:[{}],callNumber:"Do not import"};
    plugin.lookupDOI=async()=>[source];
    try {
      Zotero.UndoHistory.clear(); await win.ZoteroPane.selectItems([record.id]);await menuState(win,[record]);
      invokeMenu(win,"zsr10-doi");
      await waitFor("DOI overwrite from command",()=>!plugin.busy && record.getField("title")===source.title,12000);
      const after=await snapshot(record); same(after.creators,source.creators,"Native creator update");
      same(after.callNumber,before.callNumber,"DOI does not update metrics");same(after.pages,before.pages,"Missing fields not erased");same(after.extra,before.extra,"Extra unchanged");
      same(record.getTags().length,0,"No imported tags");same(record.numAttachments(),0,"No downloaded attachments");
      same(await Zotero.UndoHistory.undo(),true,"DOI undo");same(await snapshot(record),before,"Undo authors and all fields");
      same(await Zotero.UndoHistory.redo(),true,"DOI redo");same(await snapshot(record),after,"Redo authors and all fields");
      return {viaMenuDOM:true,lookupStubbed:true,undoRedo:true};
    } finally {plugin.lookupDOI=lookup;}
  });

  await step("live-native-DOI-updates-existing-item-without-creating-duplicates", async () => {
    const record=await create({title:"Replace this title from DOI",DOI:"10.1038/nature14539",callNumber:"Keep metrics",extra});
    const before=(await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).length;
    const counts=await plugin.updateByDOI([record],{silent:true});
    same(counts.written,1,"Successful live DOI write");
    const result=await snapshot(record);
    same(result.DOI.toLowerCase(),"10.1038/nature14539","Live DOI matches");
    same(result.title,"Deep learning","Live title returned");check(result.creators.length>0,"Live authors returned");
    same(result.callNumber,"Keep metrics","Live DOI update preserves metrics");same(result.extra,extra,"Live DOI update preserves Extra");
    same((await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).length,before,"Native search saves no items");
    return {liveNetwork:true,updatedInPlace:true,DOI:result.DOI,title:result.title,creatorCount:result.creators.length};
  });

  await step("disable-and-enable-cleanly-registers-three-commands", async () => {
    plugin.alert=originalAlert;
    await productAddon.disable(); await waitFor("plugin disabled",()=>!Zotero.ScholarRank10,12000);
    same((await menuState(win,[])).registrations.length,0,"Menus removed on disable");
    await productAddon.enable(); plugin=await waitFor("plugin re-enabled",()=>Zotero.ScholarRank10?.prefID && Zotero.ScholarRank10,12000);
    same((await menuState(win,[fixtures.journal])).registrations.length,2,"Menus registered once");
    same(win.document.querySelector('[data-l10n-id="zsr10-menu"]').querySelectorAll("menuitem").length,3,"Exactly three commands after reload");
    same(fixtures.journal.getField("extra"),extra,"Reload does not write Extra");
    return {reload:true,summaryDialogsStubbed:alerts};
  });
  await completeSmoke();
}
