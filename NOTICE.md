# 来源与许可范围

## 参考项目

本项目基于 **SiriusXT/Zotero-Scholar-Rank 的功能设计与使用流程**，面向 Zotero 10 重新实现。
“在索书号中显示 CCF、影响因子、JCR 和中科院分区”的使用方式来自该项目。

- 原项目：[SiriusXT/Zotero-Scholar-Rank](https://github.com/SiriusXT/Zotero-Scholar-Rank)
- 参考版本：2.6，提交 [`b02db667b58eabacc75b659f311f658fafa7ae48`](https://github.com/SiriusXT/Zotero-Scholar-Rank/tree/b02db667b58eabacc75b659f311f658fafa7ae48)
- 本项目不属于原作者的官方发行版，也不代表原作者背书。

本版重新实现了 Zotero 10 生命周期、菜单和设置页、索引匹配、ISSN 校验、
离线 JSON 加载、元数据整理、DOI 原生接口调用、直接更新、撤销支持及缺失指标省略。
`assets/icon.svg` 是本项目新绘制的矢量图标。

截至 2026-08-28，在上述参考提交中未找到明确的 LICENSE/COPYING。
因此公开源码包不包含其旧运行时代码、旧数据、图片、原图标或旧 XPI，
也不将本项目的 MIT 许可证表述为对上游内容的重新授权。
公开仓库与开源许可的区别见 [GitHub 许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

## 数据整理项目

本项目提供针对 [hitfyd/ShowJCR](https://github.com/hitfyd/ShowJCR) 表结构的本地转换脚本，
不包含或执行 ShowJCR 的软件代码。用于开发核对的原始压缩包对应提交
[`2557e1856ba9f8eb945f781deeda1e5fb58ace88`](https://github.com/hitfyd/ShowJCR/tree/2557e1856ba9f8eb945f781deeda1e5fb58ace88)。

该项目的软件 [LICENSE 为 GPL-3.0](https://github.com/hitfyd/ShowJCR/blob/2557e1856ba9f8eb945f781deeda1e5fb58ace88/LICENSE)。
软件许可证不能代替第三方数据库权利人的授权；本项目不据此主张拥有 CCF/JCR/中科院整表的再分发权。
数据来源以 [ShowJCR 的来源说明](https://github.com/hitfyd/ShowJCR/blob/2557e1856ba9f8eb945f781deeda1e5fb58ace88/README.md)
及数据权利人的许可为准，另参见 [中科院分区表使用协议](https://www.fenqubiao.com/User/UseProtocol.aspx)。

## Linter 共存与功能评估

[northword/zotero-format-metadata（Linter for Zotero）](https://github.com/northword/zotero-format-metadata)
是本项目已知的共存插件，也是元数据整理功能需求的参考。2026-09-05 核对提交
[`095ada8b6cb8ed1e853b1c0f49b13d7020f514d0`](https://github.com/northword/zotero-format-metadata/tree/095ada8b6cb8ed1e853b1c0f49b13d7020f514d0)
的包元数据声明 `AGPL-3.0-or-later`，仓库附 AGPL v3 许可全文。

3.1.0 的元数据模块按本项目需求独立实现，未移植该插件的源码、测试、词表、图标或数据表，亦非其官方发行版。
将来若直接移植其代码，合并形成的衍生版本须遵守 AGPL，不能用本项目 MIT 声明覆盖上游许可。
独立实现的范围与行为见[开发说明](docs/DEVELOPMENT.md)。

## 本项目许可证的范围

公开导出目录内的新实现、构建/转换脚本、合成测试、新图标和本文档按 [MIT](LICENSE) 提供。
该许可不涵盖另行取得的原始数据、转换后的完整指标表、第三方软件或其商标。
默认公开安装包不附带这些数据；用户应自行取得并核实使用权限。
上述来源核查不构成对任何具体数据使用情形的法律意见。
