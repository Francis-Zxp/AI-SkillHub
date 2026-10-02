# 天空岛素材来源与许可（v3.2.8）

天空岛使用的全部模型与贴图随应用打包在 `app-next/public/sky/`，离线可用，运行时不访问任何 CDN 或远程图片。构建脚本：`app-next/scripts/sky-assets/`（`textures.py` 转 WebP，`build.mjs` 合并模型库，`buildings.mjs` 用村庄模块拼装建筑）。原始素材包不进入仓库，只提交构建产物与清单。

| 产物 | 来源 | 作者 | 许可 | 修改 |
| --- | --- | --- | --- | --- |
| `nature.glb`（35 个模型：树、灌木、草、花、岩石、蘑菇、石板路） | [Stylized Nature MegaKit](https://opengameart.org/content/stylized-nature-megakit) | Quaternius | CC0 1.0 | 合并为一个库，每个模型一个具名根节点；贴图转 WebP；去掉未用的贴图通道；顶点量化 |
| `buildings.glb`（Cottage / TownHouse / Tower / Workshop） | [Medieval Village MegaKit](https://opengameart.org/content/medieval-village-megakit) | Quaternius | CC0 1.0 | 用墙、屋顶、门窗模块按蓝图拼装（`buildings.mjs`），合并网格；仅屋瓦保留法线贴图 |
| `props.glb`（19 个道具：长椅、木箱、书架、推车等） | [Fantasy Props MegaKit](https://opengameart.org/content/fantasy-props-megakit) | Quaternius | CC0 1.0 | 同 nature |
| `villager.glb` | [Ultimate Modular Women — Animated Woman](https://poly.pizza/m/nIItLV9nxS) | Quaternius | CC0 1.0 | 只保留 Idle / Idle_Neutral / Walk / Wave / Interact 五段动画 |
| `gull.glb` | [Flying gull](https://poly.pizza/m/eMNhHDZakYp)（Poly Pizza） | Poly by Google | **CC-BY 3.0**，需署名 | 去重、焊接顶点；翅膀扇动改为着色器动画 |
| `textures/brush.webp`、`textures/noise.webp` | Medieval Village MegaKit 附带的笔刷 / 地形噪声贴图 | Quaternius | CC0 1.0 | 转 WebP，作为世界坐标采样的地表与岩石细节 |

署名的落点：

- 应用内：天空岛页底部「素材与许可」面板列出全部来源，包括 CC-BY 署名。
- 安装包内：`sky/ATTRIBUTION.txt` 随前端资源一起打包。

AI SkillHub 原创部分：岛屿外形与地质（悬垂岩体、分层岩壁、钟乳石）、地表与岩石着色、水面、云海与天空、岛屿布局与主题、鸟群与人物路线、所有动画与交互代码。

许可核对：CC0 素材允许任意用途且无需署名；CC-BY 3.0 允许分发与修改，条件是署名并注明修改，二者都兼容本项目的分发方式。下载时记录的页面与许可见 `scripts/sky-assets/manifest.json`。
