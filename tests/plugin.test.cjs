"use strict";

// Exercise the actual plugin/core in isolated VMs. No real Zotero, UI, filesystem
// writes, or network calls are used by these integration-style regression tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const Core = require("../src/core.js");

const PLUGIN_CODE = fs.readFileSync(path.join(__dirname, "../src/plugin.js"), "utf8");
const PAMI = "IEEE TRANSACTIONS ON PATTERN ANALYSIS AND MACHINE INTELLIGENCE";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function jcrDataset(year = 2025) {
  return {
    schemaVersion: 1, kind: "jcr", edition: year + 1, metricYear: year, source: "test fixture",
    records: [
      { title: PAMI, issns: ["0162-8828"], aliases: [], jif: 20.4, quartiles: [{ category: "AI", quartile: "Q1" }] },
      { title: "SCIENCE", issns: ["0036-8075"], aliases: [], jif: 47.3, quartiles: [{ category: "Multidisciplinary", quartile: "Q1" }] }
    ]
  };
}

function fixtureDatasets() {
  return {
    "ccf-2026.json": {
      schemaVersion: 1, kind: "ccf", edition: 2026, source: "test fixture",
      records: [{ title: PAMI, type: "journal", rank: "A", issns: ["0162-8828"], aliases: [] }]
    },
    "jcr-2025.json": jcrDataset(),
    "cas-2025.json": {
      schemaVersion: 1, kind: "cas", edition: 2025, system: "CAS", categoryLevel: "major", source: "test fixture",
      records: [
        { title: PAMI, issns: ["0162-8828"], aliases: [], division: 1, top: true },
        { title: "SCIENCE", issns: ["0036-8075"], aliases: [], division: 1, top: true }
      ]
    }
  };
}

