---
title: 深入学习Uniswap V3
date: 2025-10-13 16:43:07
tags: Uniswap
---

## 设计原理

Uniswap V3允许用户只在一段价格区间内提供流动性，如下图：

![GMP关系模型](/img/v3-virtual-liquidity.png)

用户可以在区间`[a,b]`提供流动性，对于图中的区间`[a,b]`都有以下公式：

![Uniswap V3 流动性分布示意图](/img/20251015095433_278_98.png)

> 说明：1、Xreal和Yreal为用户实际提供的流动性数量，即x token和y token的实际数量。2、virtual则为流动池虚拟出的token，只是为了满足计算（x*y=k）。

> 注意在a点时，y token的真实数量为0，在b点时，x token的真实数量为0。

引入虚拟token的概念，用户可以在某一个区间内提供流动性，然而每个用户提供够流动性的区间不一定都相同。所以Uniswap V3的流动性价格关系如下图第三个所示：

![Uniswap V3 价格区间示意图](/img/20251015181441_279_98.png)

## tick介绍

tick就是一个价格的索引，价格P与tick之间有以下关系：

$$
P = 1.0001^{tick}
$$

其中，tick的取值为$[-887272,887272]$之间，




