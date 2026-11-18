"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  Catalog, validateDataset, normalizeISSNs, planUpdate
} = require("../src/core.js");

// Small synthetic fixtures exercise behavior; the bundled-data test below
// separately checks the actual data shipped with the plugin.
const JOURNAL = "Example Journal of Tests";
const ISSN = "1234-5679";
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

test("official TSMC punctuation and dataset spelling share metrics without renaming the item", () => {
  const title="IEEE Transactions on Systems Man Cybernetics-Systems";
  const catalog=new Catalog([dataset("ccf",[ccfJournal({title,issns:[],rank:"B"})]),dataset("jcr",[jcrJournal({title,issns:["2168-2216"]})]),dataset("cas",[casJournal({title,issns:["2168-2232"]})])]);
  const item=journal({publicationTitle:"IEEE Transactions on Systems, Man, and Cybernetics: Systems"});
  assert.equal(catalog.lookup(item).text,"B|20.4|Q1|1区TOP");
  assert.equal(catalog.lookup({...item,ISSN:"2168-2232"}).text,"B|20.4|Q1|1区TOP");
  assert.equal(item.publicationTitle,"IEEE Transactions on Systems, Man, and Cybernetics: Systems");
});

test("historical SMC titles and contradictory ISSNs never inherit successor metrics", () => {
  const catalog=new Catalog([dataset("ccf",[ccfJournal({title:"IEEE Transactions on Cybernetics",issns:[],rank:"B"})]),dataset("jcr",[jcrJournal({title:"IEEE Transactions on Cybernetics",issns:["2168-2267"]})])]);
  const old=journal({publicationTitle:"IEEE Transactions on Systems, Man, and Cybernetics, Part B (Cybernetics)",ISSN:"1083-4419"});
  assert.equal(catalog.lookup(old).hasData,false);
  const conflict=catalog.lookup({...old,publicationTitle:"IEEE Transactions on Cybernetics"});
  assert.equal(conflict.hasData,false);assert.equal(conflict.reasons.ccf,"journal-identity-conflict");
  assert.equal(catalog.lookup(journal({publicationTitle:"IEEE Transactions on Cybernetics",ISSN:"2168-2909"})).hasData,false);
});

test("a CCF entry without ISSNs can use the same journal's verified dataset ISSNs", () => {
  const catalog=new Catalog([dataset("ccf",[ccfJournal({issns:[]})]),dataset("jcr",[jcrJournal()])]);
  assert.equal(catalog.lookup(journal({publicationTitle:"",ISSN})).text,"A|20.4|Q1");
  assert.equal(catalog.lookup(journal({publicationTitle:"Different",ISSN})).provenance.ccf.matchedBy,"ISSN");
});

test("CVPR historical Computer Society editions identify the main meeting and retain track exclusions", () => {
  const catalog=conferenceCatalog();
  for(const proceedingsTitle of ["2009 IEEE Conference on Computer Vision and Pattern Recognition","2005 IEEE Computer Society Conference on Computer Vision and Pattern Recognition (CVPR'05)"])
    assert.equal(catalog.lookup({itemType:"conferencePaper",proceedingsTitle}).text,"A");
  assert.equal(catalog.lookup({itemType:"conferencePaper",proceedingsTitle:"2009 IEEE Computer Society Conference on Computer Vision and Pattern Recognition Workshops"}).hasData,false);
});

test("bibliographic acronym/year/location suffixes do not obstruct a matching full conference title", () => {
  const catalog=conferenceCatalog();
  assert.equal(catalog.lookup({itemType:"conferencePaper",proceedingsTitle:"2009 IEEE Computer Society Conference on Computer Vision and Pattern Recognition, CVPR2009, Miami, Florida, USA"}).text,"A");
  assert.equal(catalog.lookup({itemType:"conferencePaper",proceedingsTitle:"Different Conference, CVPR 2009, Miami, USA"}).hasData,false);
});

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

