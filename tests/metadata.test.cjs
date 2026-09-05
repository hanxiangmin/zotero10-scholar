"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const M = require("../src/metadata.js");
const S = require("../src/search.js");
const { Catalog } = require("../src/core.js");
const item = fields => ({ itemType: "journalArticle", title: "A study of fictional methods", DOI: "", pages: "", volume: "", issue: "", language: "en", journalAbbreviation: "", callNumber: "QA76", extra: "User notes\r\nCitation Key: keep", ...fields });
const table = records => ({ schemaVersion: 1, kind: "journal-abbreviations", source: "Invented test-only titles", records });
const apply = (before, plan) => ({ ...before, ...plan.fields });

const searchItem = overrides => item({title:"A fictional study of neural cells",date:"2025",publicationTitle:"Fictional Journal",creators:[{creatorType:"author",firstName:"Jane",lastName:"Smith"}],...overrides});
const searchRecord = overrides => ({DOI:"10.1234/found",title:["A Fictional Study of Neural Cells"],type:"journal-article",author:[{given:"J.",family:"Smith"}],
  "container-title":["Fictional Journal"],"published-print":{"date-parts":[[2026]]},...overrides});

test("title fallback requires bibliographic context and never substitutes a populated DOI", () => {
  const query=S.query(searchItem({extra:"PRIVATE NOTE",abstractNote:"PRIVATE ABSTRACT"}));
  assert.deepEqual(query,{bibliographic:"A fictional study of neural cells Fictional Journal 2025",author:"Jane Smith",cacheKey:JSON.stringify(["A fictional study of neural cells Fictional Journal 2025","Jane Smith"])});
  for(const change of [{DOI:"10.1234/x"},{DOI:"bad DOI"},{title:"______!!!"},{creators:[]},{publicationTitle:"",date:""},{title:"<b>Neural cells</b>"}])
    assert.equal(S.query(searchItem(change)),null,JSON.stringify(change));
});

test("title fallback accepts a unique identity with initials and a one-year publication difference", () => {
  const record=searchRecord();
  assert.equal(S.select(searchItem(),[record]).record,record);
  assert.equal(S.select(searchItem(),[record,{...record}]).record.DOI,record.DOI);
  assert.equal(S.select(searchItem(),[record,{...record,DOI:"10.1234/another"}]).reason,"search-ambiguous");
});

test("title matching refuses near titles, different authors, years, venues, and preprints despite high API scores", () => {
  for(const change of [{title:["A fictional study of non-neural cells"]},{author:[{given:"John",family:"Smith"}]},
    {"published-print":{"date-parts":[[2010]]}},{"container-title":["Different Journal"]},{type:"posted-content"},{type:"book-chapter"},
    {DOI:"not a DOI"},{author:[]}]) {
    assert.equal(S.select(searchItem(),[searchRecord({...change,score:10000})]).reason,"search-no-match",JSON.stringify(change));
  }
  const known=searchItem({creators:[{creatorType:"author",firstName:"Jane",lastName:"Smith"},{creatorType:"author",firstName:"Bob",lastName:"Jones"}]});
  assert.equal(S.select(known,[searchRecord()]).reason,"search-no-match");
});

test("search distinguishes conference chapters and workshops using explicit evidence and venue identity", () => {
  const standard="International Conference on Medical Image Computing and Computer-Assisted Intervention";
  const catalog=new Catalog([{schemaVersion:1,kind:"ccf",edition:2026,source:"Synthetic",records:[{type:"conference",title:standard,abbreviation:"MICCAI",rank:"B"}]}]);
  const before=searchItem({itemType:"conferencePaper",proceedingsTitle:"MICCAI-2025",conferenceName:"MICCAI"});
  const record=searchRecord({type:"book-chapter","container-title":["Medical Image Computing and Computer Assisted Intervention – MICCAI 2025"],
    assertion:[{group:{name:"ConferenceInfo"},name:"conference_year",value:"2025"}]});
  assert.equal(S.select(before,[record],catalog).record,record);
  assert.equal(S.select({...before,proceedingsTitle:"MICCAI Workshops"},[record],catalog).reason,"search-no-match");
  assert.equal(S.select({...before,proceedingsTitle:"MICCAI Workshops"},[{...record,event:{name:"MICCAI"}}],catalog).reason,"search-no-match");
  assert.equal(S.select({...before,proceedingsTitle:"Different conference"},[{...record,event:{name:"MICCAI"}}],catalog).reason,"search-no-match");
  assert.equal(S.select(before,[{...record,assertion:[]}],catalog).reason,"search-no-match");
});

