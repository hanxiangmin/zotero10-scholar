"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  Catalog, validateDataset, normalizeISSNs, readState,
  planUpdate, planRestore, STATE_PREFIX
} = require("../src/core.js");

// Small synthetic fixtures exercise behavior; the bundled-data test below
// separately checks the actual data shipped with the plugin.
const JOURNAL = "Example Journal of Tests";
const ISSN = "1234-5679";
const NOW = "2026-08-28T01:00:00.000Z";
const CVPR = "IEEE/CVF Conference on Computer Vision and Pattern Recognition";

function dataset(kind, records, overrides = {}) {
  const metadata = {
    ccf: { edition: "2026-test" },
    jcr: { edition: 2026, metricYear: 2025 },
    cas: { edition: 2025, system: "CAS", categoryLevel: "major" }
  }[kind];
  return {
    schemaVersion: 1, kind, source: "Synthetic unit-test fixture",
    ...metadata, ...overrides, records
  };
}

function ccfJournal(overrides = {}) {
  return { type: "journal", title: JOURNAL, rank: "A", issns: [ISSN], ...overrides };
}

function jcrJournal(overrides = {}) {
  return {
    title: JOURNAL, issns: [ISSN], jif: 20.4,
    quartiles: [{ category: "Synthetic subject", quartile: "Q1" }],
    ...overrides
  };
}

function casJournal(overrides = {}) {
  return { title: JOURNAL, issns: [ISSN], division: 1, top: true, ...overrides };
}

function journal(overrides = {}) {
  return { itemType: "journalArticle", publicationTitle: JOURNAL, ...overrides };
}

function fullCatalog() {
  return new Catalog([
    dataset("ccf", [ccfJournal()]),
    dataset("jcr", [jcrJournal()]),
    dataset("cas", [casJournal()])
  ]);
}

function conferenceCatalog() {
  return new Catalog([dataset("ccf", [
    { type: "conference", title: CVPR, abbreviation: "CVPR", rank: "A" },
    { type: "conference", title: "Annual Meeting of the Association for Computational Linguistics", abbreviation: "ACL", rank: "A" }
  ])]);
}

function metricCatalog({ rank = null, jif = null, quartile = null, division = null } = {}) {
  const datasets = [];
  if (rank !== null) datasets.push(dataset("ccf", [ccfJournal({ rank })]));
  if (jif !== null || quartile !== null) {
    datasets.push(dataset("jcr", [jcrJournal({
      jif, quartiles: quartile === null ? [] : [{ category: "Synthetic subject", quartile }]
    })]));
  }
  if (division !== null) datasets.push(dataset("cas", [casJournal({ division, top: false })]));
  return new Catalog(datasets);
}

function applyPlan(item, plan) {
  assert.equal(plan.action, "write", JSON.stringify(plan));
  return { ...item, callNumber: plan.callNumber, extra: plan.extra };
}

function stateLine(overrides = {}) {
  return STATE_PREFIX + JSON.stringify({
    v: 1, original: "Original shelf mark", last: "A|20.4|Q1|1区TOP",
    addedSeparator: true, ...overrides
  });
}

function legacyManagedItem(original, result, last) {
  const addedSeparator = Boolean(original.extra && !original.extra.endsWith("\n"));
  return {
    ...original, callNumber: last,
    extra: original.extra + (addedSeparator ? "\n" : "") + stateLine({
      original: original.callNumber, last, addedSeparator,
      updatedAt: NOW, provenance: result.provenance, quartilePolicy: result.policy
    })
  };
}

function legacyRefreshCases() {
  return [
    [{ rank: "C" }, "C|—|—|—", "C"],
    [{ jif: 3.6, quartile: "Q1", division: 3 }, "—|3.6|Q1|3区", "3.6|Q1|3区"],
    [{ rank: "B", quartile: "Q2" }, "B|—|Q2|—", "B|Q2"],
    [{}, "—|—|—|—", ""]
  ].map(([metrics, last, expected]) => ({
    // An all-missing legacy result can be refreshed only when the catalog is
    // available and the venue is unknown, not when the data files are absent.
    result: Object.keys(metrics).length ? metricCatalog(metrics).lookup(journal()) :
      fullCatalog().lookup(journal({ publicationTitle: "Unknown legacy venue" })),
    last, expected
  }));
}

