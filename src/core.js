/* Pure matching/validation logic. No Zotero, network, or filesystem access. */
(function (root) {
  "use strict";
  const MISSING = "—";
  const EXCLUDED_CONFERENCE = /\b(workshops?|findings|short\s+papers?|demo(?:nstration)?s?|technical\s+briefs?|companion|posters?|doctoral\s+(?:consortium|symposium)|extended\s+abstracts?)\b/i;

  function decodeEntities(value) {
    const named = {amp:"&",nbsp:" ",quot:'"',apos:"'",lt:"<",gt:">",ndash:"–",mdash:"—",lsquo:"‘",rsquo:"’",ldquo:"“",rdquo:"”"};
    // Bibliographic sources sometimes escape an entity twice. Bound decoding
    // and keep unknown/invalid entities; no HTML is rendered or executed.
    let result = String(value || "");
    for (let pass=0;pass<2;pass++) result=result.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(entity,key)=>{
      if (key[0]!=="#") return Object.hasOwn(named,key.toLowerCase()) ? named[key.toLowerCase()] : entity;
      const hex=key[1].toLowerCase()==="x",code=parseInt(key.slice(hex?2:1),hex?16:10);
      return code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff) ? String.fromCodePoint(code) : entity;
    });
    return result;
  }

  function normalizeTitle(value) {
    return decodeEntities(value).normalize("NFKD").replace(/\p{M}/gu, "")
      .toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function normalizeISSNs(value) {
    const values = Array.isArray(value) ? value : [value];
    const result = new Set();
    for (const v of values) {
      for (const match of String(v || "").toUpperCase().matchAll(/\b(\d{4})-?(\d{3}[\dX])\b/g)) {
        const digits = match[1] + match[2];
        const sum = [...digits].reduce((s, c, i) => s + (c === "X" ? 10 : Number(c)) * (8 - i), 0);
        if (sum % 11 === 0 && digits !== "00000000") result.add(match[1] + "-" + match[2]);
      }
    }
    return [...result];
  }

  // Distinct publication identities, including discontinued titles. A successor
  // is deliberately not an alias: its present-day metrics cannot be inherited.
  // Names/ISSNs: IEEE SMC title-change notice, DOI 10.1109/TSMCA.2012.2224500,
  // and the registered ISSNs in the journal datasets. See docs/VENUE_NAMES.md.
  const JOURNALS = [
    {id:"tsmc-systems",title:"IEEE Transactions on Systems, Man, and Cybernetics: Systems",issns:["2168-2216","2168-2232"],aliases:["IEEE Transactions on Systems Man Cybernetics-Systems","IEEE Transactions on Systems, Man and Cybernetics: Systems"]},
    {id:"tsmc-a",title:"IEEE Transactions on Systems, Man, and Cybernetics, Part A: Systems and Humans",issns:["1083-4427","1558-2426"],aliases:["IEEE Transactions on Systems, Man, and Cybernetics Part A: Systems and Humans","IEEE Transactions on Systems Man and Cybernetics Part A-Systems and Humans"]},
    {id:"tsmc-b",title:"IEEE Transactions on Systems, Man, and Cybernetics, Part B (Cybernetics)",issns:["1083-4419","1941-0492"],aliases:["IEEE Transactions on Systems, Man, and Cybernetics Part B: Cybernetics","IEEE Transactions on Systems Man and Cybernetics Part B-Cybernetics","IEEE Transactions on Systems, Man, and Cybernetics, Part B: Cybernetics"]},
    {id:"tsmc-c",title:"IEEE Transactions on Systems, Man, and Cybernetics, Part C: Applications and Reviews",issns:["1094-6977","1558-2442"],aliases:["IEEE Transactions on Systems, Man, and Cybernetics Part C: Applications and Reviews","IEEE Transactions on Systems Man and Cybernetics Part C-Applications and Reviews"]},
    {id:"tsmc-original",title:"IEEE Transactions on Systems, Man, and Cybernetics",issns:["0018-9472","2168-2909"],aliases:[]},
    {id:"tcyb",title:"IEEE Transactions on Cybernetics",issns:["2168-2267","2168-2275"],aliases:[]},
    {id:"thms",title:"IEEE Transactions on Human-Machine Systems",issns:["2168-2291","2168-2305"],aliases:[]},
    {id:"tnn",title:"IEEE Transactions on Neural Networks",issns:["1045-9227","1941-0093"],aliases:[]},
    {id:"tnnls",title:"IEEE Transactions on Neural Networks and Learning Systems",issns:["2162-237X","2162-2388"],aliases:[]}
  ];
  const JOURNAL_NAMES = new Map(), JOURNAL_ISSNS = new Map();
  for (const journal of JOURNALS) {
    for (const name of [journal.title,...journal.aliases]) JOURNAL_NAMES.set(normalizeTitle(name),journal);
    for (const issn of normalizeISSNs(journal.issns)) JOURNAL_ISSNS.set(issn,journal);
  }

  function journalIdentity(item) {
    const named = JOURNAL_NAMES.get(normalizeTitle(item.publicationTitle || item.title));
    const byISSN = [...new Set(normalizeISSNs(item.ISSN || item.issns).map(issn=>JOURNAL_ISSNS.get(issn)).filter(Boolean))];
    if (byISSN.length > 1 || (named && byISSN.some(journal=>journal !== named))) return {reason:"journal-identity-conflict"};
    return {record:named || byISSN[0] || null};
  }

  function journalNames(record) {
    const identity = journalIdentity(record).record;
    return [...new Set([record.title,...(record.aliases || []),...(identity ? [identity.title,...identity.aliases] : [])])];
  }

  function validYear(value) {
    return Number.isInteger(value) && value >= 2000 && value <= 2100;
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function validateDataset(input) {
    assert(input && input.schemaVersion === 1, "数据包 schemaVersion 必须为 1。");
    assert(["ccf", "jcr", "cas"].includes(input.kind), "仅支持 CCF、JCR 和中科院 CAS 数据包。");
    assert(typeof input.source === "string" && input.source.trim() && input.source.length < 4000, "数据包必须注明来源 source。");
    assert(Array.isArray(input.records) && input.records.length > 0 && input.records.length <= 100000, "数据包 records 必须包含 1–100000 条记录。");
    assert(!/新锐|xinrui|new\s*academic\s*rank/i.test([input.system, input.source, input.sourceFile, input.edition].join(" ")), "本插件不接受新锐分区数据。");
    assert(!/(?:^|[\\/])XR\d/i.test(input.sourceFile || ""), "不接受 XR（新锐）数据文件。");
    if (input.kind === "cas") {
      assert(input.system === "CAS" && input.categoryLevel === "major", "只接受 CAS 中科院大类分区；不接受新锐或小类替代。");
      assert(input.edition === 2025, "当前版本固定采用 2025 中科院升级版，不以其他年份冒充。");
    }
    if (input.kind === "jcr") {
      assert(validYear(input.edition) && validYear(input.metricYear), "JCR 必须分别注明发布年 edition 和指标年 metricYear。");
      assert(input.edition === input.metricYear + 1, "JCR 发布年应比指标年晚一年，请核对数据口径。");
    }
    const records = input.records.map((r, index) => {
      const label = `第 ${index + 1} 条记录`;
      assert(r && typeof r.title === "string" && r.title.trim(), `${label} 缺少 title。`);
      assert(r.title.length <= 2000, `${label} 刊名过长。`);
      assert(r.aliases == null || (Array.isArray(r.aliases) && r.aliases.every(a => typeof a === "string" && a.length <= 2000)), `${label} aliases 格式不正确。`);
      const record = { ...r, title: r.title.trim(), aliases: r.aliases || [], issns: normalizeISSNs(r.issns || []) };
      if (input.kind === "ccf") {
        assert(["journal", "conference"].includes(r.type) && /^[ABC]$/.test(r.rank), `${label} CCF 类型或等级不正确。`);
        assert(!r.abbreviation || typeof r.abbreviation === "string", `${label} abbreviation 格式不正确。`);
      }
      if (input.kind === "jcr") {
        assert(r.jif === null || (typeof r.jif === "number" && Number.isFinite(r.jif) && r.jif >= 0 && r.jif < 100000), `${label} JIF 必须是数字或 null，不能用 0 表示缺失。`);
        assert(r.jifDisplay == null || (r.jif === null && r.jifDisplay === "<0.1"), `${label} 仅支持 <0.1 作为非数值 JIF 显示。`);
        assert(Array.isArray(r.quartiles), `${label} 缺少 quartiles 数组。`);
        assert(r.quartiles.every(q => q && /^Q[1-4]$/.test(q.quartile) && typeof q.category === "string"), `${label} JCR 分区必须是 Q1–Q4 并带学科名称。`);
      }
      if (input.kind === "cas") {
        assert(Number.isInteger(r.division) && r.division >= 1 && r.division <= 4, `${label} 中科院大类分区必须为 1–4。`);
        assert(r.top === true || r.top === false || r.top === null, `${label} TOP 必须是 true、false 或 null。`);
      }
      return record;
    });
    return { ...input, records };
  }

  function addToIndex(index, key, record) {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    const list = index.get(key);
    if (!list.includes(record)) list.push(record);
  }

  function indexDataset(input, sharedISSNs = new Map()) {
    const dataset = validateDataset(input);
    const names = new Map(), issns = new Map();
    for (const record of dataset.records) {
      const prefix = dataset.kind === "ccf" ? `${record.type}:` : "";
      const journal = dataset.kind !== "ccf" || record.type === "journal";
      const namesForRecord = journal ? journalNames(record) : [record.title,...record.aliases];
      for (const name of [...namesForRecord, record.abbreviation]) {
        const normalized = normalizeTitle(name);
        if (normalized) addToIndex(names, prefix + normalized, record);
      }
      const identity = journal ? journalIdentity(record).record : null;
      const linked = journal ? namesForRecord.flatMap(name => {
        const entry = sharedISSNs.get(normalizeTitle(name));
        return entry?.identities.size === 1 ? [...entry.issns] : [];
      }) : [];
      for (const issn of new Set([...record.issns,...(identity?.issns || []),...linked])) addToIndex(issns, issn, record);
    }
    return { dataset, names, issns };
  }

  function pickUnique(records, matchedBy) {
    const unique = [...new Set(records)];
    if (unique.length === 1) return { record: unique[0], matchedBy };
    if (unique.length > 1) {
      // Duplicated CCF listings across subject categories are harmless only
      // when the venue and its grade agree. Other ambiguity is never guessed.
      const first = unique[0];
      if (first.rank && unique.every(r => r.type === first.type && r.rank === first.rank && normalizeTitle(r.title) === normalizeTitle(first.title))) {
        return { record: first, matchedBy };
      }
      return { record: null, reason: "ambiguous" };
    }
    return { record: null, reason: "not-found" };
  }

  function journalMatch(index, item) {
    if (!index) return { record: null, reason: "no-dataset" };
    if (journalIdentity(item).reason) return {record:null,reason:"journal-identity-conflict"};
    const found = normalizeISSNs(item.ISSN).flatMap(issn => index.issns.get(issn) || [])
      .filter(record => index.dataset.kind !== "ccf" || record.type === "journal");
    const prefix = index.dataset.kind === "ccf" ? "journal:" : "";
    const exact = index.names.get(prefix + normalizeTitle(item.publicationTitle)) || [];
    if (found.length) {
      if (exact.length && !found.some(record => exact.includes(record))) {
        return { record: null, reason: "journal-identity-conflict" };
      }
      return pickUnique(found, "ISSN");
    }
    if (exact.length) return pickUnique(exact, "title");
    // Use the abbreviation only when the full title did not match. Ambiguous
    // acronyms do not override an exact publication title or an ISSN.
    return pickUnique(index.names.get(prefix + normalizeTitle(item.journalAbbreviation)) || [], "abbreviation");
  }

  function conferenceName(value, abbreviation = "") {
    // Only edition/sponsor decorations are optional, never subject words.
    // Some IJCAI imports join the ordinal to International (ThirdInternational).
    const ordinal = "(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth)";
    let name = normalizeTitle(value).replace(new RegExp("\\b(" + ordinal + ")(?=international\\b)", "g"), "$1 ");
    const short = normalizeTitle(abbreviation);
    // ACM event labels precede the full title, e.g. KDD '18: The 24th ... .
    // The remaining full name still has to match this particular conference.
    const aliases = short === "sigkdd" ? [short,"kdd"] : short === "neurips" ? [short,"nips"] : [short];
    for (const alias of aliases.filter(Boolean)) {
      name=name.replace(new RegExp("^"+alias+"(?=(?:19|20)\\d{2}\\b|\\d{2}\\b)"),alias+" ");
      if (new RegExp("^"+alias+"(?: (?:(?:19|20)\\d{2}|\\d{2}))?$").test(name)) name=short;
      else name=name.replace(new RegExp("^"+alias+" (?:(?:19|20)\\d{2}|\\d{2}) "),"");
    }
    // DBLP's full proceedings titles may append acronym, year and location.
    // Strip that bibliographic suffix only after an explicit acronym/year pair;
    // the remaining full title must still agree (CCC collisions stay rejected).
    const parts = String(value || "").split(",");
    if (short && parts.length > 1 && new RegExp("^"+short+" ?(?:(?:19|20)\\d{2}|\\d{2})(?: |$)").test(normalizeTitle(parts.slice(1).join(" ")))) name = normalizeTitle(parts[0]);
    if (short === "pricai" && /^pricai (?:19|20)\d{2} trends in artificial intelligence$/.test(name)) {
      name = "pacific rim international conference on artificial intelligence";
    }
    if (["usenixsecurity","usenix security"].includes(short)
        && /^(?:\d+(?:st|nd|rd|th) )?usenix security symposium(?: usenix security (?:\d{2}|(?:19|20)\d{2}))?$/.test(name)) name = "usenix security symposium";
    if (short.length >= 3) name = name.replace(new RegExp("\\b"+short+"(?=(?:\\d{2}|(?:19|20)\\d{2})\\b)","g"),short+" ");
    // This proceedings series uses a volume number instead of a conference
    // prefix. NIPS is the older name of the same meeting.
    if (short === "neurips") {
      name = name.replace(/\b(?:neurips|nips)(?=(?:19|20)\d{2}\b)/g, "neurips ")
        .replace(/\bnips\b/g, "neurips");
      name = name.replace(/^advances in neural information processing systems(?: \d{1,3})?(?= |$)/,
        "conference on neural information processing systems");
    }
    if (short) {
      // normalizeTitle leaves only letters, digits and spaces: safe in a RegExp.
      const suffix = new RegExp("(?:^| )" + short + "(?: (?:\\d{2}|(?:19|20)\\d{2}))?$");
      const match = suffix.exec(name);
      if (match) name = match.index ? name.slice(0, match.index).trim() : short;
    }
    name = name.replace(/\s+(?:19|20)\d{2}$/, "");
    const leading = new RegExp("^(?:(?:proceedings|of|the|ieee\\s+computer\\s+society|ieee|acm|cvf|iapr|international|annual|conference|on|\\d+(?:st|nd|rd|th)?|" + ordinal + ")\\s+)+");
    name = name.replace(leading, "");
    // SIGKDD may precede either 'Conference' or 'International Conference'.
    if (short && name.startsWith(short + " ")) name = name.slice(short.length).trim().replace(leading, "");
    return name.replace(/\s+conference$/, "");
  }

  function conferenceMatch(index, item, { fullOnly = false } = {}) {
    if (!index) return { record: null, reason: "no-dataset" };
    const names = [item.conferenceName, item.proceedingsTitle].filter(Boolean);
    // A parent conference name does not turn a Workshop/Findings paper into a full paper.
    if (names.some(n => EXCLUDED_CONFERENCE.test(normalizeTitle(n)))) return { record: null, reason: "excluded-conference-track" };
    const candidates = [], acronyms = [];
    for (const record of index.dataset.records) {
      if (record.type !== "conference") continue;
      for (const name of [record.title, ...record.aliases, record.abbreviation]) {
        const key = conferenceName(name, record.abbreviation);
        if (!key) continue;
        const full = key.split(" ").length >= 2;
        if (full && names.some(n => conferenceName(n, record.abbreviation) === key)) {
          candidates.push({ record, length: key.length });
        } else if (!full && key.length >= 3 && names.some(n => conferenceName(n, record.abbreviation) === key
          || (` ${normalizeTitle(n)} `).includes(` ${key} `))) {
          acronyms.push({ record, key });
        }
      }
    }
    if (candidates.length) {
      const consistent = candidates.filter(({ record }) => {
        const keys = [record.title, ...record.aliases, record.abbreviation]
          .filter(Boolean).map(n => conferenceName(n, record.abbreviation));
        return names.every(n => keys.includes(conferenceName(n, record.abbreviation)));
      });
      return consistent.length ? pickUnique(consistent.map(c => c.record), "conference-title")
        : { record: null, reason: "conference-name-conflict" };
    }
    if (fullOnly) return { record: null, reason: "not-found" };
    // An acronym may identify an acronym-only venue, but must not override an
    // accompanying, incompatible full name (e.g. Chinese Control Conference).
    const safe = acronyms.filter(({ record, key }) => names.every(n => conferenceName(n, record.abbreviation) === key));
    if (safe.length) return pickUnique(safe.map(c => c.record), "conference-acronym");
    const rejected = pickUnique(acronyms.map(c => c.record), "conference-acronym");
    return rejected.record ? { record: null, reason: "conference-name-conflict", rejectedRank: rejected.record.rank }
      : { record: null, reason: rejected.reason };
  }

  function selectQuartile(quartiles, policy = "best") {
    if (!quartiles.length) return null;
    const all = [...new Set(quartiles.map(q => q.quartile))].sort();
    if (policy === "all") return all.join("/");
    return policy === "worst" ? all[all.length - 1] : all[0];
  }

  class Catalog {
    constructor(datasets) {
      this.datasets = {};
      this.indexes = {};
      for (const data of datasets) this.replace(data);
    }
    replace(data) {
      this.datasets[data.kind] = validateDataset(data);
      const shared = new Map();
      for (const dataset of Object.values(this.datasets)) for (const record of dataset.records) {
        if (dataset.kind === "ccf" && record.type !== "journal") continue;
        const identity = journalIdentity(record).record;
        for (const name of journalNames(record)) {
          const key = normalizeTitle(name);
          if (!shared.has(key)) shared.set(key,{identities:new Set(),issns:new Set()});
          const entry = shared.get(key);
          entry.identities.add(identity?.id || normalizeTitle(record.title));
          for (const issn of [...record.issns,...(identity?.issns || [])]) entry.issns.add(issn);
        }
      }
      for (const [kind,dataset] of Object.entries(this.datasets)) this.indexes[kind] = indexDataset(dataset,shared);
    }
    list() {
      return Object.values(this.indexes).map(({ dataset: { records, ...metadata } }) => ({ ...metadata, count: records.length }));
    }
    lookup(item, policy = "best") {
      if (!["journalArticle", "conferencePaper"].includes(item.itemType)) {
        return { supported: false, reason: "unsupported-type", text: "", hasData: false };
      }
      const proceedings = item.itemType === "journalArticle"
        && ((/\bproceedings\b/i.test(item.publicationTitle || "") && /\b(?:conference|symposium|meeting)\b/i.test(item.publicationTitle || ""))
          || /^advances in neural information processing systems\b/i.test(item.publicationTitle || ""));
      const proceedingsMatch = proceedings ? conferenceMatch(this.indexes.ccf, { proceedingsTitle: item.publicationTitle }, { fullOnly: true }) : null;
      const conference = item.itemType === "conferencePaper" || Boolean(proceedingsMatch?.record)
        || proceedingsMatch?.reason === "excluded-conference-track";
      const ccf = proceedingsMatch && conference ? proceedingsMatch : conference ? conferenceMatch(this.indexes.ccf, item) : journalMatch(this.indexes.ccf, item);
      const jcr = conference ? { record: null, reason: "not-applicable" } : journalMatch(this.indexes.jcr, item);
      const cas = conference ? { record: null, reason: "not-applicable" } : journalMatch(this.indexes.cas, item);
      const fields = [ccf.record?.rank || MISSING,
        jcr.record?.jifDisplay || (jcr.record?.jif != null ? String(jcr.record.jif) : MISSING),
        selectQuartile(jcr.record?.quartiles || [], policy) || MISSING,
        cas.record ? `${cas.record.division}区${cas.record.top === true ? "TOP" : ""}` : MISSING];
      const matches = { ccf, jcr, cas };
      const provenance = {};
      for (const [kind, match] of Object.entries(matches)) {
        if (!match.record) continue;
        const data = this.indexes[kind].dataset;
        provenance[kind] = {
          edition: data.edition, metricYear: data.metricYear, source: data.source,
          sourceFile: data.sourceFile, sourceSha256: data.sourceSha256,
          matchedTitle: match.record.title, matchedBy: match.matchedBy
        };
      }
      if (jcr.record) provenance.jcr.quartiles = jcr.record.quartiles;
      if (cas.record) provenance.cas.top = cas.record.top;
      const visibleFields = fields.filter(field => field !== MISSING);
      return {
        supported: true, text: visibleFields.join("|"), hasData: visibleFields.length > 0,
        ...(ccf.rejectedRank ? { rejectedRank: ccf.rejectedRank } : {}),
        fields, provenance, policy, availableKinds: Object.keys(this.indexes),
        jcrMetricYear: this.indexes.jcr?.dataset.metricYear,
        reasons: Object.fromEntries(Object.entries(matches).map(([k, v]) => [k, v.reason || "matched"]))
      };
    }
  }

  // Explicit updates replace the current value. Automatic new-item processing
  // only fills an empty field. Neither path reads or writes Extra.
  function planUpdate(item, result, { allowOverwrite = true } = {}) {
    if (!result.supported) return { action: "skip", reason: "unsupported-type" };
    // Failure to identify a venue is not evidence that an old rank is wrong.
    // In particular, manual overwrite must never turn a failed lookup into deletion.
    if (!result.hasData || !result.text) return { action: "skip", reason: "no-data" };
    const current = String(item.callNumber || "");
    if (current === result.text) return { action: "skip", reason: "unchanged" };
    if (current && !allowOverwrite) return { action: "skip", reason: "existing-call-number" };
    return { action: "write", callNumber: result.text };
  }

  const api = { Catalog, validateDataset, normalizeTitle, normalizeISSNs, selectQuartile, planUpdate, journalIdentity };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScholarCore = api;
})(globalThis);
