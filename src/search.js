/* Independent, conservative identity checks for manual bibliographic search. */
(function (root) {
  "use strict";
  const Core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.ScholarCore;
  const Metadata = typeof module !== "undefined" && module.exports ? require("./metadata.js") : root.ScholarMetadata;
  const text = value => typeof value === "string" ? value.trim() : "";
  const key = value => Core.normalizeTitle(text(value));
  const year = value => text(value).match(/\b(?:18|19|20)\d{2}\b/)?.[0] || "";
  const authors = item => (Metadata.normalizeCreators(item.creators) || []).filter(creator => creator.creatorType === "author");
  const venueNames = item => (item.itemType === "conferencePaper"
    ? [item.conferenceName, item.proceedingsTitle, item.bookTitle] : [item.publicationTitle]).map(text).filter(Boolean);
  function query(item) {
    const title = text(item.title), names = authors(item);
    if (text(item.DOI)) return null; // Never replace a populated or malformed DOI by guessing.
    if (key(title).length < 8 || title.length > 1000 || /[<>\u0000-\u001f]/.test(title) || !names.length) return null;
    const first = names[0], author = first.name || [first.firstName, first.lastName].filter(Boolean).join(" ");
    const venues = venueNames(item), date = year(item.date);
    if (!author || author.length > 200 || (!date && !venues.length)) return null;
    const bibliographic = [title, venues[0]?.slice(0, 500), date].filter(Boolean).join(" ");
    return { bibliographic, author, cacheKey: JSON.stringify([bibliographic, author]) };
  }
  function authorMatch(a, b) {
    if (a.name || b.name) return Boolean(a.name && b.name && key(a.name) === key(b.name));
    if (!key(a.lastName) || key(a.lastName) !== key(b.lastName)) return false;
    const givenA = key(a.firstName).split(" ").filter(Boolean), givenB = key(b.firstName).split(" ").filter(Boolean);
    if (!givenA.length || !givenB.length) return true;
    return givenA.slice(0, Math.min(givenA.length, givenB.length)).every((part, index) => {
      const other = givenB[index];
      return part === other || (part.length === 1 && other.startsWith(part)) || (other.length === 1 && part.startsWith(other));
    });
  }
  function crossrefIdentity(record) {
    if (!record || !Array.isArray(record.title) || !Array.isArray(record.author)) return null;
    const creators = record.author.map(author => author?.name ? { creatorType: "author", name: author.name }
      : { creatorType: "author", firstName: author?.given || "", lastName: author?.family });
    const conference = Metadata.conferenceYear(record);
    const type = record.type === "journal-article" ? "journalArticle"
      : record.type === "proceedings-article" || (record.type === "book-chapter" && conference) ? "conferencePaper" : "";
    const dates = [conference, ...["published-print", "published", "published-online", "issued"].map(field => Metadata.dateParts(record[field]))].filter(Boolean);
    const titles = [...record.title];
    if (record.title.length === 1 && Array.isArray(record.subtitle) && record.subtitle.length === 1) titles.push(`${record.title[0]}: ${record.subtitle[0]}`);
    return { DOI: record.DOI, itemType: type, titles, creators, dates,
      venues: [...(Array.isArray(record["container-title"]) ? record["container-title"] : []), record.event?.name].map(text).filter(Boolean),
      ISSN: record.ISSN || [] };
  }
  function sameVenue(item, candidate, catalog) {
    const names = venueNames(item);
    if (!names.length || !candidate.venues.length) return false;
    if (item.itemType === "journalArticle") {
      const localISSNs = Core.normalizeISSNs(item.ISSN), remoteISSNs = Core.normalizeISSNs(candidate.ISSN);
      if (localISSNs.length && remoteISSNs.length && !localISSNs.some(issn => remoteISSNs.includes(issn))) return false;
      if (names.some(name => candidate.venues.some(venue => key(name) === key(venue)))) return true;
      // Alternate names with the same valid ISSN are acceptable; the title and
      // authors of the paper still have to agree independently.
      return localISSNs.some(issn => remoteISSNs.includes(issn));
    }
    // Every populated conference field must agree. A matching acronym in one
    // field cannot hide a different event or a workshop in the other field.
    const exact = (a,b) => key(a) === key(b);
    const ancillary = /\b(workshops?|findings|companion|posters?|short\s+papers?)\b/i.test([...names,...candidate.venues].join(" "));
    const standard = name => catalog?.lookup({itemType:"conferencePaper",proceedingsTitle:name}).provenance?.ccf?.matchedTitle;
    const equivalent = (a,b) => exact(a,b) || (!ancillary && standard(a) && standard(a) === standard(b));
    return names.every(name => candidate.venues.some(venue => equivalent(name,venue)))
      && candidate.venues.every(venue => names.some(name => equivalent(name,venue)));
  }
  function matches(item, candidate, catalog) {
    if (!candidate || !Metadata.doiKey(candidate.DOI) || candidate.itemType !== item.itemType) return false;
    if (!candidate.titles.some(title => key(title) === key(item.title))) return false;
    const known = authors(item), found = Metadata.normalizeCreators(candidate.creators);
    if (!known.length || !found?.length || !authorMatch(known[0], found[0])) return false;
    if (!known.slice(1, 3).every(author => found.some(other => authorMatch(author, other)))) return false;
    const localYear = year(item.date), remoteYears = candidate.dates.map(year).filter(Boolean);
    const agreesYear = Boolean(localYear && remoteYears.some(value => Math.abs(Number(value) - Number(localYear)) <= 1));
    if (localYear && remoteYears.length && !agreesYear) return false;
    const hasVenue = venueNames(item).length > 0 && candidate.venues.length > 0;
    const agreesVenue = sameVenue(item, candidate, catalog);
    if (hasVenue && !agreesVenue) return false;
    return agreesVenue || agreesYear;
  }
  function select(item, records, catalog) {
    if (!query(item)) return { reason: "search-insufficient" };
    const found = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      if (matches(item, crossrefIdentity(record), catalog)) found.set(Metadata.doiKey(record.DOI), record);
    }
    if (found.size !== 1) return { reason: found.size ? "search-ambiguous" : "search-no-match" };
    return { record: found.values().next().value };
  }
  function resolvedPlan(item, record, source, options, catalog) {
    const skip = reason => ({ action:"skip", reason, fields:{} });
    if (text(item.DOI) || Metadata.doiKey(record?.DOI) !== Metadata.doiKey(source?.DOI)
        || !matches(item, crossrefIdentity(record), catalog)) return skip("search-no-match");
    const evidence = source?.scholarCrossref || record;
    // Recheck the final fetched title/authors/venue too, not just the search hit.
    const candidate = { DOI:source.DOI, titles:[source.title], creators:source.creators,
      itemType:source.itemType === "bookSection" && Metadata.conferenceYear(evidence) ? "conferencePaper" : source.itemType,
      venues:venueNames({...source,itemType:item.itemType}), ISSN:source.ISSN,
      dates:[source.date, Metadata.conferenceYear(evidence), ...["published-print","published","published-online"].map(field=>Metadata.dateParts(evidence?.[field]))].filter(Boolean) };
    if (!matches(item, candidate, catalog)) return skip("search-no-match");
    const doi = Metadata.cleanDOI(record.DOI);
    // Supply the verified DOI only to the pure planner. The real pre-query
    // snapshot stays unchanged for concurrency checks and the before/after UI.
    const result = Metadata.doiPlan({...item,DOI:doi},{...source,scholarCrossref:evidence},options,catalog);
    if (result.action === "skip" && result.reason !== "unchanged") return result;
    return {...result,action:"write",fields:{...result.fields,DOI:doi}};
  }
  function titleKey(value) {
    // PDF extraction may leave a soft hyphen or split a word at a line end.
    return key(text(value).replace(/\u00ad/g, "").replace(/([a-z])-\s+([a-z])/gi, "$1$2"));
  }

  function conferenceQuery(item) {
    if (item.itemType !== "conferencePaper" || text(item.DOI)) return null;
    const first = authors(item)[0];
    if (!first || titleKey(item.title).length < 12) return null;
    const name = first.name || [first.firstName, first.lastName].filter(Boolean).join(" ");
    if (!name || name.length > 200) return null;
    const date = year(item.date);
    const anchor = titleKey(item.title).split(" ").sort((a,b)=>b.length-a.length)[0];
    const dateFilter = date ? `FILTER(STR(?year) IN ("${Number(date)-1}", "${date}", "${Number(date)+1}"))` : "";
    // Anchor the query to an indexed author signature. A global title scan is
    // prohibitively expensive on the full bibliography.
    return `PREFIX dblp: <https://dblp.org/rdf/schema#>
SELECT ?paper ?title ?year ?venue ?url ?name ?ordinal WHERE {
  { SELECT DISTINCT ?paper ?title ?year ?venue WHERE {
    ?first dblp:signatureDblpName ${JSON.stringify(name)} ; dblp:signaturePublication ?paper .
    ?paper a dblp:Inproceedings ; dblp:title ?title ; dblp:yearOfEvent ?year ; dblp:publishedIn ?venue .
    FILTER(CONTAINS(LCASE(STR(?title)), ${JSON.stringify(anchor)}))
    ${dateFilter}
  } LIMIT 21 }
  ?paper dblp:hasSignature ?signature .
  ?signature dblp:signatureDblpName ?name ; dblp:signatureOrdinal ?ordinal .
  OPTIONAL { ?paper dblp:primaryDocumentPage ?url }
} LIMIT 1001`;
  }

  function conferenceRecords(bindings) {
    if (!Array.isArray(bindings) || bindings.length >= 1001) return [];
    const records = new Map();
    for (const row of bindings) {
      const value = field => text(row?.[field]?.value);
      const id = value("paper"), ordinal = Number(value("ordinal"));
      if (!/^https:\/\/dblp\.org\/rec\/conf\/[\w/-]+$/.test(id) || !Number.isInteger(ordinal) || ordinal < 1) continue;
      if (!records.has(id)) records.set(id, { id, title:value("title").replace(/\.$/, ""), date:value("year"),
        proceedingsTitle:value("venue"), url:value("url"), names:new Map() });
      records.get(id).names.set(ordinal, value("name").replace(/ \d{4}$/, ""));
    }
    if (records.size >= 21) return [];
    return [...records.values()].filter(record => record.names.has(1) && /^\d{4}$/.test(record.date)).map(record => ({
      ...record, itemType:"conferencePaper", creators:[...record.names].sort((a,b)=>a[0]-b[0]).map(([,name]) => {
        const parts = name.split(" ");
        return {creatorType:"author",lastName:parts.pop(),firstName:parts.join(" ")};
      })
    }));
  }

  function verifiedPlan(item, source, options, catalog, withCreators = true) {
    const fields = {};
    for (const field of Metadata.DOI_FIELDS) {
      const value = source[field];
      if (typeof value === "string" && value.trim() && value.length <= 100000 && !/\u0000/.test(value)
          && value.trim() !== text(item[field])) fields[field] = value.trim();
    }
    const cleanup = Metadata.plan({...item,...fields}, {title:options.title !== false, titleCase:options.titleCase,
      protectedTerms:options.protectedTerms, conference:options.conference !== false,
      doi:false,pages:false,numbers:false,language:false,abbreviation:false}, undefined, catalog);
    Object.assign(fields, cleanup.fields);
    for (const field of Object.keys(fields)) if (fields[field] === text(item[field])) delete fields[field];
    const creators = withCreators && Metadata.normalizeCreators(source.creators);
    const changed = creators && JSON.stringify(creators) !== JSON.stringify(Metadata.normalizeCreators(item.creators));
    return Object.keys(fields).length || changed
      ? {action:"write",fields,...(changed ? {creators} : {})} : {action:"skip",reason:"unchanged",fields:{}};
  }

  function conferencePlan(item, records, options, catalog) {
    const known = authors(item), localYear = year(item.date);
    const found = records.filter(record => {
      if (record.itemType !== "conferencePaper" || !titleKey(item.title) || titleKey(item.title) !== titleKey(record.title)
          || !known.length || !record.creators.length || !authorMatch(known[0],record.creators[0])) return false;
      if (!known.slice(1,3).every(author => record.creators.some(other => authorMatch(author,other)))) return false;
      if (localYear && Math.abs(Number(localYear)-Number(record.date)) > 1) return false;
      const candidate = {venues:[record.proceedingsTitle],ISSN:[]};
      return venueNames(item).length ? sameVenue(item,candidate,catalog) : Boolean(localYear);
    });
    if (found.length !== 1) return {action:"skip",reason:found.length ? "search-ambiguous" : "search-no-match",fields:{}};
    // DBLP author names are used to verify identity. Preserve Zotero's name
    // components instead of guessing surname boundaries from a display name.
    return verifiedPlan(item,found[0],options,catalog,false);
  }

  function arxivDOI(item) {
    const ids = [text(item.url).match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7}))(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/i)?.[1],
      text(item.archiveID).match(/^(?:arxiv:)?((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7}))(?:v\d+)?$/i)?.[1]].filter(Boolean);
    return ids.length && new Set(ids.map(id=>id.toLowerCase())).size === 1 ? "10.48550/arxiv." + ids[0] : "";
  }

  function preprintQuery(item) {
    const first = authors(item)[0], title = titleKey(item.title);
    if (item.itemType !== "preprint" || text(item.DOI) || !first || title.length < 12 || title.length > 1000
        || /[<>\u0000-\u001f]/.test(text(item.title)) || !year(item.date)) return null;
    const surname = key(first.lastName || first.name);
    if (!surname) return null;
    const words = title.split(" ").filter(word => word.length >= 4);
    if (!words.length) return null;
    return `titles.title:(${words.join(" OR ")}) AND creators.name:(${surname})`;
  }

  function dataCiteSource(record) {
    const data = record?.attributes;
    if (data?.types?.resourceTypeGeneral !== "Preprint" || !Metadata.doiKey(data.doi) || !Array.isArray(data.creators)) return null;
    const creators = data.creators.map(author => {
      if (author.familyName) return {creatorType:"author",firstName:author.givenName || "",lastName:author.familyName};
      const parts = text(author.name).split(",");
      return parts.length === 2 ? {creatorType:"author",firstName:parts[1].trim(),lastName:parts[0].trim()}
        : {creatorType:"author",name:text(author.name)};
    });
    if (!Metadata.normalizeCreators(creators) || !text(data.titles?.[0]?.title) || !Number.isInteger(data.publicationYear)) return null;
    return {itemType:"preprint",DOI:data.doi,title:data.titles[0].title,creators,date:String(data.publicationYear),url:text(data.url)};
  }

  function preprintPlan(item, records, options, catalog) {
    if (item.itemType !== "preprint") return {action:"skip",reason:"unsupported-type",fields:{}};
    const existing = Metadata.doiKey(item.DOI), identifier = arxivDOI(item).toLowerCase(), known = authors(item);
    if (text(item.DOI) && !existing) return {action:"skip",reason:"invalid-doi",fields:{}};
    const found = new Map();
    for (const source of records.map(dataCiteSource).filter(Boolean)) {
      const doi = Metadata.doiKey(source.DOI);
      if (existing && doi !== existing) continue;
      if (identifier && doi !== identifier) continue;
      if (!existing) {
        if (!known.length || !authorMatch(known[0],source.creators[0])
            || !known.slice(1,3).every(author => source.creators.some(other => authorMatch(author,other)))) continue;
        if (year(item.date) && Math.abs(Number(year(item.date))-Number(source.date)) > 1) continue;
        if (titleKey(item.title) !== titleKey(source.title)) {
          // A supplied arXiv identifier independently verifies renamed versions.
          // Without one, title variants require two corroborating authors, an
          // agreeing year, and at most one differing word in a long title.
          const local = titleKey(item.title).split(" "), remote = titleKey(source.title).split(" ");
          const near = known.length >= 2 && year(item.date) && local.length >= 10 && local.length === remote.length
            && local.slice(0,4).every((word,index)=>word === remote[index])
            && local.filter((word,index)=>word !== remote[index]).length <= 1;
          if (!identifier && !near) continue;
        }
      }
      found.set(doi,source);
    }
    if (found.size !== 1) return {action:"skip",reason:found.size ? "search-ambiguous" : "search-no-match",fields:{}};
    return verifiedPlan(item,[...found.values()][0],options,catalog);
  }

  const api = { query, select, resolvedPlan, conferenceQuery, conferenceRecords, conferencePlan,
    arxivDOI, preprintQuery, dataCiteSource, preprintPlan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScholarSearch = api;
})(globalThis);
