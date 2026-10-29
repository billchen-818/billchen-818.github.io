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
