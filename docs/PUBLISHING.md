# 发布

仓库：[hanxiangmin/zotero10-scholar](https://github.com/hanxiangmin/zotero10-scholar)。只维护一个版本、一个内置指标表的 XPI。

## 源码

**上传公开源码目录，不要直接推送包含旧仓库历史的开发目录。**
旧 `.git` 可能已经保存了上游代码、旧指标数据和 XPI；新加 `.gitignore` 不能清除这些历史。
导出器用固定白名单生成独立目录，不复制 `.git`，也不执行任何上传或发布命令。

```sh
python scripts/export-source.py
```

默认输出不含指标整表的 `publish/zotero10-scholar/` 和 `dist/zotero10-scholar-3.3.1-source.zip`。
目录已有内容时不会覆盖；重新导出请指定一个新目录，例如：

```sh
python scripts/export-source.py --out publish/zotero10-scholar-next
```

## 上传方式

将白名单源码提交到已有仓库，包含 `.github`、`.gitignore` 等隐藏文件。不要提交日常文献库、访问令牌、原始数据或测试日志。
不要把源码 ZIP 本身作为唯一代码文件提交；应提交解压后的源码。

保留 `LICENSE`、`NOTICE.md` 和 README 中的来源说明。仓库名称可使用 `zotero10-scholar`。
清单中的 `homepage_url` 已指向本仓库。维护与需求署名 hanxiangmin，代码、测试与文档协助署名 OpenAI Codex。

## 安装包与 Release

在 `data/` 准备三份有权使用的 JSON 和转换来源记录，见[数据准备](../data/README.md)，然后运行：

```sh
python scripts/build.py
python scripts/prepare-smoke.py --auto-close
```

唯一产物为 `dist/zotero10-scholar-3.3.1.xpi`，内置 CCF/JCR/CAS 表；缺少任一表会报错。没有额外构建开关或第二种安装包。
隔离测试准备工具不会自动启动 Zotero，按[测试说明](TESTING.md)检查路径后启动，并核对实际运行报告。

**本地生成含表 XPI 不等于取得了数据公开再分发权。** 本项目 MIT 许可只覆盖软件，完整指标表的公开发布须另行确认权利人的授权。
确认授权后，在对应源码提交上创建版本标签，将唯一 XPI、SHA-256 和可选源码 ZIP 上传到同一个 Release。
下载附件后核对 SHA-256、版本、三份数据和许可证，并说明四个手动操作、自动模式和 Linter 共存设置；全文下载始终手动执行。
GitHub Actions 只运行规则测试、合成数据打包验证和源码导出，不读取私人数据或自动发布安装包；不得将测试数据包作为正式安装包。
每次推送后请查看 Actions 结果，确认 Windows 与 Linux 检查均通过。

## 在线更新

默认不提供自动更新服务器。清单中的 `.invalid` 地址只是满足 Zotero 必需字段，
它不会下载任何新版本。准备好你自己的 HTTPS 更新清单与 XPI 地址后再替换，
同时测试升级流程并保持插件 ID 稳定。不要借用原参考项目的更新源。

## 来源边界

本公开包只包含本项目的新实现；原参考提交未见明确软件许可证，所以没有随包附带其旧实现或原图标。
真实指标表不在本项目 MIT 授权范围内，数据引入/发布必须另行核实；来源见 [NOTICE.md](../NOTICE.md)。
