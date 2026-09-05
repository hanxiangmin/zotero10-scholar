window.addEventListener("DOMContentLoaded", () => {
  "use strict";
  const data = window.arguments[0], checks = [], editors = new Map();
  const create = (tag, value, className) => {
    const element = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (value != null) element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  const labels = { title: "标题", DOI: "DOI", pages: "页码", volume: "卷", issue: "期", language: "语言", journalAbbreviation: "期刊缩写", callNumber: "索书号指标" };
  const result = document.getElementById("result"), apply = document.getElementById("apply");
  document.getElementById("heading").textContent = data.duplicatesOnly ? "疑似重复条目" : data.restore ? "恢复整理前的元数据" : "元数据整理预览";
  if (data.ranksOnly) document.getElementById("heading").textContent = "指标更新预览";
  if (data.manual) {
    document.getElementById("heading").textContent = data.ranksOnly ? "手动覆盖索书号指标" : "手动编辑与覆盖";
    document.getElementById("intro").textContent = "直接编辑右侧拟写入值，或先点击“填入自动建议”。只有实际变化的字段会写入；清空输入框会清空该字段。确认后备份原值，并保护人工设定。";
    apply.textContent = "确认手动覆盖…";
  }
  if (data.manualRestore) {
    document.getElementById("heading").textContent = "恢复手动覆盖";
    document.getElementById("intro").textContent = "恢复到本轮首次手动覆盖前，并解除对应字段的保护。覆盖后又在其他界面改过的字段会保留；本次恢复也支持 Zotero 撤销。";
  }
  if (data.restore) document.getElementById("intro").textContent = "预览恢复原值。手动修改过的字段会保留；索书号指标保持不变，如需刷新请另行更新指标。";
  if (data.duplicatesOnly) document.getElementById("intro").textContent = "按同一文献库内的 DOI 或规范化标题检查，仅供人工核对。不同 DOI 的同名论文不会仅凭标题列为重复。";
  document.getElementById("summary").textContent = data.duplicatesOnly ? `${data.rows.length} 条选中文献` : data.abbreviationSummary;
  document.getElementById("duplicate-warning").textContent = data.duplicateWarning;
  const body = document.getElementById("rows");
  for (const row of data.rows) {
    const section = create("section"), title = create("h2"), label = create("label");
    if (!data.duplicatesOnly) {
      const input = create("input"); input.type = "checkbox"; input.checked = row.writable; input.disabled = !row.writable;
      checks.push({ id: row.id, input }); label.append(input);
    }
    label.append(create("span", row.title || "（无标题）")); title.append(label); section.append(title);
    const inputs = new Map(); editors.set(row.id, inputs);
    if (row.fields.length) {
      const table = create("table"), head = create("thead"), header = create("tr"), tbody = create("tbody");
      for (const word of ["字段", "当前值", "拟写入值"]) header.append(create("th", word));
      head.append(header); table.append(head, tbody);
      for (const field of row.fields) {
        const tr = create("tr"), after = create("td", data.manual ? null : field.after || "（空）", "after");
        if (data.manual) {
          const input = create("textarea"); input.value = field.after; input.rows = field.name === "title" ? 3 : 1;
          input.maxLength = 10000; input.disabled = !row.writable;
          input.setAttribute("aria-label", `${labels[field.name]}：${row.title}`);
          input.dataset.field = field.name; inputs.set(field.name, input); after.append(input);
        }
        tr.append(create("td", labels[field.name] || field.name), create("td", field.before || "（空）"), after);
        tbody.append(tr);
      }
      section.append(table);
      if (data.manual && row.writable) {
        const suggest = create("button", "填入自动建议"); suggest.className = "suggest";
        suggest.disabled = !Object.keys(row.suggestions).length;
        suggest.addEventListener("click", () => {
          for (const [name, value] of Object.entries(row.suggestions)) if (inputs.has(name)) inputs.get(name).value = value;
          result.textContent = "建议已填入右侧，尚未保存。请核对后确认；未匹配的指标不会清空。";
        });
        section.append(suggest);
      }
    } else if (!data.duplicatesOnly) section.append(create("p", "没有可应用的修改。", "muted"));
    for (const warning of row.warnings) section.append(create("p", warning, "warnings"));
    if (row.duplicates.length) {
      section.append(create("p", `发现 ${row.duplicates.length} 条疑似重复文献：`, "warnings"));
      for (const duplicate of row.duplicates) section.append(create("p", `${duplicate.reason} · ${duplicate.title}`));
      const select = create("button", "在文献库中选中这些条目");
      select.addEventListener("click", async () => {
        try { await data.selectDuplicates([row.id, ...row.duplicates.map(item => item.id)]); }
        catch (error) { result.textContent = "无法定位条目：" + error.message; }
      });
      section.append(select);
    } else if (data.duplicatesOnly) section.append(create("p", "未发现符合本次规则的疑似重复条目。", "muted"));
    body.append(section);
  }
  apply.hidden = data.duplicatesOnly;
  apply.disabled = !checks.some(({ input }) => !input.disabled);
  apply.addEventListener("click", async () => {
    const ids = checks.filter(({ input }) => input.checked && !input.disabled).map(({ id }) => id);
    if (!ids.length) { result.textContent = "请先勾选至少一条文献。"; return; }
    apply.disabled = true;
    try {
      const edits = data.manual ? ids.map(id => ({ id, fields: Object.fromEntries([...editors.get(id)].map(([name, input]) => [name, input.value])) })) : [];
      const counts = await data.apply(ids, edits);
      if (counts.cancelled || counts.unchanged) {
        result.textContent = counts.cancelled ? "已取消，未覆盖。可以继续编辑。" : "拟写入值与当前值相同，未写入。";
        apply.disabled = false; return;
      }
      result.textContent = `已保存 ${counts.written || 0} 条；预览后有变化或变为只读的 ${counts["manually-edited"] || 0} 条已跳过。可使用 Zotero 撤销。`;
      for (const { input } of checks) input.disabled = true;
      for (const inputs of editors.values()) for (const input of inputs.values()) input.disabled = true;
      for (const button of document.querySelectorAll(".suggest")) button.disabled = true;
    } catch (error) { result.textContent = "未完成：" + error.message; apply.disabled = false; }
  });
  document.getElementById("close").addEventListener("click", () => window.close());
});
