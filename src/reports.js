(function (root) {
  "use strict";
  const LABELS = {
    title: "标题", DOI: "DOI", date: "日期", creators: "作者及贡献者", publicationTitle: "期刊名称",
    proceedingsTitle: "会议论文集标题", conferenceName: "会议名称", journalAbbreviation: "期刊缩写",
    pages: "页码", volume: "卷次", issue: "期号", language: "语言", ISSN: "ISSN", url: "网址",
    abstractNote: "摘要", publisher: "出版者", place: "出版地", callNumber: "索书号（分区指标）"
  };
  const ROLES = { author: "作者", editor: "编辑", contributor: "贡献者", translator: "译者" };
  function valueText(field, value) {
    if (field === "creators") return (value || []).map(creator => {
      const name = creator.name || [creator.lastName, creator.firstName].filter(Boolean).join(", ");
      return `${ROLES[creator.creatorType] || creator.creatorType || "贡献者"}：${name}`;
    }).join("\n");
    return String(value ?? "");
  }
  function changedItem(before, after, fields) {
    const changes = [];
    for (const field of new Set(fields)) {
      if (JSON.stringify(before[field] ?? "") === JSON.stringify(after[field] ?? "")) continue;
      changes.push({ field, label: LABELS[field] || field,
        before: valueText(field, before[field]), after: valueText(field, after[field]) });
    }
    return changes.length ? { id: before.id, key: before.key, libraryID: before.libraryID,
      title: after.title || before.title || "无标题", changes } : null;
  }
  function create(operation, counts, items, reasons) {
    const summary = [`已更新 ${counts.written || 0} 条，修改 ${items.reduce((n, item) => n + item.changes.length, 0)} 个字段。`];
    for (const [key, count] of Object.entries(counts)) {
      if (key !== "written" && count) summary.push(`${reasons[key] || key}：${count}`);
    }
    return { operation, counts: { ...counts }, summary, items, time: new Date().toLocaleTimeString("zh-CN", { hour12: false }) };
  }
  function toText(report) {
    const lines = [report.operation, ...report.summary];
    for (const item of report.items) {
      lines.push("", item.title);
      for (const change of item.changes) lines.push(`${change.label}\n修改前：${change.before || "（空）"}\n修改后：${change.after || "（空）"}`);
    }
    if (!report.items.length) lines.push("本次没有修改任何字段。");
    return lines.join("\n");
  }
  const api = { changedItem, create, toText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScholarReports = api;
})(globalThis);
