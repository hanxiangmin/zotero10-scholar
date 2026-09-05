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
在没有内置基线时可以首次导入旧年份；手动更新前请核对当前版本，3.1.2 不再保存逐条文献的历史指标年份。

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

<a id="journal-abbreviations"></a>

## 期刊缩写表（3.1.0）

在设置中的“导入期刊缩写 JSON”加载；与指标导入按钮分开。
以下是纯合成格式示例，不是实际期刊/真实缩写数据。

```json
{
  "schemaVersion": 1,
  "kind": "journal-abbreviations",
  "source": "用户提供的缩写表来源与版本",
  "records": [
    {"title": "Fictional Journal for Format Testing", "abbreviation": "Fict. J. Format Test.", "issns": []}
  ]
}
```

`source` 必填，注明出处；`records` 为 1–100000 条，文件不超过 20 MB。
每条需要非空 `title` 和 `abbreviation`，可选 `issns` 字符串数组；非法 ISSN 不用于匹配。
刊名或 ISSN 对应多种缩写时跳过，已有非空缩写不覆盖；未匹配时不清空字段。
本地导入表不随默认 XPI 或公开源码导出。期刊缩写与指标数据的授权分别核对。
