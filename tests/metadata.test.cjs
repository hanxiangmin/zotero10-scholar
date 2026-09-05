"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const M = require("../src/metadata.js");
const item = fields => ({ itemType: "journalArticle", title: "A study of fictional methods", DOI: "", pages: "", volume: "", issue: "", language: "en", journalAbbreviation: "", callNumber: "QA76", extra: "User notes\r\nCitation Key: keep", ...fields });
const table = records => ({ schemaVersion: 1, kind: "journal-abbreviations", source: "Invented test-only titles", records });
const apply = (before, plan) => ({ ...before, ...plan.fields });

test("DOI cleanup preserves legal suffix punctuation and avoids inventing identifiers", () => {
  assert.equal(M.cleanDOI("  https://doi.org/10.12345/ABC(7).x "), "10.12345/ABC(7).x");
  assert.equal(M.cleanDOI("doi: 10.5555/a;b"), "10.5555/a;b");
  for (const value of ["doi: unknown", "10.12/a", "https://example.org/10.1234/x", "10.1234/a b", "https://doi.org/10.1234/x?tracking=1"])
    assert.equal(M.cleanDOI(value), value);
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

test("cleanup uses the current fields, stays idempotent and never creates or changes Extra", () => {
  const before = item({title:"  BRCA1  and p53 ",DOI:"doi:10.1234/x",volume:"002",extra:'Zotero Scholar Metadata: {bad\nUser notes'});
  const plan = M.plan(before), after = apply(before, plan);
  assert.equal(after.title, "BRCA1 and p53"); assert.equal(after.DOI,"10.1234/x"); assert.equal(after.volume,"2");
  assert.equal(after.extra,before.extra); assert.equal(Object.hasOwn(plan,"extra"),false);
  assert.equal(M.plan(after).action,"skip");
  assert.equal(M.plan({...after,DOI:"doi:10.1234/later"}).fields.DOI,"10.1234/later");
});

test("DOI enrichment overwrites returned fields and authors but does not import protected item data", () => {
  const before=item({DOI:"https://doi.org/10.1234/x",creators:[{creatorType:"author",firstName:"Old",lastName:"Author"}]});
  const source={itemType:"journalArticle",DOI:"10.1234/X",title:"New title",publicationTitle:"New Journal",date:"2025",volume:"9",creators:[{creatorType:"author",firstName:"New",lastName:"Author"}],extra:"replace",callNumber:"C",tags:["unwanted"],attachments:[{}],notes:[{}]};
  const plan=M.doiPlan(before,source);
  assert.equal(plan.fields.title,"New title"); assert.equal(plan.fields.date,"2025");
  assert.deepEqual(plan.creators,source.creators);
  for (const field of ["extra","callNumber","tags","notes","attachments"]) assert.equal(Object.hasOwn(plan.fields,field),false);
  assert.equal(Object.hasOwn(plan,"extra"),false);
});

test("DOI enrichment preserves unavailable fields and incomplete creator lists", () => {
  const before=item({DOI:"10.1234/x",title:"Keep",pages:"1–9",creators:[{creatorType:"author",name:"Existing Group"}]});
  const plan=M.doiPlan(before,{itemType:"journalArticle",DOI:before.DOI,title:"",pages:null,creators:[{creatorType:"author",lastName:"A"},{creatorType:"author"}]});
  assert.equal(plan.action,"skip"); assert.equal(plan.creators,undefined);
  assert.deepEqual(M.normalizeCreators([{creatorType:"author",fieldMode:1,lastName:"Study Group"}]),[{creatorType:"author",name:"Study Group"}]);
});

test("DOI enrichment rejects mismatched DOI and item type before planning any writes", () => {
  const before=item({DOI:"10.1234/x"});
  assert.equal(M.doiPlan(before,{itemType:"journalArticle",DOI:"10.1234/y",title:"Wrong"}).reason,"doi-mismatch");
  assert.equal(M.doiPlan(before,{itemType:"book",DOI:before.DOI,title:"Wrong"}).reason,"doi-type-mismatch");
  assert.equal(M.doiPlan({...before,DOI:"not a DOI"},{}).reason,"invalid-doi");
});
