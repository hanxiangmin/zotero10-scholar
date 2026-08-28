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
