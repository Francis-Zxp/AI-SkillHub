# 天空岛素材来源与许可（v3.2.9 卡通版）

天空岛使用的全部模型随应用打包在 `app-next/public/sky/`，离线可用，运行时不访问任何 CDN 或远程图片。构建脚本：`app-next/scripts/sky-assets/`（`build.mjs` 合并模型库，`buildings.mjs` 用村庄模块拼装建筑，`convert-animals.cjs` 转换动物模型）。原始素材包不进入仓库，只提交构建产物与清单。

| 产物 | 来源 | 作者 | 许可 | 修改 |
| --- | --- | --- | --- | --- |
| `buildings.glb`（Cottage / TownHouse / Tower / Workshop） | [Medieval Village MegaKit](https://opengameart.org/content/medieval-village-megakit) | Quaternius | CC0 1.0 | 用墙、屋顶、门窗模块按蓝图拼装（`buildings.mjs`）；运行时去掉贴图、按材质改为平涂卡通色，屋顶颜色随分类主题 |
| `props.glb`（19 个道具：长椅、木箱、书架、推车等） | [Fantasy Props MegaKit](https://opengameart.org/content/fantasy-props-megakit) | Quaternius | CC0 1.0 | 合并为一个库；运行时卡通着色 |
| `villager.glb` | [Ultimate Modular Women — Animated Woman](https://poly.pizza/m/nIItLV9nxS) | Quaternius | CC0 1.0 | 只保留五段动画；卡通着色 |
| `animals/*.glb`（羊、猪、牛、羊驼、巴哥犬、马） | [Farm Animals Pack](https://quaternius.com/packs/farmanimals.html) | Quaternius | CC0 1.0 | 用 three.js 从 FBX 转为 glTF（`convert-animals.cjs`）；运行时按颜色合并子网格并卡通着色 |
| `gull.glb` | [Flying gull](https://poly.pizza/m/eMNhHDZakYp)（Poly Pizza） | Poly by Google | **CC-BY 3.0**，需署名 | 去重、焊接顶点；改为平涂白色，翅膀扇动为着色器动画 |

v3.2.9 起不再打包 Stylized Nature MegaKit 和地表贴图：树木、灌木、岩石、草丛、花、蘑菇和云全部在代码中由圆润几何体生成，地表与岩层用程序化着色（无贴图，不会重复或出现接缝）。

署名的落点：

- 应用内：天空岛页底部「素材与许可」面板列出全部来源，包括 CC-BY 署名。
- 安装包内：`sky/ATTRIBUTION.txt` 随前端资源一起打包。

AI SkillHub 原创部分：岛屿外形与地质、全部植物/岩石/云的几何、卡通地表与岩层着色、水面与瀑布、天空与星星、岛屿布局与主题、鸟群/人物/动物行为、所有动画与交互代码。

许可核对：CC0 素材允许任意用途且无需署名；CC-BY 3.0 允许分发与修改，条件是署名并注明修改，二者都兼容本项目的分发方式。下载时记录的页面与许可见 `scripts/sky-assets/manifest.json`。
