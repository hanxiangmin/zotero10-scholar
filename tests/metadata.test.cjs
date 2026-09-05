"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const M = require("../src/metadata.js");
const item = fields => ({ itemType: "journalArticle", title: "A study of fictional methods", DOI: "", pages: "", volume: "", issue: "", language: "en", journalAbbreviation: "", callNumber: "QA76", extra: "User notes\r\nCitation Key: keep", ...fields });
const table = records => ({ schemaVersion: 1, kind: "journal-abbreviations", source: "Invented test-only titles", records });
const apply = (before, plan) => ({ ...before, ...plan.fields, extra: plan.extra });

test("DOI cleanup preserves legal suffix punctuation and avoids inventing identifiers", () => {
  assert.equal(M.cleanDOI("  https://doi.org/10.12345/ABC(7).x "), "10.12345/ABC(7).x");
  assert.equal(M.cleanDOI("doi: 10.5555/a;b"), "10.5555/a;b");
  for (const value of ["doi: unknown", "10.12/a", "https://example.org/10.1234/x", "10.1234/a b", "https://doi.org/10.1234/x?tracking=1"])
    assert.equal(M.cleanDOI(value), value);
});

test("cleanup is idempotent, backs up original values, and preserves rank plus Extra", () => {
  const before = item({ title: "  BRCA1  and  p53 in MACH-Net  ", DOI: "doi:10.12345/test", pages: "S10 - S19", volume: "002", issue: "03" });
  const plan = M.plan(before);
  assert.deepEqual(plan.fields, { title: "BRCA1 and p53 in MACH-Net", DOI: "10.12345/test", pages: "S10–S19", volume: "2", issue: "3" });
  assert.ok(plan.extra.startsWith(before.extra));
  const after = apply(before, plan);
  assert.equal(after.callNumber, "QA76");
  assert.equal(M.plan(after).action, "skip");
  assert.deepEqual(apply(after, M.restore(after)), before);
});

test("rich text, equations, article numbers, Roman volumes and special issues remain untouched", () => {
  const before = item({ title: "  <i>BRCA1</i> and H<sub>2</sub>O  ", pages: "e001234", volume: "IV", issue: "S01" });
  assert.equal(M.plan(before).action, "skip");
});

test("language inference abstains for short, ambiguous, non-English and Japanese text", () => {
  for (const title of ["Transformer", "Deep Learning", "Analyse de la structure", "これは脳神経研究です", "지능 연구", "Étude des réseaux"])
    assert.equal(M.inferLanguage(title), "", title);
  assert.equal(M.inferLanguage("基于多模态学习的医学研究"), "zh");
  assert.equal(M.inferLanguage("A new approach for the study of cells"), "en");
  assert.equal(M.plan(item({ title: "基于多模态学习的医学研究", language: "" })).fields.language, "zh");
  assert.equal(M.plan(item({ language: "fr" })).fields.language, undefined);
});

test("abbreviations require a valid table and unique ISSN or normalized title match", () => {
  for (const input of [null, {}, table([]), table([{ title: "x", abbreviation: "<b>x</b>" }])]) assert.throws(() => new M.Abbreviations(input));
  const catalog = new M.Abbreviations(table([
    { title: "Invented Journal One", abbreviation: "Inv. J. One", issns: ["0162-8828"] },
    { title: "Invented Journal Two", abbreviation: "Inv. J. Two", issns: ["0036-8075"] }
  ]));
  assert.equal(catalog.lookup(item({ ISSN: "0162-8828", publicationTitle: "other title" })).value, "Inv. J. One");
  assert.equal(catalog.lookup(item({ publicationTitle: "INVENTED JOURNAL TWO" })).value, "Inv. J. Two");
  assert.equal(catalog.lookup(item({ ISSN: "0162-8828 0036-8075" })).ambiguous, true);
  const before = item({ ISSN: "0162-8828" });
  assert.equal(M.plan(before, {}, catalog).fields.journalAbbreviation, "Inv. J. One");
  assert.equal(M.plan({ ...before, journalAbbreviation: "My Abbr" }, {}, catalog).fields.journalAbbreviation, undefined);
});

test("conflicting names do not produce guessed abbreviations and no data never clears values", () => {
  const catalog = new M.Abbreviations(table([{ title: "Invented Journal", abbreviation: "A" }, { title: "Invented Journal", abbreviation: "B" }]));
  const plan = M.plan(item({ publicationTitle: "Invented Journal" }), {}, catalog);
  assert.equal(plan.action, "skip"); assert.ok(plan.warnings.some(w => /歧义/.test(w)));
  assert.equal(M.plan(item({ journalAbbreviation: "Keep" })).action, "skip");
});

test("per-field manual edits survive cleanup and partial restore", () => {
  const before = item({ DOI: "doi:10.1234/test", volume: "002" });
  const after = apply(before, M.plan(before));
  after.DOI = "doi:10.1234/manually-edited";
  assert.equal(M.plan(after).fields.DOI, undefined);
  const restored = apply(after, M.restore(after));
  assert.equal(restored.volume, "002");
  assert.equal(restored.DOI, after.DOI);
  assert.deepEqual(Object.keys(M.readState(restored.extra).state.fields), ["DOI"]);
});

test("corrupt, duplicate, unknown-version or unexpected-field backup blocks writes", () => {
  const valid = M.plan(item({ volume: "002" })).extra.split(M.PREFIX)[1];
  for (const value of ["{bad", '{"v":2}', JSON.stringify({v:1,addedSeparator:true,fields:{callNumber:{original:"x",last:"y"}}})]) {
    const before = item({ volume: "002", extra: M.PREFIX + value });
    assert.equal(M.plan(before).reason, "invalid-backup"); assert.equal(M.restore(before).reason, "invalid-backup");
  }
  assert.equal(M.plan(item({ extra: M.PREFIX + valid + "\n" + M.PREFIX + valid })).reason, "invalid-backup");
});

test("all rules can be disabled without modifying metadata or backups", () => {
  assert.equal(M.plan(item({ title: "  Test   title ", DOI: "doi:10.1234/x", volume: "01", language: "" }),
    Object.fromEntries(Object.keys(M.DEFAULTS).map(key => [key, false]))).action, "skip");
});

test("duplicate hints are library scoped, normalize DOI and require manual review for titles", () => {
  const title = "A deliberately fictional title for testing duplicate lookup";
  const items = [
    { id: 1, libraryID: 1, title, DOI: "doi:10.1234/ABC" },
    { id: 2, libraryID: 1, title: "Other title", DOI: "https://doi.org/10.1234/abc" },
    { id: 3, libraryID: 2, title, DOI: "10.1234/ABC" },
    { id: 4, libraryID: 1, title, DOI: "10.1234/different" },
    { id: 5, libraryID: 1, title, DOI: "" }
  ];
  const lookup = M.duplicateIndex(items), hints = lookup(items[0]);
  assert.deepEqual(hints.map(h => h.id), [2, 5]);
  assert.match(hints[0].reason, /DOI/); assert.match(hints[1].reason, /人工/);
  assert.deepEqual(lookup(items[2]), []);
});
