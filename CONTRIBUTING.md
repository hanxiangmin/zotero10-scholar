# 贡献指南

欢迎提交代码改进、可复现的问题和文档修正。请先阅读 [README](README.md) 和 [NOTICE](NOTICE.md)。

- 在 Issue 中注明 Zotero 版本、操作系统、插件版本、复现步骤和预期/实际结果。
- 使用合成文献示例；不要上传真实文献库、个人日志、访问令牌或完整指标表。
- 匹配、显示或备份规则变动，请在现有测试中增加对应回归用例，不要依赖在线服务。
- 保持 CAS 大类/年份约束，不能把新锐或其他排名体系自动替代为中科院。
- 不要去掉手改保护、备份校验、事务或发行白名单。新增公开文件须更新源码导出白名单。
- 仅提交你有权按本项目 MIT 许可贡献的内容，并保留第三方来源/许可声明。

提交前运行：

```sh
node --test tests/core.test.cjs tests/plugin.test.cjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/build.py
```

涉及界面或 Zotero 生命周期时，另在隔离 profile 中验证。不要把测试扩展装进日常文献库。
