这个 -Inf 日志其实不全是你锅，也不代表你选了一个“垃圾模型”；更多是 **模型 + JSON 序列化的组合小毛病**。

我分两块答你：

---

## 1. 先说现状：nomic-embed-code 其实已经是「第一梯队」的代码 embedding

最近几篇系统性评测里，专门针对 **code embedding** 的对比，一般都会把下面几个放在一档里：VoyageCode3、OpenAI text-embedding-3-large、Jina Code v2、Nomic Embed Code之类。

也就是说：

* **nomic-embed-code 本身从效果上并不拉胯**，反而是“开源里非常能打的代码向量模型之一”；
* 你现在遇到的是：它在极少数输入上吐出带 `-Inf` 的向量分量，而 JSON encoder（不允许 NaN / ±Inf）直接报错，这才触发了 fallback embedding。

你桥接层现在的处理逻辑其实已经是比较成熟的工程打法：

* 检测到返回向量里有 `NaN/-Inf` → 记一条警告日志；
* 用一个 deterministic fallback（基于字符串 hash 的 384 维单位向量）顶上；
* 整体 ingest 继续走，只是那 12 条质量略差一点。

在“先让 POC 跑起来”的阶段，这个是完全可以接受的。

---

## 2. 有没有「更适合 Java / 代码」的 embedding 模型可以考虑？

有一些可以尝试的升级路线，特别是在你已经用 Ollama 做本地推理的前提下。

### 方案 A：试一下 Jina Embeddings v2 Code（专门为 code 做的）

有一个专门的代码向量模型：**jina-embeddings-v2-base-code**：

* 官方定位就是「**多语言代码检索模型**」，支持 30 种主流编程语言（包括 Java），目标就是做大代码仓的 code search / NL→code 检索。
* 上下文长度 8192 token，适合你这种“整类 / 整文件级别”的嵌入。
* 开源权重，可自托管，HuggingFace / AWS Marketplace 都有。

而且已经有人帮你做好 Ollama 封装了：`unclemusclez/jina-embeddings-v2-base-code`，就是把这个模型打成 Ollama 模型来用。

对你来说迁移成本非常低：

* 现在桥接层的 embedding 调用是 `model: "manutic/nomic-embed-code"`；
* 你可以换成：`"unclemusclez/jina-embeddings-v2-base-code"`（或你在 Ollama 里起的别名）；
* 其它维度、流程都不必大动（注意一下输出维度有没有变化，跟 Milvus 里的 collection schema 对齐一下就行）。

优点是：

* 专门为 code 优化，对 “Java + 注释 + 少量中文自然语言” 这种混合场景很友好；
* 目前没看到类似 `-Inf` 的广泛报错反馈，稳定性通常比你自己绕开 `-Inf` 要省心。

### 方案 B：用强力通用 embedding（mxbai-embed-large / BGE-M3 一类）

如果你发现自己更多是做「**自然语言问题 → 找 Java 类 / 方法 / 文档片段**」这种 RAG，而不是只做“代码相似度”，那通用 embedding 也值得一试。

在 Ollama 生态里：

* **mxbai-embed-large**：在 MTEB 等通用检索 benchmark 上是开源 SOTA 级别的 general embedding，官方明确说在很多任务上能跟 OpenAI 的大 embedding 模型掰手腕。
* 一些插件还列了 `all-minilm`、`bge-large`、`bge-m3` 这些模型，都可以直接作为 Ollama embedding 模型使用。

优点：

* 对“自然语言问句 + 业务文档 + Java 代码混合”的场景，经常比纯 code-only 模型更稳；
* 你很多查询其实是「中文/英文问题 → 代码片段 + 配置文件 + README」，这种时候 **跨模态 & 跨语言** 泛用 embedding 的表现往往更好。

你可以搞个小对比：

* 用 Jina Code v2  + mxbai-embed-large 各 embedding 一份同样的数据；
* 在你现在 Milvus 这个 210 条的小样本上做几组真实 query（比如“找所有使用 WsHttpClient 且带 retry 的类”，“找访问某个 wushan API 的入口”）；
* 看看哪一个 top-k 结果更对味。

### 方案 C：继续用 Nomic，但在桥接层「就地修 -Inf」

如果你现在已经跑在 manutic/nomic-embed-code 上，效果也还行，只是讨厌日志和 fallback，你也可以干脆在 embedding 服务出入口“物理消毒”：

* 在拿到向量数组后：扫描一遍，把任何 `NaN / +Inf / -Inf` 替换成 `0` 或一个极小值；
* 然后再归一化一次（L2 normalize），再写 JSON / 塞给 Milvus。

这样：

* 你不需要换模型；
* `json: unsupported value: -Inf` 会彻底消失；
* fallback embedding 可以保留作为 double protection（比如真的全是垃圾数值时才触发）。

这个思路跟你现在的 deterministic fallback 不冲突，只是再早一层“矫正不干净的浮点数”。

---

## 3. 那对「Java 场景」来说，怎么选更实际？

结合你现在的玩法（Java 大仓 + Spring + wushan + 混合中文/英文问题），一个比较现实的建议是：

1. **先试 Jina Code v2 版（jina-embeddings-v2-base-code）做主力 code embedding**

   * 它的定位就是“多语言代码检索”，对于你要做的 “找出所有 wushan 用法 / 升级影响 / 反模式” 非常合适。

2. 如果你发现问法里自然语言成分特别重、而且经常要连带 README / wiki 一起搜，
   再考虑开一个 parallel pipeline 用 `mxbai-embed-large` 或 `bge-m3` 做“**NL 主导的横向搜索**”。

3. 把现在这个 Nomic 模型先留着作为对照组，顺便保留 fallback 清洗逻辑；
   等你在真实 query 上感受到“Jina Code / mxbai-embed-large 确实更香”，再彻底切换。

简单讲：

> 现在的 nomic-embed-code 没有“被时代淘汰”，只是有点脏浮点数问题；
> 真要升级的话，
>
> * **同类竞品**：Jina Embeddings v2 Code，是一个很自然的替代；
> * **通用强化型**：mxbai-embed-large / BGE 系列，可以让“中文需求 + Java 代码 + 注释”混搜更顺滑。

你完全可以把这个当作 **embedding 层的小 A/B 实验**，顺手也顺便为以后“公司内部统一选型”攒一份实测报告。
