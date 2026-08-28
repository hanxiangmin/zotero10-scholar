window.addEventListener("DOMContentLoaded", () => {
  const data = window.arguments[0];
  const create = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
  document.getElementById("summary").textContent = data.summary;
  document.getElementById("policy").textContent = "JCR 多学科显示：" + ({ best: "最佳分区", worst: "最低分区", all: "全部不同分区" }[data.policy]);
  document.getElementById("warnings").textContent = data.warnings.join("\n");
  const body = document.getElementById("rows");
  const fragment = document.createDocumentFragment();
  for (const row of data.rows) {
    const tr = create("tr");
    const title = create("td"); title.className = "title";
    const name = create("strong"); name.textContent = row.title || "（无标题）";
    const venue = create("div"); venue.className = "muted"; venue.textContent = row.publicationTitle || row.proceedingsTitle || row.conferenceName;
    title.append(name, venue);
    const old = create("td"); old.textContent = row.callNumber || "（空）";
    const rank = create("td"); rank.className = "rank"; rank.textContent = row.result.text;
    const status = create("td"); status.className = "status"; status.textContent = row.status;
    tr.append(title, old, rank, status); fragment.append(tr);
  }
  body.append(fragment);
  document.getElementById("sources").textContent = JSON.stringify(data.rows.map(row => ({
    key: row.key, title: row.title, result: row.result.text,
    reasons: row.result.reasons, provenance: row.result.provenance
  })), null, 2);
  document.getElementById("close").addEventListener("click", () => window.close());
});