async function harness({ builtins = fixtureDatasets(), localFiles = new Map() } = {}) {
  const state = {
    items: new Map(), persisted: new Map(), alerts: [], errors: [], saveIDs: [], reloadIDs: [],
    commits: 0, rollbacks: 0, undoActions: [], observer: null, transactionRequested: deferred(),
    transactionGate: null, pickerQueue: [], inputFiles: new Map(),
    outputFiles: new Map([...localFiles].map(([filename, data]) => [filename, structuredClone(data)])),
    writes: [], beforeWrite: null, autoNew: true, resourceReads: [], localReads: [],
    activeMenus: new Set(), activePanes: new Set(), menuConfigs: new Map(), observerPriority: null
  };

  class FilePicker {
    constructor() {
      const next = state.pickerQueue.shift();
      assert.ok(next, "a test must explicitly provide each fake file picker result");
      this.file = next.file;
      this.result = next;
      this.modeOpen = 0;
      this.returnOK = 0;
    }
    init() {}
    appendFilter() {}
    async show() {
      if (this.result.gate) await this.result.gate.promise;
      return this.result.cancel ? 1 : 0;
    }
  }

  const Zotero = {
    DataDirectory: { dir: "C:/MOCK-ZOTERO" },
    File: {
      getResourceAsync: async url => {
        const filename = url.split("/").pop();
        state.resourceReads.push(filename);
        if (!Object.hasOwn(builtins, filename)) throw new Error(`Missing bundled resource: ${filename}`);
        return JSON.stringify(builtins[filename]);
      }
    },
    ftl: { addResourceIds() {}, removeResourceIds() {} },
    getMainWindows: () => [], getMainWindow: () => null,
    MenuManager: {
      registerMenu: config => {
        state.activeMenus.add(config.menuID);
        state.menuConfigs.set(config.menuID, config);
        return config.menuID;
      },
      unregisterMenu: menuID => {
        state.menuConfigs.delete(menuID);
        return state.activeMenus.delete(menuID);
      }
    },
    PreferencePanes: {
      register: async () => { state.activePanes.add("fake-pane"); return "fake-pane"; },
      unregister: paneID => state.activePanes.delete(paneID)
    },
    Notifier: {
      registerObserver: (observer, _types, _name, priority) => {
        state.observer = observer;
        state.observerPriority = priority;
        return 1;
      },
      unregisterObserver: () => { state.observer = null; }
    },
    Prefs: { get: key => key.endsWith("autoNew") ? state.autoNew : "best", set() {} },
    Promise: { delay: async () => {} },
    Items: { getAsync: async ids => ids.map(id => state.items.get(id)) },
    ItemFields: { getID: name => name, isValidForType: () => true },
    UndoHistory: { stageAction: (action, args) => state.undoActions.push({ action, args }) },
    logError: error => state.errors.push(error),
    DB: {
      async executeTransaction(callback) {
        state.transactionRequested.resolve();
        if (state.transactionGate) await state.transactionGate.promise;
        const before = new Map([...state.persisted].map(([id, fields]) => [id, { ...fields }]));
        try {
          await callback();
          state.commits++;
        } catch (error) {
          state.persisted = before;
          state.rollbacks++;
          throw error;
        }
      }
    }
  };
  const IOUtils = {
    exists: async filename => state.outputFiles.has(filename) || state.inputFiles.has(filename),
    stat: async () => ({ size: 1024 }),
    readJSON: async filename => {
      state.localReads.push(filename);
      if (state.outputFiles.has(filename)) return structuredClone(state.outputFiles.get(filename));
      if (state.inputFiles.has(filename)) return structuredClone(state.inputFiles.get(filename));
      throw new Error(`Missing local JSON file: ${filename}`);
    },
    makeDirectory: async () => {},
    async writeJSON(filename, data) {
      state.writes.push({ filename, metricYear: data.metricYear });
      if (state.beforeWrite) await state.beforeWrite(filename, data);
      state.outputFiles.set(filename, structuredClone(data));
    }
  };
  const scope = {
    ScholarCore: Core, Zotero, IOUtils,
    PathUtils: { join: (...parts) => parts.join("/") },
    ChromeUtils: { importESModule: () => ({ FilePicker }) },
    Services: { prompt: { alert: (_, __, text) => state.alerts.push(text), confirm: () => true } }
  };
  vm.createContext(scope);
  vm.runInContext(PLUGIN_CODE, scope, { filename: "src/plugin.js" });
  const plugin = scope.ScholarPlugin;
  await plugin.start({ id: "test@mock.invalid", version: "1", rootURI: "jar:file:///MOCK/extensions/test@mock.invalid.xpi!/" });

  function item(id, values = {}) {
    const fields = { title: `Paper ${id}`, publicationTitle: PAMI, ISSN: "0162-8828", callNumber: "", extra: "User note", ...values };
    const object = {
      id, key: `ITEM${id}`, itemType: "journalArticle", itemTypeID: 1,
      library: { libraryType: "user" }, deleted: false, isFeedItem: false,
      fields, saveEntered: deferred(), saveGate: null, saveError: null,
      isRegularItem: () => true, isEditable: () => true,
      getField: name => fields[name] || "",
      setField: (name, value) => { fields[name] = value; },
      async save() {
        state.saveIDs.push(id);
        this.saveEntered.resolve();
        if (this.saveGate) await this.saveGate.promise;
        if (this.saveError) throw this.saveError;
        state.persisted.set(id, { ...fields });
      },
      async reload() {
        state.reloadIDs.push(id);
        for (const key of Object.keys(fields)) delete fields[key];
        Object.assign(fields, state.persisted.get(id));
      }
    };
    state.items.set(id, object);
    state.persisted.set(id, { ...fields });
    return object;
  }
  return { plugin, state, item };
}

