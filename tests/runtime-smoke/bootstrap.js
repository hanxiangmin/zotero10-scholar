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
const BACKUP_PREFIX = "Zotero Scholar Rank: ";

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
  check(JSON.stringify(actual) === JSON.stringify(expected),
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

async function saved(item) {
  await item.reload(null, true);
  return {
    id: item.id, key: item.key, type: item.itemType, title: item.getField("title"),
    callNumber: String(item.getField("callNumber") || ""), extra: String(item.getField("extra") || ""),
    dateModified: item.getField("dateModified")
  };
}

function fieldPair(snapshot) {
  return { callNumber: snapshot.callNumber, extra: snapshot.extra };
}

function backup(snapshot) {
  const lines = snapshot.extra.split(/\r?\n/).filter(line => line.startsWith(BACKUP_PREFIX));
  check(lines.length === 1, "Expected exactly one plugin backup line");
  const state = JSON.parse(lines[0].slice(BACKUP_PREFIX.length));
  check(state.v === 1, "Unexpected plugin backup schema");
  return state;
}

async function apply(plugin, items, options = {}) {
  await guard();
  check(plugin.active, "Product add-on is not active");
  return plugin.apply(items, { ...options, silent: true });
}

async function previewReady(plugin, items, win) {
  await guard();
  const dialog = plugin.preview(items, win);
  check(dialog && !dialog.closed, "Preview did not open a real dialog");
  smokePreviews.add(dialog);
  try {
    await waitFor("rendered preview rows", () => !dialog.closed
      && dialog.document.getElementById("rows")?.children.length === items.length, 12000);
  } catch (error) {
    if (!dialog.closed) dialog.close();
    throw error;
  }
  return dialog;
}

function menuState(win, items, refresh = true) {
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
  return {
    registrations,
    itemNodes: win.document.querySelectorAll('[data-l10n-id="zsr10-menu"]').length,
    toolNodes: win.document.querySelectorAll('[data-l10n-id="zsr10-settings"]').length
  };
}

function syntheticVenues() {
  const suffix = smokeConfig.token.slice(0, 12);
  return {
    journal: "Fictional Journal of Scholar Smoke Tests " + suffix,
    conference: "Fictional Scholar Smoke Conference " + suffix
  };
}

function syntheticOriginal() {
  return { callNumber: "SMOKE-ORIGINAL-SHELF-001", extra: "Fictional ownership fixture; not scientific evidence.\nCitation Key: smokePublic" };
}

function publicFixtureDefinitions() {
  const venues = syntheticVenues();
  const original = syntheticOriginal();
  const oldText = "B|9.9|Q1|2区";
  const state = {
    v: 1, original: original.callNumber, last: oldText, addedSeparator: true,
    updatedAt: smokeConfig.preparedAt, quartilePolicy: "best",
    provenance: Object.fromEntries(["ccf", "jcr", "cas"].map(kind => [kind, {
      source: "SYNTHETIC previous-version smoke fixture; not actual ranking data"
    }]))
  };
  return [
    ["journal", "journalArticle", { title: "[隔离测试·纯合成] 无数据期刊", publicationTitle: venues.journal, extra: "Fictional venue and test-only metrics." }],
    ["protected", "journalArticle", { title: "[隔离测试·纯合成] 原索书号不改", publicationTitle: venues.journal, callNumber: "SMOKE-UNMANAGED-SHELF", extra: "User-owned synthetic shelf fixture." }],
    ["conference", "conferencePaper", { title: "[隔离测试·纯合成] 虚构正式会议", conferenceName: venues.conference, proceedingsTitle: "Proceedings of " + venues.conference, extra: "Fictional conference, not an actual CCF entry." }],
    ["unknown", "journalArticle", { title: "[隔离测试·纯合成] 始终未匹配", publicationTitle: "Unlisted Fictional Journal " + smokeConfig.token.slice(0, 12), extra: "Unknown synthetic venue; keep unchanged." }],
    ["workshop", "conferencePaper", { title: "[隔离测试·纯合成] 虚构Workshop", conferenceName: venues.conference, proceedingsTitle: venues.conference + " Workshops", extra: "Synthetic ancillary track; never borrow the parent rank." }],
    ["managed", "journalArticle", { title: "[隔离测试·纯合成] 缺少数据保护旧结果", publicationTitle: venues.journal, callNumber: oldText, extra: original.extra + "\n" + BACKUP_PREFIX + JSON.stringify(state) }]
  ];
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
    const menus = menuState(win, []);
    same(menus.registrations.length, 2, "Startup menu registrations");
    same([menus.itemNodes, menus.toolNodes], [1, 1], "Startup menu DOM instances");
    return { rootURI: productAddon.getResourceURI().spec, datasets: plugin.catalog.list(),
      warnings: [...plugin.loadWarnings], menuIDs: [...plugin.menuIDs], menus };
  }, true);

  await step("create-isolated-synthetic-items", async () => {
    const journal = {
      publicationTitle: "IEEE Transactions on Pattern Analysis and Machine Intelligence",
      journalAbbreviation: "TPAMI", ISSN: "0162-8828"
    };
    const definitions = smokeConfig.withData ? [
      ["journal", "journalArticle", { ...journal, title: "[隔离测试] TPAMI：空索书号", extra: "Synthetic journal fixture; keep this note." }],
      ["protected", "journalArticle", { ...journal, title: "[隔离测试] 真实索书号保护与恢复", callNumber: "QA76.9 .SMOKE-001", extra: "Shelf-owner note\nCitation Key: smokeShelf" }],
      ["conference", "conferencePaper", { title: "[隔离测试] CVPR 正式会议论文", conferenceName: "CVPR", proceedingsTitle: "Proceedings of the 2026 IEEE/CVF Computer Vision and Pattern Recognition Conference (CVPR)", extra: "Synthetic full-paper fixture." }],
      ["unknown", "journalArticle", { title: "[隔离测试] 未知期刊必须跳过", publicationTitle: "Journal of Isolated Scholar Smoke Tests " + smokeConfig.token.slice(0, 12), extra: "Unknown venue; keep unchanged." }],
      ["workshop", "conferencePaper", { title: "[隔离测试] CVPR Workshop 不能记为 A", conferenceName: "CVPR", proceedingsTitle: "2026 IEEE/CVF Computer Vision and Pattern Recognition Workshops (CVPRW)", extra: "Ancillary track; keep unchanged." }],
      ["undo", "journalArticle", { ...journal, title: "[隔离测试] Zotero 撤销与重做", extra: "Undo fixture original note." }],
      ["manual", "journalArticle", { ...journal, title: "[隔离测试] 手动修改后的索书号保护", extra: "Manual-edit fixture original note." }]
    ] : publicFixtureDefinitions();
    await guard();
    await Zotero.DB.executeTransaction(async () => {
      await guard();
      collection = new Zotero.Collection();
      collection.libraryID = Zotero.Libraries.userLibraryID;
      collection.name = "[隔离测试] Scholar Rank " + new Date().toISOString();
      await collection.save();
      for (const [name, type, fields] of definitions) {
        const item = new Zotero.Item(type);
        item.libraryID = Zotero.Libraries.userLibraryID;
        for (const [field, value] of Object.entries(fields)) item.setField(field, value);
        item.setCollections([collection.id]);
        await item.save({ skipSelect: true });
        fixtures[name] = item;
      }
    });
    for (const [name, item] of Object.entries(fixtures)) smokeReport.fixtures[name] = await saved(item);
    smokeReport.collection = { id: collection.id, key: collection.key, name: collection.name };
    return { collection: smokeReport.collection, count: allItems().length };
  }, true);

  if (smokeConfig.withData) {
  await step("preview-renders-without-writing", async () => {
    const before = await Promise.all(allItems().map(saved));
    const dialog = await previewReady(plugin, allItems(), win);
    try {
      const rows = dialog.arguments[0].rows;
      same(rows.find(row => row.id === fixtures.journal.id).result.text, smokeConfig.expectedJournal, "TPAMI preview");
      same(rows.find(row => row.id === fixtures.conference.id).result.text, smokeConfig.expectedConference, "CVPR preview");
      check(rows.find(row => row.id === fixtures.workshop.id).result.hasData === false, "Workshop received a rank");
      same(await Promise.all(allItems().map(saved)), before, "Preview must not change stored fields");
      return { renderedRows: dialog.document.getElementById("rows").children.length,
        ranks: Array.from(dialog.document.querySelectorAll(".rank"), element => element.textContent) };
    } finally { dialog.close(); }
  });

  await step("bulk-apply-journal-and-conference", async () => {
    const counts = await apply(plugin, [fixtures.journal, fixtures.conference]);
    same(counts.written, 2, "Bulk written count");
    const journal = await saved(fixtures.journal), conference = await saved(fixtures.conference);
    same(journal.callNumber, smokeConfig.expectedJournal, "Persisted TPAMI rank");
    same(conference.callNumber, smokeConfig.expectedConference, "Persisted CVPR rank");
    same(backup(journal).original, "", "Journal blank original backup");
    same(backup(conference).original, "", "Conference blank original backup");
    check(journal.extra.startsWith(smokeReport.fixtures.journal.extra), "Original Extra note was not preserved");
    return { counts, journal: fieldPair(journal), conference: fieldPair(conference) };
  });

  await step("repeated-update-is-unchanged", async () => {
    const items = [fixtures.journal, fixtures.conference];
    const before = await Promise.all(items.map(saved));
    const counts = await apply(plugin, items);
    same(counts.unchanged, 2, "Unchanged count");
    same(counts.written || 0, 0, "Repeat writes");
    same(await Promise.all(items.map(saved)), before, "Repeated update changes neither fields nor dateModified");
    return { counts };
  });

  await step("upgrade-compacts-legacy-format-and-preserves-backup", async () => {
    const current = await saved(fixtures.conference);
    const legacy = { ...backup(current), last: "A|—|—|—" };
    await guard();
    fixtures.conference.setField("callNumber", legacy.last);
    fixtures.conference.setField("extra", current.extra.replace(/^Zotero Scholar Rank: [^\r\n]*/m,
      () => BACKUP_PREFIX + JSON.stringify(legacy)));
    await fixtures.conference.saveTx({ skipSelect: true });
    const counts = await apply(plugin, [fixtures.conference]);
    same(counts.written, 1, "Legacy-format update count");
    const compact = await saved(fixtures.conference);
    same(compact.callNumber, smokeConfig.expectedConference, "No empty metric slots after upgrade");
    same(backup(compact).original, legacy.original, "Upgrade preserves the first backup");
    check(compact.extra.startsWith(smokeReport.fixtures.conference.extra), "Upgrade lost original Extra text");
    same((await apply(plugin, [fixtures.conference])).unchanged, 1, "Compact result is idempotent");
    same(await saved(fixtures.conference), compact, "Repeat refresh leaves stored fields unchanged");
    same((await apply(plugin, [fixtures.conference], { restore: true })).written, 1, "Restore after upgrade");
    same(fieldPair(await saved(fixtures.conference)), fieldPair(smokeReport.fixtures.conference),
      "Restoring upgraded data recovers original fields");
    same((await apply(plugin, [fixtures.conference])).written, 1, "Reapply compact result for preview");
    return { previousText: legacy.last, compactText: compact.callNumber, original: legacy.original,
      counts, restoreVerified: true };
  });

  await step("existing-call-number-is-protected", async () => {
    const before = await saved(fixtures.protected);
    const counts = await apply(plugin, [fixtures.protected]);
    same(counts["existing-call-number"], 1, "Existing-call-number skip count");
    same(await saved(fixtures.protected), before, "Protected item remains untouched");
    return { counts, originalCallNumber: before.callNumber };
  });

  await step("explicit-overwrite-keeps-original-backup", async () => {
    const counts = await apply(plugin, [fixtures.protected], { allowOverwrite: true });
    same(counts.written, 1, "Explicit overwrite count");
    const stored = await saved(fixtures.protected);
    same(stored.callNumber, smokeConfig.expectedJournal, "Overwritten call number");
    same(backup(stored).original, smokeReport.fixtures.protected.callNumber, "Original shelf number in backup");
    check(stored.extra.startsWith(smokeReport.fixtures.protected.extra), "Original Extra content lost");
    return { counts, backup: backup(stored) };
  });

  await step("restore-original-call-number-and-extra", async () => {
    const counts = await apply(plugin, [fixtures.protected], { restore: true });
    same(counts.written, 1, "Restore count");
    same(fieldPair(await saved(fixtures.protected)), fieldPair(smokeReport.fixtures.protected), "Exact original fields after restore");
    return { counts };
  });

  await step("zotero-undo-and-redo", async () => {
    const before = await saved(fixtures.undo);
    await guard();
    Zotero.UndoHistory.clear(); // Only this isolated profile's in-memory history.
    check(Zotero.UndoHistory.isEnabled(), "Zotero UndoHistory is disabled");
    same((await apply(plugin, [fixtures.undo])).written, 1, "Undo fixture update");
    const after = await saved(fixtures.undo);
    check(Zotero.UndoHistory.canUndo(), "Plugin did not register an undo action");
    await guard();
    same(await Zotero.UndoHistory.undo(), true, "Zotero UndoHistory.undo result");
    same(fieldPair(await saved(fixtures.undo)), fieldPair(before), "Undo restores persisted fields");
    check(Zotero.UndoHistory.canRedo(), "No redo action after undo");
    await guard();
    same(await Zotero.UndoHistory.redo(), true, "Zotero UndoHistory.redo result");
    same(fieldPair(await saved(fixtures.undo)), fieldPair(after), "Redo restores plugin fields and backup");
    return { undo: true, redo: true, restoredText: after.callNumber };
  });

  await step("unknown-and-workshop-are-skipped", async () => {
    const items = [fixtures.unknown, fixtures.workshop];
    const before = await Promise.all(items.map(saved));
    const result = plugin.catalog.lookup(plugin.snapshot(fixtures.workshop));
    same(result.reasons.ccf, "excluded-conference-track", "Workshop exclusion reason");
    const counts = await apply(plugin, items);
    same(counts["no-data"], 2, "Unknown and workshop skip count");
    same(counts.written || 0, 0, "No false-rank writes");
    same(await Promise.all(items.map(saved)), before, "Skipped fixtures remain unchanged");
    return { counts, workshopReason: result.reasons.ccf };
  });

  await step("manually-edited-result-stays-protected", async () => {
    same((await apply(plugin, [fixtures.manual])).written, 1, "Manual-edit fixture initial update");
    await guard();
    fixtures.manual.setField("callNumber", "Manual shelf correction — keep me");
    await fixtures.manual.saveTx({ skipSelect: true });
    const before = await saved(fixtures.manual);
    const refresh = await apply(plugin, [fixtures.manual], { allowOverwrite: true });
    const restore = await apply(plugin, [fixtures.manual], { restore: true });
    same(refresh["manually-edited"], 1, "Manual edit blocks overwrite");
    same(restore["manually-edited"], 1, "Manual edit blocks restore");
    same(await saved(fixtures.manual), before, "Manual correction remains untouched");
    return { refresh, restore };
  });
  } else {
    await step("public-empty-preview-does-not-write", async () => {
      const before = await Promise.all(allItems().map(saved));
      const dialog = await previewReady(plugin, allItems(), win);
      try {
        const rows = dialog.arguments[0].rows;
        for (const row of rows) {
          same(row.result.text, "", "Empty-catalog preview text");
          check(row.result.hasData === false, "Empty catalog supplied invented metrics");
          same(row.result.availableKinds, [], "Empty-catalog availability");
        }
        same(dialog.arguments[0].datasets, [], "No private data in the public preview");
        check(dialog.arguments[0].warnings.length >= 3, "Public preview must show missing-data guidance");
        same(await Promise.all(allItems().map(saved)), before, "Empty preview must not write items");
        return { renderedRows: rows.length, warnings: [...dialog.arguments[0].warnings], wroteItems: false };
      } finally { dialog.close(); }
    });

    await step("public-unmatched-items-stay-unchanged", async () => {
      const items = allItems().filter(item => item.id !== fixtures.managed.id);
      const before = await Promise.all(items.map(saved));
      const counts = await apply(plugin, items, { allowOverwrite: true });
      same(counts["no-data"], items.length, "All unmanaged items without datasets are skipped");
      same(counts.written || 0, 0, "No empty-result writes");
      same(await Promise.all(items.map(saved)), before, "Missing data preserves blank and nonblank original fields");
      return { counts };
    });

    await step("public-missing-data-protects-managed-result-and-allows-restore", async () => {
      const before = await saved(fixtures.managed);
      same(before.callNumber, backup(before).last, "Synthetic prior-version state owns the current result");
      const counts = await apply(plugin, [fixtures.managed], { allowOverwrite: true });
      same(counts["data-unavailable"], 1, "Unavailable datasets preserve a managed result");
      same(counts.written || 0, 0, "No managed-result clearing");
      same(await saved(fixtures.managed), before, "Prior-version fields and backup are unchanged");
      const restored = await apply(plugin, [fixtures.managed], { restore: true });
      same(restored.written, 1, "Restore is available without datasets");
      same(fieldPair(await saved(fixtures.managed)), syntheticOriginal(), "Exact synthetic original fields after restore");
      return { counts, restored, oldSyntheticResult: before.callNumber, scientificData: false };
    });

    await step("public-seed-guarded-synthetic-local-overrides", async () => {
      const context = await guard();
      same(plugin.catalog.list(), [], "Overrides must be tested through a real reload, not injected into the catalog");
      const storage = PathUtils.join(Zotero.DataDirectory.dir, "zotero10-scholar");
      if (await IOUtils.exists(storage)) {
        same(canonical(storage), context.dataDir + "/zotero10-scholar", "Existing override directory must not redirect");
      }
      await IOUtils.makeDirectory(storage, { ignoreExisting: true });
      same(canonical(storage), context.dataDir + "/zotero10-scholar", "Override directory stays inside the isolated data directory");
      same(canonical(plugin.storageDir), canonical(storage), "Product uses the isolated override directory");
      const written = [];
      for (const data of syntheticDatasets()) {
        await guard();
        const path = PathUtils.join(storage, data.kind + ".json");
        const tmpPath = path + ".tmp";
        check(!(await IOUtils.exists(path)) && !(await IOUtils.exists(tmpPath)), "Refusing to replace an existing smoke override");
        // The parent exists and is canonical; the fixed filename and tmp file
        // are absent, so no existing symlink/file is followed or overwritten.
        same(canonical(storage), context.dataDir + "/zotero10-scholar", "Synthetic override parent");
        await IOUtils.writeJSON(path, data, { tmpPath });
        same(canonical(path), context.dataDir + "/zotero10-scholar/" + data.kind + ".json", "Written synthetic override target");
        written.push({ kind: data.kind, path, records: data.records.length, source: data.source });
      }
      same(plugin.catalog.list(), [], "Writing fixture files must not bypass startup loading");
      smokeReport.syntheticData = { scientificData: false, venues: syntheticVenues(), files: written };
      return smokeReport.syntheticData;
    }, true);
  }

  await step("seed-synthetic-abbreviation-table", async () => {
    await guard();
    await IOUtils.makeDirectory(plugin.storageDir, { ignoreExisting: true });
    const table = { schemaVersion: 1, kind: "journal-abbreviations", source: "Synthetic smoke table, not a real journal abbreviation",
      records: [{ title: "Fictional Journal of Metadata Smoke", abbreviation: "Fict. Metadata" }] };
    await IOUtils.writeJSON(PathUtils.join(plugin.storageDir, "abbreviations.json"), table);
    return { source: table.source, count: 1 };
  });

  await step("disable-enable-cleans-and-restores-menus", async () => {
    const beforeFields = await Promise.all(allItems().map(saved));
    const oldPlugin = plugin;
    const before = menuState(win, allItems());
    same(before.registrations.length, 2, "Initial menu registrations");
    same([before.itemNodes, before.toolNodes], [1, 1], "Initial menu DOM instances");
    const closingPreview = await previewReady(plugin, allItems(), win);
    let disabled, enabled;
    try {
      await guard();
      await productAddon.disable(); // Standard AddonManager API, no private toggles.
      await waitFor("product shutdown", () => !Zotero.ScholarRank10 && !oldPlugin.active);
      await waitFor("preview cleanup on disable", () => closingPreview.closed && oldPlugin.dialogs.size === 0);
      disabled = menuState(win, allItems());
      same(disabled.registrations.length, 0, "Disabled add-on menu registrations");
      same([disabled.itemNodes, disabled.toolNodes], [0, 0], "Disabled add-on menu DOM after normal refresh");
      same(oldPlugin.menuIDs.length, 0, "Product clears menu handles");
    } finally {
      if (!smokeStopping) {
        await guard();
        if (productAddon.userDisabled) await productAddon.enable();
        plugin = await waitFor("product enabled again", () => Zotero.ScholarRank10?.catalog && Zotero.ScholarRank10);
        await waitFor("re-enabled menus", () => plugin.menuIDs?.length === 2 && plugin.prefID);
      }
    }
    check(productAddon.isActive, "Product did not return to active state");
    enabled = menuState(win, allItems());
    same(enabled.registrations.length, 2, "Re-enabled menu registrations");
    same([enabled.itemNodes, enabled.toolNodes], [1, 1], "Re-enable must not duplicate menu DOM");
    same(await Promise.all(allItems().map(saved)), beforeFields, "Disable/enable must not modify library records");
    return { before, disabled, enabled, previewClosedOnDisable: closingPreview.closed };
  });

  if (!smokeConfig.withData) {
    await step("public-reload-reads-local-overrides-and-updates-new-items", async () => {
      same(plugin.catalog.list().map(data => data.kind).sort(), ["cas", "ccf", "jcr"], "Reloaded synthetic dataset kinds");
      check(plugin.catalog.list().every(data => data.source.startsWith("SYNTHETIC ISOLATED SMOKE TEST ONLY")),
        "A public smoke result must come only from the declared synthetic local files");
      same(plugin.loadWarnings, [], "Valid overrides resolve missing-data warnings after re-enable");
      await guard();
      await Zotero.DB.executeTransaction(async () => {
        await guard();
        const item = new Zotero.Item("journalArticle");
        item.libraryID = Zotero.Libraries.userLibraryID;
        item.setField("title", "[隔离测试·纯合成] 导入后新条目：2.5 / Q2 / 3区");
        item.setField("publicationTitle", syntheticVenues().journal);
        item.setField("extra", "SYNTHETIC metrics only; not a real paper or scientific ranking.");
        item.setCollections([collection.id]);
        await item.save({ skipSelect: true });
        fixtures.afterImport = item;
      });
      smokeReport.fixtures.afterImport = await saved(fixtures.afterImport);
      const updatedItems = [fixtures.afterImport, fixtures.conference];
      const counts = await apply(plugin, updatedItems);
      same(counts.written, 2, "Synthetic journal and conference update count");
      const journal = await saved(fixtures.afterImport), conference = await saved(fixtures.conference);
      same(journal.callNumber, smokeConfig.expectedJournal, "Invented C / 2.5 / Q2 / 3区 result");
      same(conference.callNumber, smokeConfig.expectedConference, "Invented conference B result");
      same(backup(journal).original, "", "New synthetic journal retains its empty original backup");
      same(backup(conference).original, "", "Synthetic conference retains its empty original backup");
      const repeated = await apply(plugin, updatedItems);
      same(repeated.unchanged, 2, "Synthetic local-override results are idempotent");
      same(await saved(fixtures.afterImport), journal, "Repeated refresh preserves the new item's stored fields");
      const skippedItems = [fixtures.unknown, fixtures.workshop, fixtures.protected, fixtures.managed];
      const beforeSkipped = await Promise.all(skippedItems.map(saved));
      const skipped = await apply(plugin, skippedItems);
      same(skipped["no-data"], 2, "Unknown and workshop synthetic venues stay unmatched");
      same(skipped["existing-call-number"], 2, "Both untouched and restored shelf marks stay protected");
      same(await Promise.all(skippedItems.map(saved)), beforeSkipped, "Unmatched and protected items remain unchanged after importing");
      return { counts, repeated, skipped, scientificData: false,
        journal: fieldPair(journal), conference: fieldPair(conference) };
    });
  }

  await step("metadata-settings-controls", async () => {
    plugin.showSettings();
    const preferences = await waitFor("Scholar Rank settings controls", () => {
      const windows = Services.wm.getEnumerator(null);
      while (windows.hasMoreElements()) {
        const candidate = windows.getNext();
        if (candidate.document?.getElementById("zsr10-metadata-rules")?.querySelectorAll("input").length === 7) return candidate;
      }
      return null;
    }, 12000);
    same(preferences.document.getElementById("zsr10-metadata-auto").checked, false, "Auto-cleanup default checkbox");
    const checkbox = preferences.document.querySelectorAll("#zsr10-metadata-rules input")[1];
    checkbox.click(); same(plugin.pref("metadata.doi"), false, "Rule control persists disabled preference");
    checkbox.click(); same(plugin.pref("metadata.doi"), true, "Rule control can re-enable DOI cleanup");
    check(preferences.document.getElementById("zsr10-abbreviation-summary").textContent.includes("1"), "Settings show abbreviation count");
    check(preferences !== win, "Preferences expected in a separate window");
    preferences.close();
    return { controls: 7, defaultAuto: false, preferenceChange: true };
  });

  let metadataItem, metadataOriginal, metadataAfter;
  const metadataFields = ["title", "DOI", "pages", "volume", "issue", "language", "journalAbbreviation", "callNumber", "extra"];
  const metaSaved = async item => {
    await item.reload(null, true);
    return Object.fromEntries(metadataFields.map(field => [field, String(item.getField(field) || "")]));
  };
  const metadataDialog = async (items, options = {}) => {
    const dialog = await plugin.previewMetadata(items, { win, ...options });
    smokePreviews.add(dialog);
    await waitFor("metadata preview DOM", () => !dialog.closed && dialog.document.getElementById("rows")?.children.length === items.length, 12000);
    return dialog;
  };

  await step("metadata-preview-duplicates-and-apply", async () => {
    same(plugin.abbreviations.count, 1, "Abbreviation table reloads after enable");
    const fields = { title: "BRCA1  and p53 in a fictional study", DOI: "doi:10.12345/scholar-smoke", pages: "S10 - S19", volume: "002", issue: "03",
      publicationTitle: "Fictional Journal of Metadata Smoke", callNumber: "USER-SHELF-KEEP", extra: "User note — preserve exactly" };
    await guard();
    metadataItem = new Zotero.Item("journalArticle");
    metadataItem.libraryID = Zotero.Libraries.userLibraryID;
    for (const [field, value] of Object.entries(fields)) metadataItem.setField(field, value);
    await metadataItem.saveTx({ skipSelect: true });
    const duplicate = new Zotero.Item("journalArticle"); duplicate.libraryID = metadataItem.libraryID;
    duplicate.setField("title", "Another fictional title for duplicate testing"); duplicate.setField("DOI", "10.12345/scholar-smoke");
    await duplicate.saveTx({ skipSelect: true });
    metadataOriginal = await metaSaved(metadataItem);
    const dialog = await metadataDialog([metadataItem]);
    same(await metaSaved(metadataItem), metadataOriginal, "Metadata preview must not write");
    check(!dialog.arguments[0].duplicateWarning, "Duplicate lookup raised an error");
    check(dialog.arguments[0].rows[0].duplicates.some(candidate => candidate.id === duplicate.id), "DOI duplicate was not found");
    await dialog.arguments[0].selectDuplicates([metadataItem.id, duplicate.id]);
    same(win.ZoteroPane.getSelectedItems().map(item => item.id).sort(), [metadataItem.id, duplicate.id].sort(), "Duplicate selection");
    Zotero.UndoHistory.clear();
    dialog.document.getElementById("apply").click();
    await waitFor("metadata applied through actual preview button", () => dialog.document.getElementById("result").textContent.includes("已保存 1"), 12000);
    metadataAfter = await metaSaved(metadataItem);
    same(metadataAfter.DOI, "10.12345/scholar-smoke", "Clean DOI");
    same(metadataAfter.title, "BRCA1 and p53 in a fictional study", "Keep gene names and title case");
    same(metadataAfter.pages, "S10–S19", "Clean page range");
    same(metadataAfter.volume, "2", "Clean numeric volume");
    same(metadataAfter.journalAbbreviation, "Fict. Metadata", "Fill imported abbreviation");
    same(metadataAfter.language, "en", "Fill empty language conservatively");
    same(metadataAfter.callNumber, "USER-SHELF-KEEP", "Keep original shelf mark");
    check(metadataAfter.extra.includes("Zotero Scholar Metadata:"), "Missing metadata backup");
    check(metadataAfter.extra.startsWith(metadataOriginal.extra), "Lost user Extra note");
    check(dialog.document.getElementById("apply").disabled, "Double-apply button must be disabled");
    dialog.close();
    return { stored: metadataAfter, duplicateID: duplicate.id, appliedViaDOM: true };
  }, true);

  await step("metadata-native-undo-redo-and-no-repeat-write", async () => {
    same(await Zotero.UndoHistory.undo(), true, "Undo metadata operation");
    same(await metaSaved(metadataItem), metadataOriginal, "Undo all cleanup fields plus backup");
    same(await Zotero.UndoHistory.redo(), true, "Redo metadata operation");
    same(await metaSaved(metadataItem), metadataAfter, "Redo all cleanup fields plus backup");
    const result = await apply(plugin, [metadataItem], { metadata: true });
    same(result.written || 0, 0, "Repeat cleanup must not write");
    return { undo: true, redo: true, noRepeatWrite: true };
  });

  await step("metadata-stale-preview-and-protected-restore", async () => {
    const dialog = await metadataDialog([metadataItem], { restore: true });
    metadataItem.setField("DOI", "10.12345/manual"); await metadataItem.saveTx({ skipSelect: true });
    const result = await dialog.arguments[0].apply([metadataItem.id]);
    same(result["manually-edited"], 1, "Stale preview skips changed item");
    same(metadataItem.getField("volume"), "2", "Stale restore cannot write other fields");
    dialog.close();
    const current = await metadataDialog([metadataItem], { restore: true });
    await current.arguments[0].apply([metadataItem.id]);
    const restored = await metaSaved(metadataItem);
    same(restored.DOI, "10.12345/manual", "Manual DOI survives restore");
    same(restored.volume, metadataOriginal.volume, "Unedited volume restored");
    same(restored.title, metadataOriginal.title, "Original title restored");
    same(restored.callNumber, metadataOriginal.callNumber, "Restore leaves shelf mark intact");
    current.close();
    return { restored, partialRestore: true };
  });

  await step("metadata-auto-new-independent-toggle", async () => {
    plugin.setPref("metadata.auto", true); plugin.setPref("autoNew", false);
    try {
      const item = new Zotero.Item("journalArticle"); item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField("title", "A fictional test of automatic cleanup"); item.setField("DOI", "doi:10.12345/automatic");
      item.setField("callNumber", "AUTOMATIC-SHELF"); await item.saveTx({ skipSelect: true });
      await waitFor("automatic metadata cleanup", () => !plugin.busy && item.getField("DOI") === "10.12345/automatic", 12000);
      await plugin.pendingAuto;
      await item.reload(null, true);
      same(item.getField("callNumber"), "AUTOMATIC-SHELF", "Metadata-only auto mode keeps shelf mark");
      same(item.getField("DOI"), "10.12345/automatic", "Automatic cleanup persisted");
      return { automaticCleanup: true, independentToggle: true };
    } finally { plugin.setPref("metadata.auto", false); }
  });

  await step(smokeConfig.autoClose ? "final-preview-before-auto-close" : "leave-final-preview-for-inspection", async () => {
    plugin = Zotero.ScholarRank10;
    check(plugin?.active && plugin.catalog, "Product not active for final preview");
    await guard();
    await win.ZoteroPane.selectItems(allItems().map(item => item.id));
    const dialog = await previewReady(plugin, allItems(), win);
    if (!smokeConfig.autoClose) dialog.focus();
    smokeReport.previewReady = true;
    smokeReport.finalFixtures = {};
    for (const [name, item] of Object.entries(fixtures)) smokeReport.finalFixtures[name] = await saved(item);
    return { title: dialog.document.title, renderedRows: dialog.document.getElementById("rows").children.length,
      retainedItemIDs: allItems().map(item => item.id) };
  });

  await completeSmoke();
}
