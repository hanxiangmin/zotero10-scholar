/* Independent MIT implementation of conservative field cleanup.
 * No third-party formatter code, dictionaries, datasets, or network access. */
(function (root) {
  "use strict";
  const Core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.ScholarCore;
  const FIELDS = Object.freeze(["title", "DOI", "pages", "volume", "issue", "language", "journalAbbreviation", "conferenceName", "proceedingsTitle"]);
  const DEFAULTS = Object.freeze({ title: true, doi: true, pages: true, numbers: true, language: true, abbreviation: true, conference: true });
  const text = value => String(value ?? "");
  const plain = value => !/[<>]/.test(value);
  // A small original list of scientific spellings, not a borrowed dictionary.
  const PROTECTED_TERMS = "ccRCC fMRI MRI MRIs CT PET OCT WSI WSIs DNA RNA mRNA p53 BRCA1 HGNN HGNNv2 HGTL HOBN DHGFormer SVM CAD GNSS EEG ECG CCF DOI AI IEEE Gaussian Bayesian Bayes Markov Fourier Laplace Euler Euclidean Riemannian Boolean Bernoulli Poisson Newtonian Alzheimer Parkinson";

  function sentenceCase(value, extraTerms = "") {
    const title = text(value);
    if (!plain(title) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(title)) return title;
    const terms = new Map((PROTECTED_TERMS + " " + text(extraTerms).slice(0, 10000)).split(/[\s,，;；]+/)
      .filter(Boolean).map(word => [word.toLowerCase(), word]));
    let previousEnd = 0, first = true;
    return title.replace(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu, (word, offset) => {
      const prefix = title.slice(previousEnd, offset);
      const capitalize = first || /[:：!?]\s*["'“‘(\[]*\s*$/.test(prefix);
      first = false; previousEnd = offset + word.length;
      const protectedWord = terms.get(word.toLowerCase());
      if (protectedWord) return protectedWord;
      // Keep unknown acronyms, mixed-case model names and gene/number tokens.
      if (/[\p{N}]/u.test(word) || /^[A-Z]{2,}s?$/.test(word) || /[a-z][A-Z]/.test(word)) return word;
      const lower = word.toLowerCase();
      return capitalize ? lower[0].toUpperCase() + lower.slice(1) : lower;
    });
  }

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

  function standardConferenceNames(item, catalog) {
    if (item.itemType !== "conferencePaper" || !catalog) return {};
    const names = [item.conferenceName, item.proceedingsTitle].filter(value => text(value).trim());
    if (!names.length || names.some(value => !plain(value))) return {};
    // Each populated field must independently identify the same venue. Never
    // flatten workshops or contradict an unfamiliar/different proceedings name.
    const matched = names.map(name => catalog.lookup({ itemType: "conferencePaper", proceedingsTitle: name }).provenance?.ccf?.matchedTitle);
    if (matched.some(name => !name) || new Set(matched).size !== 1) return {};
    const standard = matched[0].trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/\s*&\s*/g, " & ");
    return Object.fromEntries(["conferenceName", "proceedingsTitle"].filter(field => text(item[field]) !== standard).map(field => [field, standard]));
  }

  function plan(item, options = {}, abbreviations = new Abbreviations(), catalog = null) {
    const warnings = [], fields = {};
    const enabled = { ...DEFAULTS, ...options };
    const propose = (field, value) => { if (value !== text(item[field])) fields[field] = value; };
    if (enabled.title && plain(text(item.title))) {
      const title = text(item.title).trim().replace(/[\s\u00a0]+/g, " ");
      const english = !text(item.language).trim() || /^en(?:[-_].*)?$/i.test(item.language);
      propose("title", enabled.titleCase !== "preserve" && english ? sentenceCase(title, enabled.protectedTerms) : title);
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
    if (enabled.conference) Object.assign(fields, standardConferenceNames(item, catalog));
    return Object.keys(fields).length
      ? { action: "write", fields, warnings }
      : { action: "skip", reason: "unchanged", fields, warnings };
  }

  const DOI_FIELDS = Object.freeze([...new Set([...FIELDS, "publicationTitle", "date", "ISSN", "url", "abstractNote", "proceedingsTitle", "conferenceName", "publisher", "place"])]);
  function doiKey(value) {
    const doi = cleanDOI(value);
    return /^10\.\d{4,9}\/\S+$/.test(doi) && !/[<>"\u0000-\u001f]/.test(doi) ? doi.toLowerCase() : "";
  }
  function normalizeCreators(values) {
    if (!Array.isArray(values) || !values.length || values.length > 10000) return null;
    const result = [];
    for (const value of values) {
      if (!value || typeof value.creatorType !== "string" || !value.creatorType) return null;
      const type = value.creatorType;
      if (value.fieldMode === 1 || typeof value.name === "string") {
        const name = text(value.name ?? value.lastName).trim();
        if (!name) return null;
        result.push({ creatorType: type, name });
      } else {
        if (typeof value.lastName !== "string" || !value.lastName.trim()) return null;
        if (value.firstName != null && typeof value.firstName !== "string") return null;
        result.push({ creatorType: type, firstName: text(value.firstName).trim(), lastName: value.lastName.trim() });
      }
    }
    return result;
  }
  function dateParts(value) {
    const parts = value?.["date-parts"]?.[0];
    if (!Array.isArray(parts) || !parts.length || parts.length > 3 || !parts.every(Number.isInteger)
        || parts[0] < 1600 || parts[0] > 2100 || (parts.length > 1 && (parts[1] < 1 || parts[1] > 12))) return "";
    if (parts.length > 2 && (parts[2] < 1 || parts[2] > new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate())) return "";
    return parts.map((part, i) => i ? String(part).padStart(2, "0") : String(part)).join("-");
  }

  function conferenceYear(evidence) {
    const values = new Set();
    const start = dateParts(evidence?.event?.start), end = dateParts(evidence?.event?.end);
    if (start) values.add(start.slice(0, 4));
    if (end) values.add(end.slice(0, 4));
    for (const assertion of Array.isArray(evidence?.assertion) ? evidence.assertion : []) {
      if (assertion?.group?.name === "ConferenceInfo" && assertion.name === "conference_year"
          && /^(?:19|20)\d{2}$/.test(text(assertion.value))) values.add(String(assertion.value));
    }
    return values.size === 1 ? [...values][0] : "";
  }

  function doiPlan(item, source, options = {}, catalog = null) {
    const fields = {}, skip = reason => ({ action: "skip", reason, fields });
    if (!doiKey(item.DOI)) return skip("invalid-doi");
    if (!source || doiKey(source.DOI) !== doiKey(item.DOI)) return skip("doi-mismatch");
    const raw = source.scholarCrossref;
    const evidence = raw && doiKey(raw.DOI) === doiKey(item.DOI) && Array.isArray(raw.title)
      && raw.title.some(title => Core.normalizeTitle(title) === Core.normalizeTitle(source.title)) ? raw : null;
    const year = conferenceYear(evidence);
    // Springer registers conference chapters as book sections. Only bridge
    // these types with explicit, DOI- and title-checked conference evidence.
    const chapter = item.itemType === "conferencePaper" && source.itemType === "bookSection"
      && evidence?.type === "book-chapter" && year;
    if (source.itemType !== item.itemType && !chapter) return skip("doi-type-mismatch");
    for (const field of DOI_FIELDS) {
      let value = source[field];
      if (typeof value !== "string" || !value.trim() || value.length > 100000 || /\u0000/.test(value)) continue;
      value = field === "DOI" ? cleanDOI(value) : value.trim();
      if (value !== text(item[field])) fields[field] = value;
    }
    if (chapter && !source.proceedingsTitle && typeof source.bookTitle === "string" && source.bookTitle.trim()) {
      fields.proceedingsTitle = source.bookTitle.trim();
    }
    if (item.itemType === "conferencePaper") {
      delete fields.date;
      if (year && year !== text(item.date)) fields.date = year;
    } else if (evidence) {
      // Journal issue/print date takes precedence over online-first/issued.
      const date = dateParts(evidence["published-print"]) || dateParts(evidence.published)
        || dateParts(evidence["published-online"]);
      if (date) {
        delete fields.date;
        if (date !== text(item.date)) fields.date = date;
      }
    }
    const updated = { ...item, ...fields };
    // Apply only the title rule here; the other cleanup actions stay separate.
    if (options.title !== false && typeof source.title === "string" && source.title.trim()) {
      const cleanup = plan(updated, { title: true, doi: false, pages: false, numbers: false, language: false, abbreviation: false,
        titleCase: options.titleCase, protectedTerms: options.protectedTerms });
      if (cleanup.fields.title !== undefined) fields.title = cleanup.fields.title;
      if (fields.title === text(item.title)) delete fields.title;
    }
    if (options.conference !== false) {
      Object.assign(fields, standardConferenceNames({ ...item, ...fields }, catalog));
      for (const field of ["conferenceName", "proceedingsTitle"]) if (fields[field] === text(item[field])) delete fields[field];
    }
    const creators = normalizeCreators(source.creators);
    const changedCreators = creators && JSON.stringify(creators) !== JSON.stringify(normalizeCreators(item.creators));
    const result = Object.keys(fields).length || changedCreators
      ? { action: "write", fields, ...(changedCreators ? { creators } : {}) } : skip("unchanged");
    if (item.itemType === "conferencePaper" && !year) result.dateUnverified = true;
    return result;
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

  const api = { FIELDS, DEFAULTS, cleanDOI, inferLanguage, Abbreviations, plan, duplicateIndex,
    DOI_FIELDS, doiKey, normalizeCreators, doiPlan, sentenceCase, dateParts, conferenceYear, standardConferenceNames };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScholarMetadata = api;
})(globalThis);