function previouslyManagedItem({ plugin, state, item }, id) {
  const record = item(id, { callNumber: "QA76 original shelf mark", extra: "Citation Key: keep\r\nUser notes" });
  const original = { ...record.fields };
  const snapshot = plugin.snapshot(record);
  const result = new Core.Catalog(Object.values(fixtureDatasets())).lookup(snapshot);
  const plan = Core.planUpdate(snapshot, result, { allowOverwrite: true, now: "2026-08-28T01:00:00.000Z" });
  assert.equal(plan.action, "write");
  record.fields.callNumber = plan.callNumber;
  record.fields.extra = plan.extra;
  state.persisted.set(id, { ...record.fields });
  return { record, original };
}

test("a data-free plugin starts, preserves items during refresh, and can restore an existing backup", async () => {
  const environment = await harness({ builtins: {} });
  const { plugin, state, item } = environment;
  assert.equal(plugin.active, true);
  assert.equal(plugin.catalog.list().length, 0);
  assert.equal(state.activeMenus.size, 2);
  assert.equal(state.activePanes.size, 1);
  assert.ok(state.observer, "a missing dataset must not prevent normal plugin initialization");
  assert.match(plugin.dataSummary(), /导入/);
  for (const kind of ["CCF", "JCR", "CAS"]) {
    assert.ok(plugin.loadWarnings.some(warning => warning.startsWith(kind)), `${kind} should explain its missing data`);
  }

  const fresh = item(40);
  const freshBefore = { ...fresh.fields };
  const { record: managed, original } = previouslyManagedItem(environment, 41);
  const managedBefore = { ...managed.fields };
  const counts = await plugin.apply([fresh, managed], { silent: true });
  assert.equal(counts["no-data"], 1);
  assert.equal(counts["data-unavailable"], 1);
  assert.equal(state.saveIDs.length, 0);
  assert.deepEqual(fresh.fields, freshBefore);
  assert.deepEqual(managed.fields, managedBefore);

  const restored = await plugin.apply([managed], { restore: true, silent: true });
  assert.equal(restored.written, 1);
  assert.deepEqual(managed.fields, original);
  await plugin.stop();
  assert.equal(state.activeMenus.size, 0);
  assert.equal(state.activePanes.size, 0);
  assert.equal(state.observer, null);
});

test("a data-free plugin imports local packages, resumes protected updates, and reloads overrides in a new VM", async () => {
  const environment = await harness({ builtins: {} });
  const { plugin, state } = environment;
  const { record, original } = previouslyManagedItem(environment, 42);
  const packages = fixtureDatasets();
  packages["jcr-2025.json"].records[0].jif = 21.1;

  for (const [index, filename] of ["jcr-2025.json", "ccf-2026.json", "cas-2025.json"].entries()) {
    const data = packages[filename];
    const inputPath = `user-import-${data.kind}.json`;
    state.inputFiles.set(inputPath, data);
    state.pickerQueue.push({ file: inputPath });
    await plugin.importDataset({});
    assert.equal(plugin.catalog.list().length, index + 1);
    assert.equal(state.saveIDs.length, 0, "importing data must not itself change library items");
    assert.equal(plugin.loadWarnings.some(warning => warning.startsWith(data.kind.toUpperCase())), false,
      "a successful import must clear that dataset's missing-data warning");
    if (index < 2) {
      const counts = await plugin.apply([record], { silent: true });
      assert.equal(counts["data-unavailable"], 1);
      assert.equal(state.saveIDs.length, 0, "partial imports cannot remove metrics from a previously complete result");
    }
  }
  assert.equal(state.outputFiles.size, 3);
  assert.equal(plugin.loadWarnings.length, 0);
  const refreshed = await plugin.apply([record], { silent: true });
  assert.equal(refreshed.written, 1);
  assert.equal(record.fields.callNumber, "A|21.1|Q1|1区TOP");
  assert.equal(Core.readState(record.fields.extra).state.original, original.callNumber);
  assert.equal((await plugin.apply([record], { silent: true })).unchanged, 1);
  await plugin.stop();

  const restarted = await harness({ builtins: {}, localFiles: state.outputFiles });
  const nextItem = restarted.item(43);
  assert.equal(restarted.plugin.catalog.list().length, 3);
  assert.equal(restarted.plugin.catalog.lookup(restarted.plugin.snapshot(nextItem)).text, "A|21.1|Q1|1区TOP");
  assert.equal(restarted.state.localReads.length, 3, "startup must read overrides independently of missing builtins");
  assert.equal(restarted.state.writes.length, 0, "startup should only read the persisted overrides");
  assert.equal((await restarted.plugin.apply([nextItem], { silent: true })).written, 1);
  assert.equal(nextItem.fields.callNumber, "A|21.1|Q1|1区TOP");
  await restarted.plugin.stop();
});

