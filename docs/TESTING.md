# 测试说明

## 自动化

```sh
node --test tests/core.test.cjs tests/metadata.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
```

Node 测试覆盖：指标匹配、缺失项省略、手动直接覆盖、自动模式保留非空索书号、元数据规则、Extra 不变、DOI 手动入口/作者更新/失败保护/查询期间编辑、事务回滚和生命周期。被删除的自定义备份/恢复测试已替换为新行为测试。
Python 测试覆盖：唯一安装包必须内置三份表、缺数据拒绝打包、源码白名单、危险路径、输出冲突及 ZIP 完整性。

公开检出不含三份真实指标 JSON，真实 TPAMI 集成测试会明确报告 skipped。
不使用虚构数据冒充这项真实数据检查；其余测试使用测试文件内声明的合成数据。

本地已准备好三份实际数据时，可强制要求真实集成测试执行：

```powershell
$env:SCHOLAR_REQUIRE_DATA = '1'
node --test tests/core.test.cjs tests/metadata.test.cjs tests/plugin.test.cjs
```

此开关下缺任一数据文件就失败，不会跳过。数据转换还可单独检查：

```sh
python scripts/import-showjcr.py ShowJCR-master.zip --check
```

## Zotero 实机

隔离脚手架测试唯一的内置数据安装包。先在 `data/` 准备三份表及来源记录：

```sh
python scripts/build.py
python scripts/prepare-smoke.py --auto-close
```

准备命令只创建新的 `work/smoke-*/profile` 和 `data`，打印明确的启动命令。
手动检查命令中的路径确为刚创建的隔离目录，再启动 Zotero；不要改成日常 profile。
报告写入同一隔离目录的 `data/runtime-report.json`。测试扩展不进入产品安装包。
可选 `--auto-close` 让该隔离实例在保存结果后自行退出，不关闭其他已运行实例。

测试隔离配置关闭同步、本地 API 和 Word/LibreOffice 自动安装。
原生场景检查四个菜单和管理页按钮、即时开关、直接更新、Zotero 撤销/重做、自动模式不联网、DOI 原地更新和启用/停用。
确定性的 DOI 写入测试使用显式合成返回值；另有独立步骤真正联网调用原生 DOI 查询器，核对 DOI、标题、作者和“不新建条目”。真实网络步骤失败会明确标记失败，不以模拟结果代替。
无 DOI 场景还会通过真实 Crossref 检索找回 `Deep learning`（Yann LeCun，Nature，2015）的 DOI，检查空 DOI 的前后对照和原生撤销/重做；模拟测试覆盖歧义、网络失败、作者/会议信息冲突和并发编辑。
测试中只屏蔽阻塞式提示框；非模态结果窗口实际打开，检查逐字段前后值、自动批次追加、长摘要滚动、元数据按纯文本显示及关闭按钮，并保存隔离测试截图。
会议回归使用报告中的 KDD / IJCAI 名称写法，检查四条空指标恢复、重复更新、标准全称、日期保持不变，以及未匹配条目不清空旧等级。
附件测试覆盖 Google 来源和跳转拦截、HTTP 限流/验证停止、PDF 内容验证、取消、已有附件与只读库跳过、自动处理不下载。独立原生步骤真正下载 IJCAI 2019 开放论文 PDF，检查文件落盘、父子关系、重复下载跳过和原文献字段不变；另一步明确用合成 HTTP 429 检查队列停止。

未运行的项目不能声称通过：本地成功不等于 GitHub Actions 已运行，VM 测试也不代替所有实机组合。
大量文献、跨设备同步、不同操作系统及所有第三方插件组合尚不在完整实测范围内。

3.2.1 的独立实机步骤还联网核对 TransMIL 的 DBLP 会议记录、标准 NeurIPS 名称和 CCF A，以及 AllSet 预印本的 DataCite 标题、arXiv DOI、2021 年份和重复更新。

3.3.0 新增全库范围加载、正式版本筛选、改名与关联 DOI、SICI 标识、编辑者保留、停止后保留已完成修改等回归。实机检查包含预印本原地转换、原条目键及文件夹/子附件/笔记、原生撤销/重做，以及 AllSet 真实正式版查找。

3.3.1 新增官方论文集标题保留、历史会议名称、期刊别名及跨表 ISSN 关联、旧分刊与后继刊物隔离的回归。独立原生场景验证 NeurIPS 论文集名称在整理、指标更新和 Zotero BibTeX 导出后保持正确。

3.3.2 覆盖 KDD 的字符实体、ACM 年份前缀、KDD/SIGKDD 别名、附属类别排除及会议字段冲突。原生场景检查用户提供的 24th KDD 标题恢复为 A，原出版字段保持不变。
