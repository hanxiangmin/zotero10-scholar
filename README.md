# Scholar Rank · 元数据整理与学术指标

**Zotero 10 · 3.1.1 本地开发版 · MIT**

本目录在 Scholar Rank 3.0.3 基础上独立实现元数据整理，保留 CCF、影响因子、JCR 与 2025 中科院大类分区/TOP 的索书号显示。
开发目录：`E:\GitHub\Tools\zotero10-scholar-next`，分支 `codex/metadata-core`。本版尚未发布到 GitHub Release。

## 功能

- **预览后应用**：逐字段显示当前值与拟写入值，可按条目勾选；保存前再次核对内容，避免覆盖预览后的修改。
- **DOI、页码、卷期整理**：清理明确的 DOI 前缀，规范页码连接符和纯数字卷期；保留文章编号、罗马数字及特殊期号。
- **保守标题整理**：只整理普通标题的空白，保留大小写、基因名、模型名；含富文本的标题跳过。没有整库自动改大小写。
- **语言补全**：仅补空值，保守识别中文/英文；短文本、不确定或其他语言跳过。
- **期刊缩写**：从用户导入表按有效 ISSN 或刊名匹配；歧义、未命中和已有缩写不覆盖。
- **重复提示**：检查同一库的 DOI 或规范化标题，可定位疑似重复条目，不自动合并或删除。
- **原值恢复与撤销**：整理字段使用独立 Extra 备份，逐字段保护手动修改；支持 Zotero 撤销/重做。
- **统一处理顺序**：自动整理与自动填充指标分别开关，都启用时先整理再匹配指标；默认均关闭。
- **管理页与手动覆盖**：集中设置自动处理；可编辑选中文献的字段、填入自动建议并确认覆盖。人工设定有独立备份，普通更新不会覆盖，可单独恢复。

指标仅显示有数据的部分：`A|20.4|Q1|1区TOP`、`3.6|Q1|3区`、`C`。年份以本地数据包为准。

## 安装和使用

1. 在 Zotero 的“工具 → 插件 → 从文件安装插件”中安装本目录的 `dist/zotero10-scholar-3.1.1.xpi`，不要解压。
2. 本版沿用原 Scholar Rank 的插件 ID，安装后升级替换原版；本目录源码与原开发目录分别保存。
3. 公开包不附带 CCF/JCR/中科院指标表，也不附带完整期刊缩写表。可在设置中分别导入有权使用的 JSON；基础格式整理无需这些数据。
4. 选中文献 → 右键 **Scholar Rank → 整理元数据与更新指标** → 检查前后值 → 应用勾选条目。
5. 打开 **工具 → Scholar Rank 设置与数据版本**，在“自动处理”中分别开启自动整理、自动更新指标。仅处理之后新增的条目，按本地数据更新，不自动下载年度数据。
6. 已有条目可在管理页点击 **整理并更新指标** 或 **仅更新指标**。需要覆盖时用 **手动编辑与覆盖**，编辑右侧值（或填入自动建议）后确认；未编辑字段不变。
7. 需要撤销时用 Zotero 撤销，或选择 **恢复手动覆盖** / **恢复整理前的元数据**。手动覆盖期间的人工设定不会被普通更新覆盖。

个人数据构建 `dist/zotero10-scholar-3.1.1-personal.xpi` 包含开发者本地指标表；期刊缩写表仍单独导入。
[完整安装说明](docs/INSTALL.md) · [缩写 JSON 格式](docs/DATA_FORMAT.md#journal-abbreviations)

> [!WARNING]
> 同时安装 Linter for Zotero / Format Metadata 时，仍需关闭其 **“清理被滥用的标准字段”** 规则。
> 启用本版自动整理后，也请停用 Linter 中重复的自动整理，避免同一条目被处理两次。
> [冲突与恢复说明](docs/INSTALL.md#与-linter-for-zotero--format-metadata-共存)

## 开发

Node.js 22+、Python 3.10+；本项目不需要 npm/pip 第三方依赖。

```sh
node --test tests/core.test.cjs tests/metadata.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/build.py
python scripts/export-source.py
```

| 文件 | 用途 |
| --- | --- |
| `src/metadata.js` | 独立整理规则、缩写索引、重复提示与逐字段备份 |
| `src/core.js` | 指标校验、匹配和索书号保护 |
| `src/plugin.js` | 事件顺序、精确预览计划、事务保存和导入 |
| `metadata-preview.*` | 整理/恢复/重复检查窗口 |
| `tests/metadata.test.cjs` | 独立规则测试，使用合成示例 |
| `tests/plugin.test.cjs` | 插件集成、竞争条件及回滚测试 |

[开发说明](docs/DEVELOPMENT.md) · [测试说明](docs/TESTING.md) · [修改记录](CHANGELOG.md) · [数据说明](data/README.md)

## 来源与许可证

采用 [MIT](LICENSE)。元数据整理按本项目需求独立实现，未移植 Linter 的源码、测试、词表、图标或数据资源；不声称覆盖 Linter 的全部功能。
功能需求参考 [northword/zotero-format-metadata](https://github.com/northword/zotero-format-metadata)，其软件采用 AGPL，感谢原作者的功能设计。
指标显示功能参考 [SiriusXT/Zotero-Scholar-Rank](https://github.com/SiriusXT/Zotero-Scholar-Rank) 的使用流程，由本项目面向 Zotero 10 重新实现。

[来源与许可范围](NOTICE.md) · [贡献指南](CONTRIBUTING.md)。软件 MIT 许可不涵盖另行取得的第三方指标数据。

维护与需求：**hanxiangmin**。代码实现、测试及文档协助：**OpenAI Codex**。
