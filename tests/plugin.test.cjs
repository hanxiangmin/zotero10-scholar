"use strict";

// Exercise the actual plugin/core in isolated VMs. No real Zotero, UI, filesystem
// writes, or network calls are used by these integration-style regression tests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const Core = require("../src/core.js");
const Metadata = require("../src/metadata.js");
const Reports = require("../src/reports.js");
const Search = require("../src/search.js");

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

async function harness({ builtins = fixtureDatasets(), localFiles = new Map(), fastTimeout = false } = {}) {
  const state = {
    items: new Map(), persisted: new Map(), alerts: [], errors: [], saveIDs: [], reloadIDs: [], dialogs: [],
    doiResponses: new Map(), doiLookups: [], crossrefResponses: new Map(), crossrefLookups: [], titleResponses: [], titleLookups: [], commits: 0, rollbacks: 0, undoActions: [], observer: null, transactionRequested: deferred(),
    transactionGate: null, pickerQueue: [], inputFiles: new Map(),
    outputFiles: new Map([...localFiles].map(([filename, data]) => [filename, structuredClone(data)])),
    writes: [], beforeWrite: null, autoNew: true, resourceReads: [], localReads: [],
    activeMenus: new Set(), activePanes: new Set(), menuConfigs: new Map(), observerPriority: null,
    preferences: { "metadata.auto": false, "metadata.duplicates": true, ...Object.fromEntries(Object.entries(Metadata.DEFAULTS).map(([key, value]) => ["metadata." + key, value])) }
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

  const mainWindow = { openDialog(url, name, features, data) {
    const listeners = new Map();
    const dialog = { url, name, features, data, closed: false, Event, events: [],
      addEventListener: (type, callback) => listeners.set(type, callback),
      dispatchEvent(event) { this.events.push(event.type); listeners.get(event.type)?.(event); },
      close() { this.closed = true; listeners.get("unload")?.({target:{documentURI:url}}); }
    };
    state.dialogs.push(dialog);
    return dialog;
  } };
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
    getMainWindows: () => [], getMainWindow: () => mainWindow,
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
    Prefs: {
      get: key => key.endsWith("autoNew") ? state.autoNew : key.endsWith("quartilePolicy") ? "best" : state.preferences[key.replace("extensions.zotero10scholar.", "")],
      set: (key, value) => { if (key.endsWith("autoNew")) state.autoNew=value; else state.preferences[key.replace("extensions.zotero10scholar.", "")] = value; }
    },
    Promise: { delay: async () => {} },
    Items: {
      getAsync: async ids => ids.map(id => state.items.get(id)),
      loadDataTypes: async () => {},
      getAll: async libraryID => [...state.items.values()].filter(item => item.libraryID === libraryID && !item.deleted)
    },
    Translate: { Search: class {
      setIdentifier(identifier) { assert.deepEqual(Object.keys(identifier), ["DOI"]); this.doi=identifier.DOI; state.doiLookups.push(this.doi); }
      async getTranslators() { return [{translatorID:"synthetic-test-translator"}]; }
      setTranslator(translators) { assert.equal(translators.length,1); }
      async translate(options) {
        assert.equal(options.libraryID,false); assert.equal(options.saveAttachments,false);
        const value=state.doiResponses.get(this.doi);
        if (value instanceof Error) throw value;
        return await value || [];
      }
    } },
    HTTP: { request: async (method, url, options) => {
      assert.equal(method, "GET"); assert.equal(options.responseType, "json"); assert.equal(options.timeout, 15000);
      if (url.startsWith("https://api.crossref.org/works?")) {
        state.titleLookups.push(url);
        const value=await state.titleResponses;
        if(value instanceof Error)throw value;
        return {response:{message:{items:value}}};
      }
      assert.ok(url.startsWith("https://api.crossref.org/works/"));
      const doi = decodeURIComponent(url.slice("https://api.crossref.org/works/".length));
      state.crossrefLookups.push(doi);
      const value = state.crossrefResponses.get(doi);
      if (!value || value instanceof Error) throw value || new Error("No synthetic Crossref response");
      return { response: { message: value } };
    } },
    CreatorTypes: { getID: name => name, isValidForItemType: name => ["author","editor","contributor","translator"].includes(name) },
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
    ScholarCore: Core, ScholarMetadata: Metadata, ScholarSearch: Search, ScholarReports: Reports, Zotero, IOUtils, clearTimeout,
    setTimeout: (callback, ms) => setTimeout(callback, fastTimeout && ms === 45000 ? 1 : ms),
    PathUtils: { join: (...parts) => parts.join("/") },
    ChromeUtils: { importESModule: () => ({ FilePicker }) },
    Services: { prompt: { alert: (_, __, text) => state.alerts.push(text), confirm: () => true } }
  };
  vm.createContext(scope);
  vm.runInContext(PLUGIN_CODE, scope, { filename: "src/plugin.js" });
  const plugin = scope.ScholarPlugin;
  await plugin.start({ id: "test@mock.invalid", version: "1", rootURI: "jar:file:///MOCK/extensions/test@mock.invalid.xpi!/" });

  function item(id, values = {}) {
    const fields = { creators: [], title: `Paper ${id}`, publicationTitle: PAMI, ISSN: "0162-8828", callNumber: "", extra: "User note", ...values };
    const object = {
      id, key: `ITEM${id}`, libraryID: 1, itemType: "journalArticle", itemTypeID: 1,
      library: { libraryType: "user" }, deleted: false, isFeedItem: false,
      fields, saveEntered: deferred(), saveGate: null, saveError: null,
      isRegularItem: () => true, isEditable: () => true,
      getCreatorsJSON: () => structuredClone(fields.creators),
      setCreators: values => { fields.creators=structuredClone(values); },
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

test("imported abbreviation tables persist across reload and malformed replacements are rejected", async () => {
  const { plugin, state, item } = await harness();
  const table = { schemaVersion: 1, kind: "journal-abbreviations", source: "Synthetic user table", records: [{ title: PAMI, abbreviation: "Fixture Abbr" }] };
  state.inputFiles.set("/table.json", table); state.pickerQueue.push({ file: "/table.json" });
  await plugin.importAbbreviations();
  assert.equal(plugin.abbreviations.count, 1);
  assert.equal(state.saveIDs.length, 0);
  const reopened = await harness({ localFiles: state.outputFiles });
  assert.equal(reopened.plugin.abbreviations.count, 1);
  const record = item(312);
  assert.equal(plugin.metadataPlan(plugin.snapshot(record)).fields.journalAbbreviation, "Fixture Abbr");
  state.inputFiles.set("/bad.json", null); state.pickerQueue.push({ file: "/bad.json" });
  await assert.rejects(plugin.importAbbreviations(), /缩写表/);
  assert.equal(plugin.abbreviations.count, 1);
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

test("three menu actions directly clean metadata, query DOI, or update ranks", async () => {
  const {plugin,state,item}=await harness();
  const menus=state.menuConfigs.get("scholar-items").menus[0].menus;
  assert.deepEqual(Array.from(menus,m=>m.l10nID),["zsr10-metadata","zsr10-doi","zsr10-update"]);
  const record=item(100,{DOI:"doi:10.1234/x",callNumber:"Old",extra:"Existing note"});
  menus[0].onCommand(null,{items:[record],menuElem:{ownerGlobal:{}}}); await tick();
  if (plugin.currentOperation) await plugin.currentOperation;
  assert.equal(record.fields.DOI,"10.1234/x"); assert.equal(record.fields.callNumber,"Old");
  menus[2].onCommand(null,{items:[record],menuElem:{ownerGlobal:{}}}); await tick();
  if (plugin.currentOperation) await plugin.currentOperation;
  assert.equal(record.fields.callNumber,"A|20.4|Q1|1区TOP"); assert.equal(record.fields.extra,"Existing note");
  assert.equal(state.doiLookups.length,0);
});

test("manual rank update overwrites old locks without changing historical Extra records", async () => {
  const {plugin,state,item}=await harness();
  for (const [index,extra] of ['User note','Zotero Scholar Rank: {bad','Zotero Scholar Manual: {"v":1,"fields":{"callNumber":{"original":"A","last":"C"}}}'].entries()) {
    const record=item(110+index,{callNumber:"C",extra});
    assert.equal((await plugin.apply([record],{silent:true})).written,1);
    assert.equal(record.fields.extra,extra);
    assert.equal((await plugin.apply([record],{silent:true})).unchanged,1);
  }
  assert.equal(state.undoActions.length,3);
});

test("automatic modes remain independent and never query DOI or overwrite existing call numbers", async () => {
  const {plugin,state,item}=await harness();
  for (const [index,autoMetadata,autoRanks] of [[0,false,false],[1,true,false],[2,false,true],[3,true,true]]) {
    state.preferences["metadata.auto"]=autoMetadata; state.autoNew=autoRanks;
    const record=item(120+index,{DOI:"doi:10.1234/x"});
    state.observer.notify("add","item",[record.id]); await plugin.pendingAuto;
    assert.equal(record.fields.DOI,autoMetadata?"10.1234/x":"doi:10.1234/x");
    assert.equal(record.fields.callNumber,autoRanks?"A|20.4|Q1|1区TOP":"");
    assert.equal(record.fields.extra,"User note");
  }
  const existing=item(124,{callNumber:"My shelf",DOI:"doi:10.1234/x"});
  state.observer.notify("add","item",[existing.id]); await plugin.pendingAuto;
  assert.equal(existing.fields.callNumber,"My shelf");
  state.observer.notify("modify","item",[existing.id]); await plugin.pendingAuto;
  assert.equal(state.doiLookups.length,0);
});

test("missing catalogs and unknown venues preserve existing fields", async () => {
  const {plugin,state,item}=await harness({builtins:{}});
  const record=item(130,{callNumber:"C",DOI:"doi:10.1234/x"}),before={...record.fields};
  assert.equal((await plugin.apply([record],{silent:true}))["no-data"],1);
  assert.deepEqual(record.fields,before);
  assert.equal((await plugin.apply([record],{silent:true,metadata:true})).written,1);
  assert.equal(record.fields.DOI,"10.1234/x"); assert.equal(record.fields.callNumber,"C");
  state.pickerQueue.push({file:"jcr.json"}); state.inputFiles.set("jcr.json",jcrDataset());
  await plugin.importDataset({}); await plugin.apply([record],{silent:true});
  assert.equal(record.fields.callNumber,"20.4|Q1");
});

test("management always uses main-window selection and has no hidden restore or manual-edit modes", async () => {
  const {plugin,state,item}=await harness(); const record=item(140,{DOI:"doi:10.1234/x"}); let selected=[];
  plugin.window=()=>({ZoteroPane:{getSelectedItems:()=>selected}});
  await plugin.manageSelected("ranks",{}); assert.equal(state.alerts.length,1);
  selected=[record]; await plugin.manageSelected("metadata",{});
  assert.equal(record.fields.DOI,"10.1234/x"); assert.equal(record.fields.callNumber,"");
  await assert.rejects(plugin.manageSelected("restoreManual",{}),/未知/);
});

const remote = (DOI, overrides={}) => ({itemType:"journalArticle",DOI,title:"A returned paper title",publicationTitle:PAMI,date:"2025",creators:[{creatorType:"author",firstName:"New",lastName:"Author"}],...overrides});

test("manual DOI command uses the non-saving native API, updates in place, and caches duplicate DOI queries", async () => {
  const {plugin,state,item}=await harness();
  const records=[item(150,{DOI:"doi:10.1234/x",callNumber:"C",pages:"Keep pages"}),item(151,{DOI:"10.1234/X",callNumber:"C"})];
  state.doiResponses.set("10.1234/x",[remote("10.1234/x",{extra:"Do not import",callNumber:"A",attachments:[{}],tags:["no"]})]);
  const menus=state.menuConfigs.get("scholar-items").menus[0].menus;
  menus[1].onCommand(null,{items:records,menuElem:{ownerGlobal:{}}}); await tick();
  if (plugin.currentOperation) await plugin.currentOperation;
  assert.deepEqual(state.doiLookups,["10.1234/x"]);
  assert.equal(state.items.size,2); assert.equal(state.saveIDs.length,2);
  for (const record of records) {
    assert.equal(record.fields.title,"A returned paper title"); assert.equal(record.fields.callNumber,"C");
    assert.equal(record.fields.extra,"User note"); assert.equal(record.fields.date,"2025");
    assert.equal(record.fields.creators[0].lastName,"Author");
    assert.equal(record.fields.tags,undefined); assert.equal(record.fields.attachments,undefined);
  }
  assert.equal(records[0].fields.pages,"Keep pages");
  assert.equal((await plugin.updateByDOI(records,{silent:true})).unchanged,2);
});

test("DOI failures, invalid identifiers, ambiguous responses, and read-only items are skipped independently", async () => {
  const {plugin,state,item}=await harness();
  const records=[item(160,{DOI:""}),item(161,{DOI:"10.1234/fail"}),item(162,{DOI:"10.1234/ambiguous"}),item(163,{DOI:"10.1234/readonly"}),item(164,{DOI:"10.1234/good"})];
  records[3].isEditable=()=>false;
  state.doiResponses.set("10.1234/fail",new Error("network failure"));
  state.doiResponses.set("10.1234/ambiguous",[remote("10.1234/ambiguous"),remote("10.1234/ambiguous")]);
  state.doiResponses.set("10.1234/good",[remote("10.1234/good")]);
  const before=records.map(record=>structuredClone(record.fields));
  const counts=await plugin.updateByDOI(records,{silent:true});
  assert.equal(counts.written,1); assert.equal(counts["search-insufficient"],1); assert.equal(counts["lookup-failed"],1); assert.equal(counts["doi-mismatch"],1); assert.equal(counts["read-only"],1);
  for(let i=0;i<4;i++) assert.deepEqual(records[i].fields,before[i]);
  assert.equal(state.doiLookups.includes("10.1234/readonly"),false);
});

test("DOI response cannot overwrite a user edit made while the request was pending", async () => {
  const {plugin,state,item}=await harness(); const record=item(170,{DOI:"10.1234/x"}),gate=deferred();
  state.doiResponses.set("10.1234/x",gate.promise);
  const update=plugin.updateByDOI([record],{silent:true}); await tick();
  record.fields.creators=[{creatorType:"author",name:"User correction"}];
  gate.resolve([remote("10.1234/x")]);
  assert.equal((await update)["manually-edited"],1); assert.equal(state.saveIDs.length,0);
});

test("disabling during a pending DOI lookup prevents later writes", async () => {
  const {plugin,state,item}=await harness(); const record=item(171,{DOI:"10.1234/x"}),gate=deferred();
  state.doiResponses.set("10.1234/x",gate.promise);
  const update=plugin.updateByDOI([record],{silent:true}); await tick();
  const stop=plugin.stop(); gate.resolve([remote("10.1234/x")]); await update; await stop;
  assert.equal(state.saveIDs.length,0); assert.equal(plugin.active,false);
});

test("failed DOI batch rolls back both changed authors and fields", async () => {
  const {plugin,state,item}=await harness(); const records=[item(180,{DOI:"10.1234/x"}),item(181,{DOI:"10.1234/y"})];
  for (const record of records) state.doiResponses.set(record.fields.DOI,[remote(record.fields.DOI)]);
  const before=records.map(record=>structuredClone(record.fields)); records[1].saveError=new Error("failed DOI save");
  await assert.rejects(plugin.updateByDOI(records,{silent:true}),/failed DOI save/);
  records.forEach((record,index)=>assert.deepEqual(record.fields,before[index])); assert.equal(state.rollbacks,1);
});

test("a timed-out native DOI query cannot write when the late response eventually arrives", async () => {
  const {plugin,state,item}=await harness({fastTimeout:true});
  const record=item(190,{DOI:"10.1234/late"}),gate=deferred();
  state.doiResponses.set("10.1234/late",gate.promise);
  const before=structuredClone(record.fields);
  assert.equal((await plugin.updateByDOI([record],{silent:true}))["lookup-failed"],1);
  gate.resolve([remote("10.1234/late")]); await tick();
  assert.equal(state.saveIDs.length,0); assert.deepEqual(record.fields,before);
  assert.equal(plugin.busy,false);
});

test("supplementary Crossref dates are DOI-only, cached, and applied by the manual command", async () => {
  const {plugin,state,item}=await harness();
  const record=item(200,{DOI:"10.1234/x",title:"Old title",date:"2026"});
  record.itemType="conferencePaper";
  state.doiResponses.set("10.1234/x",[remote("10.1234/x",{itemType:"bookSection",title:"HGTL: a Test for CcRCC",date:"2026"})]);
  state.crossrefResponses.set("10.1234/x",{DOI:"10.1234/x",type:"book-chapter",title:["HGTL: a Test for CcRCC"],
    assertion:[{group:{name:"ConferenceInfo"},name:"conference_year",value:"2025"}]});
  assert.equal((await plugin.updateByDOI([record],{silent:true})).written,1);
  assert.equal(record.fields.date,"2025"); assert.equal(record.fields.title,"HGTL: A test for ccRCC");
  assert.deepEqual(state.crossrefLookups,["10.1234/x"]);
  assert.equal(record.itemType,"conferencePaper"); assert.equal(record.fields.extra,"User note");
  assert.equal(record.fields.scholarCrossref,undefined);
});

test("a failed supplementary date request leaves conference date intact while other fields update", async () => {
  const {plugin,state,item}=await harness();
  const record=item(201,{DOI:"10.1234/x",date:"2025"});record.itemType="conferencePaper";
  state.doiResponses.set("10.1234/x",[remote("10.1234/x",{itemType:"conferencePaper",date:"2026"})]);
  state.crossrefResponses.set("10.1234/x",new Error("429"));
  const counts=await plugin.updateByDOI([record],{silent:true});
  assert.equal(counts.written,1); assert.equal(counts["conference-date-unverified"],1);
  assert.equal(record.fields.date,"2025"); assert.equal(record.fields.title,"A returned paper title");
});

test("automatic metadata standardizes conference names offline while rank-only updates do not", async () => {
  const {plugin,state,item}=await harness();
  const standard="International Conference on Medical Image Computing and Computer-Assisted Intervention";
  plugin.catalog.replace({schemaVersion:1,kind:"ccf",edition:2026,source:"Synthetic",records:[{type:"conference",title:standard,abbreviation:"MICCAI",rank:"B"}]});
  const record=item(210,{DOI:"10.1234/x",conferenceName:"MICCAI",proceedingsTitle:"MICCAI-2005",date:"2025",callNumber:"Keep"});
  record.itemType="conferencePaper";
  await plugin.apply([record],{silent:true});
  assert.equal(record.fields.callNumber,"B");assert.equal(record.fields.conferenceName,"MICCAI");
  state.preferences["metadata.auto"]=true;state.autoNew=false;
  state.observer.notify("add","item",[record.id]);await plugin.pendingAuto;
  assert.equal(record.fields.conferenceName,standard);assert.equal(record.fields.proceedingsTitle,standard);
  assert.equal(record.fields.date,"2025");assert.equal(record.fields.callNumber,"B");
  assert.equal(state.doiLookups.length,0);assert.equal(state.crossrefLookups.length,0);
});

test("each manual update reports only committed fields with complete before and after values", async () => {
  const {plugin,state,item}=await harness();
  const record=item(220,{title:"A Study: a Model",DOI:"doi:10.1234/x",language:"en",callNumber:"C"});
  await plugin.apply([record],{metadata:true});
  const metadata=state.dialogs[0].data.batches[0];
  assert.equal(metadata.operation,"整理元数据");
  assert.deepEqual(metadata.items[0].changes.find(change=>change.field==="title"),
    {field:"title",label:"标题",before:"A Study: a Model",after:"A study: A model"});
  assert.ok(metadata.items[0].changes.every(change=>!["callNumber","extra","date"].includes(change.field)));
  assert.equal(metadata.items[0].changes.find(change=>change.field==="DOI").before,"doi:10.1234/x");
  await plugin.apply([record]);
  const ranks=state.dialogs[1].data.batches[0];
  assert.equal(ranks.operation,"更新分区指标");
  assert.deepEqual(ranks.items[0].changes,[{field:"callNumber",label:"索书号（分区指标）",before:"C",after:"A|20.4|Q1|1区TOP"}]);
  state.doiResponses.set("10.1234/x",[remote("10.1234/x")]);
  await plugin.updateByDOI([record]);
  const doi=state.dialogs[2].data.batches[0];
  assert.equal(doi.operation,"联网更新元数据");
  assert.deepEqual(doi.items[0].changes.find(change=>change.field==="date"),{field:"date",label:"日期",before:"",after:"2025"});
  assert.deepEqual(doi.items[0].changes.find(change=>change.field==="creators"),{field:"creators",label:"作者及贡献者",before:"",after:"作者：Author, New"});
  assert.ok(doi.items[0].changes.every(change=>!["callNumber","extra"].includes(change.field)));
  assert.equal(state.commits,3); assert.equal(state.alerts.length,0);
});

test("automatic updates open and reuse a nonmodal result window, including empty results", async () => {
  const {plugin,state,item}=await harness();
  state.preferences["metadata.auto"]=true;
  const first=item(230,{DOI:"doi:10.1234/x"}),second=item(231,{DOI:"doi:10.1234/y"});
  state.observer.notify("add","item",[first.id,second.id]);await plugin.pendingAuto;
  assert.equal(state.dialogs.length,1);
  const dialog=state.dialogs[0];
  assert.equal(dialog.data.automatic,true);
  dialog.dispatchEvent({type:"unload",target:{documentURI:"about:blank"}});
  assert.equal(plugin.autoResult.win,dialog);assert.equal(plugin.resultWindows.has(dialog),true);
  assert.equal(dialog.features.includes("modal"),false);
  assert.equal(dialog.data.batches[0].items.length,2);
  assert.ok(dialog.data.batches[0].items.every(row=>row.changes.some(change=>change.field==="DOI")&&row.changes.some(change=>change.field==="callNumber")));
  state.observer.notify("add","item",[first.id]);await plugin.pendingAuto;
  assert.equal(state.dialogs.length,1); assert.equal(dialog.data.batches.length,2);
  assert.equal(dialog.data.batches[1].items.length,0);
  assert.match(Reports.toText(dialog.data.batches[1]),/没有修改任何字段/);
  assert.deepEqual(dialog.events,["unload","scholar-rank-results"]);
  dialog.close();
  state.observer.notify("add","item",[first.id]);await plugin.pendingAuto;
  assert.equal(state.dialogs.length,2);
  assert.equal(state.doiLookups.length,0);
  await plugin.stop(); assert.equal(state.dialogs[1].closed,true);
  assert.equal(plugin.resultWindows.size,0); assert.equal(plugin.autoResult,null);
});

test("reports exclude read-only, unchanged and concurrently edited items, but explain skip counts", async () => {
  const {plugin,state,item}=await harness();
  const records=[item(240),item(241),item(242,{callNumber:"A|20.4|Q1|1区TOP"}),item(243)];
  records[1].isEditable=()=>false;
  const gate=deferred();state.transactionGate=gate;
  const updating=plugin.apply(records);
  await state.transactionRequested.promise;
  records[3].fields.title="User correction";gate.resolve();await updating;
  const report=state.dialogs[0].data.batches[0];
  assert.deepEqual(Array.from(report.items,row=>row.id),[240]);
  assert.deepEqual(report.counts,{"read-only":1,unchanged:1,"manually-edited":1,written:1});
  assert.match(Reports.toText(report),/处理期间条目发生变化/);
  assert.equal(Reports.toText(report).includes("User correction"),false);
});

test("rolled-back batches never display a success diff and release operation state", async () => {
  const {plugin,state,item}=await harness();
  const records=[item(250),item(251)]; records[1].saveError=new Error("save failed");
  await assert.rejects(plugin.apply(records),/save failed/);
  assert.equal(state.dialogs.length,1); assert.equal(state.rollbacks,1);
  const report=state.dialogs[0].data.batches[0];
  assert.equal(report.items.length,0);assert.match(Reports.toText(report),/本批修改未保存/);
  assert.equal(plugin.busy,false); assert.equal(plugin.currentOperation,null);
});

test("an update with no DOI response still opens an explicit no-change report", async () => {
  const {plugin,state,item}=await harness();
  state.doiResponses.set("10.1234/fail",new Error("offline"));
  await plugin.updateByDOI([item(260,{DOI:"10.1234/fail"}),item(261,{DOI:""})]);
  const report=state.dialogs[0].data.batches[0];
  assert.equal(report.items.length,0);
  assert.match(Reports.toText(report),/DOI 查询失败/);
  assert.match(Reports.toText(report),/无 DOI 且标题、作者或出版信息不足/);
  assert.match(Reports.toText(report),/本次没有修改任何字段/);
});

test("a result window failure reports committed changes without retrying the save", async () => {
  const {plugin,state,item}=await harness();
  await plugin.apply([item(270)],{win:{openDialog(){throw new Error("window unavailable");}}});
  assert.equal(state.commits,1);assert.deepEqual(state.saveIDs,[270]);
  assert.match(state.alerts[0],/更新结果窗口未能打开/);
  assert.match(state.alerts[0],/修改前：（空）/);
  assert.match(state.alerts[0],/修改后：A\|20.4\|Q1\|1区TOP/);
  assert.equal(plugin.busy,false);
});

test("report formatting preserves author order, empty changes and untrusted text as plain data", () => {
  const longText="<img src=x onerror=alert(1)>".repeat(100);
  const before={id:1,title:longText,callNumber:"B",creators:[{creatorType:"author",firstName:"Old",lastName:"Person"}]};
  const after={...before,callNumber:"",creators:[{creatorType:"editor",name:"Team <script>"},{creatorType:"author",firstName:"New",lastName:"Person"}]};
  const row=Reports.changedItem(before,after,["callNumber","creators","title"]);
  assert.equal(row.title,longText);
  assert.equal(row.changes[0].after,"");
  assert.equal(row.changes[1].after,"编辑：Team <script>\n作者：Person, New");
  assert.equal(Reports.changedItem(before,before,["title"]),null);
});

const noDOIFields = () => ({title:"A fictional study of neural cells",DOI:"",date:"2025",publicationTitle:PAMI,
  creators:[{creatorType:"author",firstName:"Jane",lastName:"Smith"}],extra:"PRIVATE NOTE",abstractNote:"PRIVATE ABSTRACT",callNumber:"Keep"});
const foundRecord = () => ({DOI:"10.1234/found",type:"journal-article",title:["A fictional study of neural cells"],author:[{given:"Jane",family:"Smith"}],
  "container-title":[PAMI],ISSN:["0162-8828"],"published-print":{"date-parts":[[2026]]}});
const foundSource = () => remote("10.1234/found",{...noDOIFields(),DOI:"10.1234/found",date:"2026"});

test("manual online update uses DOI first, searches only absent DOI, and reports a genuinely empty original DOI", async () => {
  const {plugin,state,item}=await harness();
  const records=[item(280,{DOI:"10.1234/existing"}),item(281,noDOIFields()),item(282,noDOIFields())];
  state.doiResponses.set("10.1234/existing",[remote("10.1234/existing")]);
  state.titleResponses=[foundRecord()];state.doiResponses.set("10.1234/found",[foundSource()]);state.crossrefResponses.set("10.1234/found",foundRecord());
  assert.equal((await plugin.updateByDOI(records)).written,3);
  assert.deepEqual(state.doiLookups,["10.1234/existing","10.1234/found"]);assert.equal(state.titleLookups.length,1);
  const params=new URL(state.titleLookups[0]).searchParams;
  assert.deepEqual([...params.keys()],["query.bibliographic","query.author","rows"]);
  assert.equal(params.get("query.author"),"Jane Smith");assert.equal(params.get("rows"),"20");
  assert.equal(decodeURIComponent(state.titleLookups[0]).includes("PRIVATE"),false);
  const report=state.dialogs[0].data.batches[0];
  for(const record of records.slice(1)) {
    assert.equal(record.fields.DOI,"10.1234/found");assert.equal(record.fields.date,"2026");
    assert.equal(record.fields.extra,"PRIVATE NOTE");assert.equal(record.fields.callNumber,"Keep");
    const change=report.items.find(row=>row.id===record.id).changes.find(row=>row.field==="DOI");
    assert.equal(change.before,"");assert.equal(change.after,"10.1234/found");
  }
  assert.equal((await plugin.updateByDOI(records.slice(1),{silent:true})).unchanged,2);
  assert.equal(state.titleLookups.length,1);
});

test("failed or invalid existing DOIs never trigger a title search", async () => {
  const {plugin,state,item}=await harness();
  const bad=item(283,{...noDOIFields(),DOI:"malformed"}),failed=item(284,{...noDOIFields(),DOI:"10.1234/fail"});
  state.doiResponses.set("10.1234/fail",new Error("offline"));
  const result=await plugin.updateByDOI([bad,failed]);
  assert.equal(result["invalid-doi"],1);assert.equal(result["lookup-failed"],1);
  assert.equal(state.titleLookups.length,0);assert.equal(state.saveIDs.length,0);
});

test("title search failures and ambiguous matches leave all metadata and the empty DOI unchanged", async () => {
  for(const [response,reason] of [[new Error("429"),"search-failed"],[[],"search-no-match"],[[foundRecord(),{...foundRecord(),DOI:"10.1234/other"}],"search-ambiguous"]]) {
    const {plugin,state,item}=await harness(),record=item(285,noDOIFields()),before=structuredClone(record.fields);
    state.titleResponses=response;
    assert.equal((await plugin.updateByDOI([record]))[reason],1);
    assert.deepEqual(record.fields,before);assert.equal(state.doiLookups.length,0);assert.equal(state.saveIDs.length,0);
    assert.match(Reports.toText(state.dialogs[0].data.batches[0]),/本次没有修改任何字段/);
  }
});

test("a DOI or author edit during title search invalidates the saved plan without overwriting it", async () => {
  for(const change of [{DOI:"10.1234/user-correction"},{creators:[{creatorType:"author",name:"User author correction"}]}]) {
    const {plugin,state,item}=await harness(),record=item(286,noDOIFields()),gate=deferred();
    state.titleResponses=gate.promise;state.doiResponses.set("10.1234/found",[foundSource()]);
    const updating=plugin.updateByDOI([record],{silent:true});await tick();Object.assign(record.fields,change);
    gate.resolve([foundRecord()]);assert.equal((await updating)["manually-edited"],1);
    assert.equal(state.saveIDs.length,0);
    for(const [key,value] of Object.entries(change))assert.deepEqual(record.fields[key],value);
  }
});

test("disabling during a title search prevents subsequent DOI lookup and writes", async () => {
  const {plugin,state,item}=await harness(),record=item(287,noDOIFields()),gate=deferred();
  state.titleResponses=gate.promise;
  const updating=plugin.updateByDOI([record],{silent:true});await tick();
  const stopping=plugin.stop();gate.resolve([foundRecord()]);await updating;await stopping;
  assert.equal(state.doiLookups.length,0);assert.equal(state.saveIDs.length,0);assert.equal(state.dialogs.length,0);
});

test("automatic cleanup and ranks never call the new title-search endpoint", async () => {
  const {plugin,state,item}=await harness();state.preferences["metadata.auto"]=true;state.autoNew=true;
  const record=item(288,{...noDOIFields(),callNumber:""});
  state.observer.notify("add","item",[record.id]);await plugin.pendingAuto;
  assert.equal(record.fields.DOI,"");assert.equal(record.fields.callNumber,"A|20.4|Q1|1区TOP");
  assert.equal(state.titleLookups.length,0);assert.equal(state.doiLookups.length,0);
});