test("a known ISSN and a different known journal name are a conflict, never silently mixed", () => {
  const catalog = new Catalog([dataset("jcr", [
    jcrJournal({ jif: 5.2 }),
    jcrJournal({ title: "Different Journal", issns: ["0162-8828"], jif: 99 })
  ])]);
  const result = catalog.lookup(journal({ publicationTitle: "Different Journal", ISSN }));
  assert.equal(result.hasData, false);
  assert.equal(result.reasons.jcr, "journal-identity-conflict");
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

test("conference full names reject acronym collisions without deleting any existing rank", () => {
  const catalog = new Catalog([dataset("ccf", [{ type: "conference", title: "Conference on Computational Complexity", abbreviation: "CCC", rank: "B" }])]);
  const input = { itemType: "conferencePaper", conferenceName: "CCC", proceedingsTitle: "2018 37th Chinese Control Conference (CCC)", callNumber: "B" };
  const result = catalog.lookup(input);
  assert.equal(result.hasData, false);
  assert.equal(result.reasons.ccf, "conference-name-conflict");
  assert.deepEqual(planUpdate(input, result), { action: "skip", reason: "no-data" });
  assert.equal(planUpdate(input, result, { allowOverwrite: false }).action, "skip");
  assert.equal(planUpdate({ ...input, callNumber: "QA76" }, result).action, "skip");
  assert.equal(catalog.lookup({ ...input, proceedingsTitle: "Conference on Computational Complexity 2026" }).text, "B");
  assert.equal(catalog.lookup({ itemType: "conferencePaper", conferenceName: "CCC" }).text, "B");
});

test("KDD and IJCAI report spellings match full venues and restore cleared ranks", () => {
  const records = [
    { type: "conference", title: "ACM SIGKDD Conference on Knowledge Discovery and Data Mining", abbreviation: "SIGKDD", rank: "A" },
    { type: "conference", title: "International Joint Conference on Artificial Intelligence", abbreviation: "IJCAI", rank: "B" }
  ];
  const catalog = new Catalog([dataset("ccf", records)]);
  // Exact venue strings from the user-provided report; grades use the 2026 edition.
  for (const [conferenceName, proceedingsTitle, rank] of [
    ["", "Proceedings of the 26th ACM SIGKDD International Conference on Knowledge Discovery & Data Mining", "A"],
    ["IJCAI", "Proceedings of the Twenty-Eighth International Joint Conference on Artificial Intelligence", "B"],
    ["Twenty-Seventh International Joint Conference on Artificial Intelligence {IJCAI-18}", "Proceedings of the Twenty-Seventh International Joint Conference on Artificial Intelligence", "B"],
    ["Thirty-Third International Joint Conference on Artificial Intelligence {IJCAI-24}", "Proceedings of the Thirty-ThirdInternational Joint Conference on Artificial Intelligence", "B"]
  ]) {
    const item = { itemType: "conferencePaper", conferenceName, proceedingsTitle, callNumber: "" };
    const result = catalog.lookup(item);
    assert.equal(result.text, rank, proceedingsTitle);
    assert.deepEqual(planUpdate(item, result), { action: "write", callNumber: rank });
    assert.equal(planUpdate({ ...item, callNumber: rank }, result).reason, "unchanged");
    // Each nonempty field also stands alone: metadata standardization uses this.
    for (const value of [conferenceName, proceedingsTitle].filter(Boolean))
      assert.equal(catalog.lookup({ itemType: "conferencePaper", proceedingsTitle: value }).text, rank, value);
    for (const ending of [" Workshops", " Findings", " Companion"])
      assert.equal(catalog.lookup({ ...item, proceedingsTitle: proceedingsTitle + ending }).hasData, false);
  }
});

test("full conference matches cannot hide conflicting fields or remove subject words", () => {
  const catalog = conferenceCatalog();
  for (const proceedingsTitle of [
    "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition in Medicine",
    "Proceedings of a Different Conference (CVPR)",
    "International Conference on Pattern Recognition"
  ]) {
    const item = { itemType: "conferencePaper", conferenceName: CVPR, proceedingsTitle, callNumber: "A" };
    const result = catalog.lookup(item);
    assert.equal(result.hasData, false, proceedingsTitle);
    assert.equal(planUpdate(item, result).action, "skip");
  }
});

test("a missing IEEE sponsor does not prevent an otherwise exact ICASSP full-name match", () => {
  const catalog = new Catalog([dataset("ccf", [{ type: "conference", title: "IEEE International Conference on Acoustics,Speech and Signal Processing", abbreviation: "ICASSP", rank: "B" }])]);
  const result = catalog.lookup({ itemType: "conferencePaper", proceedingsTitle: "International Conference on Acoustics, Speech, and Signal Processing" });
  assert.equal(result.text, "B");
  assert.equal(catalog.lookup({ itemType: "conferencePaper", proceedingsTitle: "International Conference on Other Signal Processing (ICASSP)" }).hasData, false);
});

test("CVPR cannot fall back to the shorter, different Pattern Recognition conference", () => {
  const catalog = new Catalog([dataset("ccf", [
    { type: "conference", title: "IEEE/CVF Computer Vision and Pattern Recognition Conference", abbreviation: "CVPR", rank: "A" },
    { type: "conference", title: "International Conference on Pattern Recognition", abbreviation: "ICPR", rank: "C" }
  ])]);
  assert.equal(catalog.lookup({ itemType: "conferencePaper", conferenceName: "CVPR", proceedingsTitle: "Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition" }).text, "A");
  assert.equal(catalog.lookup({ itemType: "conferencePaper", proceedingsTitle: "International Conference on Unknown Pattern Recognition" }).hasData, false);
  assert.equal(catalog.lookup({ itemType: "conferencePaper", conferenceName: "IEEE/CVF Computer Vision and Pattern Recognition Conference", proceedingsTitle: "International Conference on Pattern Recognition" }).reasons.ccf,"conference-name-conflict");
});

test("AAAI proceedings stored as a journal article get the conference rank without changing item type", () => {
  const catalog = new Catalog([dataset("ccf", [{ type: "conference", title: "AAAI Conference on Artificial Intelligence", abbreviation: "AAAI", rank: "A" }])]);
  const item = journal({ publicationTitle: "Proceedings of the AAAI Conference on Artificial Intelligence", ISSN: "2374-3468" });
  const result = catalog.lookup(item);
  assert.equal(result.text, "A");
  assert.equal(result.reasons.jcr, "not-applicable");
  assert.equal(item.itemType, "journalArticle");
  assert.equal(catalog.lookup({ ...item, publicationTitle: "Proceedings of the AAAI Conference on Artificial Intelligence Workshops" }).hasData, false);
  assert.equal(catalog.lookup({ ...item, publicationTitle: "AAAI" }).hasData, false);
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

test("one manual update replaces existing metrics or shelf marks without touching Extra", () => {
  for (const callNumber of ["", "QA76", "C|—|—|—", "user correction"]) {
    const item = journal({ callNumber, extra: 'User notes\r\nZotero Scholar Manual: {bad' });
    const before = { ...item };
    const plan = planUpdate(item, fullCatalog().lookup(item));
    assert.deepEqual(plan, { action: "write", callNumber: "A|20.4|Q1|1区TOP" });
    assert.deepEqual(item, before);
    assert.equal(Object.hasOwn(plan, "extra"), false);
  }
});

test("automatic updates only fill empty call numbers and repeated updates do not write", () => {
  const result = fullCatalog().lookup(journal());
  assert.equal(planUpdate({callNumber:"C"}, result, {allowOverwrite:false}).reason, "existing-call-number");
  assert.equal(planUpdate({callNumber:""}, result, {allowOverwrite:false}).action, "write");
  assert.equal(planUpdate({callNumber:result.text}, result).reason, "unchanged");
});

test("missing or unmatched data never clears values, even during explicit updates", () => {
  for (const result of [new Catalog([]).lookup(journal()), fullCatalog().lookup(journal({publicationTitle:"Unknown"}))]) {
    assert.equal(planUpdate({callNumber:"C",extra:"old record"}, result).reason, "no-data");
  }
});
