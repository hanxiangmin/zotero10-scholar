# 开发说明

## 环境

Node.js 22+；Python 3.10+。仅使用标准库，不需要 npm/pip 安装依赖。
Zotero 原生运行需要桌面版 10.0.x；Node 测试通过 VM 模拟接口，不操作实际文献库。

## 结构

| 路径 | 用途 |
| --- | --- |
| `bootstrap.js` | Zotero 生命周期与 chrome 内容注册 |
| `src/core.js` | 数据校验、匹配、显示和备份决策，无外部 I/O |
| `src/plugin.js` | 菜单、设置、离线包加载、文献事务及恢复 |
| `prefs*` / `preview*` | 设置页与预览窗口 |
| `locale/` / `assets/` | Fluent 文案与本项目图标 |
| `scripts/build.py` | 默认无数据的 XPI 白名单构建 |
| `scripts/export-source.py` | 不继承旧 Git 历史的公开源码导出 |
| `tests/` | 合成单测、打包测试和隔离实机脚手架 |

## 本地检查

```sh
node --test tests/core.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/build.py
python scripts/export-source.py
```

公开检出没有真实指标数据，TPAMI 真实数据集成测试会明确跳过，合成测试仍全部执行。
私人数据检查可设置 `SCHOLAR_REQUIRE_DATA=1`，使缺失真实数据变成失败，详见 [测试说明](TESTING.md)。
运行脚本产生的缓存、产物和指标文件均不应提交到仓库。

## 修改约束

- `fields` 内部仍保持四个指标位置，只有对外 `text` 省略缺失项；不要误删有效零值。
- Extra 中保存 schema v1 的原索书号和最后写入值。手动修改过的字段不得被刷新/恢复覆盖。
- 不可把“未加载数据源”当作“期刊已无指标”；公开版升级前后的旧结果需要保留。
- 期刊、会议、辅助会议轨道必须区分；不存在唯一候选时跳过。
- 公开文件通过白名单维护；不要把整个开发目录打 ZIP，也不要连同旧 `.git` 推送。

## Zotero 隔离实机测试

`scripts/prepare-smoke.py` 只准备新 profile/data，并打印启动命令，不会自动启动或触碰已有 profile。
完整指标测试需要事先准备本地个人构建，见 [测试说明](TESTING.md)。
测试扩展与产品 XPI 分开，使用随机目录标记和路径校验，关闭同步、本地 API 与办公套件自动安装。
不要把测试扩展安装到正式文献库。

<a id="metadata-integration"></a>

## 元数据整理功能整合评估

状态：**可行性与许可评估，尚未实现或随 v3.0.3 发布。** 核对日期：2026-09-05。
参考 [northword/zotero-format-metadata](https://github.com/northword/zotero-format-metadata/tree/095ada8b6cb8ed1e853b1c0f49b13d7020f514d0)
的规则注册、执行器、字段规则、依赖和 manifest；核对提交为 `095ada8b6cb8ed1e853b1c0f49b13d7020f514d0`。

### 适合保留的核心功能

| 功能 | 建议范围 |
| --- | --- |
| DOI 与页码、卷期格式整理 | 首期离线规则；清理明确的 DOI 前缀、规范页码连接符和数字格式，保留文章编号、罗马数字等有效值 |
| 标题整理 | 首期提供预览和手动应用；保护专业缩写、基因名、模型名及现有富文本，不默认对整库转换大小写 |
| 语言补全 | 首期只补空值；识别不确定时跳过，已有有效语言不覆盖 |
| 期刊缩写 | 首期仅用来源和许可明确的本地缩写表或用户导入表；未命中时保留现有值，不自行猜测 |
| 重复条目提示 | 首期只提示并跳转检查；不自动合并或删除 |
| 标题上下标、斜体、粗体快捷编辑 | 后续可选；需要另适配 Zotero 10 编辑控件与快捷键，不能仅复制文本处理函数 |

DOI/ArXiv 联网补全、整条元数据替换、高校所在地、专利/学位论文专项规则不列入精简首期。
默认不引入 `no-field-misuse` 或 Extra 清空工具；整理流程须保留索书号和 `Zotero Scholar Rank:` 状态行。

### 实现方式

上游使用 TypeScript、规则执行器和 Zotero Plugin Toolkit，并有语言识别、缩写数据等依赖。
它的 manifest 已覆盖 Zotero 10，但这不等于规则可以直接放入本项目当前的无依赖 JavaScript 结构。

建议在一个插件内依次执行“读取条目 → 元数据整理预览/应用 → 指标匹配 → 保存”，统一管理新条目事件。
元数据整理使用字段白名单，禁止写 `callNumber`；指标模块沿用已有备份和手动修改保护。
新增整理字段也需提供原值记录与撤销，保留 Extra 中其他内容。只有应用的元数据才用于后续指标匹配。
每条规则单独开关，自动整理默认关闭；首期先覆盖期刊和会议，遇到不支持的字段或只读条目跳过。
安装合并版并启用自动整理后，应停用独立 Linter 的重复自动处理，避免同一条目被整理两次。

真正合入前，需要验证专业缩写/富文本、缺失缩写数据、重复执行、批量导入、手改保护、撤销和 Zotero 10 实机行为。
本节为源码评估，不代表已完成合并版实机验证。

### 许可路线

上游 [package.json](https://github.com/northword/zotero-format-metadata/blob/095ada8b6cb8ed1e853b1c0f49b13d7020f514d0/package.json)
明确声明 `AGPL-3.0-or-later`，并附有 [AGPL v3 许可全文](https://github.com/northword/zotero-format-metadata/blob/095ada8b6cb8ed1e853b1c0f49b13d7020f514d0/LICENSE)。

- **直接移植规则代码：** 许可证允许修改、合并和再分发；这种合并形成的衍生作品整体需按 AGPL 发布。
  保留作者版权和许可声明，标明来源提交、修改内容和日期，随 XPI 提供该版本的完整对应源码与构建脚本。
  本项目原 MIT 部分可纳入，但应保留其 MIT 声明，不能把移入的 AGPL 代码改标为 MIT。
  正式采用时需同步调整根许可证、包元数据、贡献指南、来源文件及发布说明。
- **独立实现少量同类功能：** 按字段规范、Zotero API 和本项目需求编写独立实现，不移植或改写上游源码、测试、词表及资源，
  可继续采用 MIT。注明功能参考不等于取得复制 AGPL 代码后改用 MIT 的授权。

若采用直接移植路线，建议合并版使用 `AGPL-3.0-or-later`，保留本项目名称并明确是独立维护版本。
期刊缩写表、语言词表及第三方依赖仍需逐项核对许可；上游软件许可证不替代这些资源各自的许可。
当前 MIT 版本未因本次文档评估而改换许可证，亦未纳入上游运行时代码或数据资源。
