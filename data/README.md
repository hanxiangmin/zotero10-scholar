# 数据与授权

公开仓库不包含真实 CCF/JCR/中科院整表，也不在安装或构建时自动下载数据。
请自行取得数据，并确认适用的使用权限；代码 MIT 许可不等于数据库的再分发许可。
来源与范围详见 [NOTICE.md](../NOTICE.md)。

## 从本地 ShowJCR 格式转换

已有且有权使用的 `ShowJCR-master.zip` 可放在项目根目录后运行：

```sh
python scripts/update-ccf.py --zip ShowJCR-master.zip
python scripts/import-showjcr.py ShowJCR-master.zip
```

转换脚本只读取明确的 CSV，不解压执行 ZIP 内文件，不联网下载。

| 输入 CSV | 输出 JSON | 口径 |
| --- | --- | --- |
| `CCF2026-UTF8.csv` | `data/ccf-2026.json` | CCF 第七版，国际期刊/会议 A/B/C |
| `JCR2025-UTF8.csv` | `data/jcr-2025.json` | 2026 发布版，2025 指标年 |
| `FQBJCR2025-UTF8.csv` | `data/cas-2025.json` | 中科院 2025 升级版大类及独立 TOP 字段 |

本版不读取新锐 XR 表，不使用五年影响因子或中科院小类替代大类。
表结构和年份不符合时会拒绝转换，不能把更名后的文件当作新年份数据。
`data/SOURCES.md` 是本地转换生成的审计记录，随真实数据留在本地，不进入公开源码包。

## 加载与构建

在插件设置中分别导入三个 JSON，无需重新构建。文件写入当前 Zotero 数据目录下的
`zotero10-scholar/ccf.json`、`jcr.json`、`cas.json`，重启后继续使用。
可以只加载部分来源；没有匹配项不会伪造指标，缺少旧结果所需来源时会保护旧结果。

若需要个人使用的内置数据包，可运行 `python scripts/build.py --with-data`。
该包以 `-personal.xpi` 结尾，不应在未取得数据再分发权时公开上传。
默认构建命令始终排除真实数据，即使 `data/` 中存在这些文件。

自行整理的 JSON 也可以使用，格式见 [数据格式](../docs/DATA_FORMAT.md)。
