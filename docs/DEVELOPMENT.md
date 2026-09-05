# 开发说明

Node.js 22+、Python 3.10+，无额外依赖；原生运行环境为 Zotero 10.0.x。

| 文件 | 用途 |
| --- | --- |
| `src/core.js` | 指标包校验、匹配、紧凑显示和直接更新计划 |
| `src/metadata.js` | 纯整理规则、缩写索引、重复检测、DOI 字段及作者校验 |
| `src/search.js` | 无 DOI 的检索上下文、候选身份检查及最终结果再核对 |
| `src/plugin.js` | 三个菜单入口、Zotero API、数据导入与事务写入 |
| `src/reports.js`、`results*` | 保存后的字段差异及只读结果窗口 |
| `prefs*` | 管理页、自动开关和规则设置 |
| `scripts/` | 构建、数据转换、源码导出与隔离测试准备 |
| `tests/` | 纯规则、模拟接口、打包与原生环境测试 |

## 写入边界

运行时不读写 Extra 状态，不删除旧版本遗留内容。手动指标更新在匹配成功后直接覆盖，自动新条目处理只填空索书号。任何未匹配或会议名称冲突均保留原值，不能由拒绝候选推导出清空旧等级。

三个菜单分别调用 `apply({metadata:true,updateRanks:false})`、`updateByDOI()` 和指标 `apply()`。第二个保留内部方法名，但界面叫“联网更新元数据”。不能把 DOI 或标题联网查询接入新增/修改通知器。自动整理和自动分区使用各自开关；共同开启时先整理再匹配。

DOI 查询使用 `new Zotero.Translate.Search()`、`setIdentifier({DOI})`、`getTranslators()`、`setTranslator()` 和 `translate({libraryID:false,saveAttachments:false})`。这些接口已通过本机 Zotero 10 源码核对；原生翻译器由 Zotero 提供，不移植其代码。
[Zotero 查询翻译器说明](https://www.zotero.org/support/dev/translators) · [JavaScript API](https://www.zotero.org/support/dev/client_coding/javascript_api)

每次手动批量 DOI 查询按条目串行执行，相同 DOI 在本批内复用结果。单次查询等待上限 45 秒；超时结果不会继续写入，底层翻译器网络请求可能稍后自行完成。Crossref 补充请求使用 `Zotero.HTTP.request`，只发送 DOI，超时 15 秒且包含在总时限内。

DOI 为空时才执行 `lookupTitle()`，向 Crossref `/works` 发送 `query.bibliographic`、`query.author`、`rows=20`，超时 15 秒，同批相同查询复用结果。至少需要有效标题、作者，以及年份或出版物信息。候选必须与规范化标题、第一作者及已有后两名作者符合；不接受明确年份/出版物冲突。年份匹配允许相差一年以涵盖在线发表与卷期差异，但不会从该容差推断最终日期。不同 DOI 有多个可信候选时拒绝写入；API 排序分不作为身份依据。

空 DOI 查得候选后仍走原生 DOI 查询，并再次核对最终标题、作者与出版物。只有通过核对才把 DOI 纳入本次字段计划，原始快照保持 DOI 为空，供并发保护、原生撤销和修改前后展示使用。现有 DOI 失效/格式异常不触发标题回退，避免无依据替换标识符。Crossref 未收录的文献保留原值，不声称检索覆盖所有出版社。[Crossref 检索接口说明](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/)

补充数据必须同时通过 DOI 和标题一致性检查。会议年份仅取 `event.start/end` 或 `ConferenceInfo/conference_year`，冲突则不覆盖日期。期刊优先 `published-print`，再 `published`、`published-online`，不用 created/deposited。通常要求返回条目类型一致；仅有明确会议证据的 `book-chapter` 可将原生 `bookSection` 字段映射到已有 `conferencePaper`，不改变实际条目类型。

`sentenceCase` 为独立实现，句首/冒号后大写，保留已知术语、未知全大写缩写、混合大小写及数字词；富文本和已知非英文标题不自动改写。专名无法完全从字形判断，允许用户补充保护词，不声称自动识别所有专名。

`standardConferenceNames` 仅处理 `conferencePaper`：每个已有会议字段必须独立匹配同一个 CCF 标准全称，才统一两个字段。忽略标准前后缀中的赞助方、会议届次、年份等装饰，不从名称推断日期，不转换条目类型，不将 Workshop/未识别名称覆盖为主会议。由 `metadata.conference` 控制，自动整理和 DOI 更新复用；指标操作不改会议字段。
只复制明确允许且非空的字符串字段；有效作者列表整体替换，缺失或格式异常时保留原作者。类型、Extra、索书号、标签、笔记和附件不在 DOI 写入范围。来源文本作为数据处理，不执行返回内容。

保存前重新比较原快照（含作者）、类型、库和权限，防止覆盖查询期间的其他编辑。所有本批写入在同一数据库事务内进行；失败后回滚并重载内存对象。保留 Zotero 原生 UndoHistory，不额外保存一份文献。

结果差异仅比较写入字段及作者，保存后重新读取条目值，并在整个事务提交成功后才返回。手动操作每批一个非模态窗口；自动批次追加到尚未关闭的自动结果窗口。值使用 `textContent` 渲染，不解释 HTML。结果只保留在窗口内存中，不写文件或 Extra；关闭窗口或停用插件后释放。内部 `silent` 可供测试抑制手动结果窗口，但自动新增处理始终显示结果。

匹配必须保留 ISSN 校验、唯一候选、主会议/附属轨道区分和有效零指标。CAS 仍严格限定 2025 大类；来源和指标年份在数据包与设置中显示，不再逐条写入 Extra。

## 验证和分发

```sh
node --test tests/core.test.cjs tests/metadata.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/build.py
python scripts/export-source.py
```

公开检出不含真实指标，TPAMI 数据集成测试会跳过；可设置 `SCHOLAR_REQUIRE_DATA=1` 强制要求该数据。其他规则测试使用明确的合成文献。
源码和 XPI 分别使用固定白名单。源码不含真实指标表；唯一 XPI 必须内置三份表及来源记录，缺数据时拒绝构建。新增源码文件须更新导出白名单。
不上传 `work/`、完整文献库或未经再分发授权的指标表/含表安装包。GitHub CI 的构建测试使用合成文件，不生成可发布的指标数据包。
原生测试使用 `prepare-smoke.py` 创建全新 profile/data，并核验随机标记；禁止在正式文献库中运行测试扩展。[测试说明](TESTING.md)
