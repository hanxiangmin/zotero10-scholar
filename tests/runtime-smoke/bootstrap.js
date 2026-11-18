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
    withData: smokeConfig.withData, mode: "bundled-data",
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
  plugin.alert = message => alerts.push(message); // suppress only blocking alerts; result windows stay real
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

  await step("four-menu-actions-and-direct-metadata-cleanup", async () => {
    await win.ZoteroPane.selectItems([fixtures.journal.id]); await menuState(win,[fixtures.journal]);
    const node=win.document.querySelector('[data-l10n-id="zsr10-menu"]');
    const ids=Array.from(node.querySelectorAll("menuitem"),item=>item.getAttribute("data-l10n-id"));
    same(ids,["zsr10-metadata","zsr10-doi","zsr10-update","zsr10-download"],"Four independent item commands");
    invokeMenu(win,"zsr10-metadata");
    await waitFor("direct metadata update",()=>!plugin.busy && fixtures.journal.getField("DOI")==="10.12345/cleanup-test",12000);
    const value=await snapshot(fixtures.journal);
    same(value.title,"A fictional study of BRCA1 and p53","Scientific case protection");
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

  await step("settings-four-buttons-and-independent-automatic-controls", async () => {
    plugin.showSettings();
    const preferences=await waitFor("new settings",()=>{
      const windows=Services.wm.getEnumerator(null);
      while(windows.hasMoreElements()) { const candidate=windows.getNext(); if(candidate.document?.getElementById("zsr10-doi")) return candidate; }
    },12000);
    smokePreviews.add(preferences);
    const doc=preferences.document;
    for(const id of ["zsr10-metadata","zsr10-doi","zsr10-ranks","zsr10-download","zsr10-cancel-download"]) check(doc.getElementById(id),"Missing management action "+id);
    check(!doc.getElementById("zsr10-restore-manual") && !doc.getElementById("zsr10-manual"),"Retired controls removed");
    same(doc.querySelectorAll("#zsr10-metadata-rules input").length,8,"Individual rule switches");
    same(doc.getElementById("zsr10-title-case").value,"sentence","Sentence case default");
    const titleControl=doc.getElementById("zsr10-title-case");
    titleControl.value="preserve"; titleControl.dispatchEvent(new preferences.Event("change"));
    same(plugin.pref("metadata.titleCase"),"preserve","Title preference saves");
    titleControl.value="sentence"; titleControl.dispatchEvent(new preferences.Event("change"));
    check(doc.getElementById("zsr10-protected-terms"),"Custom protected spelling control");
    same(doc.getElementById("zsr10-doi").textContent,"联网更新元数据","Online command label");
    preferences.resizeTo(1250,1600);await Zotero.Promise.delay(500);
    const first=doc.getElementById("zsr10-doi").closest("groupbox").getBoundingClientRect();
    const last=doc.getElementById("zsr10-metadata-rules").closest("groupbox").getBoundingClientRect();
    const rect=new preferences.DOMRect(first.x-10,first.y-10,first.width+20,last.bottom-first.y+20);
    const canvas=doc.createElementNS("http://www.w3.org/1999/xhtml","canvas");canvas.width=Math.ceil(rect.width*1.5);canvas.height=Math.ceil(rect.height*1.5);
    const bitmap=await preferences.browsingContext.currentWindowGlobal.drawSnapshot(rect,1.5,"rgb(255,255,255)",false);
    canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();await guard();
    const directory=PathUtils.join(smokeConfig.sessionDir,"screenshots");await IOUtils.makeDirectory(directory,{ignoreExisting:true});
    await IOUtils.write(PathUtils.join(directory,"settings-panel.png"),Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]),c=>c.charCodeAt(0)));
    doc.getElementById("zsr10-auto-new").click(); doc.getElementById("zsr10-metadata-auto").click();
    same(plugin.pref("autoNew"),true,"Auto ranks saved"); same(plugin.pref("metadata.auto"),true,"Auto cleanup saved");
    check(doc.getElementById("zsr10-auto-status").textContent.includes("自动整理 → 自动更新分区指标"),"Combined status");
    doc.getElementById("zsr10-auto-new").click(); doc.getElementById("zsr10-metadata-auto").click();
    fixtures.journal.setField("callNumber","Another manual value"); await fixtures.journal.saveTx({skipSelect:true});
    await win.ZoteroPane.selectItems([fixtures.journal.id]); doc.getElementById("zsr10-ranks").click();
    await waitFor("settings updates main-window selection",()=>!plugin.busy && fixtures.journal.getField("callNumber")===smokeConfig.expectedJournal,12000);
    preferences.close(); return {fourActions:true,toggles:true,selectionFromMainWindow:true};
  });

  await step("automatic-processing-is-offline-and-preserves-existing-call-number", async () => {
    const lookup=plugin.lookupDOI; let lookups=0; plugin.lookupDOI=async()=>{lookups++;throw new Error("Auto mode must not query DOI");};
    plugin.setPref("metadata.auto",true);plugin.setPref("autoNew",true);
    try {
      const record=await create({title:"A fictional automatic study of cells",DOI:"doi:10.12345/automatic-test",publicationTitle:fixtures.journal.getField("publicationTitle"),callNumber:"Auto must keep",extra});
      await waitFor("automatic cleanup",()=>!plugin.busy && record.getField("DOI")==="10.12345/automatic-test",12000); await plugin.pendingAuto;
      same(record.getField("callNumber"),"Auto must keep","Keep existing rank in automatic mode"); same(record.getField("extra"),extra,"Auto does not write Extra"); same(lookups,0,"No DOI network call");
      if(smokeConfig.withData) {
        const meeting=new Zotero.Item("conferencePaper");meeting.libraryID=Zotero.Libraries.userLibraryID;
        meeting.setField("title","Fictional Meeting Test: a Study of fMRI");
        meeting.setField("conferenceName","MICCAI");meeting.setField("proceedingsTitle","Medical Image Computing and Computer Assisted Intervention – MICCAI-2005");
        meeting.setField("date","2025");meeting.setField("callNumber","Auto must keep");await meeting.saveTx({skipSelect:true});
        const standard="International Conference on Medical Image Computing and Computer-Assisted Intervention";
        await waitFor("automatic conference standardization",()=>!plugin.busy && meeting.getField("conferenceName")===standard,12000);await plugin.pendingAuto;
        same(meeting.getField("proceedingsTitle"),"Medical Image Computing and Computer Assisted Intervention – MICCAI-2005","Historical proceedings title retained");
        same(meeting.getField("date"),"2025","Name cleanup never infers date from 2005 suffix");
        same(meeting.getField("title"),"Fictional meeting test: A study of fMRI","Automatic subtitle capitalization");
        same(meeting.getField("callNumber"),"Auto must keep","Name cleanup respects rank automatic boundary");
        same(lookups,0,"Conference cleanup remains offline");
      }
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

  await step("native-before-after-results-window-and-safe-rendering", async () => {
    await guard();
    const record=new Zotero.Item("conferencePaper");record.libraryID=Zotero.Libraries.userLibraryID;
    const fields={title:"Fictional Hypergraph Study: a Model for fMRI",DOI:"10.12345/result-dialog",date:"2026",
      conferenceName:"MICCAI",proceedingsTitle:"Medical Image Computing and Computer Assisted Intervention – MICCAI-2025",callNumber:"B",extra};
    for(const [field,value] of Object.entries(fields))record.setField(field,value);
    await record.saveTx({skipSelect:true});
    const lookup=plugin.lookupDOI, previous=new Set(plugin.resultWindows);
    plugin.lookupDOI=async()=>[{...fields,itemType:"conferencePaper",title:fields.title,
      scholarCrossref:{DOI:fields.DOI,title:[fields.title],type:"proceedings-article",event:{start:{"date-parts":[[2025,9,23]]}}}}];
    try { same((await plugin.updateByDOI([record],{win})).written,1,"Dialog fixture saved"); } finally {plugin.lookupDOI=lookup;}
    same(record.getField("date"),"2025","Dialog fixture date saved");
    let dialog;
    try { dialog=await waitFor("native result table",()=>[...plugin.resultWindows].find(candidate=>!previous.has(candidate)&&candidate.document?.querySelector("tbody tr")),12000); }
    catch(error) { throw new Error(error.message+"; windows="+JSON.stringify([...plugin.resultWindows].map(candidate=>({previous:previous.has(candidate),closed:candidate.closed,url:candidate.location?.href,text:candidate.document?.documentElement?.textContent?.slice(-8000)})))); }
    smokePreviews.add(dialog);
    const doc=dialog.document, rows=Array.from(doc.querySelectorAll("tbody tr"));
    const values=field=>Array.from(doc.querySelectorAll(`tr[data-field="${field}"] td`),cell=>cell.textContent);
    same(values("date"),["日期","2026","2025"],"Saved date before/after");
    same(values("title"),["标题",fields.title,"Fictional hypergraph study: A model for fMRI"],"Title before/after");
    check(rows.every(row=>!["extra","callNumber"].includes(row.dataset.field)),"Unchanged and protected fields omitted");
    same(Array.from(doc.querySelectorAll("thead th"),cell=>cell.textContent),["字段","修改前","修改后"],"Three comparison columns");
    dialog.resizeTo(1020,760); await Zotero.Promise.delay(500);
    const directory=PathUtils.join(smokeConfig.sessionDir,"screenshots");
    await IOUtils.makeDirectory(directory,{ignoreExisting:true});
    const rect=new dialog.DOMRect(0,0,dialog.innerWidth,dialog.innerHeight);
    const canvas=doc.createElementNS("http://www.w3.org/1999/xhtml","canvas");canvas.width=Math.ceil(rect.width*1.5);canvas.height=Math.ceil(rect.height*1.5);
    const bitmap=await dialog.browsingContext.currentWindowGlobal.drawSnapshot(rect,1.5,"rgb(255,255,255)",false);
    canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();await guard();
    const screenshot=PathUtils.join(directory,"update-results.png");
    await IOUtils.write(screenshot,Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]),c=>c.charCodeAt(0)));
    doc.getElementById("zsr10-results-close").click();await waitFor("result close button",()=>dialog.closed,5000);

    // Render malicious-looking metadata literally, including long abstracts.
    const markup='<img src="x" onerror="window.__scholarInjected=true">';
    plugin.showResult({written:1},win,[{title:markup,changes:[{field:"abstractNote",label:"摘要",before:"",after:markup.repeat(200)}]}],{operation:"渲染安全测试"});
    const safe=await waitFor("safe metadata rendering",()=>[...plugin.resultWindows].find(candidate=>!previous.has(candidate)&&candidate.document?.querySelector('tr[data-field="abstractNote"]')),12000);
    smokePreviews.add(safe);
    same(safe.document.querySelector("tbody tr td.after").textContent,markup.repeat(200),"No truncation or HTML interpretation");
    same(safe.document.querySelectorAll("img, iframe").length,0,"No nodes created from metadata");
    check(!safe.__scholarInjected,"No script from metadata executed");
    check(safe.document.getElementById("zsr10-results-list").scrollHeight>safe.document.getElementById("zsr10-results-list").clientHeight,"Long values remain scrollable");
    safe.dispatchEvent(new safe.KeyboardEvent("keydown",{key:"Escape"}));await waitFor("escape closes result",()=>safe.closed,5000);
    return {realWindow:true,columns:3,changedFields:rows.map(row=>row.dataset.field),safePlainText:true,screenshot};
  });

  await step("native-automatic-result-window-appends-batches", async () => {
    const first=await create({title:"Fictional automatic report one",publicationTitle:fixtures.journal.getField("publicationTitle"),extra});
    const second=await create({title:"Fictional automatic report two",publicationTitle:fixtures.journal.getField("publicationTitle"),extra});
    if(plugin.autoResult?.win&&!plugin.autoResult.win.closed)plugin.autoResult.win.close();
    plugin.setPref("autoNew",true);
    try {
      await plugin.apply([first],{automatic:true,silent:true,win});
      const dialog=plugin.autoResult.win;smokePreviews.add(dialog);
      await waitFor("automatic result first batch",()=>dialog.document?.querySelectorAll(".batch").length===1,12000);
      await plugin.apply([second],{automatic:true,silent:true,win});
      check(plugin.autoResult.win===dialog,"Automatic batches share one native window");
      await waitFor("automatic result appended batch",()=>dialog.document.querySelectorAll(".batch").length===2,12000);
      same(dialog.document.querySelectorAll('tr[data-field="callNumber"]').length,2,"Both committed ranks shown");
      await plugin.apply([second],{automatic:true,silent:true,win});
      await waitFor("automatic empty report",()=>dialog.document.querySelectorAll(".batch").length===3,12000);
      check(dialog.document.querySelector(".batch:last-child").textContent.includes("本次没有修改任何字段"),"No change is explicit");
      dialog.close();return {realWindow:true,batches:3,windows:1};
    } finally {plugin.setPref("autoNew",false);}
  });

  await step("native-library-audit-scope-loads-every-collection-without-children", async () => {
    const items = await plugin.allPaperItems();
    check(items.length >= 3,"Library scope includes fixtures");
    check(items.every(item=>item.isRegularItem() && !item.deleted),"Only regular non-deleted items");
    same(new Set(items.map(item=>item.id)).size,items.length,"One entry per item across collections");
    for(const item of items) plugin.snapshot(item);
    return {allItemsLoaded:items.length,deduplicated:true,fieldsLoaded:true};
  });

  await step("native-audit-promotes-a-preprint-in-place-with-collections-children-and-undo", async () => {
    await guard();
    const record = new Zotero.Item("preprint");
    record.libraryID = Zotero.Libraries.userLibraryID;
    record.setField("title","A complete study of synthetic learning models");
    record.setField("DOI","10.48550/arxiv.1234.56789");
    record.setField("date","2025");
    record.setField("extra",extra);
    record.setCreators([{creatorType:"author",firstName:"Jane",lastName:"Smith"}]);
    await record.saveTx({skipSelect:true});
    const collection = new Zotero.Collection();
    collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = "Audit conversion fixture";
    await collection.saveTx();
    record.addToCollection(collection.id);await record.saveTx();
    const note = new Zotero.Item("note");note.parentID=record.id;note.setNote("Preserve this note");await note.saveTx();
    const attachment = await Zotero.Attachments.linkFromURL({url:"https://example.invalid/audit-fixture.pdf",parentItemID:record.id,title:"Preserve attachment"});
    const originalKey = record.key, before = await snapshot(record), oldRequest = plugin.fetchAuditJSON;
    plugin.fetchAuditJSON = async kind => {
      if (kind === "datacite") return {data:[]};
      if (kind !== "crossref-search") throw new Error("Unexpected fixture lookup");
      return {message:{items:[{DOI:"10.1234/final-fixture",type:"journal-article",title:[record.getField("title")],
        author:[{given:"Jane",family:"Smith"}],"container-title":["Verified Fixture Journal"],volume:"12",issue:"3",page:"101-119",
        "published-print":{"date-parts":[[2026,3]]},"published-online":{"date-parts":[[2025,11]]}}]}};
    };
    try {
      Zotero.UndoHistory.clear();
      const report = await plugin.auditItems([record,record],{silent:true});
      same(report.counts.checked,1,"Deduplicated record");same(report.counts.promoted,1,"One published version");
      same(record.itemType,"journalArticle","Native type conversion");same(record.key,originalKey,"Stable item key");
      same(record.getField("volume"),"12","Final volume");same(record.getField("pages"),"101-119","Final pages");
      same(record.getField("date"),"2026-03","Issue date");same(record.getField("extra"),extra,"Original Extra");
      same(record.getCollections(),[collection.id],"Original collection");same(Zotero.Items.get(note.id).parentID,record.id,"Original note parent");
      same(Zotero.Items.get(attachment.id).parentID,record.id,"Original attachment parent");
      same(await Zotero.UndoHistory.undo(),true,"Undo conversion");same(await snapshot(record),before,"Native undo restores preprint");
      same(await Zotero.UndoHistory.redo(),true,"Redo conversion");same(record.itemType,"journalArticle","Redo final type");
      return {lookupStubbed:true,promoted:1,stableKey:true,collectionsAndChildren:true,undoRedo:true};
    } finally {plugin.fetchAuditJSON=oldRequest;}
  });

  await step("live-audit-prefers-AllSet-published-conference-over-preprint", async () => {
    await guard();
    const record = new Zotero.Item("preprint");record.libraryID=Zotero.Libraries.userLibraryID;
    record.setField("title","You are AllSet: A Multiset Function Framework for Hypergraph Neural Networks");
    record.setField("DOI","10.48550/arxiv.2106.13264");record.setField("date","2021");
    record.setCreators([{creatorType:"author",firstName:"Eli",lastName:"Chien"},{creatorType:"author",firstName:"Chao",lastName:"Pan"}]);
    await record.saveTx({skipSelect:true});
    const report=await plugin.auditItems([record],{silent:true});
    same(report.counts.promoted,1,"Live final-version promotion");same(record.itemType,"conferencePaper","Published conference type");
    same(record.getField("conferenceName"),"International Conference on Learning Representations","ICLR official name");
    same(record.getField("date"),"2022","Conference year");same(record.getField("DOI"),"","No preprint DOI on conference version");
    return {liveNetwork:true,source:report.outcomes[0].source,finalYear:record.getField("date"),finalType:record.itemType};
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

  await step("live-empty-DOI-title-search-finds-the-original-publication", async () => {
    const record=await create({title:"Deep learning",publicationTitle:"Nature",date:"2015",DOI:"",callNumber:"Keep metrics",extra});
    record.setCreators([{creatorType:"author",firstName:"Yann",lastName:"LeCun"}]);await record.saveTx({skipSelect:true});
    const before=await snapshot(record),size=(await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).length;
    const previous=new Set(plugin.resultWindows);Zotero.UndoHistory.clear();
    const counts=await plugin.updateByDOI([record],{win});
    same(counts.written,1,"Live title fallback writes one existing item");
    same(record.getField("DOI").toLowerCase(),"10.1038/nature14539","Recovered known DOI");
    const dialog=await waitFor("title search DOI diff",()=>[...plugin.resultWindows].find(candidate=>!previous.has(candidate)&&candidate.document?.querySelector('tr[data-field="DOI"]')),12000);
    smokePreviews.add(dialog);
    same(Array.from(dialog.document.querySelectorAll('tr[data-field="DOI"] td'),cell=>cell.textContent),["DOI","（空）","10.1038/nature14539"],"Original empty DOI reported honestly");
    same(record.getField("callNumber"),"Keep metrics","Search leaves ranks untouched");same(record.getField("extra"),extra,"Search leaves Extra untouched");
    same((await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).length,size,"Title search creates no duplicates");
    same(await Zotero.UndoHistory.undo(),true,"Undo discovered DOI and metadata");same(await snapshot(record),before,"Original empty DOI restored by native undo");
    same(await Zotero.UndoHistory.redo(),true,"Redo discovered DOI");same(record.getField("DOI").toLowerCase(),"10.1038/nature14539","Redo verified DOI");
    dialog.close();return {liveNetwork:true,query:"Deep learning / Yann LeCun / Nature / 2015",DOI:record.getField("DOI"),updatedInPlace:true,undoRedo:true};
  });

  await step("live-TransMIL-without-DOI-updates-NeurIPS-and-CCF", async () => {
    await guard();
    const record = new Zotero.Item("conferencePaper");
    record.libraryID = Zotero.Libraries.userLibraryID;
    record.setField("title", "TransMIL: Transformer based correlated multiple instance learning for whole slide image classification");
    record.setField("proceedingsTitle", "Advances in Neural Information Processing Systems 34");
    record.setField("date", "2021");
    record.setCreators([{creatorType:"author",firstName:"Zhuchen",lastName:"Shao"}, {creatorType:"author",firstName:"Hao",lastName:"Bian"}]);
    await record.saveTx({skipSelect:true});
    same((await plugin.updateByDOI([record],{silent:true})).written,1,"Live DBLP metadata update");
    same(record.getField("conferenceName"),"Conference on Neural Information Processing Systems","Standard NeurIPS name");
    same(record.getField("proceedingsTitle"),"Advances in Neural Information Processing Systems 34","Official proceedings title retained");
    same(record.getField("DOI"),"","No invented proceedings DOI");
    same((await plugin.apply([record],{silent:true})).written,1,"Separate rank command");
    same(record.getField("callNumber"),"A","Bundled NeurIPS CCF grade");
    return {liveNetwork:true,source:"DBLP",conference:record.getField("conferenceName"),rank:record.getField("callNumber")};
  });

  await step("live-AllSet-preprint-updates-from-DataCite-without-converting-the-item", async () => {
    await guard();
    const record = new Zotero.Item("preprint");
    record.libraryID = Zotero.Libraries.userLibraryID;
    record.setField("title","You are AllSet: A multiset learning FRAME- work for hypergraph neural networks");
    record.setField("date","2022");
    record.setCreators([{creatorType:"author",firstName:"Eli",lastName:"Chien"}, {creatorType:"author",firstName:"Chao",lastName:"Pan"}]);
    await record.saveTx({skipSelect:true});
    await menuState(win,[record]);
    const counts = await plugin.updateByDOI([record],{silent:true});
    same(counts.written,1,"Live preprint title fallback " + JSON.stringify(counts));
    same(record.itemType,"preprint","Original item type");
    same(record.getField("DOI").toLowerCase(),"10.48550/arxiv.2106.13264","Verified arXiv DOI");
    same(record.getField("date"),"2021","Preprint publication year");
    same(record.getField("title"),"You are AllSet: A multiset function framework for hypergraph neural networks","Source title and sentence case");
    same((await plugin.updateByDOI([record],{silent:true})).unchanged,1,"Repeated DOI-first lookup is idempotent");
    return {liveNetwork:true,source:"DataCite",DOI:record.getField("DOI"),date:record.getField("date")};
  });

  await step("live-MICCAI-conference-year-and-protected-title-case", async () => {
    await guard();
    const record=new Zotero.Item("conferencePaper");record.libraryID=Zotero.Libraries.userLibraryID;
    record.setField("title","Old title");record.setField("date","2026");
    record.setField("DOI","10.1007/978-3-032-05162-2_49");
    record.setField("callNumber","B");record.setField("extra",extra);await record.saveTx({skipSelect:true});
    const before=(await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).length;
    const counts=await plugin.updateByDOI([record],{silent:true});
    same(counts.written,1,"Live conference update");
    same(record.getField("date"),"2025","Explicit conference year overrides print 2026");
    const standard="International Conference on Medical Image Computing and Computer-Assisted Intervention";
    same(record.getField("conferenceName"),standard,"DOI uses standard conference name");
    same(record.getField("proceedingsTitle"),"Medical Image Computing and Computer Assisted Intervention – MICCAI 2025","DOI restores official annual proceedings title");
    same(record.getField("title"),"Multimodal hypergraph guide learning for non-invasive ccRCC survival prediction","Sentence case and ccRCC protection");
    same(record.itemType,"conferencePaper","Do not convert library item type");
    same(record.getField("extra"),extra,"Conference Extra untouched");
    same(record.getField("callNumber"),"B","Conference metrics untouched by DOI");
    same((await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).length,before,"No duplicate conference record");
    return {liveNetwork:true,DOI:record.getField("DOI"),date:record.getField("date"),title:record.getField("title")};
  });

  await step("real-venue-regressions-from-user-report", async () => {
    if (!smokeConfig.withData) return {skipped:"No real catalog"};
    same(plugin.catalog.lookup({itemType:"conferencePaper",proceedingsTitle:"International Conference on Acoustics, Speech, and Signal Processing"}).text,"B","ICASSP missing IEEE prefix");
    const ccc=plugin.catalog.lookup({itemType:"conferencePaper",proceedingsTitle:"2018 37th Chinese Control Conference (CCC)"});
    same(ccc.hasData,false,"Chinese Control Conference is not Computational Complexity");
    same(plugin.catalog.lookup({itemType:"journalArticle",publicationTitle:"Proceedings of the AAAI Conference on Artificial Intelligence"}).text,"A","AAAI journal-article import");
    return {ICASSP:"B",CCC:"rejected",AAAI:"A"};
  });

  await step("escaped-KDD-proceedings-and-ACM-label-recover-A-without-renaming", async () => {
    await guard();
    const paper=new Zotero.Item("conferencePaper");paper.libraryID=Zotero.Libraries.userLibraryID;
    const book="Proceedings of the 24th ACM SIGKDD International Conference on Knowledge Discovery &amp; Data Mining";
    const meeting="KDD '18: The 24th ACM SIGKDD International Conference on Knowledge Discovery and Data Mining";
    for(const[field,value]of Object.entries({title:"Synthetic KDD entity regression",proceedingsTitle:book,conferenceName:meeting,date:"2018",extra}))paper.setField(field,value);
    await paper.saveTx({skipSelect:true});
    same((await plugin.apply([paper],{silent:true})).written,1,"Native rank update committed");
    same(paper.getField("callNumber"),"A","CCF A recovered");
    same(paper.getField("proceedingsTitle"),book,"Original book field retained");same(paper.getField("conferenceName"),meeting,"Original meeting field retained");
    same(paper.getField("extra"),extra,"Extra retained");
    return {escapedAmpersand:true,acmPrefix:true,rank:"A",publicationFieldsRetained:true};
  });

  await step("official-proceedings-survive-cleanup-and-native-bibtex-export", async () => {
    await guard();
    const paper=new Zotero.Item("conferencePaper");paper.libraryID=Zotero.Libraries.userLibraryID;
    const book="Advances in Neural Information Processing Systems 34";
    for(const [field,value] of Object.entries({title:"Proceedings preservation regression",proceedingsTitle:book,date:"2021",extra}))paper.setField(field,value);
    paper.setCreators([{creatorType:"author",firstName:"Test",lastName:"Author"}]);
    await paper.saveTx({skipSelect:true});
    await plugin.apply([paper],{metadata:true,silent:true});await plugin.apply([paper],{silent:true});
    same(paper.getField("proceedingsTitle"),book,"Official book title retained");
    same(paper.getField("conferenceName"),"Conference on Neural Information Processing Systems","Separate meeting name");
    same(paper.getField("callNumber"),"A","Aliases identify CCF A");
    const translator=new Zotero.Translate.Export();translator.setItems([paper]);
    const exporters=await Zotero.Translators.getAllForType("export");
    const bibtex=exporters.find(candidate=>candidate.label==="BibTeX");check(bibtex,"Native BibTeX translator available");
    translator.setTranslator(bibtex);await translator.translate();
    const output=translator.string;await IOUtils.writeUTF8(PathUtils.join(smokeConfig.dataDir,"native-proceedings.bib"),output);
    check(typeof output==="string"&&output.replace(/[{}]/g,"").toLowerCase().includes(book.toLowerCase()),"BibTeX retains official proceedings title");
    return {officialBook:book,rank:"A",nativeBibTeX:true};
  });

  await step("four-report-conferences-recover-ranks-without-clearing-conflicts", async () => {
    await guard();
    if (!smokeConfig.withData) return {skipped:"No real catalog"};
    const definitions = [
      ["Dual channel hypergraph collaborative filtering", "", "Proceedings of the 26th ACM SIGKDD International Conference on Knowledge Discovery & Data Mining", "2020-08-23", "A"],
      ["Dynamic hypergraph neural networks", "IJCAI", "Proceedings of the Twenty-Eighth International Joint Conference on Artificial Intelligence", "2019-08", "B"],
      ["Iterative metric learning for imbalance data classification", "Twenty-Seventh International Joint Conference on Artificial Intelligence {IJCAI-18}", "Proceedings of the Twenty-Seventh International Joint Conference on Artificial Intelligence", "2018-07", "B"],
      ["Negative prompt driven complementary parallel representation for open-world 3D object retrieval", "Thirty-Third International Joint Conference on Artificial Intelligence {IJCAI-24}", "Proceedings of the Thirty-ThirdInternational Joint Conference on Artificial Intelligence", "2024-08", "B"]
    ];
    const items=[];
    for (const [title,conferenceName,proceedingsTitle,date] of definitions) {
      const item=new Zotero.Item("conferencePaper");item.libraryID=Zotero.Libraries.userLibraryID;
      for (const [key,value] of Object.entries({title,conferenceName,proceedingsTitle,date,extra})) item.setField(key,value);
      await item.saveTx({skipSelect:true});items.push(item);
    }
    const previous=new Set(plugin.resultWindows);
    same((await plugin.apply(items,{win})).written,4,"Restore all four empty call numbers");
    const expected=definitions.map(row=>row[4]);
    same(items.map(item=>item.getField("callNumber")),expected,"Ranks from bundled CCF 2026");
    const dialog=await waitFor("four restored rank rows",()=>[...plugin.resultWindows].find(candidate=>!previous.has(candidate)&&candidate.document?.querySelectorAll('tr[data-field="callNumber"]').length===4),12000);
    smokePreviews.add(dialog);
    same([...dialog.document.querySelectorAll('tr[data-field="callNumber"]')].map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent)),expected.map(rank=>["索书号（分区指标）","（空）",rank]),"Before/after reports actual restored values");
    same((await plugin.apply(items,{silent:true})).unchanged,4,"Repeating update cannot clear ranks");
    same((await plugin.apply(items,{metadata:true,silent:true})).written,2,"Fill missing/abbreviated conference names");
    for (let i=0;i<items.length;i++) {
      const standard=i===0 ? "ACM SIGKDD Conference on Knowledge Discovery and Data Mining" : "International Joint Conference on Artificial Intelligence";
      same(items[i].getField("conferenceName"),i<2 ? standard : definitions[i][1],"Official full conference names retained");
      same(items[i].getField("proceedingsTitle"),definitions[i][2],"Official proceedings title retained");
      same(items[i].getField("date"),definitions[i][3],"Offline name cleanup preserves date");
      same(items[i].getField("callNumber"),expected[i],"Metadata cleanup preserves rank");
      same(items[i].getField("extra"),extra,"Extra unchanged");
    }
    const conflict=new Zotero.Item("conferencePaper");conflict.libraryID=Zotero.Libraries.userLibraryID;
    for(const [key,value] of Object.entries({title:"Conflicting conference regression",conferenceName:"CCC",proceedingsTitle:"2018 37th Chinese Control Conference (CCC)",callNumber:"B",extra})) conflict.setField(key,value);
    await conflict.saveTx({skipSelect:true});
    same((await plugin.apply([conflict],{silent:true}))["no-data"],1,"Conflict remains unmatched");
    same(conflict.getField("callNumber"),"B","Uncertainty never deletes the existing bare grade");
    dialog.close();return {realReportVenueStrings:true,ranks:expected,conflictPreserved:true,nativeDiff:true};
  });

  await step("live-manual-PDF-download-stores-one-real-full-text-and-preserves-metadata", async () => {
    await guard();
    const item=new Zotero.Item("conferencePaper");item.libraryID=Zotero.Libraries.userLibraryID;
    for(const [field,value] of Object.entries({title:"Dynamic hypergraph neural networks",DOI:"10.24963/ijcai.2019/366",
      url:"https://www.ijcai.org/proceedings/2019/0366.pdf",date:"2019",conferenceName:"IJCAI",callNumber:"B",extra})) item.setField(field,value);
    await item.saveTx({skipSelect:true});const before=await snapshot(item);
    const request=plugin.attachmentRequest,calls=[];
    plugin.attachmentRequest=async function(url,options,task){calls.push(url);return request.call(this,url,options,task);};
    const previous=new Set(plugin.resultWindows);
    try {
      await win.ZoteroPane.selectItems([item.id]);await menuState(win,[item]);invokeMenu(win,"zsr10-download");
      await waitFor("manual PDF command finishes",()=>!plugin.busy&&item.numFileAttachmentsWithContentType("application/pdf")===1,120000);
      same(await snapshot(item),before,"PDF download does not change any metadata");
      const attachments=await Zotero.Items.getAsync(item.getAttachments());
      const pdf=attachments.find(child=>child.attachmentContentType==="application/pdf");
      check(pdf&&pdf.parentID===item.id,"Stored as child of original paper");
      const path=await pdf.getFilePathAsync();check(path&&await IOUtils.exists(path),"Downloaded file exists");
      const bytes=await IOUtils.read(path);check(bytes.length>10000,"Real publication PDF is not a placeholder");
      check(new TextDecoder().decode(bytes.slice(0,1024)).includes("%PDF-"),"Real PDF signature");
      const requestCount=calls.length;const again=await plugin.downloadAttachments([item],{silent:true});
      same(again["pdf-existing"],1,"Repeated command skips existing PDF");same(calls.length,requestCount,"No second network lookup");
      same(item.getAttachments(),[pdf.id],"No duplicate attachment");
      same((await IOUtils.read(path)).length,bytes.length,"Existing file remains unchanged");
      check(calls.every(url=>!new URL(url).hostname.includes("google")),"No Google request");
      const dialog=await waitFor("PDF result window",()=>[...plugin.resultWindows].find(candidate=>!previous.has(candidate)&&candidate.document?.querySelector('tr[data-field="pdf"]')),12000);
      smokePreviews.add(dialog);check(dialog.document.getElementById("zsr10-results-heading").textContent.includes("1 份 PDF"),"Real success count shown");
      dialog.close();return {liveNetwork:true,DOI:item.getField("DOI"),bytes:bytes.length,attachmentKey:pdf.key,requests:calls.length,noGoogle:true,noDuplicates:true};
    } finally {plugin.attachmentRequest=request;}
  });

  await step("native-manual-PDF-access-limit-stops-the-batch-without-saves", async () => {
    await guard();
    const items=[];
    for(let i=0;i<2;i++) items.push(await create({title:"Synthetic PDF access-limit fixture "+i,url:"https://publisher.example.org/blocked",extra}));
    const request=plugin.attachmentRequest;let calls=0;
    plugin.attachmentRequest=async()=>{calls++;return {status:429,response:null,getResponseHeader:()=>null};};
    try {
      const counts=await plugin.downloadAttachments(items,{silent:true});
      same(counts["pdf-access-limited"],1,"Access limit reported");same(counts["pdf-not-attempted"],1,"Remaining item not attempted");
      same(calls,1,"No automatic retry");same(items.map(item=>item.getAttachments().length),[0,0],"No files stored");
      return {syntheticHTTP:true,status:429,requests:calls,noFiles:true};
    } finally {plugin.attachmentRequest=request;}
  });

  await step("disable-and-enable-cleanly-registers-four-commands", async () => {
    plugin.alert=originalAlert;
    await productAddon.disable(); await waitFor("plugin disabled",()=>!Zotero.ScholarRank10,12000);
    same((await menuState(win,[])).registrations.length,0,"Menus removed on disable");
    await productAddon.enable(); plugin=await waitFor("plugin re-enabled",()=>Zotero.ScholarRank10?.prefID && Zotero.ScholarRank10,12000);
    same((await menuState(win,[fixtures.journal])).registrations.length,2,"Menus registered once");
    same(win.document.querySelector('[data-l10n-id="zsr10-menu"]').querySelectorAll("menuitem").length,4,"Exactly four commands after reload");
    same(fixtures.journal.getField("extra"),extra,"Reload does not write Extra");
    return {reload:true,summaryDialogsStubbed:alerts};
  });
  await completeSmoke();
}
