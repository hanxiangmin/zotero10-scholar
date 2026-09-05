var ScholarRankPrefs = {
  init(win) {
    const plugin = Zotero.ScholarRank10, doc = win.document;
    if (!plugin) return;
    const status = doc.getElementById("zsr10-operation-status");
    const render = () => {
      doc.getElementById("zsr10-version-summary").textContent = plugin.catalog.list().map(d =>
        `${d.kind.toUpperCase()} ${d.edition}${d.kind === "jcr" ? ` · IF ${d.metricYear}` : ""} — ${d.count.toLocaleString()} 条\n来源：${d.sourceFile || d.source}`
      ).join("\n\n") || plugin.dataSummary();
      doc.getElementById("zsr10-load-warning").textContent = plugin.loadWarnings.join("\n");
      doc.getElementById("zsr10-abbreviation-summary").textContent = plugin.abbreviations.count
        ? `${plugin.abbreviations.count} 条期刊缩写\n来源：${plugin.abbreviations.source}` : "未导入期刊缩写表。";
    };
    const select = doc.getElementById("zsr10-quartile"); select.value = plugin.policy();
    select.addEventListener("change", () => plugin.setPref("quartilePolicy", select.value));
    const auto = doc.getElementById("zsr10-auto-new"), metadataAuto = doc.getElementById("zsr10-metadata-auto");
    auto.checked = Boolean(plugin.pref("autoNew")); metadataAuto.checked = Boolean(plugin.pref("metadata.auto"));
    const renderAuto = () => {
      doc.getElementById("zsr10-auto-status").textContent = metadataAuto.checked && auto.checked
        ? "新增条目：自动整理 → 自动更新分区指标" : metadataAuto.checked ? "新增条目：仅自动整理元数据"
        : auto.checked ? "新增条目：仅自动更新分区指标" : "自动处理已关闭";
    };
    auto.addEventListener("change", () => { plugin.setPref("autoNew", auto.checked); renderAuto(); });
    metadataAuto.addEventListener("change", () => { plugin.setPref("metadata.auto", metadataAuto.checked); renderAuto(); });
    const names = { title: "标题空白", doi: "DOI 前缀", pages: "页码连接符", numbers: "卷期数字", language: "补全空语言", abbreviation: "补全空期刊缩写", duplicates: "手动整理时提示疑似重复数量" };
    const rules = doc.getElementById("zsr10-metadata-rules"); rules.replaceChildren();
    for (const [key, name] of Object.entries(names)) {
      const label = doc.createElementNS("http://www.w3.org/1999/xhtml", "label");
      const input = doc.createElementNS("http://www.w3.org/1999/xhtml", "input"); input.type = "checkbox";
      input.checked = plugin.pref("metadata." + key) !== false;
      input.addEventListener("change", () => plugin.setPref("metadata." + key, input.checked));
      label.append(input, doc.createTextNode(" " + name)); rules.append(label);
    }
    const actions = { metadata: "metadata", doi: "doi", ranks: "ranks" };
    for (const [id, action] of Object.entries(actions)) doc.getElementById("zsr10-" + id).addEventListener("click", () => plugin.safeRun(() => plugin.manageSelected(action, win), win));
    const refreshStatus = () => {
      if (!status.isConnected || !plugin.active) { win.clearInterval(timer); return; }
      const items = plugin.selectedItems().filter(item => plugin.supported(item));
      doc.getElementById("zsr10-selection-summary").textContent = `已选中 ${items.length} 条期刊/会议文献，其中 ${items.filter(item => plugin.editable(item)).length} 条可编辑。`;
      status.textContent = plugin.status;
      for (const id of Object.keys(actions)) doc.getElementById("zsr10-" + id).disabled = plugin.busy;
    };
    const timer = win.setInterval(refreshStatus, 500);
    win.addEventListener("unload", () => win.clearInterval(timer), { once: true });
    doc.getElementById("zsr10-import-abbreviations").addEventListener("click", () => plugin.safeRun(async () => { await plugin.importAbbreviations(win); render(); }, win));
    doc.getElementById("zsr10-import").addEventListener("click", () => plugin.safeRun(async () => { await plugin.importDataset(win); render(); }, win));
    render(); renderAuto(); refreshStatus();
  }
};
