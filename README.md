# Scholar Rank · 元数据与学术分区

**Zotero 10 · 3.1.2 本地开发版 · MIT**

独立实现元数据整理、DOI 信息更新，以及 CCF、影响因子、JCR、2025 中科院大类分区/TOP 的索书号显示。
本版保存在 `E:\GitHub\Tools\zotero10-scholar-next`，尚未发布到 GitHub Release。

## 三个入口

| 操作 | 功能 |
| --- | --- |
| **整理元数据** | 按设置整理标题空白、DOI 前缀、页码、卷期，并补全空语言和期刊缩写；不同时修改分区指标。 |
| **根据 DOI 更新** | 仅手动触发。通过 Zotero 自带查询器联网获取题目、作者、期刊、日期等信息，成功返回的字段直接覆盖旧值。 |
| **更新分区指标** | 用本地指标表直接更新所选条目的索书号，匹配失败时保留原值。 |

菜单不再区分预览、普通更新、覆盖、备份和恢复；也不新增或修改 Extra 记录。误操作可使用 Zotero 原生撤销。
指标只显示有数据的部分，如 `A|20.4|Q1|1区TOP`、`3.6|Q1|3区` 或 `C`。

## 安装与使用

1. 在 Zotero **工具 → 插件 → 从文件安装插件** 中安装 `dist/zotero10-scholar-3.1.2.xpi`，不要解压。本版沿用原插件 ID，可直接升级。
2. 公开安装包不含第三方指标表；在 **工具 → Scholar Rank 设置** 导入有权使用的 CCF/JCR/CAS JSON。期刊缩写表单独导入。
3. 在主窗口选中文献，右键 **Scholar Rank**，选择以上三个操作之一。设置页也有相同的三个按钮。
4. 设置中可分别开启“新增条目时自动整理元数据”和“新增条目时自动更新分区指标”。默认关闭，自动模式仅填空索书号；**DOI 联网更新始终只能手动执行**。

DOI 更新不会清空未返回的字段，不改条目类型、附件、笔记、标签、Extra 或索书号。DOI 不一致、类型不同或查询失败时跳过。需要刷新分区时再点击“更新分区指标”。
指标年份以本地导入数据为准，不自动下载新年度数据。

个人使用的 `dist/zotero10-scholar-3.1.2-personal.xpi` 含本地指标表，不能作为公开安装包上传。
[完整说明](docs/INSTALL.md) · [数据格式](docs/DATA_FORMAT.md)

> [!WARNING]
> 与 Linter for Zotero / Format Metadata 共存时，仍需关闭其 **“清理被滥用的标准字段”**，否则索书号指标可能被清空。
> 使用本插件自动整理后，也请停用 Linter 中重复的自动整理功能。[共存设置](docs/INSTALL.md#与-linter-for-zotero--format-metadata-共存)

## 开发

Node.js 22+、Python 3.10+，无额外 npm/pip 依赖。

```sh
node --test tests/core.test.cjs tests/metadata.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/build.py
python scripts/export-source.py
```

`src/core.js` 负责指标匹配，`src/metadata.js` 负责整理及 DOI 返回字段的校验，`src/plugin.js` 负责 Zotero 接口、菜单、查询和事务写入。
[开发说明](docs/DEVELOPMENT.md) · [测试说明](docs/TESTING.md) · [修改记录](CHANGELOG.md)

## 来源与许可证

软件采用 [MIT](LICENSE)，不包含第三方指标数据的再分发许可。
指标显示流程参考 [SiriusXT/Zotero-Scholar-Rank](https://github.com/SiriusXT/Zotero-Scholar-Rank)，由本项目面向 Zotero 10 重新实现。
元数据需求参考 [northword/zotero-format-metadata](https://github.com/northword/zotero-format-metadata)，未移植其源码、测试、词表、图标或数据；不声称覆盖 Linter 全部功能。
DOI 查询调用已安装 Zotero 的原生查询器，不随本项目分发其实现。[来源说明](NOTICE.md)

维护与需求：**hanxiangmin**。代码、测试与文档协助：**OpenAI Codex**。
