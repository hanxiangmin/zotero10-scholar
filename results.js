"use strict";
(() => {
  const data = window.arguments[0];
  let rendered = 0;
  const element = (tag, text, className) => {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function renderPending() {
    const list = document.getElementById("zsr10-results-list");
    if (!list) return;
    while (rendered < data.batches.length) {
      const report = data.batches[rendered++], section = element("section", undefined, "batch");
      section.append(element("h2", `${report.operation} · ${report.time}`), element("p", report.summary.join("\n"), "summary"));
      for (const item of report.items) {
        const article = element("article");
        article.append(element("h3", item.title));
        const table = element("table"), head = element("thead"), header = element("tr"), body = element("tbody");
        for (const label of ["字段", "修改前", "修改后"]) {
          const cell = element("th", label); cell.setAttribute("scope", "col"); header.append(cell);
        }
        head.append(header);
        for (const change of item.changes) {
          const row = element("tr"); row.dataset.field = change.field;
          row.append(element("td", change.label),
            element("td", change.before || "（空）", change.before ? "before" : "before empty"),
            element("td", change.after || "（空）", change.after ? "after" : "after empty"));
          body.append(row);
        }
        table.append(head, body); article.append(table); section.append(article);
      }
      if (!report.items.length) section.append(element("p", "本次没有修改任何字段。", "empty"));
      list.append(section);
    }
    const written = data.batches.reduce((sum, report) => sum + (report.counts.written || 0), 0);
    document.getElementById("zsr10-results-heading").textContent = `${data.automatic ? "自动更新结果" : "更新结果"} · 已更新 ${written} 条`;
  }
  window.addEventListener("scholar-rank-results", renderPending);
  window.addEventListener("DOMContentLoaded", () => {
    renderPending();
    document.getElementById("zsr10-results-close").addEventListener("click", () => window.close());
    document.getElementById("zsr10-results-close").focus();
  }, { once: true });
  window.addEventListener("keydown", event => { if (event.key === "Escape") window.close(); });
})();
