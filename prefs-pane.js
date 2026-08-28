var ScholarRankPrefs = {
  init(win) {
    const plugin = Zotero.ScholarRank10;
    const doc = win.document;
    if (!plugin) return;
    const render = () => {
      doc.getElementById("zsr10-version-summary").textContent = plugin.catalog.list().map(d =>
        `${d.kind.toUpperCase()} ${d.edition}${d.kind === "jcr" ? ` · IF ${d.metricYear}` : ""} — ${d.count.toLocaleString()} 条\n来源：${d.sourceFile || d.source}`
      ).join("\n\n") || plugin.dataSummary();
      doc.getElementById("zsr10-load-warning").textContent = plugin.loadWarnings.join("\n");
    };
    const select = doc.getElementById("zsr10-quartile");
    select.value = plugin.policy();
    select.addEventListener("change", () => plugin.setPref("quartilePolicy", select.value));
    const auto = doc.getElementById("zsr10-auto-new");
    auto.checked = Boolean(plugin.pref("autoNew"));
    auto.addEventListener("change", () => plugin.setPref("autoNew", auto.checked));
    doc.getElementById("zsr10-import").addEventListener("click", () => plugin.safeRun(async () => {
      await plugin.importDataset(win);
      render();
    }, win));
    render();
  }
};