test("resolved title matches supplement only an empty DOI and recheck the final returned identity", () => {
  const before=searchItem(), record=searchRecord();
  const source={itemType:"journalArticle",DOI:record.DOI,title:record.title[0],date:"2026",publicationTitle:"Fictional Journal",
    creators:[{creatorType:"author",firstName:"Jane",lastName:"Smith"}],scholarCrossref:record,extra:"Ignore",callNumber:"Ignore"};
  const plan=S.resolvedPlan(before,record,source,{},null);
  assert.equal(plan.action,"write");assert.equal(plan.fields.DOI,record.DOI);assert.equal(plan.fields.date,"2026");
  assert.equal(before.DOI,"");assert.equal(plan.fields.callNumber,undefined);assert.equal(plan.fields.extra,undefined);
  for(const change of [{title:"A totally different publication"},{creators:[{creatorType:"author",lastName:"Other"}]},{DOI:"10.1234/different"}])
    assert.equal(S.resolvedPlan(before,record,{...source,...change},{},null).action,"skip");
  assert.equal(S.resolvedPlan({...before,DOI:"10.1234/existing"},record,source,{},null).action,"skip");
});

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

test("sentence case capitalizes the subtitle, protects scientific spellings, and is idempotent", () => {
  const cases = [
    ["HGTL: a Hypergraph Transfer Learning Framework for Survival Prediction of CcRCC", "HGTL: A hypergraph transfer learning framework for survival prediction of ccRCC"],
    ["DHGFormer: dynamic Hierarchical Graph Transformer for fMRI", "DHGFormer: Dynamic hierarchical graph transformer for fMRI"],
    ["3D Semantic Gaussian via Geometric-Semantic Hypergraph Computation", "3D semantic Gaussian via geometric-semantic hypergraph computation"],
    ["HGNNv2: Stable Hypergraph Neural Networks", "HGNNv2: Stable hypergraph neural networks"],
    ["ML-DSVM+: a Meta-Learning Based Deep SVM+ for Computer-Aided Diagnosis", "ML-DSVM+: A meta-learning based deep SVM+ for computer-aided diagnosis"],
    ["CcRCC Metastasis Prediction via Multiple WSIs", "ccRCC metastasis prediction via multiple WSIs"],
    ["A study: ccRCC and fMRI", "A study: ccRCC and fMRI"],
    ["A Study: “the Next Step”", "A study: “The next step”"]
  ];
  for (const [input, expected] of cases) {
    assert.equal(M.sentenceCase(input), expected);
    assert.equal(M.sentenceCase(expected), expected);
  }
  assert.equal(M.sentenceCase("A Study of London and iPhone", "London iPhone"), "A study of London and iPhone");
  assert.equal(M.plan(item({ title: "A New Title" }), { titleCase: "preserve" }).fields.title, undefined);
  assert.equal(M.plan(item({ title: "Un Titre Français", language: "fr" })).fields.title, undefined);
  assert.equal(M.sentenceCase("<i>BRCA1</i>: a Study"), "<i>BRCA1</i>: a Study");
});

const crossrefSource = (type, extra = {}) => ({ DOI: "10.1234/x", title: ["A Test Title"], type, ...extra });
const confAssertions = year => [{ group: { name: "ConferenceInfo" }, name: "conference_year", value: String(year) }];

test("DOI updates use explicit conference year and safely bridge Springer book sections", () => {
  const before = item({ itemType: "conferencePaper", DOI: "10.1234/x", date: "2026" });
  const source = { itemType: "bookSection", DOI: before.DOI, title: "A Test Title", date: "2026", bookTitle: "Fictional proceedings",
    scholarCrossref: crossrefSource("book-chapter", { assertion: confAssertions(2025), "published-print": { "date-parts": [[2026]] } }) };
  const result = M.doiPlan(before, source);
  assert.equal(result.fields.date, "2025");
  assert.equal(result.fields.title, "A test title");
  assert.equal(result.fields.proceedingsTitle, "Fictional proceedings");
  assert.equal(before.itemType, "conferencePaper");
  assert.equal(M.doiPlan(before, { ...source, scholarCrossref: { ...source.scholarCrossref, DOI: "10.1234/wrong" } }).reason, "doi-type-mismatch");
  assert.equal(M.doiPlan(before, { ...source, scholarCrossref: { ...source.scholarCrossref, title: ["Different work"] } }).reason, "doi-type-mismatch");
});

