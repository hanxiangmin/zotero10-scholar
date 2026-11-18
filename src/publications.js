/* Bibliographic completeness and published-version checks. No library writes. */
(function (root) {
  "use strict";
  const local = typeof module !== "undefined" && module.exports;
  const Core = local ? require("./core.js") : root.ScholarCore;
  const Metadata = local ? require("./metadata.js") : root.ScholarMetadata;
  const Search = local ? require("./search.js") : root.ScholarSearch;
  const PUBLICATION_FIELDS = ["publicationTitle", "proceedingsTitle", "conferenceName", "volume", "issue", "pages", "DOI", "ISSN", "journalAbbreviation"];
  const text = value => typeof value === "string" ? value.trim() : "";
  const year = value => String(value || "").match(/\b(?:18|19|20)\d{2}\b/)?.[0] || "";
  const authorList = item => (Metadata.normalizeCreators(item.creators) || []).filter(person => person.creatorType === "author");

  function preprint(item) {
    return item.itemType === "preprint" || /^10\.48550\/arxiv\./i.test(Metadata.doiKey(item.DOI))
      || /\b(?:arxiv|biorxiv|medrxiv|corr)\b/i.test(text(item.publicationTitle))
      || (!Metadata.doiKey(item.DOI) && Boolean(Search.arxivDOI(item)));
  }

  function missing(item) {
    if (!["journalArticle", "conferencePaper", "preprint", "bookSection", "report"].includes(item.itemType)) return [];
    const fields = ["title", "date", "DOI"];
    if (item.itemType === "journalArticle" && !preprint(item)) fields.push("publicationTitle", "volume", "issue", "pages");
    if (item.itemType === "conferencePaper") fields.push("proceedingsTitle", "pages");
    return fields.filter(field => !text(item[field]));
  }

  function crossrefSource(record) {
    const identity = Search.crossrefIdentity(record);
    if (!identity || !identity.itemType || !Metadata.doiKey(record.DOI)) return null;
    const containers = (record["container-title"] || []).map(text).filter(Boolean);
    const series = /^(?:lecture notes in (?:computer science|artificial intelligence|networks and systems)|communications in computer and information science|lecture notes in bioinformatics)$/i;
    const venue = containers.find(name => !series.test(name)) || text(record.event?.name);
    if (!venue) return null;
    const conference = identity.itemType === "conferencePaper";
    const source = {
      itemType: identity.itemType, DOI: Metadata.cleanDOI(record.DOI),
      title: identity.titles[identity.titles.length - 1], creators: identity.creators,
      date: conference ? Metadata.conferenceYear(record) : Metadata.dateParts(record["published-print"])
        || Metadata.dateParts(record.published) || Metadata.dateParts(record["published-online"]) || Metadata.dateParts(record.issued),
      volume: text(record.volume), issue: text(record.issue), pages: text(record.page) || text(record["article-number"]),
      ISSN: (record.ISSN || []).join(", "), url: text(record.URL), publisher: text(record.publisher),
      source: "Crossref", sourceURL: "https://api.crossref.org/works/" + encodeURIComponent(record.DOI),
      dateUnverified: conference && !Metadata.conferenceYear(record)
    };
    if (conference) {
      source.proceedingsTitle = venue;
      if (text(record.event?.name)) source.conferenceName = record.event.name;
    } else source.publicationTitle = venue;
    return source;
  }

  function sameAuthor(known, found) {
    if (Search.authorMatch(known, found)) return true;
    const name = person => Core.normalizeTitle(person.name || [person.firstName, person.lastName].filter(Boolean).join(" "));
    return name(known) && name(known) === name(found);
  }

  function agrees(item, source) {
    if (!source || !text(source.title) || !text(item.title)) return false;
    const original = Search.titleKey(item.title), candidate = Search.titleKey(source.title);
    const known = authorList(item), found = authorList(source);
    const matched = known.filter(person => found.some(other => sameAuthor(person, other)));
    const linked = preprint(item) && source.verifiedPreprintDOI
      && [Metadata.doiKey(item.DOI), Search.arxivDOI(item).toLowerCase()].includes(source.verifiedPreprintDOI);
    if (original !== candidate && !linked) {
      const a = original.split(" "), b = candidate.split(" ");
      if (a.length < 10 || a.length !== b.length || !a.slice(0, 4).every((word, i) => word === b[i])
          || a.filter((word, i) => word !== b[i]).length > 1 || matched.length < 2) return false;
    }
    if (known.length) return matched.length > 0;
    const a = year(item.date), b = year(source.date);
    return original.split(" ").length >= 6 && Boolean(a && b && Math.abs(Number(a) - Number(b)) <= 1);
  }

  function unique(item, sources) {
    const found = new Map();
    for (const source of sources.filter(Boolean)) {
      if (agrees(item, source)) found.set(Metadata.doiKey(source.DOI) || source.sourceURL, source);
    }
    if (found.size !== 1) return {reason: found.size ? "search-ambiguous" : "search-no-match"};
    return {source: [...found.values()][0]};
  }

  function plan(item, source, options = {}, catalog) {
    if (!agrees(item, source)) return {action: "skip", reason: "search-no-match", fields: {}};
    const fields = {}, converted = source.itemType !== item.itemType;
    const promoted = preprint(item) && source.itemType !== "preprint";
    if (converted || promoted) {
      for (const field of PUBLICATION_FIELDS) if (text(item[field])) fields[field] = "";
    }
    for (const field of Metadata.DOI_FIELDS) {
      const value = text(source[field]);
      if (value && value.length <= 100000 && !/\u0000/.test(value) && value !== text(item[field])) fields[field] = value;
    }
    const after = {...item, ...fields, itemType: source.itemType};
    const cleanup = Metadata.plan(after, {...options, doi: false, pages: false, numbers: false, language: false, abbreviation: false}, undefined, catalog);
    Object.assign(fields, cleanup.fields);
    for (const field of Object.keys(fields)) if (fields[field] === text(item[field])) delete fields[field];
    const sourceCreators = Metadata.normalizeCreators(source.creators);
    const sourceRoles = new Set((sourceCreators || []).map(person => person.creatorType));
    const retainedCreators = (Metadata.normalizeCreators(item.creators) || []).filter(person => !sourceRoles.has(person.creatorType));
    const creators = sourceCreators && [...sourceCreators,...retainedCreators];
    const changedCreators = creators && !source.preserveCreators
      && JSON.stringify(creators) !== JSON.stringify(Metadata.normalizeCreators(item.creators));
    return {
      action: Object.keys(fields).length || converted || changedCreators ? "write" : "skip",
      reason: "unchanged", fields, ...(converted ? {itemType: source.itemType} : {}),
      ...(changedCreators ? {creators} : {}), promoted,
      source: source.source, sourceURL: source.sourceURL, dateUnverified: source.dateUnverified,
      missing: missing(after), sourceMissing: missing(source)
    };
  }

  function dblpQuery(item) {
    const title = Search.titleKey(item.title);
    if (title.length < 8 || title.length > 2000 || /[<>\u0000-\u001f]/.test(text(item.title))) return null;
    const names = [...new Set(authorList(item).map(person => text(person.name || [person.firstName, person.lastName].filter(Boolean).join(" "))
      .replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 4);
    if (!names.length) return null;
    const anchor = title.split(" ").sort((a, b) => b.length - a.length)[0];
    return `PREFIX dblp: <https://dblp.org/rdf/schema#>
SELECT ?paper ?title ?year ?eventYear ?venue ?url ?doi ?pages ?volume ?issue ?name ?ordinal WHERE {
 { SELECT DISTINCT ?paper ?title ?year ?eventYear ?venue WHERE {
   VALUES ?authorName { ${names.map(name => JSON.stringify(name)).join(" ")} }
   VALUES ?type { dblp:Inproceedings dblp:Article }
   ?first dblp:signatureDblpName ?authorName ; dblp:signaturePublication ?paper .
   ?paper a ?type ; dblp:title ?title ; dblp:yearOfPublication ?year ; dblp:publishedIn ?venue .
   FILTER(CONTAINS(LCASE(STR(?title)), ${JSON.stringify(anchor)}))
   OPTIONAL { ?paper dblp:yearOfEvent ?eventYear }
 } LIMIT 21 }
 ?paper dblp:hasSignature ?signature .
 ?signature dblp:signatureDblpName ?name ; dblp:signatureOrdinal ?ordinal .
 OPTIONAL { ?paper dblp:primaryDocumentPage ?url }
 OPTIONAL { ?paper dblp:doi ?doi }
 OPTIONAL { ?paper dblp:pagination ?pages }
 OPTIONAL { ?paper dblp:publishedInJournalVolume ?volume }
 OPTIONAL { ?paper dblp:publishedInJournalVolumeIssue ?issue }
} LIMIT 1001`;
  }

  function dblpSources(rows) {
    if (!Array.isArray(rows) || rows.length >= 1001) return [];
    const records = new Map();
    for (const row of rows) {
      const value = field => text(row?.[field]?.value);
      const id = value("paper"), order = Number(value("ordinal"));
      if (!/^https:\/\/dblp\.org\/rec\/(?:conf|journals)\/[\w/-]+$/.test(id) || !Number.isInteger(order) || order < 1) continue;
      if (id.includes("/journals/corr/") || /\b(?:corr|arxiv|biorxiv|medrxiv)\b/i.test(value("venue"))
          || /^10\.48550\/arxiv\./i.test(Metadata.doiKey(value("doi")))) continue;
      if (!records.has(id)) {
        const conference = id.includes("/rec/conf/");
        const source = {
          itemType: conference ? "conferencePaper" : "journalArticle", title: value("title").replace(/\.$/, ""),
          DOI: Metadata.doiKey(value("doi")), date: conference ? value("eventYear") : value("year"),
          pages: value("pages"), volume: value("volume"), issue: value("issue"), url: value("url"),
          source: "DBLP", sourceURL: id, preserveCreators: true, names: new Map(),
          dateUnverified: conference && !value("eventYear")
        };
        source[conference ? "proceedingsTitle" : "publicationTitle"] = value("venue");
        records.set(id, source);
      }
      records.get(id).names.set(order, value("name").replace(/ \d{4}$/, ""));
    }
    if (records.size >= 21) return [];
    return [...records.values()].filter(record => record.names.has(1)).map(record => {
      record.creators = [...record.names].sort((a, b) => a[0] - b[0]).map(([, name]) => {
        const words = name.split(" ");
        return {creatorType: "author", lastName: words.pop(), firstName: words.join(" ")};
      });
      delete record.names;
      return record;
    });
  }

  function publisherMetadata(html) {
    if (typeof html !== "string" || html.length > 5 * 1024 * 1024) return {};
    const decode = value => value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
      const named = {"&amp;":"&","&quot;":"\"","&apos;":"'","&lt;":"<","&gt;":">"};
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const hex = entity.toLowerCase().startsWith("&#x");
      const code = parseInt(entity.slice(hex ? 3 : 2,-1),hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
    const values = {};
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      const attrs = {};
      for (const match of tag.matchAll(/\b(name|property|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3]);
      const name = (attrs.name || attrs.property || "").toLowerCase();
      if (name.startsWith("citation_") && attrs.content) values[name] = attrs.content;
    }
    const first = values.citation_firstpage, last = values.citation_lastpage;
    return {title:values.citation_title, arxivID:values.citation_arxiv_id, DOI:values.citation_doi,
      volume:values.citation_volume, issue:values.citation_issue,
      pages:first ? last && last !== first ? first + "–" + last : first : undefined};
  }

  class Client {
    constructor(request, cancelled = () => false) {
      this.request = request;
      this.cancelled = cancelled;
      this.cache = new Map();
    }
    async get(kind, key, url) {
      if (this.cancelled()) throw new Error("audit-cancelled");
      const cacheKey = kind + ":" + key;
      if (!this.cache.has(cacheKey)) this.cache.set(cacheKey, this.request(kind, key, url));
      const result = await this.cache.get(cacheKey);
      if (this.cancelled()) throw new Error("audit-cancelled");
      return result;
    }
    async crossref(doi) {
      const data = await this.get("crossref", doi, "https://api.crossref.org/works/" + encodeURIComponent(doi));
      return crossrefSource(data?.message);
    }
    async titleSearch(item) {
      const title = Search.titleKey(item.title);
      if (title.length < 8 || title.length > 2000) return [];
      const url = "https://api.crossref.org/works?query.title=" + encodeURIComponent(title) + "&rows=20";
      const data = await this.get("crossref-search", title, url);
      return (data?.message?.items || []).map(crossrefSource).filter(source => source && !preprint(source));
    }
    async dblp(item) {
      const query = dblpQuery(item);
      if (!query) return [];
      const data = await this.get("dblp", query, "https://sparql.dblp.org/sparql?query=" + encodeURIComponent(query) + "&format=json");
      return dblpSources(data?.results?.bindings);
    }
    async enrichPublisher(source) {
      let url;
      try { url = new URL(source.url); } catch (_) { return source; }
      if (!["https:","http:"].includes(url.protocol) || url.username || url.password) return source;
      const allowed = ["proceedings.neurips.cc","papers.nips.cc","proceedings.mlr.press","jmlr.org","www.jmlr.org","openaccess.thecvf.com","aclanthology.org","www.ijcai.org"];
      if (!allowed.includes(url.hostname)) return source;
      url.protocol = "https:";
      const html = await this.get("publisher",url.href,url.href);
      const fields = publisherMetadata(html);
      if (Search.titleKey(fields.title) !== Search.titleKey(source.title)) return source;
      const updated = {...source};
      for (const field of ["volume","issue","pages"]) if (text(fields[field])) updated[field] = fields[field].trim();
      updated.publisherURL = url.href;
      return updated;
    }
    async arxivPublished(item) {
      const preprintDOI = Metadata.doiKey(item.DOI) || Search.arxivDOI(item).toLowerCase();
      if (!preprintDOI.startsWith("10.48550/arxiv.")) return null;
      const id = preprintDOI.slice("10.48550/arxiv.".length);
      if (!/^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})$/i.test(id)) return null;
      const url = "https://arxiv.org/abs/" + id;
      const html = await this.get("publisher",url,url);
      const fields = publisherMetadata(html);
      if (text(fields.arxivID).replace(/^arxiv:/i,"").replace(/v\d+$/i,"").toLowerCase() !== id) return null;
      const publishedDOI = Metadata.doiKey(fields.DOI);
      if (!publishedDOI || publishedDOI.startsWith("10.48550/arxiv.")) return null;
      const source = await this.crossref(publishedDOI);
      if (!source || preprint(source)) return null;
      source.verifiedPreprintDOI = preprintDOI;
      source.versionSourceURL = url;
      return agrees(item,source) ? source : null;
    }
    async dataCite(item) {
      const doi = Metadata.doiKey(item.DOI) || Search.arxivDOI(item);
      const url = doi ? "https://api.datacite.org/dois/" + encodeURIComponent(doi)
        : "https://api.datacite.org/dois?query=" + encodeURIComponent(Search.preprintQuery({...item, itemType: "preprint", DOI: ""}) || Search.titleKey(item.title))
          + "&resource-type-id=preprint&sort=relevance&page%5Bsize%5D=20";
      const data = await this.get("datacite", doi || Search.titleKey(item.title), url);
      const records = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
      return records.map(record => {
        const source = Search.dataCiteSource(record);
        const publishedDOIs = (record.attributes?.relatedIdentifiers || []).filter(relation => relation.relatedIdentifierType === "DOI"
          && ["IsPreprintOf","IsVersionOf","IsPublishedIn"].includes(relation.relationType))
          .map(relation => Metadata.doiKey(relation.relatedIdentifier)).filter(Boolean);
        const identifier = Metadata.doiKey(item.DOI) || Search.arxivDOI(item).toLowerCase();
        return source && {...source, publishedDOIs, ...(identifier === Metadata.doiKey(source.DOI) ? {verifiedPreprintDOI:identifier} : {}),
          source: "DataCite", sourceURL: "https://api.datacite.org/dois/" + encodeURIComponent(source.DOI)};
      }).filter(Boolean);
    }
    async resolve(item, {preferPublished = true} = {}) {
      const errors = [];
      const attempt = async action => {
        try { return await action(); }
        catch (error) {
          if (this.cancelled()) throw error;
          errors.push(String(error.message || error));
          return null;
        }
      };
      const doi = Metadata.doiKey(item.DOI);
      const originalPreprint = preprint(item);
      let source = null;
      let fallbackPreprint = null;
      if (originalPreprint && !preferPublished) {
        const records = await attempt(() => this.dataCite(item));
        source = unique(item, records || []).source;
        return {source, errors, reason: source ? "verified" : "search-no-match"};
      }
      if (doi && !/^10\.48550\/arxiv\./i.test(doi)) {
        const candidate = await attempt(() => this.crossref(doi));
        if (agrees(item, candidate) && !preprint(candidate)) source = candidate;
      }
      if (!source && originalPreprint) {
        const preprints = await attempt(() => this.dataCite(item));
        fallbackPreprint = unique(item, preprints || []).source;
        for (const publishedDOI of fallbackPreprint?.publishedDOIs || []) {
          const candidate = await attempt(() => this.crossref(publishedDOI));
          if (candidate) candidate.verifiedPreprintDOI = Metadata.doiKey(fallbackPreprint.DOI);
          if (agrees(item, candidate)) { source = candidate; break; }
        }
      }
      if (!source) {
        const records = await attempt(() => this.titleSearch(item));
        const match = unique(item, records || []);
        if (match.source) source = match.source;
        else if (match.reason === "search-ambiguous") return {reason: match.reason, errors};
      }
      if (!source || (originalPreprint && preferPublished && source.itemType === "preprint")) {
        const records = await attempt(() => this.dblp(item));
        const match = unique(item, records || []);
        if (match.source) {
          source = match.source;
          if (Metadata.doiKey(source.DOI)) {
            const full = await attempt(() => this.crossref(Metadata.doiKey(source.DOI)));
            if (agrees(item, full)) source = full;
          }
        } else if (match.reason === "search-ambiguous") return {reason: match.reason, errors};
      }
      if (!source && originalPreprint) {
        source = await attempt(() => this.arxivPublished(item));
      }
      if (!source && originalPreprint) {
        source = fallbackPreprint;
      }
      if (source?.itemType === "conferencePaper" && source.dateUnverified) {
        const records = await attempt(() => this.dblp(item));
        const event = unique(item,records || []).source;
        if (event?.itemType === "conferencePaper" && event.date) {
          source = {...source,date:event.date,dateUnverified:false,eventSourceURL:event.sourceURL};
        }
      }
      if (source?.source === "DBLP") source = await attempt(() => this.enrichPublisher(source)) || source;
      return {source, errors, reason: source ? "verified" : errors.length ? "search-failed" : "search-no-match"};
    }
  }

  const api = {Client, missing, preprint, agrees, unique, plan, crossrefSource, dblpQuery, dblpSources, publisherMetadata, PUBLICATION_FIELDS};
  if (local) module.exports = api;
  else root.ScholarPublications = api;
})(globalThis);
