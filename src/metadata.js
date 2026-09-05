/* Independent MIT implementation of conservative field cleanup and recovery.
 * No third-party formatter code, dictionaries, datasets, or network access. */
(function (root) {
  "use strict";
  const Core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.ScholarCore;
  const PREFIX = "Zotero Scholar Metadata: ";
  const FIELDS = Object.freeze(["title", "DOI", "pages", "volume", "issue", "language", "journalAbbreviation"]);
  const DEFAULTS = Object.freeze({ title: true, doi: true, pages: true, numbers: true, language: true, abbreviation: true });
  const text = value => String(value ?? "");
  const plain = value => !/[<>]/.test(value);

  function cleanDOI(value) {
    const original = text(value);
    let candidate = original.trim().replace(/^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "");
    if (/^https?:/i.test(original.trim()) && /[?#]/.test(candidate)) return original;
    // DOI suffixes may contain punctuation and parentheses; do not strip them.
    if (/^10\.\d{4,9}\/\S+$/i.test(candidate) && !/[<>"\u0000-\u001f]/.test(candidate)) return candidate;
    return original;
  }

  function inferLanguage(title) {
    const value = text(title);
    if (!plain(value) || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return "";
    const han = (value.match(/\p{Script=Han}/gu) || []).length;
    const letters = (value.match(/\p{L}/gu) || []).length;
    if (han >= 4 && han / Math.max(letters, 1) >= 0.5) return "zh";
    if (/[^\x00-\x7f]/.test(value)) return "";
    const words = value.toLowerCase().match(/[a-z]+/g) || [];
    const grammar = new Set(["the", "and", "with", "for", "of", "a", "an", "in", "to", "by", "from", "using", "based", "on"]);
    const signals = new Set(words.filter(word => grammar.has(word)));
    return words.length >= 5 && signals.size >= 2 ? "en" : "";
  }

  class Abbreviations {
    constructor(input) {
      this.names = new Map(); this.issns = new Map(); this.source = ""; this.count = 0;
      if (input === undefined) return;
      if (!input || input.schemaVersion !== 1 || input.kind !== "journal-abbreviations"
          || typeof input.source !== "string" || !input.source.trim() || input.source.length > 4000
          || !Array.isArray(input.records) || !input.records.length || input.records.length > 100000) {
        throw new Error("缩写表需要 schemaVersion: 1、kind: journal-abbreviations、source 和 records（1–100000 条）。");
      }
      const add = (map, key, abbreviation) => {
        if (!key) return;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(abbreviation);
      };
      for (const record of input.records) {
        if (!record || typeof record.title !== "string" || !record.title.trim() || record.title.length > 2000
            || typeof record.abbreviation !== "string" || !record.abbreviation.trim() || record.abbreviation.length > 500
            || !plain(record.abbreviation) || /[\r\n]/.test(record.abbreviation)
            || (record.issns != null && (!Array.isArray(record.issns) || record.issns.some(v => typeof v !== "string")))) {
          throw new Error("缩写记录必须包含有效 title、abbreviation，可选 issns 字符串数组。");
        }
        add(this.names, Core.normalizeTitle(record.title), record.abbreviation.trim());
        for (const issn of Core.normalizeISSNs(record.issns || [])) add(this.issns, issn, record.abbreviation.trim());
      }
      this.source = input.source; this.count = input.records.length;
    }
    lookup(item) {
      const byISSN = new Set(Core.normalizeISSNs(item.ISSN).flatMap(issn => [...(this.issns.get(issn) || [])]));
      const candidates = byISSN.size ? byISSN : this.names.get(Core.normalizeTitle(item.publicationTitle)) || new Set();
      return { value: candidates.size === 1 ? [...candidates][0] : "", ambiguous: candidates.size > 1 };
    }
  }

  function readState(extra) {
    const lines = text(extra).split(/\r?\n/).filter(line => line.startsWith(PREFIX));
    if (!lines.length) return { state: null, corrupt: false };
    try {
      if (lines.length !== 1 || lines[0].length > 200000) throw new Error();
      const state = JSON.parse(lines[0].slice(PREFIX.length));
      if (state.v !== 1 || typeof state.addedSeparator !== "boolean" || !state.fields || Array.isArray(state.fields)
          || typeof state.fields !== "object" || !Object.keys(state.fields).length) throw new Error();
      for (const [field, values] of Object.entries(state.fields)) {
        if (!FIELDS.includes(field) || !values || typeof values.original !== "string" || typeof values.last !== "string") throw new Error();
      }
      return { state, corrupt: false };
    } catch (_) { return { state: null, corrupt: true }; }
  }

  function writeState(extra, state) {
    const value = text(extra);
    const line = PREFIX + JSON.stringify(state);
    if (readState(value).state) return value.replace(/^Zotero Scholar Metadata: [^\r\n]*/m, () => line);
    return value + (value && !value.endsWith("\n") ? "\n" : "") + line;
  }

  function removeState(extra, state) {
    const value = text(extra), match = /^Zotero Scholar Metadata: [^\r\n]*/m.exec(value);
    if (!match) return value;
    let start = match.index;
    if (state.addedSeparator && start > 0 && value[start - 1] === "\n") start -= 1;
    return value.slice(0, start) + value.slice(match.index + match[0].length);
  }

  function plan(item, options = {}, abbreviations = new Abbreviations()) {
    const { state, corrupt } = readState(item.extra);
    const warnings = [], fields = {};
    if (corrupt) return { action: "skip", reason: "invalid-backup", fields, warnings: ["元数据备份异常，未整理。"] };
    const enabled = { ...DEFAULTS, ...options };
    const next = state ? JSON.parse(JSON.stringify(state)) : {
      v: 1, addedSeparator: Boolean(item.extra && !item.extra.endsWith("\n")), fields: {}
    };
    const propose = (field, value) => {
      const before = text(item[field]);
      if (value === before) return;
      if (state?.fields[field] && before !== state.fields[field].last) {
        warnings.push(`${field} 已被手动修改，已保留。`); return;
      }
      fields[field] = value;
      next.fields[field] = { original: state?.fields[field]?.original ?? before, last: value };
    };
    if (enabled.title && plain(text(item.title))) {
      // Retain every word's case, punctuation and spelling, including genes.
      propose("title", text(item.title).trim().replace(/[\s\u00a0]+/g, " "));
    }
    if (enabled.doi) propose("DOI", cleanDOI(item.DOI));
    if (enabled.pages) {
      const original = text(item.pages), value = original.trim();
      if (/^(?:[A-Za-z]?\d+)\s*[-–—]\s*(?:[A-Za-z]?\d+)$/.test(value)) {
        propose("pages", value.replace(/\s*[-–—]\s*/, "–"));
      }
    }
    if (enabled.numbers) for (const field of ["volume", "issue"]) {
      const value = text(item[field]).trim();
      if (/^\d+$/.test(value)) propose(field, value.replace(/^0+(?=\d)/, ""));
    }
    if (enabled.language && !text(item.language).trim()) {
      const language = inferLanguage(item.title);
      if (language) propose("language", language);
      else warnings.push("语言无法可靠判断，已跳过；可手动填写。 ");
    }
    if (enabled.abbreviation && item.itemType === "journalArticle" && !text(item.journalAbbreviation).trim()) {
      const result = abbreviations.lookup(item);
      if (result.value) propose("journalAbbreviation", result.value);
      else if (result.ambiguous) warnings.push("期刊缩写存在歧义，已跳过。 ");
      else warnings.push(abbreviations.count ? "缩写表未匹配，保留现有值。" : "尚未导入期刊缩写表，已跳过。 ");
    }
    return Object.keys(fields).length
      ? { action: "write", fields, extra: writeState(item.extra, next), warnings }
      : { action: "skip", reason: "unchanged", fields, warnings };
  }

  function restore(item) {
    const { state, corrupt } = readState(item.extra), fields = {}, warnings = [];
    if (corrupt || !state) return { action: "skip", reason: corrupt ? "invalid-backup" : "no-backup", fields, warnings };
    const next = JSON.parse(JSON.stringify(state));
    for (const [field, values] of Object.entries(state.fields)) {
      if (text(item[field]) !== values.last) { warnings.push(`${field} 已被手动修改，已保留。`); continue; }
      fields[field] = values.original; delete next.fields[field];
    }
    if (!Object.keys(fields).length) return { action: "skip", reason: "manually-edited", fields, warnings };
    return { action: "write", fields, warnings,
      extra: Object.keys(next.fields).length ? writeState(item.extra, next) : removeState(item.extra, state) };
  }

  function duplicateIndex(items) {
    const dois = new Map(), titles = new Map();
    const add = (map, key, item) => { if (key) { if (!map.has(key)) map.set(key, []); map.get(key).push(item); } };
    const doiKey = item => {
      const doi = cleanDOI(item.DOI).toLowerCase();
      return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : "";
    };
    for (const item of items) {
      const doi = doiKey(item), title = Core.normalizeTitle(item.title);
      add(dois, doi && `${item.libraryID}:${doi}`, item);
      if (title.length >= 25) add(titles, `${item.libraryID}:${title}`, item);
    }
    return item => {
      const doi = doiKey(item), title = Core.normalizeTitle(item.title), result = new Map();
      for (const candidate of dois.get(`${item.libraryID}:${doi}`) || []) {
        if (candidate.id !== item.id) result.set(candidate.id, { id: candidate.id, title: candidate.title, reason: "DOI 相同" });
      }
      if (title.length >= 25) for (const candidate of titles.get(`${item.libraryID}:${title}`) || []) {
        if (candidate.id === item.id || (doi && doiKey(candidate) && doiKey(candidate) !== doi)) continue;
        if (!result.has(candidate.id)) result.set(candidate.id, { id: candidate.id, title: candidate.title, reason: "标题相同，需人工核对" });
      }
      return [...result.values()];
    };
  }

  const api = { FIELDS, PREFIX, DEFAULTS, cleanDOI, inferLanguage, Abbreviations, readState, plan, restore, duplicateIndex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScholarMetadata = api;
})(globalThis);
