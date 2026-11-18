# 刊名、会议与论文集名称

出版字段保存正式名称，指标匹配在内部进行，不改写出版字段。

- 期刊保留发表时的官方刊名。匹配时兼容大小写、标点、`&` / `and`、经过核实的名称别名和印刷/电子 ISSN。
- 匹配会解码 `&amp;`、`&#38;` 等来源字符实体，兼容 `KDD '18: …` 等 ACM 名称前缀；原出版字段保持不变。
- 会议名称仅在空缺或只有简称时补全。论文集标题保留年份、卷次及 Workshop 等必要区别。
- 例如 NeurIPS 的会议名可为 `Conference on Neural Information Processing Systems`，2021 年论文集为 `Advances in Neural Information Processing Systems 34`。二者分别保存在对应字段。
- CCF、JCR 和中科院表分别匹配；同刊的已确认 ISSN 可在表之间关联。标题和 ISSN 指向不同刊物时跳过，不猜测。
- 历史名称不等于后继刊物：TSMC 的旧 Part A/B/C、原始 TSMC，以及 Systems、Cybernetics、Human-Machine Systems 分别识别。最新表未收录旧刊时不借用后继刊物的影响因子或分区。
- DBLP 只提供简称时不覆盖已有完整论文集标题；联网出版来源提供正式标题时可以更新。所有修改仍显示前后对照。

名称关系依据：[CCF 会议目录](https://www.ccf.org.cn/Academic_Evaluation/AI/)、[NeurIPS 官方论文集](https://proceedings.neurips.cc/paper/2021)、[IEEE SMC 更名说明](https://www.ieeesmc.org/publications/transactions-on-smc-systems/)、[IEEE 更名公告 DOI](https://doi.org/10.1109/TSMCA.2012.2224500)。期刊 ISSN 与导入指标表的登记信息交叉核对。
