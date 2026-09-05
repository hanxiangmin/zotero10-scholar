# 开发说明

Node.js 22+、Python 3.10+，无额外依赖；原生运行环境为 Zotero 10.0.x。

| 文件 | 用途 |
| --- | --- |
| `src/core.js` | 指标包校验、匹配、紧凑显示和直接更新计划 |
| `src/metadata.js` | 纯整理规则、缩写索引、重复检测、DOI 字段及作者校验 |
| `src/plugin.js` | 三个菜单入口、Zotero API、数据导入与事务写入 |
| `prefs*` | 管理页、自动开关和规则设置 |
| `scripts/` | 构建、数据转换、源码导出与隔离测试准备 |
| `tests/` | 纯规则、模拟接口、打包与原生环境测试 |

## 写入边界

3.1.2 按用户要求移除全部自定义备份/恢复、单独覆盖和预览流程。运行时不读写 Extra 状态，不删除旧版本遗留内容。手动指标更新直接覆盖，自动新条目处理只填空索书号；不匹配时均保留原值。

三个菜单分别调用 `apply({metadata:true,updateRanks:false})`、`updateByDOI()` 和指标 `apply()`，不能把 DOI 联网查询接入新增/修改通知器。自动整理和自动分区使用各自开关；共同开启时先整理再匹配。

DOI 查询使用 `new Zotero.Translate.Search()`、`setIdentifier({DOI})`、`getTranslators()`、`setTranslator()` 和 `translate({libraryID:false,saveAttachments:false})`。这些接口已通过本机 Zotero 10 源码核对；原生翻译器由 Zotero 提供，不移植其代码。
[Zotero 查询翻译器说明](https://www.zotero.org/support/dev/translators) · [JavaScript API](https://www.zotero.org/support/dev/client_coding/javascript_api)

每次手动批量 DOI 查询按条目串行执行，相同 DOI 在本批内复用结果。单次查询等待上限 45 秒；超时结果不会继续写入，底层翻译器网络请求可能稍后自行完成。仅接受返回 DOI 和条目类型均一致的唯一记录。
只复制明确允许且非空的字符串字段；有效作者列表整体替换，缺失或格式异常时保留原作者。类型、Extra、索书号、标签、笔记和附件不在 DOI 写入范围。来源文本作为数据处理，不执行返回内容。

保存前重新比较原快照（含作者）、类型、库和权限，防止覆盖查询期间的其他编辑。所有本批写入在同一数据库事务内进行；失败后回滚并重载内存对象。保留 Zotero 原生 UndoHistory，不额外保存一份文献。

匹配必须保留 ISSN 校验、唯一候选、主会议/附属轨道区分和有效零指标。CAS 仍严格限定 2025 大类；来源和指标年份在数据包与设置中显示，不再逐条写入 Extra。

## 验证和分发

```sh
node --test tests/core.test.cjs tests/metadata.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/build.py
python scripts/export-source.py
```

公开检出不含真实指标，TPAMI 数据集成测试会跳过；可设置 `SCHOLAR_REQUIRE_DATA=1` 强制要求该数据。其他规则测试使用明确的合成文献。
源码和 XPI 使用固定白名单，不上传 `work/`、`dist/*-personal.xpi`、本地数据或完整文献库。新增公开文件须更新白名单。
原生测试使用 `prepare-smoke.py` 创建全新 profile/data，并核验随机标记；禁止在正式文献库中运行测试扩展。[测试说明](TESTING.md)
