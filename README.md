# Zotero 10 Scholar Rank：CCF、JCR 与中科院期刊分区插件

面向**学术文献管理**的 **Zotero 分区插件**，适用于 Zotero 10：在原生**索书号**列显示
**CCF A/B/C**、**影响因子（JIF）**、**JCR Q1–Q4**，以及 **2025 中科院升级版大类分区**和 TOP 标记。

A Zotero 10 plugin for academic reference management: CCF conference/journal ranks,
Journal Impact Factor (JIF), JCR quartiles and CAS journal rankings in the Call Number column.
Offline lookup using locally imported data.

**基于 [SiriusXT/Zotero-Scholar-Rank](https://github.com/SiriusXT/Zotero-Scholar-Rank) 的功能设计与使用流程，
面向 Zotero 10 重新实现。** 非原作者官方发行版。参考版本、修改内容和许可范围见 [NOTICE.md](NOTICE.md)。

```text
A|20.4|Q1|1区TOP
3.6|Q1|3区
C
```

以上展示格式，不保证对应期刊的当前指标。缺失项及其分隔符省略；有效 `0`、`<0.1` 保留。

## 功能

- 右键菜单简写为 **Scholar Rank**，支持预览、更新、覆盖前备份和恢复。
- 优先用有效 ISSN/eISSN 匹配，其次是唯一刊名/明确别名；歧义不猜测。
- 区分期刊与会议；Workshops、Findings 等不套用主会议等级。
- JIF 为数据包所载指标年的期刊影响因子；会议不显示期刊影响因子与分区。
- JCR 期刊分区支持多学科的最佳、最低或全部分区。中科院固定使用 **2025 升级版大类分区**，不读取新锐 XR。
- 原索书号保存在 Extra 中，保留其他内容；支持 Zotero 撤销/重做，保护手动改过的结果。
- 离线查询，不需要账号或 API 密钥，不向服务器发送文献内容。新条目自动填充默认关闭。

## 安装与数据

**[下载 v3.0.2 插件（XPI）](https://github.com/hanxiangmin/zotero10-scholar/releases/download/v3.0.2/zotero10-scholar-3.0.2.xpi)** · [全部 Releases](https://github.com/hanxiangmin/zotero10-scholar/releases)

适用 Zotero **10.0.x**。**不要解压 XPI**；在“工具 → 插件 → 从文件安装插件”中选择下载的文件，
然后在文献列表列标题的右键菜单中勾选“索书号”。先预览少量条目，再更新。

**公开源码和默认 XPI 不附带 CCF/JCR/中科院整表。** 安装后请在
“工具 → Scholar Rank 设置与数据版本”导入有权使用的 JSON 数据包。
没有数据时不会生成指标；已管理条目缺少原指标所需数据包时会保留旧值。

数据转换方法和格式见 [数据说明](data/README.md) 与 [JSON 格式](docs/DATA_FORMAT.md)。
数据年份由包内元数据决定，不联网自动刷新。指标属于期刊/会议，不能替代对单篇论文的判断。

从本项目 3.0.0/3.0.1 升级时直接安装新 XPI，无需卸载。现有字符串需选中文献后执行
**Scholar Rank → 更新所选条目（保护已有索书号）** 才会更新。[完整安装说明](docs/INSTALL.md)

## 开发与构建

需要 Node.js 22+、Python 3.10+；仅用标准库，无需安装 npm 或 pip 依赖。

```sh
node --test tests/core.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/build.py
python scripts/export-source.py
```

- `dist/zotero10-scholar-3.0.2.xpi`：不带第三方数据的公开安装包。
- `dist/zotero10-scholar-3.0.2-source.zip`：公开源码压缩包。
- `publish/zotero10-scholar/`：可上传到新仓库的干净源码目录，不含旧 `.git` 历史。

含本地数据的个人构建需要显式运行 `python scripts/build.py --with-data`，
产物带 `-personal.xpi` 后缀。**不要把个人构建、原始 ZIP、转换后的指标表或旧开发目录整体上传。**
取得相应再分发权限前，不要将第三方数据附在公开仓库或 Release 中。

默认没有在线升级服务器。Zotero 要求的 `update_url` 使用 HTTPS `.invalid` 保留地址，
“检查更新”可能提示连接失败；请手动安装新版。维护者配置自己的更新服务时再修改该地址，
不要指向原参考项目。此处未关闭 Zotero 的安全检查。

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [修改记录](CHANGELOG.md) | 本版相对参考项目和早期版本的变化 |
| [开发说明](docs/DEVELOPMENT.md) | 目录结构、构建与隔离测试 |
| [测试说明](docs/TESTING.md) | 自动化检查、真实数据测试的跳过条件 |
| [上传与发布](docs/PUBLISHING.md) | 公开目录、Git 历史、Release 与数据边界 |
| [贡献指南](CONTRIBUTING.md) | 提交改动与问题报告 |

## 许可证与致谢

本项目公开包内的新实现采用 [MIT License](LICENSE)。此许可证不涵盖第三方数据和上游旧实现。
感谢 SiriusXT 的原插件设计、ShowJCR 的数据表结构整理，以及 Zotero 的开发文档和接口。
详细来源与范围见 [NOTICE.md](NOTICE.md)。

### 开发贡献

- **[hanxiangmin](https://github.com/hanxiangmin)**：项目维护、需求设计与使用反馈。
- **OpenAI Codex**：协助 Zotero 10 适配、代码实现、测试和开源文档整理（AI 开发辅助工具）。
