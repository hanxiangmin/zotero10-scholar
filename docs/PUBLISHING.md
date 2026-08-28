# 上传到自己的 GitHub

## 先区分公开与个人文件

**上传公开源码目录，不要直接推送包含旧仓库历史的开发目录。**
旧 `.git` 可能已经保存了上游代码、旧指标数据和 XPI；新加 `.gitignore` 不能清除这些历史。
导出器用固定白名单生成独立目录，不复制 `.git`，也不执行任何上传或发布命令。

```sh
python scripts/export-source.py
```

默认输出 `publish/zotero10-scholar/` 和 `dist/zotero10-scholar-3.0.2-source.zip`。
目录已有内容时不会覆盖；重新导出请指定一个新目录，例如：

```sh
python scripts/export-source.py --out publish/zotero10-scholar-next
```

## 上传方式

在自己的 GitHub 账号下新建仓库，将**公开源码目录内的文件**上传，包含 `.github`、`.gitignore` 等隐藏文件。
也可以将源码 ZIP 解压到独立目录，用 GitHub Desktop 将该目录创建为新的仓库，再发布到你的账号。
不要把源码 ZIP 本身作为唯一代码文件提交；应提交解压后的源码。

保留 `LICENSE`、`NOTICE.md` 和 README 中的来源说明。仓库名称可使用 `zotero10-scholar`。
当前清单没有填写别人的主页地址；确定你自己的仓库 URL 后可添加 `manifest.json` 的 `homepage_url`。
默认作者字段为 contributors，可改为你希望公开使用的署名。

## Release

| 可准备公开发布 | 必须留在本地，除非另获相应授权 |
| --- | --- |
| 默认 `zotero10-scholar-3.0.2.xpi` | `*-personal.xpi`、早期附数据 XPI |
| `*-source.zip` 和各自 SHA-256 | `ShowJCR-master.zip`、真实 `data/*.json` |
| 白名单源码和文档 | `work/` 测试库/日志、旧 `.git`、`legacy/`、`__data/` |

上传 Release 前运行测试并确认 XPI 中不含 `data/*.json`，说明“公开版需用户自行导入数据”。
GitHub Actions 只运行测试和公开构建，不自动创建 Release、推送代码或读取私人数据。
每次推送后请查看 Actions 结果，确认 Windows 与 Linux 检查均通过。

## 在线更新

默认不提供自动更新服务器。清单中的 `.invalid` 地址只是满足 Zotero 必需字段，
它不会下载任何新版本。准备好你自己的 HTTPS 更新清单与 XPI 地址后再替换，
同时测试升级流程并保持插件 ID 稳定。不要借用原参考项目的更新源。

## 来源边界

本公开包只包含本项目的新实现；原参考提交未见明确软件许可证，所以没有随包附带其旧实现或原图标。
真实指标表不在本项目 MIT 授权范围内，数据引入/发布必须另行核实；来源见 [NOTICE.md](../NOTICE.md)。