test("missing builtins do not bypass validation of local override types and CAS years", async () => {
  const packages = fixtureDatasets();
  const localFiles = new Map([
    ["C:/MOCK-ZOTERO/zotero10-scholar/ccf.json", jcrDataset()],
    ["C:/MOCK-ZOTERO/zotero10-scholar/jcr.json", jcrDataset(2026)],
    ["C:/MOCK-ZOTERO/zotero10-scholar/cas.json", { ...packages["cas-2025.json"], edition: 2024 }]
  ]);
  const { plugin, state, item } = await harness({ builtins: {}, localFiles });
  assert.deepEqual(plugin.catalog.list().map(data => data.kind), ["jcr"]);
  assert.equal(plugin.catalog.indexes.jcr.dataset.metricYear, 2026);
  assert.equal(plugin.catalog.lookup(plugin.snapshot(item(44))).text, "20.4|Q1");
  assert.ok(plugin.loadWarnings.some(warning => warning.startsWith("CCF")));
  assert.ok(plugin.loadWarnings.some(warning => warning.startsWith("CAS")));
  assert.equal(state.writes.length, 0);
  await plugin.stop();
});

test("startup rejects older local JCR only when a newer builtin is available", async () => {
  for (const [builtins, expectedYear] of [[fixtureDatasets(), 2025], [{}, 2024]]) {
    const localFiles = new Map([["C:/MOCK-ZOTERO/zotero10-scholar/jcr.json", jcrDataset(2024)]]);
    const { plugin, state } = await harness({ builtins, localFiles });
    assert.equal(plugin.catalog.indexes.jcr.dataset.metricYear, expectedYear);
    assert.equal(state.writes.length, 0);
    await plugin.stop();
  }
});

test("preview remains tracked through initial about:blank unload and closes on stop", async () => {
  const { plugin, item } = await harness();
  let unload;
  const previewURL = "chrome://zotero10-scholar/content/preview.xhtml";
  const dialog = {
    closed: false,
    addEventListener: (type, handler) => { if (type === "unload") unload = handler; },
    removeEventListener: (type, handler) => { if (type === "unload" && unload === handler) unload = null; },
    close() { this.closed = true; unload?.({ target: { documentURI: previewURL } }); }
  };
  const win = { openDialog: url => { assert.equal(url, previewURL); return dialog; } };
  assert.equal(plugin.preview([item(1)], win), dialog);
  unload({ target: { documentURI: "about:blank" } });
  assert.equal(plugin.dialogs.size, 1, "initial document navigation must not lose the window handle");
  await plugin.stop();
  assert.equal(dialog.closed, true);
  assert.equal(plugin.dialogs.size, 0);
});

test("new-item automatic updates wait for a manual batch instead of being dropped", { timeout: 5000 }, async t => {
  const { plugin, state, item } = await harness();
  assert.equal(state.observerPriority, 700,
    "new-item ranks must run after Format Metadata/Linter priority 666");
  const manualItem = item(1), addedItem = item(2);
  manualItem.saveGate = deferred();
  t.after(() => manualItem.saveGate.resolve());
  const manual = plugin.apply([manualItem], { silent: true });
  await manualItem.saveEntered.promise;

  state.observer.notify("add", "item", [addedItem.id]);
  await tick();
  assert.deepEqual(state.saveIDs, [manualItem.id], "the automatic batch must not run concurrently");
  manualItem.saveGate.resolve();
  await manual;
  await plugin.pendingAuto;

  assert.deepEqual(state.saveIDs, [manualItem.id, addedItem.id]);
  assert.equal(state.persisted.get(addedItem.id).callNumber, "A|20.4|Q1|1区TOP");
  assert.equal(state.commits, 2);
});