test("the optional real TPAMI data, never a mock, produces A|20.4|Q1|1区TOP", t => {
  const dataDir = path.join(__dirname, "..", "data");
  const filenames = ["ccf-2026.json", "jcr-2025.json", "cas-2025.json"];
  const missing = filenames.filter(name => !fs.existsSync(path.join(dataDir, name)));
  if (missing.length) {
    const message = `Real metric packages are not included in this checkout: ${missing.join(", ")}`;
    if (process.env.SCHOLAR_REQUIRE_DATA === "1") assert.fail(`SCHOLAR_REQUIRE_DATA=1: ${message}`);
    t.skip(message + "; set SCHOLAR_REQUIRE_DATA=1 to require this private integration test");
    return;
  }
  // Existing but malformed or incorrect files must still fail. Synthetic
  // fixtures above never stand in for these optional private data packages.
  const datasets = filenames.map(name => JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8")));
  assert.deepEqual(new Set(datasets.map(data => data.kind)), new Set(["ccf", "jcr", "cas"]),
    "The integration test requires all three generated data packages");

  const result = new Catalog(datasets).lookup(journal({
    publicationTitle: "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    journalAbbreviation: "TPAMI", ISSN: "0162-8828"
  }));
  assert.equal(result.text, "A|20.4|Q1|1区TOP");
  assert.equal(result.provenance.jcr.metricYear, 2025);
  assert.equal(result.provenance.cas.edition, 2025);
});

test("all missing-metric combinations omit empty text slots while preserving the four internal fields", () => {
  const cases = [
    [{}, ["—", "—", "—", "—"], ""],
    [{ rank: "C" }, ["C", "—", "—", "—"], "C"],
    [{ jif: 3.6 }, ["—", "3.6", "—", "—"], "3.6"],
    [{ rank: "C", jif: 3.6 }, ["C", "3.6", "—", "—"], "C|3.6"],
    [{ quartile: "Q1" }, ["—", "—", "Q1", "—"], "Q1"],
    [{ rank: "C", quartile: "Q1" }, ["C", "—", "Q1", "—"], "C|Q1"],
    [{ jif: 3.6, quartile: "Q1" }, ["—", "3.6", "Q1", "—"], "3.6|Q1"],
    [{ rank: "C", jif: 3.6, quartile: "Q1" }, ["C", "3.6", "Q1", "—"], "C|3.6|Q1"],
    [{ division: 3 }, ["—", "—", "—", "3区"], "3区"],
    [{ rank: "C", division: 3 }, ["C", "—", "—", "3区"], "C|3区"],
    [{ jif: 3.6, division: 3 }, ["—", "3.6", "—", "3区"], "3.6|3区"],
    [{ rank: "C", jif: 3.6, division: 3 }, ["C", "3.6", "—", "3区"], "C|3.6|3区"],
    [{ quartile: "Q1", division: 3 }, ["—", "—", "Q1", "3区"], "Q1|3区"],
    [{ rank: "C", quartile: "Q1", division: 3 }, ["C", "—", "Q1", "3区"], "C|Q1|3区"],
    [{ jif: 3.6, quartile: "Q1", division: 3 }, ["—", "3.6", "Q1", "3区"], "3.6|Q1|3区"],
    [{ rank: "C", jif: 3.6, quartile: "Q1", division: 3 }, ["C", "3.6", "Q1", "3区"], "C|3.6|Q1|3区"]
  ];
  for (const [metrics, fields, text] of cases) {
    const result = metricCatalog(metrics).lookup(journal());
    const label = JSON.stringify(metrics);
    assert.deepEqual(result.fields, fields, label);
    assert.equal(result.text, text, label);
    assert.equal(result.hasData, text !== "", label);
  }
});

test("all CCF ranks remain visible on their own for journals and conferences", () => {
  for (const rank of ["A", "B", "C"]) {
    const catalog = new Catalog([dataset("ccf", [
      ccfJournal({ rank }), { type: "conference", title: CVPR, abbreviation: "CVPR", rank }
    ])]);
    for (const item of [journal(), { itemType: "conferencePaper", conferenceName: "CVPR" }]) {
      const result = catalog.lookup(item);
      assert.equal(result.text, rank, `${item.itemType}: ${rank}`);
      assert.deepEqual(result.fields, [rank, "—", "—", "—"]);
    }
  }
});

test("journal names normalize punctuation and accents but never use substring matches", () => {
  const catalog = new Catalog([dataset("jcr", [jcrJournal({
    title: "Études & Research: Methods", issns: []
  })])]);
  assert.equal(catalog.lookup(journal({ publicationTitle: "ETUDES and Research — Methods" })).fields[1], "20.4");
  for (const publicationTitle of ["Études & Research", "Études & Research: Methods Supplement"]) {
    const result = catalog.lookup(journal({ publicationTitle }));
    assert.equal(result.hasData, false, publicationTitle);
  }
});

test("valid ISSNs resolve a journal despite a different title and malformed ISSNs do not", () => {
  const catalog = fullCatalog();
  const valid = catalog.lookup(journal({ publicationTitle: "Unrecognized translated name", ISSN: "12345679" }));
  assert.equal(valid.text, "A|20.4|Q1|1区TOP");
  assert.equal(valid.provenance.jcr.matchedBy, "ISSN");
  const invalid = catalog.lookup(journal({ publicationTitle: "Unrecognized translated name", ISSN: "1234-5678" }));
  assert.equal(invalid.hasData, false);
});

test("ISSN parsing validates checksums, accepts X, and deduplicates print/electronic forms", () => {
  assert.deepEqual(normalizeISSNs([
    "ISSN 0162-8828; eISSN 19393539", "01628828", "2434-561x", "0000-0000", "1234-5678"
  ]), ["0162-8828", "1939-3539", "2434-561X"]);
});

test("an ISSN match has priority over a conflicting publication title", () => {
  const catalog = new Catalog([dataset("jcr", [
    jcrJournal({ jif: 5.2 }),
    jcrJournal({ title: "Different Journal", issns: ["0162-8828"], jif: 99 })
  ])]);
  const result = catalog.lookup(journal({ publicationTitle: "Different Journal", ISSN }));
  assert.equal(result.fields[1], "5.2");
  assert.equal(result.provenance.jcr.matchedBy, "ISSN");
});

test("ambiguous ISSNs fail closed even when the title could break the tie", () => {
  const catalog = new Catalog([dataset("jcr", [
    jcrJournal(), jcrJournal({ title: "A different journal sharing the same identifier", jif: 9 })
  ])]);
  const result = catalog.lookup(journal({ ISSN }));
  assert.equal(result.hasData, false);
  assert.equal(result.reasons.jcr, "ambiguous");
});

test("exact publication titles win over ambiguous abbreviations; abbreviation-only ambiguity is skipped", () => {
  const catalog = new Catalog([dataset("jcr", [
    jcrJournal({ aliases: ["EJT"] }),
    jcrJournal({ title: "Other Journal", issns: [], aliases: ["EJT"], jif: 4 })
  ])]);
  assert.equal(catalog.lookup(journal({ journalAbbreviation: "EJT" })).fields[1], "20.4");
  const ambiguous = catalog.lookup(journal({ publicationTitle: "Unknown title", journalAbbreviation: "EJT" }));
  assert.equal(ambiguous.hasData, false);
  assert.equal(ambiguous.reasons.jcr, "ambiguous");
});

test("journal ISSN lookup cannot borrow a CCF rank from a conference record", () => {
  const catalog = new Catalog([dataset("ccf", [{
    type: "conference", title: "Example Conference", rank: "A", issns: [ISSN]
  }])]);
  assert.equal(catalog.lookup(journal({ publicationTitle: "Unknown Journal", ISSN })).hasData, false);
});

test("identical CCF grades across subject categories are safe, conflicting grades are ambiguous", () => {
  const first = ccfJournal({ category: "Artificial Intelligence" });
  const second = ccfJournal({ category: "Computer Graphics" });
  const duplicates = new Catalog([dataset("ccf", [first, second])]);
  assert.equal(duplicates.lookup(journal()).fields[0], "A");

  const conflicting = new Catalog([dataset("ccf", [first, { ...second, rank: "B" }])]);
  const result = conflicting.lookup(journal());
  assert.equal(result.hasData, false);
  assert.equal(result.reasons.ccf, "ambiguous");
});

test("different conference names sharing an abbreviation are not merged merely because both are A", () => {
  const catalog = new Catalog([dataset("ccf", [
    { type: "conference", title: "Example Conference One", abbreviation: "ECO", rank: "A" },
    { type: "conference", title: "Example Conference Other", abbreviation: "ECO", rank: "A" }
  ])]);
  const result = catalog.lookup({ itemType: "conferencePaper", proceedingsTitle: "Proceedings of ECO 2026" });
  assert.equal(result.hasData, false);
  assert.equal(result.reasons.ccf, "ambiguous");
});

test("CVPR full papers match their proceedings while conference JIF/JCR/CAS remain inapplicable", () => {
  const result = conferenceCatalog().lookup({
    itemType: "conferencePaper", conferenceName: "CVPR",
    proceedingsTitle: `Proceedings of the 2026 ${CVPR} (CVPR)`,
    publicationTitle: JOURNAL, ISSN
  });
  assert.equal(result.text, "A");
  assert.deepEqual(result.fields, ["A", "—", "—", "—"]);
  assert.equal(result.reasons.jcr, "not-applicable");
  assert.equal(result.reasons.cas, "not-applicable");
});

test("workshops, Findings and ancillary tracks override an exact parent-conference name", () => {
  const catalog = conferenceCatalog();
  for (const [conferenceName, proceedingsTitle] of [
    ["CVPR", "2026 IEEE/CVF CVPR Workshops"],
    ["CVPR Workshops", "CVPR"],
    ["ACL", "Findings of the Association for Computational Linguistics: ACL 2026"],
    ["CVPR", "CVPR 2026 Short Papers"],
    ["CVPR", "CVPR 2026 Companion"],
    ["CVPR", "CVPR 2026 Demonstrations"]
  ]) {
    const result = catalog.lookup({ itemType: "conferencePaper", conferenceName, proceedingsTitle });
    assert.equal(result.hasData, false, proceedingsTitle);
    assert.equal(result.reasons.ccf, "excluded-conference-track", proceedingsTitle);
    assert.equal(planUpdate({ callNumber: "", extra: "" }, result).action, "skip");
  }
});

test("conference acronyms must be complete tokens, not parts of CVPRW or MYCVPR", () => {
  for (const proceedingsTitle of ["Proceedings of CVPRW 2026", "Proceedings of MYCVPR 2026"]) {
    assert.equal(conferenceCatalog().lookup({ itemType: "conferencePaper", proceedingsTitle }).hasData, false);
  }
});

test("unknown venues and preprints never produce a write plan", () => {
  const catalog = fullCatalog();
  const item = { callNumber: "", extra: "Citation Key: untouched" };
  for (const input of [
    journal({ publicationTitle: "Unknown Journal" }),
    { itemType: "conferencePaper", conferenceName: "Unknown Conference" },
    journal({ itemType: "preprint" }),
    journal({ itemType: "report" })
  ]) {
    const result = catalog.lookup(input);
    assert.equal(planUpdate(item, result).action, "skip", input.itemType);
  }
  assert.deepEqual(item, { callNumber: "", extra: "Citation Key: untouched" });
});

test("a managed journal changed to an unknown venue clears stale metrics and retains its original backup", () => {
  const catalog = fullCatalog();
  const original = { callNumber: "QA76.9 original shelf mark", extra: "DOI: example\nCitation Key: keep" };
  const managed = applyPlan(original, planUpdate(original, catalog.lookup(journal()), {
    allowOverwrite: true, now: NOW
  }));
  const unknown = catalog.lookup(journal({ publicationTitle: "Completely Unknown Replacement Journal" }));
  assert.equal(unknown.hasData, false);

  const updated = applyPlan(managed, planUpdate(managed, unknown, { now: "2026-08-29T01:00:00Z" }));
  assert.equal(updated.callNumber, "");
  const backup = readState(updated.extra).state;
  assert.equal(backup.original, original.callNumber);
  assert.equal(backup.last, updated.callNumber);
  assert.deepEqual(backup.provenance, {});
  assert.equal(updated.extra.split(STATE_PREFIX).length - 1, 1);
  assert.deepEqual(applyPlan(updated, planRestore(updated)), original);
});

test("an unknown venue on a first refresh does not write placeholders or create a backup", () => {
  const unknown = fullCatalog().lookup(journal({ publicationTitle: "Completely Unknown Journal" }));
  for (const callNumber of ["", "User shelf mark"]) {
    const item = { callNumber, extra: "Citation Key: untouched" };
    const before = { ...item };
    assert.deepEqual(planUpdate(item, unknown, { allowOverwrite: true }), { action: "skip", reason: "no-data" });
    assert.deepEqual(item, before);
    assert.equal(readState(item.extra).state, null);
  }
});

test("an unknown venue does not clear a managed call number that the user edited manually", () => {
  const catalog = fullCatalog();
  const original = { callNumber: "", extra: "Preserve user notes" };
  const managed = applyPlan(original, planUpdate(original, catalog.lookup(journal()), { now: NOW }));
  managed.callNumber = "User corrected shelf mark";
  const before = { ...managed };
  const unknown = catalog.lookup(journal({ publicationTitle: "Completely Unknown Replacement Journal" }));

  assert.deepEqual(planUpdate(managed, unknown, { allowOverwrite: true }), {
    action: "skip", reason: "manually-edited"
  });
  assert.deepEqual(managed, before);
});

test("missing datasets protect managed metrics even when the remaining catalog cannot find the venue", () => {
  const original = { callNumber: "QA76 original shelf mark", extra: "Citation Key: preserved" };
  const managed = applyPlan(original, planUpdate(original, fullCatalog().lookup(journal()), {
    allowOverwrite: true, now: NOW
  }));
  const availableCases = [
    [],
    [dataset("jcr", [jcrJournal()]), dataset("cas", [casJournal()])],
    [dataset("ccf", [ccfJournal()]), dataset("cas", [casJournal()])],
    [dataset("ccf", [ccfJournal()]), dataset("jcr", [jcrJournal()])]
  ];
  for (const datasets of availableCases) {
    const catalog = new Catalog(datasets);
    for (const publicationTitle of [JOURNAL, "Unknown replacement venue"]) {
      const result = catalog.lookup(journal({ publicationTitle }));
      assert.deepEqual(new Set(result.availableKinds), new Set(datasets.map(data => data.kind)));
      const before = { ...managed };
      for (const allowOverwrite of [false, true]) {
        assert.deepEqual(planUpdate(managed, result, { allowOverwrite }), {
          action: "skip", reason: "data-unavailable"
        }, `${result.availableKinds.join(", ") || "no data"}: ${publicationTitle}`);
      }
      assert.deepEqual(managed, before);
      assert.deepEqual(applyPlan(managed, planRestore(managed)), original,
        "Restoring the original call number does not require any metric datasets");
    }
  }
});

test("a partial catalog may refresh a managed item when all of its previously used dataset kinds remain available", () => {
  const catalog = metricCatalog({ rank: "B" });
  const original = { callNumber: "", extra: "Keep this note" };
  const saved = applyPlan(original, planUpdate(original, catalog.lookup(journal()), { now: NOW }));
  catalog.replace(dataset("ccf", [ccfJournal({ rank: "C" })]));
  const result = catalog.lookup(journal());
  assert.deepEqual(result.availableKinds, ["ccf"]);
  const updated = applyPlan(saved, planUpdate(saved, result));
  assert.equal(updated.callNumber, "C");
  assert.deepEqual(applyPlan(updated, planRestore(updated)), original);
});

test("importing the missing dataset kinds resumes managed updates without replacing the original backup", () => {
  const original = { callNumber: "Original shelf mark", extra: "DOI: preserve\r\nCitation Key: keep\r\n" };
  const managed = applyPlan(original, planUpdate(original, fullCatalog().lookup(journal()), {
    allowOverwrite: true, now: NOW
  }));
  const catalog = new Catalog([]);
  for (const data of [
    dataset("jcr", [jcrJournal({ jif: 21.1 })]),
    dataset("ccf", [ccfJournal({ rank: "B" })])
  ]) {
    assert.deepEqual(planUpdate(managed, catalog.lookup(journal())), {
      action: "skip", reason: "data-unavailable"
    });
    catalog.replace(data);
  }
  assert.deepEqual(planUpdate(managed, catalog.lookup(journal())), {
    action: "skip", reason: "data-unavailable"
  });
  catalog.replace(dataset("cas", [casJournal({ division: 2, top: false })]));
  const result = catalog.lookup(journal());
  const updated = applyPlan(managed, planUpdate(managed, result));
  assert.equal(updated.callNumber, "B|21.1|Q1|2区");
  assert.equal(readState(updated.extra).state.original, original.callNumber);
  assert.deepEqual(planUpdate(updated, result), { action: "skip", reason: "unchanged" });
  assert.deepEqual(applyPlan(updated, planRestore(updated)), original);
});

test("older loaded JCR data cannot replace or clear a newer managed result", () => {
  const original = { callNumber: "QA76 original shelf mark", extra: "Citation Key: keep\nUser notes" };
  const managed = applyPlan(original, planUpdate(original,
    metricCatalog({ jif: 20.4, quartile: "Q1" }).lookup(journal()), {
      allowOverwrite: true, now: NOW
    }));
  const before = { ...managed };
  const older = new Catalog([dataset("jcr", [jcrJournal({ jif: 9 })], {
    edition: 2025, metricYear: 2024
  })]);

  for (const publicationTitle of [JOURNAL, "Unknown replacement venue"]) {
    const result = older.lookup(journal({ publicationTitle }));
    assert.equal(result.jcrMetricYear, 2024,
      "The loaded source year remains known even when its journal does not match");
    assert.equal(Boolean(result.provenance.jcr), publicationTitle === JOURNAL);
    for (const allowOverwrite of [false, true]) {
      assert.deepEqual(planUpdate(managed, result, { allowOverwrite }), {
        action: "skip", reason: "outdated-data"
      }, publicationTitle);
    }
    assert.deepEqual(managed, before, "A rejected downgrade leaves the complete saved backup unchanged");
  }
  assert.deepEqual(applyPlan(managed, planRestore(managed)), original);
});

test("an item without saved metrics may still use an older JCR source", () => {
  const original = { callNumber: "", extra: "Citation Key: new-item" };
  const catalog = new Catalog([dataset("jcr", [jcrJournal({ jif: 9 })], {
    edition: 2025, metricYear: 2024
  })]);
  const updated = applyPlan(original, planUpdate(original, catalog.lookup(journal()), { now: NOW }));
  assert.equal(updated.callNumber, "9|Q1");
  assert.equal(readState(updated.extra).state.provenance.jcr.metricYear, 2024);
});

test("same-year and newer JCR sources can refresh or clear managed metrics without replacing the original backup", () => {
  const original = { callNumber: "Original shelf mark", extra: "DOI: preserve\r\nCitation Key: keep\r\n" };
  const managed = applyPlan(original, planUpdate(original,
    metricCatalog({ jif: 20.4, quartile: "Q1" }).lookup(journal()), {
      allowOverwrite: true, now: NOW
    }));

  for (const metricYear of [2025, 2026]) {
    const catalog = new Catalog([dataset("jcr", [jcrJournal({ jif: 21.1 })], {
      edition: metricYear + 1, metricYear
    })]);
    for (const publicationTitle of [JOURNAL, "Unknown replacement venue"]) {
      const matched = publicationTitle === JOURNAL;
      const result = catalog.lookup(journal({ publicationTitle }));
      const updated = applyPlan(managed, planUpdate(managed, result));
      assert.equal(updated.callNumber, matched ? "21.1|Q1" : "");
      const state = readState(updated.extra).state;
      assert.equal(state.original, original.callNumber);
      assert.equal(state.provenance.jcr?.metricYear, matched ? metricYear : undefined);
      assert.deepEqual(applyPlan(updated, planRestore(updated)), original);
    }
  }
});

test("JIF <0.1 and actual zero remain visible while missing JIF produces empty text", () => {
  for (const [record, field, text, hasData] of [
    [jcrJournal({ jif: null, jifDisplay: "<0.1", quartiles: [] }), "<0.1", "<0.1", true],
    [jcrJournal({ jif: 0, quartiles: [] }), "0", "0", true],
    [jcrJournal({ jif: null, quartiles: [] }), "—", "", false]
  ]) {
    const result = new Catalog([dataset("jcr", [record])]).lookup(journal());
    assert.deepEqual(result.fields, ["—", field, "—", "—"]);
    assert.equal(result.text, text);
    assert.equal(result.hasData, hasData);
    const plan = planUpdate({ callNumber: "", extra: "" }, result);
    if (hasData) {
      assert.equal(plan.action, "write");
      assert.equal(plan.callNumber, text);
    } else {
      assert.deepEqual(plan, { action: "skip", reason: "no-data" });
    }
  }
});

test("multi-category JCR policies sort and deduplicate quartiles while retaining all category evidence", () => {
  const quartiles = [
    { category: "Category C", quartile: "Q3" },
    { category: "Category A", quartile: "Q1" },
    { category: "Category B", quartile: "Q2" },
    { category: "Another category", quartile: "Q1" }
  ];
  for (const jif of [20.4, null]) {
    const catalog = new Catalog([dataset("jcr", [jcrJournal({ jif, quartiles })])]);
    for (const [policy, expected] of [["best", "Q1"], ["worst", "Q3"], ["all", "Q1/Q2/Q3"]]) {
      const result = catalog.lookup(journal(), policy);
      assert.deepEqual(result.fields, ["—", jif === null ? "—" : "20.4", expected, "—"]);
      assert.equal(result.text, jif === null ? expected : `20.4|${expected}`);
      assert.deepEqual(result.provenance.jcr.quartiles, quartiles);
    }
  }
});

test("CAS TOP is independent of division, and unknown TOP is not fabricated", () => {
  for (const [division, top, display] of [
    [1, false, "1区"], [1, null, "1区"], [2, true, "2区TOP"], [1, true, "1区TOP"]
  ]) {
    const result = new Catalog([dataset("cas", [casJournal({ division, top })])]).lookup(journal());
    assert.equal(result.fields[3], display);
    assert.equal(result.text, display);
    assert.equal(result.provenance.cas.top, top);
  }
});

test("existing call numbers are protected by default and opt-in overwrite keeps the original backup", () => {
  const result = fullCatalog().lookup(journal());
  const original = { callNumber: "QA76.9 — 架位 12", extra: "DOI: 10.0000/example\nCitation Key: mykey" };
  assert.deepEqual(planUpdate(original, result), { action: "skip", reason: "existing-call-number" });

  const saved = applyPlan(original, planUpdate(original, result, { allowOverwrite: true, now: NOW }));
  const backup = readState(saved.extra).state;
  assert.equal(backup.original, original.callNumber);
  assert.equal(backup.last, result.text);
  const restored = applyPlan(saved, planRestore(saved));
  assert.deepEqual(restored, original);
});

test("backup and restore preserve unrelated Extra content, including existing newline styles", () => {
  const result = fullCatalog().lookup(journal());
  for (const extra of ["", "User notes without newline", "DOI: example\n", "DOI: example\r\nCitation Key: x\r\n"]) {
    const original = { callNumber: "", extra };
    const saved = applyPlan(original, planUpdate(original, result, { now: NOW }));
    assert.ok(saved.extra.startsWith(extra));
    assert.equal(saved.extra.split(STATE_PREFIX).length - 1, 1);
    assert.deepEqual(applyPlan(saved, planRestore(saved)), original);
  }
});

test("repeated updates retain the first call-number backup and do not duplicate metadata", () => {
  const catalog = fullCatalog();
  const original = { callNumber: "Original shelf number", extra: "My note" };
  const first = applyPlan(original, planUpdate(original, catalog.lookup(journal()), { allowOverwrite: true, now: NOW }));
  catalog.replace(dataset("jcr", [jcrJournal({ jif: 21.1 })]));
  const second = applyPlan(first, planUpdate(first, catalog.lookup(journal()), { now: "2026-08-29T01:00:00Z" }));
  assert.equal(second.callNumber, "A|21.1|Q1|1区TOP");
  assert.equal(readState(second.extra).state.original, original.callNumber);
  assert.equal(second.extra.split(STATE_PREFIX).length - 1, 1);
  assert.deepEqual(applyPlan(second, planRestore(second)), original);
});

test("ordinary refresh migrates 3.0.0 display state once and preserves backups, Extra, and restoration", () => {
  const migrationTime = "2026-08-29T01:00:00.000Z";
  const appendedNotes = "\nUser-added after 3.0.0: keep $& and 原始笔记\r\n";
  for (const { result, last, expected } of legacyRefreshCases()) {
    for (const extra of ["", "Citation Key: keep\nUser note without final newline", "DOI: example\r\nCitation Key: keep\r\n"]) {
      const original = { callNumber: "QA76.9 — 原索书号", extra };
      const legacy = legacyManagedItem(original, result, last);
      legacy.extra += appendedNotes;
      const before = { ...legacy };
      const label = `${last} -> ${JSON.stringify(expected)}, Extra=${JSON.stringify(extra)}`;

      // The old state uses the same metrics and provenance: only its display
      // changes, so normal refresh must not require an overwrite opt-in.
      const migrated = applyPlan(legacy, planUpdate(legacy, result, { now: migrationTime }));
      assert.equal(migrated.callNumber, expected, label);
      const backup = readState(migrated.extra).state;
      assert.equal(backup.original, original.callNumber, label);
      assert.equal(backup.last, expected, label);
      assert.equal(backup.updatedAt, migrationTime, label);
      assert.deepEqual(backup.provenance, readState(legacy.extra).state.provenance, label);
      assert.equal(backup.quartilePolicy, result.policy, label);
      assert.equal(migrated.extra.split(STATE_PREFIX).length - 1, 1, label);
      assert.equal(migrated.extra.startsWith(extra), true, label);
      assert.equal(migrated.extra.endsWith(appendedNotes), true, label);
      assert.deepEqual(legacy, before, "Planning must not mutate the legacy item");

      assert.deepEqual(planUpdate(migrated, result, { now: "2026-08-30T01:00:00.000Z" }), {
        action: "skip", reason: "unchanged"
      }, label);
      assert.equal(readState(migrated.extra).state.updatedAt, migrationTime, label);
      assert.deepEqual(applyPlan(migrated, planRestore(migrated)), {
        ...original, extra: extra + appendedNotes
      }, label);
    }
  }
});

test("manual changes to legacy call numbers block migration and restore even if they match the new compact text", () => {
  for (const { result, last, expected } of legacyRefreshCases()) {
    const original = { callNumber: "Original shelf mark", extra: "Retain user notes" };
    for (const callNumber of ["User corrected shelf mark", expected]) {
      const edited = { ...legacyManagedItem(original, result, last), callNumber };
      const before = { ...edited };
      for (const allowOverwrite of [false, true]) {
        assert.deepEqual(planUpdate(edited, result, { allowOverwrite }), {
          action: "skip", reason: "manually-edited"
        }, `${last} manually changed to ${JSON.stringify(callNumber)}`);
      }
      assert.deepEqual(planRestore(edited), { action: "skip", reason: "manually-edited" });
      assert.deepEqual(edited, before);
    }
  }
});

test("old-looking call numbers without plugin state are not automatically migrated", () => {
  for (const { result, last } of legacyRefreshCases()) {
    if (!result.hasData) continue;
    const unmanaged = { callNumber: last, extra: "Citation Key: user-owned" };
    const before = { ...unmanaged };
    assert.deepEqual(planUpdate(unmanaged, result), { action: "skip", reason: "existing-call-number" });
    assert.deepEqual(planRestore(unmanaged), { action: "skip", reason: "no-backup" });
    assert.deepEqual(unmanaged, before);
  }
});

test("restoring removes only the plugin record and retains Extra notes added afterwards", () => {
  const original = { callNumber: "", extra: "DOI: example\nOriginal note" };
  const saved = applyPlan(original, planUpdate(original, fullCatalog().lookup(journal()), { now: NOW }));
  saved.extra += "\nUser-added: keep this note";
  const restored = applyPlan(saved, planRestore(saved));
  assert.equal(restored.callNumber, "");
  assert.equal(restored.extra, original.extra + "\nUser-added: keep this note");
});

test("manual call-number edits block both refresh and restore, even with overwrite enabled", () => {
  const result = fullCatalog().lookup(journal());
  const saved = applyPlan({ callNumber: "", extra: "Keep" }, planUpdate({ callNumber: "", extra: "Keep" }, result));
  saved.callNumber = "User corrected shelf number";
  const before = { ...saved };
  assert.deepEqual(planUpdate(saved, result, { allowOverwrite: true }), { action: "skip", reason: "manually-edited" });
  assert.deepEqual(planRestore(saved), { action: "skip", reason: "manually-edited" });
  assert.deepEqual(saved, before);
});

test("only an explicit repair may restore an externally cleared managed result", () => {
  const result = fullCatalog().lookup(journal());
  const original = { callNumber: "", extra: "Keep" };
  const managed = applyPlan(original, planUpdate(original, result, { now: NOW }));
  const cleared = { ...managed, callNumber: "" };

  assert.deepEqual(planUpdate(cleared, result), { action: "skip", reason: "manually-edited" });
  const repaired = applyPlan(cleared, planUpdate(cleared, result, { repairCleared: true }));
  assert.equal(repaired.callNumber, result.text);
  assert.equal(readState(repaired.extra).state.original, original.callNumber);

  const changedResult = metricCatalog({ rank: "A", jif: 21.1, quartile: "Q1", division: 1 }).lookup(journal());
  assert.notEqual(changedResult.text, result.text);
  assert.deepEqual(planUpdate(cleared, changedResult, { repairCleared: true }), {
    action: "skip", reason: "manually-edited"
  }, "repair must not turn an empty manual edit into a metric refresh");
  const refreshed = applyPlan(cleared, planUpdate(cleared, changedResult, {
    repairCleared: true, allowOverwrite: true
  }));
  assert.equal(refreshed.callNumber, changedResult.text,
    "the confirmed overwrite path may refresh a cleared value with changed metrics");
  assert.equal(readState(refreshed.extra).state.original, original.callNumber);

  const manual = { ...managed, callNumber: "User shelf mark" };
  assert.deepEqual(planUpdate(manual, result, { repairCleared: true }), {
    action: "skip", reason: "manually-edited"
  });
});

test("corrupt JSON, unsupported state schemas, and duplicate backup prefixes block all writes", () => {
  const result = fullCatalog().lookup(journal());
  const invalidExtras = [
    STATE_PREFIX + "{broken JSON", STATE_PREFIX + "null",
    stateLine({ v: 2 }), stateLine({ original: 42 }), stateLine({ last: null }),
    stateLine() + "\n" + stateLine(),
    stateLine() + "\r\n" + STATE_PREFIX + "{broken JSON"
  ];
  for (const extra of invalidExtras) {
    const item = { callNumber: result.text, extra };
    assert.equal(readState(extra).corrupt, true, extra);
    assert.deepEqual(planUpdate(item, result, { allowOverwrite: true }), { action: "skip", reason: "invalid-backup" });
    assert.deepEqual(planRestore(item), { action: "skip", reason: "invalid-backup" });
    assert.equal(item.extra, extra);
  }
});

test("a refresh with identical values and provenance is a no-op despite a new timestamp", () => {
  const result = fullCatalog().lookup(journal());
  const saved = applyPlan({ callNumber: "", extra: "" }, planUpdate({ callNumber: "", extra: "" }, result, { now: NOW }));
  assert.deepEqual(planUpdate(saved, result, { now: "2026-09-01T00:00:00Z" }), { action: "skip", reason: "unchanged" });
  assert.equal(readState(saved.extra).state.updatedAt, NOW);
  assert.deepEqual(planRestore({ callNumber: "Shelf", extra: "No backup" }), { action: "skip", reason: "no-backup" });
});

test("CAS packages reject XR filenames even inside POSIX or Windows paths", () => {
  for (const sourceFile of [
    "XR2025-UTF8.csv", "datasets/XR2025-UTF8.csv", "C:\\metrics\\XR2025-UTF8.csv"
  ]) {
    assert.throws(() => validateDataset(dataset("cas", [casJournal()], { sourceFile })), /新锐|XR/, sourceFile);
  }
});

test("CAS packages reject a relabelled Xinrui source, other years, and minor-category substitutes", () => {
  for (const overrides of [
    { source: "2025 新锐分区" }, { source: "Xinrui ranking 2025" },
    { edition: 2024 }, { edition: 2026 }, { edition: "2025" },
    { system: "XR" }, { categoryLevel: "minor" }
  ]) {
    assert.throws(() => validateDataset(dataset("cas", [casJournal()], overrides)), undefined, JSON.stringify(overrides));
  }
});

test("JCR release and metric years must be independently present and one year apart", () => {
  for (const overrides of [
    { edition: 2025, metricYear: 2025 },
    { edition: 2026, metricYear: 2024 },
    { edition: 2026, metricYear: undefined },
    { edition: "2026", metricYear: 2025 }
  ]) {
    assert.throws(() => validateDataset(dataset("jcr", [jcrJournal()], overrides)));
  }
});

test("malformed JIF, quartile, and TOP values are rejected instead of becoming plausible numbers", () => {
  for (const overrides of [
    { jif: "20.4" }, { jif: -1 }, { jif: NaN }, { jif: Infinity },
    { jif: undefined }, { jif: 0, jifDisplay: "<0.1" },
    { jif: null, jifDisplay: "N/A" },
    { quartiles: [{ category: "Category", quartile: "Q0" }] },
    { quartiles: [{ quartile: "Q1" }] }
  ]) {
    assert.throws(() => validateDataset(dataset("jcr", [jcrJournal(overrides)])));
  }
  for (const overrides of [{ division: 0 }, { division: 5 }, { top: "true" }, { top: undefined }]) {
    assert.throws(() => validateDataset(dataset("cas", [casJournal(overrides)])));
  }
});

test("a rejected replacement dataset leaves the previously working catalog intact", () => {
  const catalog = fullCatalog();
  const before = catalog.lookup(journal());
  assert.throws(() => catalog.replace(dataset("cas", [casJournal({ division: 4 })], { edition: 2024 })));
  assert.deepEqual(catalog.lookup(journal()), before);
});
