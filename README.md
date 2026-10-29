# billchen 的博客

基于 Hexo 7 和 `hexo-theme-yinwang` 的个人技术博客，主要记录 Rust、区块链、Solana、Go 与 AI 工程实践。

## 本地开发

```bash
npm install
npm run server
```

默认访问 `http://localhost:4000`。

## 构建与发布

```bash
npm run clean
npm run build
npm run deploy
```

发布目标配置在 `_config.yml`，当前指向 `billchen-818/billchen-818.github.io` 的 `master` 分支。

如果需要 Google Analytics，请在 `themes/hexo-theme-yinwang/_config.yml` 中填写真实 Measurement ID，并将 `google_analysis.enable` 改为 `true`。

## 访问统计

站点使用不蒜子展示今日及累计 PV/UV，并在文章页展示单篇阅读量。配置位于 `themes/hexo-theme-yinwang/_config.yml`：

```yaml
busuanzi:
  enable: true
  script: https://cdn.busuanzi.cc/busuanzi/3.6.9/busuanzi.min.js
```

将 `enable` 改为 `false` 可停止加载第三方统计脚本并隐藏公开计数。
