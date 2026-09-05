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
    const renderAuto = () => {
      doc.getElementById("zsr10-auto-status").textContent = metadataAuto.checked && auto.checked
        ? "新增条目：自动整理 → 自动更新指标" : metadataAuto.checked ? "新增条目：仅自动整理元数据"
        : auto.checked ? "新增条目：仅自动更新指标" : "自动处理已关闭，可使用下方手动操作";
    };
    auto.addEventListener("change", () => { plugin.setPref("autoNew", auto.checked); renderAuto(); });
    metadataAuto.addEventListener("change", () => { plugin.setPref("metadata.auto", metadataAuto.checked); renderAuto(); });
    const renderSelection = () => {
      if (!plugin.active) return;
      const items = plugin.selectedItems().filter(item => plugin.supported(item));
      doc.getElementById("zsr10-selection-summary").textContent = `已选中 ${items.length} 条期刊/会议文献，其中 ${items.filter(item => plugin.editable(item)).length} 条可编辑。`;
    };
    for (const [id, action] of Object.entries({ review: "review", ranks: "ranks", manual: "manual", "restore-manual": "restoreManual", "restore-metadata": "restoreMetadata" })) {
      doc.getElementById("zsr10-" + id).addEventListener("click", () => plugin.safeRun(async () => {
        renderSelection(); await plugin.manageSelected(action, win);
      }, win));
    }
    // The preferences document may be replaced when switching panes.
    win.addEventListener("focus", renderSelection);
    win.addEventListener("unload", () => win.removeEventListener("focus", renderSelection), { once: true });
    doc.getElementById("zsr10-import-abbreviations").addEventListener("click", () => plugin.safeRun(async () => {
      await plugin.importAbbreviations(win); render();
    }, win));
    doc.getElementById("zsr10-import").addEventListener("click", () => plugin.safeRun(async () => {
      await plugin.importDataset(win);
      render();
    }, win));
    render(); renderAuto(); renderSelection();
  }
};
