/* Pure matching/validation logic. No Zotero, network, or filesystem access. */
(function (root) {
  "use strict";
  const MISSING = "—";
  const STATE_PREFIX = "Zotero Scholar Rank: ";
  const EXCLUDED_CONFERENCE = /\b(workshops?|findings|short\s+papers?|demo(?:nstration)?s?|technical\s+briefs?|companion|posters?|doctoral\s+(?:consortium|symposium)|extended\s+abstracts?)\b/i;

  function normalizeTitle(value) {
    return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "")
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

  function indexDataset(input) {
    const dataset = validateDataset(input);
    const names = new Map(), issns = new Map();
    for (const record of dataset.records) {
      const prefix = dataset.kind === "ccf" ? `${record.type}:` : "";
      for (const name of [record.title, ...record.aliases, record.abbreviation]) {
        const normalized = normalizeTitle(name);
        if (normalized) addToIndex(names, prefix + normalized, record);
      }
      for (const issn of record.issns) addToIndex(issns, issn, record);
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
    const found = normalizeISSNs(item.ISSN).flatMap(issn => index.issns.get(issn) || [])
      .filter(record => index.dataset.kind !== "ccf" || record.type === "journal");
    if (found.length) return pickUnique(found, "ISSN");
    const prefix = index.dataset.kind === "ccf" ? "journal:" : "";
    const exact = index.names.get(prefix + normalizeTitle(item.publicationTitle)) || [];
    if (exact.length) return pickUnique(exact, "title");
    // Use the abbreviation only when the full title did not match. Ambiguous
    // acronyms do not override an exact publication title or an ISSN.
    return pickUnique(index.names.get(prefix + normalizeTitle(item.journalAbbreviation)) || [], "abbreviation");
  }

  function conferenceMatch(index, item) {
    if (!index) return { record: null, reason: "no-dataset" };
    const names = [item.conferenceName, item.proceedingsTitle].filter(Boolean);
    // A parent conference name does not turn a Workshop/Findings paper into a full paper.
    if (names.some(n => EXCLUDED_CONFERENCE.test(n))) return { record: null, reason: "excluded-conference-track" };
    const exact = names.flatMap(n => index.names.get("conference:" + normalizeTitle(n)) || []);
    if (exact.length) return pickUnique(exact, "conference-title");
    const candidates = [];
    for (const record of index.dataset.records) {
      if (record.type !== "conference") continue;
      for (const name of [record.title, ...record.aliases, record.abbreviation]) {
        const key = normalizeTitle(name);
        // Short acronyms like AI are unsafe in a longer proceedings title.
        if (key.length < 3) continue;
        if (names.some(n => (` ${normalizeTitle(n)} `).includes(` ${key} `))) candidates.push({ record, length: key.length });
      }
    }
    const longest = Math.max(0, ...candidates.map(c => c.length));
    return pickUnique(candidates.filter(c => c.length === longest).map(c => c.record), "conference-alias");
  }

  function selectQuartile(quartiles, policy = "best") {
    if (!quartiles.length) return null;
    const all = [...new Set(quartiles.map(q => q.quartile))].sort();
    if (policy === "all") return all.join("/");
    return policy === "worst" ? all[all.length - 1] : all[0];
  }

  class Catalog {
    constructor(datasets) {
      this.indexes = {};
      for (const data of datasets) this.replace(data);
    }
    replace(data) {
      const index = indexDataset(data);
      this.indexes[data.kind] = index;
    }
    list() {
      return Object.values(this.indexes).map(({ dataset: { records, ...metadata } }) => ({ ...metadata, count: records.length }));
    }
    lookup(item, policy = "best") {
      if (!["journalArticle", "conferencePaper"].includes(item.itemType)) {
        return { supported: false, reason: "unsupported-type", text: "", hasData: false };
      }
      const conference = item.itemType === "conferencePaper";
      const ccf = conference ? conferenceMatch(this.indexes.ccf, item) : journalMatch(this.indexes.ccf, item);
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
        fields, provenance, policy, availableKinds: Object.keys(this.indexes),
        jcrMetricYear: this.indexes.jcr?.dataset.metricYear,
        reasons: Object.fromEntries(Object.entries(matches).map(([k, v]) => [k, v.reason || "matched"]))
      };
    }
  }

  function readState(extra) {
    const lines = String(extra || "").split(/\r?\n/).filter(l => l.startsWith(STATE_PREFIX));
    if (!lines.length) return { state: null, corrupt: false };
    if (lines.length !== 1) return { state: null, corrupt: true };
    try {
      const state = JSON.parse(lines[0].slice(STATE_PREFIX.length));
      assert(state.v === 1 && typeof state.original === "string" && typeof state.last === "string", "Invalid state");
      return { state, corrupt: false };
    } catch (_) { return { state: null, corrupt: true }; }
  }

  function writeState(extra, state) {
    const text = String(extra || "");
    const line = STATE_PREFIX + JSON.stringify(state);
    if (readState(text).state) return text.replace(/^Zotero Scholar Rank: [^\r\n]*/m, () => line);
    return text + (text && !text.endsWith("\n") ? "\n" : "") + line;
  }

  function removeState(extra, state) {
    const text = String(extra || "");
    const match = /^Zotero Scholar Rank: [^\r\n]*/m.exec(text);
    if (!match) return text;
    let start = match.index;
    if (state.addedSeparator && start > 0 && text[start - 1] === "\n") start -= 1;
    return text.slice(0, start) + text.slice(match.index + match[0].length);
  }

  function planUpdate(item, result, {
    allowOverwrite = false, repairCleared = false, now = new Date().toISOString()
  } = {}) {
    if (!result.supported) return { action: "skip", reason: "unsupported-type" };
    const { state, corrupt } = readState(item.extra);
    if (corrupt) return { action: "skip", reason: "invalid-backup" };
    const current = String(item.callNumber || "");
    // A metadata linter may clear callNumber while leaving our exact state in
    // Extra. Only an explicit user action may repair that empty field; normal
    // refreshes still protect every non-empty manual edit.
    const mayRepairCleared = Boolean(state && repairCleared && !current && state.last
      && (result.text === state.last || allowOverwrite));
    if (state && state.last !== current && !mayRepairCleared) {
      return { action: "skip", reason: "manually-edited" };
    }
    // A public build may have no bundled catalogs. Missing source packages must
    // not be mistaken for a venue changing to one with no matching metrics.
    if (state && Array.isArray(result.availableKinds)
      && (!result.availableKinds.length || Object.keys(state.provenance || {}).some(kind => !result.availableKinds.includes(kind)))) {
      return { action: "skip", reason: "data-unavailable" };
    }
    // A public build can load an older local JCR package that a previous
    // personal build rejected. Check the loaded year even for unmatched titles.
    const previousJCRYear = state?.provenance?.jcr?.metricYear;
    if (Number.isInteger(previousJCRYear) && Number.isInteger(result.jcrMetricYear)
      && result.jcrMetricYear < previousJCRYear) {
      return { action: "skip", reason: "outdated-data" };
    }
    // A changed venue must not retain the previous venue's derived metrics.
    // Only clear results that this plugin owns; unknown new items stay untouched.
    if (!result.hasData && !state) return { action: "skip", reason: "no-data" };
    if (!state && current && !allowOverwrite) return { action: "skip", reason: "existing-call-number" };
    const next = {
      v: 1, original: state ? state.original : current, last: result.text,
      addedSeparator: state ? state.addedSeparator : Boolean(item.extra && !item.extra.endsWith("\n")),
      updatedAt: now, provenance: result.provenance, quartilePolicy: result.policy
    };
    // Avoid touching dateModified and the sync queue on repeated refreshes.
    if (state && current === next.last && JSON.stringify(state.provenance) === JSON.stringify(next.provenance) && state.quartilePolicy === next.quartilePolicy) {
      return { action: "skip", reason: "unchanged" };
    }
    return { action: "write", callNumber: result.text, extra: writeState(item.extra, next) };
  }

  function planRestore(item) {
    const { state, corrupt } = readState(item.extra);
    if (corrupt) return { action: "skip", reason: "invalid-backup" };
    if (!state) return { action: "skip", reason: "no-backup" };
    if (String(item.callNumber || "") !== state.last) return { action: "skip", reason: "manually-edited" };
    return { action: "write", callNumber: state.original, extra: removeState(item.extra, state) };
  }

  const api = { Catalog, validateDataset, normalizeTitle, normalizeISSNs, selectQuartile, readState, planUpdate, planRestore, STATE_PREFIX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScholarCore = api;
})(globalThis);
