# Zotero 10 Scholar Rank · CCF / JCR / 中科院分区

**Zotero 10 · 元数据整理 · DOI 更新 · 学术指标 · MIT**

在索书号中显示 CCF 等级、影响因子、JCR 分区、2025 中科院大类分区/TOP，同时提供元数据整理和手动 DOI 信息更新。不使用新锐分区替代中科院分区。

## 3.1.2 重构

本次重构将界面统一为三个操作，删除自定义备份、恢复、预览和单独覆盖流程。
只维护一个版本、一个内置指标表的安装包，不再区分个人版和公开版；导入数据仅用于后续更新内置表。

## 三个入口

| 操作 | 功能 |
| --- | --- |
| **整理元数据** | 按设置整理标题空白、DOI 前缀、页码、卷期，并补全空语言和期刊缩写；不同时修改分区指标。 |
| **根据 DOI 更新** | 仅手动触发。通过 Zotero 自带查询器联网获取题目、作者、期刊、日期等信息，成功返回的字段直接覆盖旧值。 |
| **更新分区指标** | 用本地指标表直接更新所选条目的索书号，匹配失败时保留原值。 |

菜单不再区分预览、普通更新、覆盖、备份和恢复；也不新增或修改 Extra 记录。误操作可使用 Zotero 原生撤销。
指标只显示有数据的部分，如 `A|20.4|Q1|1区TOP`、`3.6|Q1|3区` 或 `C`。

## 安装与使用

> 3.1.2 重构源码已提供；内置完整指标表的安装包须确认数据再分发授权后才上传 [Releases](https://github.com/hanxiangmin/zotero10-scholar/releases)。现有旧版附件不是本次重构版。

1. 安装包名称统一为 `zotero10-scholar-3.1.2.xpi`。在 Zotero **工具 → 插件 → 从文件安装插件** 中安装，不要解压；沿用原插件 ID，可直接升级。
2. 安装包内置 CCF/JCR/CAS 表，无需首次导入。更新表或添加可选期刊缩写表，可在 **工具 → Scholar Rank 设置** 中导入有权使用的 JSON。
3. 在主窗口选中文献，右键 **Scholar Rank**，选择以上三个操作之一。设置页也有相同的三个按钮。
4. 设置中可分别开启“新增条目时自动整理元数据”和“新增条目时自动更新分区指标”。默认关闭，自动模式仅填空索书号；**DOI 联网更新始终只能手动执行**。

DOI 更新不会清空未返回的字段，不改条目类型、附件、笔记、标签、Extra 或索书号。DOI 不一致、类型不同或查询失败时跳过。需要刷新分区时再点击“更新分区指标”。
指标年份以本地导入数据为准，不自动下载新年度数据。

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

构建前须在 `data/` 准备完整指标表；缺少任一表会报错，不生成缺数据的安装包。公开源码不附整表，CI 使用合成数据验证打包。[数据准备](data/README.md)

`src/core.js` 负责指标匹配，`src/metadata.js` 负责整理及 DOI 返回字段的校验，`src/plugin.js` 负责 Zotero 接口、菜单、查询和事务写入。
[开发说明](docs/DEVELOPMENT.md) · [测试说明](docs/TESTING.md) · [修改记录](CHANGELOG.md)

## 来源与许可证

软件采用 [MIT](LICENSE)，不包含第三方指标数据的再分发许可。
感谢 [SiriusXT/Zotero-Scholar-Rank](https://github.com/SiriusXT/Zotero-Scholar-Rank) 的指标展示设计，以及 [Linter for Zotero](https://github.com/northword/zotero-format-metadata) 的元数据整理思路。本项目独立实现，未移植两者的源码、图标或词表。
本地转换脚本适配 [ShowJCR](https://github.com/hitfyd/ShowJCR) 的 CSV 格式；DOI 查询调用 Zotero 自带接口。[许可范围与来源说明](NOTICE.md)

维护与需求：**hanxiangmin**。代码、测试与文档协助：**OpenAI Codex**。
