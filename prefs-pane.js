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
      doc.getElementById("zsr10-abbreviation-summary").textContent = plugin.abbreviations.count
        ? `${plugin.abbreviations.count} 条期刊缩写\n来源：${plugin.abbreviations.source}` : "未导入期刊缩写表。";
    };
    const select = doc.getElementById("zsr10-quartile");
    select.value = plugin.policy();
    select.addEventListener("change", () => plugin.setPref("quartilePolicy", select.value));
    const auto = doc.getElementById("zsr10-auto-new");
    auto.checked = Boolean(plugin.pref("autoNew"));
    auto.addEventListener("change", () => plugin.setPref("autoNew", auto.checked));
    const rules = doc.getElementById("zsr10-metadata-rules");
    const names = { title: "标题空白整理（保留大小写）", doi: "DOI 前缀整理", pages: "页码连接符整理", numbers: "卷期数字整理", language: "补全空语言字段", abbreviation: "补全空期刊缩写", duplicates: "预览时检查疑似重复条目" };
    rules.replaceChildren();
    for (const [key, name] of Object.entries(names)) {
      const label = doc.createElementNS("http://www.w3.org/1999/xhtml", "label");
      const input = doc.createElementNS("http://www.w3.org/1999/xhtml", "input"); input.type = "checkbox";
      input.checked = plugin.pref("metadata." + key) !== false;
      input.addEventListener("change", () => plugin.setPref("metadata." + key, input.checked));
      label.append(input, doc.createTextNode(" " + name)); rules.append(label);
    }
    const metadataAuto = doc.getElementById("zsr10-metadata-auto");
    metadataAuto.checked = Boolean(plugin.pref("metadata.auto"));
    metadataAuto.addEventListener("change", () => plugin.setPref("metadata.auto", metadataAuto.checked));
    doc.getElementById("zsr10-import-abbreviations").addEventListener("click", () => plugin.safeRun(async () => {
      await plugin.importAbbreviations(win); render();
    }, win));
    doc.getElementById("zsr10-import").addEventListener("click", () => plugin.safeRun(async () => {
      await plugin.importDataset(win);
      render();
    }, win));
    render();
  }
};