test("journal dates use formal print/issue date, never DOI digits, deposit or earliest timestamp", () => {
  const source = { itemType: "journalArticle", DOI: "10.1234/x", title: "A Test Title", date: "2025-09-19",
    scholarCrossref: crossrefSource("journal-article", { "published-print": { "date-parts": [[2026, 3]] }, "published-online": { "date-parts": [[2025, 9, 19]] } }) };
  assert.equal(M.doiPlan(item({ DOI: source.DOI, date: "2025" }), source).fields.date, "2026-03");
  assert.equal(M.dateParts({ "date-parts": [[2025, 2, 29]] }), "");
  assert.equal(M.dateParts({ "date-parts": [[2024, 2, 29]] }), "2024-02-29");
  for (const parts of [[2025, 13], ["2025"], [2025, 1, 0], [2025, 1, 1, 1]]) assert.equal(M.dateParts({ "date-parts": [parts] }), "");
});

test("unknown or contradictory conference years preserve the existing date and report why", () => {
  const before = item({ itemType: "conferencePaper", DOI: "10.1234/x", date: "2025" });
  const source = { itemType: before.itemType, DOI: before.DOI, title: "A Test Title", date: "2026" };
  const result = M.doiPlan(before, source);
  assert.equal(result.fields.date, undefined);
  assert.equal(result.dateUnverified, true);
  assert.equal(M.conferenceYear({ event: { start: { "date-parts": [[2025, 9, 23]] } }, assertion: confAssertions(2026) }), "");
  assert.equal(M.conferenceYear({ assertion: [{ name: "conference_year", value: "2025" }] }), "");
  assert.equal(M.conferenceYear({ event: { start: { "date-parts": [[2018, 7, 25]] }, end: { "date-parts": [[2018, 7, 27]] } } }), "2018");
  assert.equal(M.conferenceYear({ "container-title": ["A Conference 2025"], created: { "date-parts": [[2025]] } }), "");
});

const MICCAI = "International Conference on Medical Image Computing and Computer-Assisted Intervention";
function conferenceCatalog() {
  return new Catalog([{schemaVersion:1,kind:"ccf",edition:2026,source:"Synthetic fixture",records:[
    {type:"conference",title:MICCAI,abbreviation:"MICCAI",rank:"B"},
    {type:"conference",title:"Conference on Computational Complexity",abbreviation:"CCC",rank:"B"}
  ]}]);
}

test("conference metadata uses a standard full name in both fields without deriving or changing date", () => {
  const before=item({itemType:"conferencePaper",conferenceName:"MICCAI",proceedingsTitle:"Medical Image Computing and Computer Assisted Intervention – MICCAI-2005",date:"2025"});
  const catalog=conferenceCatalog(), result=M.plan(before,{},undefined,catalog);
  assert.equal(result.fields.conferenceName,MICCAI);assert.equal(result.fields.proceedingsTitle,MICCAI);
  assert.equal(result.fields.date,undefined);assert.equal(result.fields.callNumber,undefined);
  assert.equal(M.plan(apply(before,result),{},undefined,catalog).action,"skip");
  assert.equal(M.plan(before,{conference:false},undefined,catalog).fields.conferenceName,undefined);
  assert.equal(M.plan({...before,conferenceName:""},{},undefined,catalog).fields.conferenceName,MICCAI);
});

test("standardization abstains for workshops, unknown/conflicting names and journal item types", () => {
  const catalog=conferenceCatalog();
  for (const fields of [
    {conferenceName:"MICCAI",proceedingsTitle:"MICCAI 2025 Workshops"},
    {conferenceName:"MICCAI",proceedingsTitle:"An unknown special proceedings title"},
    {conferenceName:"MICCAI",proceedingsTitle:"Conference on Computational Complexity"},
    {conferenceName:"CCC",proceedingsTitle:"Chinese Control Conference (CCC)"},
    {conferenceName:"Unknown conference",proceedingsTitle:""},
    {conferenceName:"MICCAI",proceedingsTitle:"<i>MICCAI</i>"},
    {itemType:"journalArticle",conferenceName:"MICCAI",proceedingsTitle:MICCAI}
  ]) assert.deepEqual(M.standardConferenceNames({itemType:"conferencePaper",...fields},catalog),{});
});

test("DOI enrichment shares the conference-name rule instead of restoring annual suffixes", () => {
  const before=item({itemType:"conferencePaper",DOI:"10.1234/x",conferenceName:MICCAI,proceedingsTitle:MICCAI,date:"2025"});
  const source={itemType:"bookSection",DOI:before.DOI,title:"A Test Title",date:"2026",bookTitle:"Medical Image Computing and Computer Assisted Intervention – MICCAI 2025",
    scholarCrossref:crossrefSource("book-chapter",{assertion:confAssertions(2025)})};
  const result=M.doiPlan(before,source,{},conferenceCatalog());
  assert.equal(result.fields.proceedingsTitle,undefined);assert.equal(result.fields.conferenceName,undefined);
  assert.equal(result.fields.date,undefined);
  assert.equal(M.doiPlan(before,source,{conference:false},conferenceCatalog()).fields.proceedingsTitle,source.bookTitle);
});
