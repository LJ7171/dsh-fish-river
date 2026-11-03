# 来源与致谢

## 代码

- 本项目从 **[ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish) 0.8.5**（MIT）演进而来：事件流、四阶段与瓶颈、记忆显著性与固化、拒绝与疤、观测台、B 站浏览等骨架来自该项目的作者。
- 渠道层的设计参考了 **[Britneycode/dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul) 0.12.0**（MIT）的思路（每聊一句的流水、出站筛选、按人隔离），实现是重写的，没有整块拷贝。
- `lib/vendor/uqr.mjs` 来自 **uqr@0.1.2**（MIT，Anthony Fu），作为源码随包分发，**不构成运行时依赖**——`package.json` 的三个依赖字段永远是 `{}`。

## 理论引用

原理页引用了 Kolb / Piaget / Bowlby / Erikson / Festinger / Bartlett / Dewey / Schön 的理论，属思想引用，页底标注了作者与年份；不含他人代码或原文。

## 美术资源

`media/fish.jpg` 由作者提供的大肥鱼原图经 AI 生成，随本仓库以同一许可授权；其余示意图为本项目自绘。头像由用户自行上传（存在 `~/.dsh-fish-river/avatar.<ext>`），不入库。
