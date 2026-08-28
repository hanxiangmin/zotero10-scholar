# 本地 JSON 数据格式

三种包分别导入，`schemaVersion` 固定为 `1`，`source` 必填，`records` 为 1–100000 条。
以下是**合成示例**，不代表真实期刊指标，不作为发行版内置数据。

## CCF

```json
{
  "schemaVersion": 1,
  "kind": "ccf",
  "edition": 2026,
  "source": "Synthetic example, not a real ranking",
  "records": [
    {"type": "journal", "title": "Example Journal of Tests", "rank": "C", "issns": [], "aliases": []}
  ]
}
```

`type` 为 `journal` 或 `conference`，`rank` 为 `A`/`B`/`C`。
会议可提供 `abbreviation`；不要把 Workshops/Findings 等写成正式主会议。

## JCR / JIF

```json
{
  "schemaVersion": 1,
  "kind": "jcr",
  "edition": 2026,
  "metricYear": 2025,
  "source": "Synthetic example, not a real metric",
  "records": [
    {"title": "Example Journal of Tests", "issns": [], "jif": 2.5,
     "quartiles": [{"category": "Example subject", "quartile": "Q2"}]}
  ]
}
```

`edition` 为发布年，必须比 `metricYear` 晚一年。`jif` 为非负有限数或 `null`，缺失不能用 `0` 替代。
小于 0.1 时使用 `"jif": null, "jifDisplay": "<0.1"`。`quartiles` 可为空数组，不补猜缺失分区。
低年份数据不能覆盖已加载的较新年份。每个学科保留自己的 `Q1`–`Q4`。
在没有内置基线时可以首次导入旧年份，但不会用它覆盖条目里已保存的更晚指标年。

## 中科院 CAS

```json
{
  "schemaVersion": 1,
  "kind": "cas",
  "edition": 2025,
  "system": "CAS",
  "categoryLevel": "major",
  "source": "Synthetic example, not an official CAS table",
  "records": [
    {"title": "Example Journal of Tests", "issns": [], "division": 2, "top": true}
  ]
}
```

本版只接受 CAS、2025、major。`division` 为 1–4，`top` 为 `true`/`false`/`null`，
不得根据一区自行推断为 TOP。缺少有效大类分区的记录不要伪造数字。
含新锐/XR 标识、其他体系、小类或不符年份的包会被拒绝。

## 可选来源字段与安全

可包含 `sourceFile`、`sourceSha256`、其他来源审计元数据。
刊名必填，可选 `aliases` 和 `issns` 数组；只有校验通过的 ISSN 才进入索引。
来源声明只是可追溯信息，不等于本插件已经认证其准确性或数据授权。
导入只解析 JSON，不执行文件中的代码。最大导入文件大小为 40 MiB。
