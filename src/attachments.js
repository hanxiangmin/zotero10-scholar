/* Manual PDF lookup. No browser automation, custom resolvers or Scholar requests. */
(function (root) {
  "use strict";
  const MAX_BYTES = 50 * 1024 * 1024;
  class DownloadError extends Error {
    constructor(reason, stopBatch = false) { super(reason); this.reason = reason; this.stopBatch = stopBatch; }
  }
  function checkedURL(value, base) {
    let url;
    try { url = new URL(value, base); } catch (_) { throw new DownloadError("pdf-invalid-url"); }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // Exclude all Google country domains, not just scholar.google.com. This also
    // prevents search/translate redirects from being used as an indirect route.
    if (/(^|\.)(?:google\.[a-z.]+|googleusercontent\.com|gstatic\.com|recaptcha\.net)$/.test(host))
      throw new DownloadError("pdf-blocked-source");
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !host.includes('.') || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
      || host.startsWith('[') || /\.(?:localhost|local|internal)$/.test(host))
      throw new DownloadError("pdf-invalid-url");
    url.hash = "";
    return url.href;
  }
  function pdfBytes(bytes) {
    const text = a => Array.from(a, c => String.fromCharCode(c)).join("");
    return bytes.length > 16 && /^\s*%PDF-[12]\.\d\b/.test(text(bytes.subarray(0, 1024)))
      && text(bytes.subarray(Math.max(0, bytes.length - 4096))).includes("%%EOF");
  }
  function challenged(html) {
    return /<title[^>]*>\s*(?:just a moment|access denied|attention required|verify (?:you|your)|captcha|sign in|log in)/i.test(html)
      || /(?:id|class)\s*=\s*["'][^"']*(?:cf-chl-|g-recaptcha|h-captcha|captcha-container)/i.test(html)
      || /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html);
  }
  function links(doc, base) {
    const candidates = [];
    for (const node of doc.querySelectorAll('meta[name], meta[property]')) {
      const name = (node.getAttribute('name') || node.getAttribute('property') || '').toLowerCase();
      if (['citation_pdf_url', 'bepress_citation_pdf_url', 'wkhealth_pdf_url'].includes(name))
        candidates.push(node.getAttribute('content'));
    }
    for (const node of doc.querySelectorAll('link[type="application/pdf"]')) candidates.push(node.getAttribute('href'));
    const safe = [];
    for (const value of candidates.filter(Boolean)) {
      try {
        const url = checkedURL(value, base);
        if (!/supplement|supporting[-_]|appendix/i.test(url)) safe.push(url);
      } catch (_) { /* Never request a blocked link, even when supplied by a publisher. */ }
    }
    return [...new Set(safe)].slice(0, 4);
  }
  class Downloader {
    constructor(env) { this.env = env; this.lastRequest = 0; }
    check() { if (this.env.cancelled()) throw new DownloadError("pdf-cancelled", true); }
    async request(url, options = {}) {
      this.check(); url = checkedURL(url);
      const delay = Math.max(0, 1500 - (this.env.now() - this.lastRequest));
      if (delay) await this.env.delay(delay);
      this.check(); this.lastRequest = this.env.now();
      let response;
      try {
        response = await this.env.request(url, { ...options, followRedirects: false,
          successCodes: false, timeout: 30000, errorDelayMax: 0, noRetryOnThrottle: true });
      } catch (error) {
        this.check();
        if (error.reason) throw error;
        throw new DownloadError("pdf-network-failed");
      }
      this.check();
      if ([401, 403, 429, 503].includes(response.status)) throw new DownloadError("pdf-access-limited", true);
      return response;
    }
    async fetchCandidate(start, budget, depth = 0) {
      let url = checkedURL(start);
      for (let redirects = 0; redirects < 8; redirects++) {
        if (budget.seen.has(url) || budget.left-- <= 0) return null;
        budget.seen.add(url);
        const response = await this.request(url, { responseType: 'arraybuffer' });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const target = response.getResponseHeader('Location');
          if (!target) return null;
          url = checkedURL(target, url); continue;
        }
        if (response.status !== 200) return null;
        const bytes = new Uint8Array(response.response);
        if (bytes.length > MAX_BYTES) throw new DownloadError("pdf-too-large");
        if (pdfBytes(bytes)) return { bytes, url };
        const type = response.getResponseHeader('Content-Type') || '';
        if (!/html/i.test(type) || bytes.length > 5 * 1024 * 1024) return null;
        const html = this.env.decode(bytes);
        if (challenged(html)) throw new DownloadError("pdf-access-limited", true);
        if (depth >= 1) return null;
        const doc = this.env.parseHTML(html);
        for (const link of links(doc, url)) {
          const result = await this.fetchCandidate(link, budget, depth + 1);
          if (result) return result;
        }
        return null;
      }
      return null;
    }
    async find({ DOI, url }) {
      const budget = { seen: new Set(), left: 16 };
      let lastReason = 'pdf-not-found';
      const tryURL = async value => {
        try { return await this.fetchCandidate(value, budget); }
        catch (error) {
          if (error.stopBatch) throw error;
          lastReason = error.reason || 'pdf-network-failed'; return null;
        }
      };
      if (DOI) {
        const found = await tryURL('https://doi.org/' + DOI);
        if (found) return found;
      }
      if (url) { const found = await tryURL(url); if (found) return found; }
      if (DOI && budget.left > 0) {
        // The same DOI-only OA service used by Zotero. Explicit HTTP options
        // ensure that errors/limits never cause automatic retries or redirects.
        const response = await this.request('https://services.zotero.org/oa/search', {
          method: 'POST', responseType: 'json', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doi: DOI })
        });
        if (response.status === 200 && Array.isArray(response.response)) {
          for (const candidate of response.response.slice(0, 6)) {
            for (const address of [candidate.url, candidate.pageURL].filter(Boolean)) {
              const result = await tryURL(address);
              if (result) return result;
            }
          }
        }
      }
      throw new DownloadError(lastReason);
    }
  }
  const api = { Downloader, DownloadError, checkedURL, pdfBytes, challenged, links, MAX_BYTES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScholarAttachments = api;
})(globalThis);