test("Zotero priority ordering leaves Scholar Rank after Format Metadata cleanup", async () => {
  const { plugin, state, item } = await harness();
  const added = item(8, { callNumber: "23.6|Q1|3区" });
  const order = [];
  const observers = [
    {
      priority: 666,
      notify: async () => {
        order.push("format-metadata");
        added.fields.callNumber = "";
        state.persisted.set(added.id, { ...added.fields });
      }
    },
    {
      priority: state.observerPriority,
      notify: (...args) => {
        order.push("scholar-rank");
        return state.observer.notify(...args);
      }
    }
  ];

  for (const observer of observers.sort((a, b) => a.priority - b.priority)) {
    await Promise.resolve(observer.notify("add", "item", [added.id], {}));
  }
  await plugin.pendingAuto;

  assert.deepEqual(order, ["format-metadata", "scholar-rank"]);
  assert.equal(state.persisted.get(added.id).callNumber, "A|20.4|Q1|1区TOP");
});

test("an explicit update repairs an externally cleared rank but preserves non-empty manual edits", async () => {
  const environment = await harness();
  const { plugin, state, item } = environment;
  const { record } = previouslyManagedItem(environment, 7);
  const expected = Core.readState(record.fields.extra).state.last;

  record.fields.callNumber = "";
  state.persisted.set(record.id, { ...record.fields });
  assert.equal((await plugin.apply([record], { silent: true }))["manually-edited"], 1);
  assert.equal(record.fields.callNumber, "");

  const repaired = await plugin.apply([record], { repairCleared: true, silent: true });
  assert.equal(repaired.written, 1);
  assert.equal(record.fields.callNumber, expected);

  record.fields.callNumber = "User shelf mark";
  state.persisted.set(record.id, { ...record.fields });
  assert.equal((await plugin.apply([record], { repairCleared: true, silent: true }))["manually-edited"], 1);
  assert.equal(record.fields.callNumber, "User shelf mark");
});

test("the confirmed overwrite menu can refresh a cleared rank after metrics change", async () => {
  const environment = await harness();
  const { plugin, state, item } = environment;
  const { record } = previouslyManagedItem(environment, 9);
  record.fields.callNumber = "";
  state.persisted.set(record.id, { ...record.fields });

  const newer = jcrDataset();
  newer.records[0].jif = 21.1;
  plugin.catalog.replace(newer);
  assert.equal(plugin.catalog.lookup(plugin.snapshot(record)).text, "A|21.1|Q1|1区TOP");

  const itemMenu = state.menuConfigs.get("scholar-items");
  const overwrite = itemMenu.menus[0].menus.find(menu => menu.l10nID === "zsr10-overwrite");
  overwrite.onCommand(null, { items: [record], menuElem: { ownerGlobal: {} } });
  await tick();
  if (plugin.currentOperation) await plugin.currentOperation;
  await tick();

  assert.equal(record.fields.callNumber, "A|21.1|Q1|1区TOP");
  assert.equal(Core.readState(record.fields.extra).state.original, "QA76 original shelf mark");
});

test("stop waits for an in-flight last save and rolls the transaction back", { timeout: 5000 }, async t => {
  const { plugin, state, item } = await harness();
  const only = item(3);
  const original = { ...state.persisted.get(only.id) };
  only.saveGate = deferred();
  t.after(() => only.saveGate.resolve());
  const outcome = plugin.apply([only], { silent: true }).then(value => ({ value }), error => ({ error }));
  await only.saveEntered.promise;

  let stopped = false;
  const stopping = plugin.stop().then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false, "shutdown must not resolve while a write is outstanding");
  only.saveGate.resolve();
  await outcome;
  await stopping;

  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.deepEqual(state.persisted.get(only.id), original);
  assert.deepEqual(only.fields, original, "rollback must also realign the cached Zotero item");
  assert.equal(state.undoActions.length, 0);
  assert.equal(plugin.busy, false);
});

