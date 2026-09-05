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
node --test tests/core.test.cjs tests/metadata.test.cjs tests/plugin.test.cjs
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

## 独立元数据模块（3.1.0）

3.1.1 添加 `planManual` / `restoreManual` 和第三个独立备份命名空间。普通整理和恢复逐字段跳过人工设定，插件的 `rankPlan` 对所有普通指标入口执行同样保护。手动编辑不会改动旧指标/整理备份；恢复本轮首次覆盖前值后解除保护。仅显式编辑确认路径可覆盖人工值，未新增全局强制覆盖开关。

管理页操作始终通过主窗口 `getSelectedItems()` 获取当前选择；预览保存持有原快照并重新核验。输入字段白名单、最大长度、损坏备份与事务失败均有测试，最终确认仅在隔离自动化测试中替换为可控制回调。

`src/metadata.js` 为独立 MIT 实现，不引入上游 Linter 的执行器、规则或数据。
它接收普通条目快照，生成字段改动与 Extra 备份计划，不访问 Zotero、文件系统或网络。
DOI、标题、页码、卷期、语言和缩写是明确的字段白名单，不能修改 `callNumber`。

`src/plugin.js` 在整理后快照上计算指标，合并两种备份，并通过一次事务保存。
预览窗口展示的计划在打开时固定；改变设置或数据表不会悄悄改变已展示的计划。
应用时再次核对快照、条目类型、库和权限；已改变条目跳过，保存失败则回滚整个事务并重载缓存。
窗口对每次计划只允许一次成功应用。重复导入通知不会生成无意义的重复写入。

整理状态使用 `Zotero Scholar Metadata:` 前缀、schema v1 和逐字段 `{original,last}` 记录。
恢复只修改当前值仍与 last 相同的字段，手改字段的备份继续保留，其他 Extra 行不变。
指标状态继续由 `src/core.js` 管理。元数据恢复不自动重算指标，避免恢复操作写入未预览的指标。

缩写表为独立导入格式（见 DATA_FORMAT.md），运行时保存在 Zotero 数据目录的 `zotero10-scholar/abbreviations.json`。
按 ISSN 优先、规范化刊名次之的规则查找，冲突时跳过；没有网络推断或内置第三方整表。
重复检查调用 Zotero API 加载同库条目，建立 DOI/标题索引；每次预览重新检查，不修改条目。

首期标题处理只规范无富文本标题的空白，不改变单词大小写或末尾标点。
语言识别是可关闭的中英文启发式规则，不能代替通用语言检测器。
作者格式、日期推断、全自动句子式大小写、联网补全和富文本编辑工具栏不属于本版。
