# 测试说明

## 自动化

```sh
node --test tests/core.test.cjs tests/metadata.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
```

Node 测试覆盖：指标匹配、缺失项省略、手动直接覆盖、自动模式保留非空索书号、元数据规则、Extra 不变、DOI 手动入口/作者更新/失败保护/查询期间编辑、事务回滚和生命周期。被删除的自定义备份/恢复测试已替换为新行为测试。
Python 测试覆盖：公开/个人构建分离、源码白名单、缺文件和危险路径、输出冲突及 ZIP 完整性。

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

完整版隔离脚手架使用本地已准备的个人数据构建：

```sh
python scripts/build.py --with-data
python scripts/prepare-smoke.py
```

公开无数据安装包也有独立实机分支，使用测试脚本内的合成数据检查本地覆盖包的加载，不把它当作真实期刊指标：

```sh
python scripts/prepare-smoke.py --product dist/zotero10-scholar-3.1.2.xpi --auto-close
```

准备命令只创建新的 `work/smoke-*/profile` 和 `data`，打印明确的启动命令。
手动检查命令中的路径确为刚创建的隔离目录，再启动 Zotero；不要改成日常 profile。
报告写入同一隔离目录的 `data/runtime-report.json`。测试扩展不进入产品安装包。
可选 `--auto-close` 让该隔离实例在保存结果后自行退出，不关闭其他已运行实例。

测试隔离配置关闭同步、本地 API 和 Word/LibreOffice 自动安装。
原生场景检查三个菜单和管理页按钮、即时开关、直接更新、Zotero 撤销/重做、自动模式不联网、DOI 原地更新和启用/停用。
确定性的 DOI 写入测试使用显式合成返回值；另有独立步骤真正联网调用原生 DOI 查询器，核对 DOI、标题、作者和“不新建条目”。真实网络步骤失败会明确标记失败，不以模拟结果代替。
测试中屏蔽结果提示弹窗以避免阻塞，菜单、管理页和数据库操作仍使用真实控件/API。

未运行的项目不能声称通过：本地成功不等于 GitHub Actions 已运行，VM 测试也不代替所有实机组合。
大量文献、跨设备同步、不同操作系统及所有第三方插件组合尚不在完整实测范围内。