test("a venue change while waiting for the transaction skips the stale metric plan", { timeout: 5000 }, async t => {
  const { plugin, state, item } = await harness();
  const changed = item(4);
  state.transactionGate = deferred();
  t.after(() => state.transactionGate.resolve());
  const update = plugin.apply([changed], { silent: true });
  await state.transactionRequested.promise;

  changed.fields.publicationTitle = "SCIENCE";
  changed.fields.ISSN = "0036-8075";
  // Model an independent user edit committed before this queued transaction.
  state.persisted.set(changed.id, { ...changed.fields });
  state.transactionGate.resolve();
  const counts = await update;

  assert.equal(counts["manually-edited"], 1);
  assert.equal(state.saveIDs.length, 0);
  assert.equal(changed.fields.publicationTitle, "SCIENCE");
  assert.equal(changed.fields.callNumber, "");
  assert.equal(changed.fields.extra, "User note");
});

test("a later save failure rolls back and reloads every touched item", { timeout: 5000 }, async () => {
  const { plugin, state, item } = await harness();
  const first = item(5), second = item(6);
  const originals = [first, second].map(record => ({ ...record.fields }));
  second.saveError = new Error("simulated database failure");

  await assert.rejects(plugin.apply([first, second], { silent: true }), /simulated database failure/);
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.deepEqual(state.reloadIDs, [first.id, second.id]);
  for (const [index, record] of [first, second].entries()) {
    assert.deepEqual(state.persisted.get(record.id), originals[index]);
    assert.deepEqual(record.fields, originals[index]);
  }
  assert.equal(state.undoActions.length, 0);
});

test("overlapping JSON imports cannot downgrade a newer JCR dataset", { timeout: 5000 }, async t => {
  const { plugin, state } = await harness();
  const newerStarted = deferred(), releaseNewer = deferred(), releaseOlder = deferred();
  t.after(() => { releaseNewer.resolve(); releaseOlder.resolve(); });
  state.pickerQueue.push({ file: "newer.json" }, { file: "older.json" });
  state.inputFiles.set("newer.json", jcrDataset(2026));
  state.inputFiles.set("older.json", jcrDataset(2025));
  state.beforeWrite = async (_, data) => {
    if (data.metricYear === 2026) {
      newerStarted.resolve();
      await releaseNewer.promise;
    } else {
      await releaseOlder.promise;
    }
  };

  const newer = plugin.importDataset({});
  await newerStarted.promise;
  // The first import is not committed yet, so an unlocked second import sees
  // the old year and would incorrectly pass the initial no-downgrade guard.
  const olderOutcome = plugin.importDataset({}).then(value => ({ value }), error => ({ error }));
  await tick();
  releaseNewer.resolve();
  await newer;
  releaseOlder.resolve();
  await olderOutcome;

  assert.deepEqual(state.writes.map(write => write.metricYear), [2026]);
  assert.equal(plugin.catalog.indexes.jcr.dataset.metricYear, 2026);
  assert.equal([...state.outputFiles.values()][0].metricYear, 2026);
  assert.equal(plugin.busy, false);
});

test("an import dialog completed after stop cannot write a local override", { timeout: 5000 }, async () => {
  const { plugin, state } = await harness();
  const pickerGate = deferred();
  state.pickerQueue.push({ file: "late.json", gate: pickerGate });
  state.inputFiles.set("late.json", jcrDataset(2026));
  const importing = plugin.importDataset({});
  await plugin.stop();
  pickerGate.resolve();
  await importing;

  assert.equal(state.writes.length, 0);
  assert.equal(plugin.catalog.indexes.jcr.dataset.metricYear, 2025);
});
