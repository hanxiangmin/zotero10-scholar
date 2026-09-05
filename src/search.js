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
  const api = { query, select, resolvedPlan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScholarSearch = api;
})(globalThis);
