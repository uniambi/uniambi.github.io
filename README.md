# UniAmbi demo

在本目录运行：

```bash
python3 -m http.server 8000
```

打开 http://localhost:8000 。使用 Python 自带的静态服务器即可；没有额外服务端脚本。请通过 HTTP 打开，不要直接双击 HTML（浏览器会限制本地模块和媒体读取）。页面是纯静态 HTML/CSS/JS，可将整个目录原样托管；没有构建步骤、CDN 或运行时外部依赖。

## 页面

- Text to Audio：10 个样例、50 个音频版本，桌面每行两个播放器。
- Video to Audio：13 个样例，每例三个独立视频（UniAmbi、OmniAudio、Visage）；两例附带的 Ground Truth 仍以音频保留，共41个音频版本。
- Video + Text to Audio：6 个样例，每例四个独立视频（UniAmbi、MMAudio、AudioX、Omni2Sound），共24个音频版本。

标题为“UniAmbi: Unified Spatial Audio Generation via Iterative Expert Routing”，标题字号为桌面65px、手机52px（较上一版再减小4px），后接完整摘要；T2A/VT2A 样例以“序号 + 原始模型输入 prompt”开头，完整保留 `<Des>`、`<D>`、`<S>` 等标签并按文字显示，V2A 仅保留序号。所有方法名称后显示真实的 FOA audio / mono audio / stereo audio；VT2A 的 MMAudio、Omni2Sound 标为 Only mono audio，AudioX 保持原始双声道并标为 Only stereo audio。章节标题、说明文字和顶部导航字号已放大；顶部标签字号为桌面24px、平板20px、手机16px；底部 Previous group / Next group 使用透明背景、胶囊圆角的大按钮（桌面至少56px高，手机至少52px高）。顶部箭头保持大按钮，手机导航分行排布；三组音量控件均固定右对齐。页面不显示样例数量标签和页脚 SwanSphere 链接，T2A移除操作提示句，视频视角拖动提示加粗。左右箭头循环切换三组，各页完整展示该组全部样例。也支持分组标签、键盘左右键及直接访问 `#t2a`、`#v2a`、`#vt2a`。播放器互斥，切页自动停止；支持暂停、进度定位、音量和全景拖拽。全景视频与选中音频同步；不同方法保留各自完整音频时长。视频短于音频时停留在最后一帧。

## 音频渲染

- 页面当前67个原生四通道音频按用户指定的 **W, Y, Z, X** 顺序输入本地 Omnitone 1.3.0，在播放时实时解码为双耳耳机输出；缓存保留四通道原信号，不预渲染为双声道。顺序对应 ACN；归一化按参考站的 AmbiX/SN3D 处理，不额外缩放 W。
- WAV 用显式 PCM/IEEE float 读取，保留原始通道顺序；支持 PCM8/16/24/32、float32/64 和 extensible。FLAC 由 Web Audio 解码，严格检查四通道；已用合成四通道 FLAC 验证没有通道重排。
- 拖动视频改变视角，传递相机逆旋转到 FOA 解码器。正 yaw 向左、正 pitch 向上；前方声源在向左转头后位于右侧。
- 2026-10-12 已将 T2A 的17个、V2A 的4个 Stereo projection MP3 替换为同一样例、同一模型的原始四通道 WAV/FLAC（12个模型输出、9个Ground Truth）。SHA-256与补充包逐一一致；不做增益调整、重采样或通道重排。Ground Truth保留原始通道顺序，页面仍沿用既有WYZX解码设置；文件复制校验不等于独立验证其空间规范。
- 其余42个单声道和6个立体声 baseline 保持原通道布局。
- 所有方法使用同一 `0.5 × volume` 输出增益，默认音量0.7；不做逐方法归一化、裁剪或重编码。原素材和 JSONL 保留不变。
- 最多缓存8个解码音频；同一时刻仅一个视频源、一个全景 viewer 和一个音频源活跃。无 WebGL 时显示原始全景视频并提示。

T2A 最初第6、7、8条补充语音均已移除（最后移除的是当时页面第6条 `demo_t_dynamic_speech_16`）；原素材保留。页面中的 Reference 名称统一显示为 Ground Truth。V2A 原第02个样例已从展示清单移除（原素材不删除），全部场景描述文字不再显示，拖动提示加粗；VT2A 原第5、6个样例已调整至前两位，其余顺序保留。T2A/VT2A 保留提示词标签；按要求从VT2A第一条的展示文本中移除了皮艇敲击描述，原始metadata不改写，重建清单会保留这项展示修改。只有 UniAmbi 版本的样例不伪造 baseline。公开 `data.json` 不包含原 JSONL 中的机器路径或内部模型信息。

## 原始 FOA 已补齐

补充包 `swansphere_good_cases_13_foa_20261012` 中的21个补充音频此前已替换到 `assets/t2a/` 和 `assets/v2a/`，文件名为 `sample_id__ours_foa.wav` 或 `sample_id__reference_foa.wav/flac`。被替代的21个双声道MP3已从assets移除。源素材中的3条补充语音没有Ground Truth，均已按要求从页面移除；此前排除的 `-3GumCmyAIk_68` 未恢复。补齐FOA时未改动Baseline、视频或播放代码；当前展示顺序按上述删减规则生成。

## 新增 T2A 案例

2026-10-12 从本地 `tmp/` 加入 `audio_audio_dynamic_00188503`、`audio_speech_dynamic_00020970`、`audio_speech_dynamic_00153020`。本模型WAV与entry的release输出SHA-256一致。每条包含原始四通道模型输出、四通道Ground Truth，以及MMAudio、Tango2、AudioLDM2单声道baseline；caption逐条匹配，音频不重编码、不裁剪。Tango2原始时长均为10.242秒，其余版本保留各自时长。新增3条在T2A中排第8–10条。移除最后一条补充语音后，页面共29个样例、115个音频版本。 已在Chrome逐个播放新增15个音频，确认声道类型、完整时长和带标签prompt均正确；页面70项回归检查通过，桌面及手机布局正常。

## 视频资源控制

所有独立方法视频默认不设置 `src`，`preload="none"`，先共用静态全景投影首帧。原有20张640×360 JPEG预览合计约479 KiB（当前页面使用19张），滚动浏览不会请求MP4或创建WebGL。点击播放后才完整获取对应视频Blob，同一素材切换方法不重复请求。最多保留2个视频Blob（这批素材最大的两个合计约2.33 MiB），因此标准Python服务器即使没有Range支持也能正常定位。切换方法释放上一个video解码器和WebGL；切页取消在途请求、释放全部Blob URL。音频和视频在准备完毕后才同步启动。

## 更新素材

更新 `assets/{t2a,v2a,vt2a}/info.jsonl` 和对应文件后执行：

```bash
python3 scripts/build_manifest.py
```

如果新增或更换视频，在标准Python服务器运行时更新预览：

```bash
node scripts/build_previews.cjs http://localhost:8000
```

预览生成工具需要本机Node.js、Playwright和Chrome，普通浏览页面不需要这些依赖。

`scripts/build_manifest.py` 按稳定sample ID保存V2A移除与VT2A排序规则，重建不会恢复旧排列。脚本验证所有音频引用及实际通道数后生成 `data.json`。文件名和原提示词保留；`ours` 的页面名称统一为 UniAmbi。

## 验证

音频引擎已通过106个实际音频的解码检查和32项FOA信号测试。2026-10-12，新版页面在标准 `python3 -m http.server 8000` 服务上通过70项Chrome回归检查：摘要、prompt、方法视频、按需加载、共享Blob缓存上限、切页清理、无Range响应下的定位与同步、320/390/768/1440px布局；无浏览器错误。另通过7项冷启动取消检查，验证播放初始化时切页不会重新请求旧媒体，并能正常开始后续播放。T2A删减前另通过38项检查：29个样例、103个结果、格式标注、字号、排列、12种组别/屏宽组合；在V2A及VT2A中实际播放FOA并拖动，各观察到8次实时旋转更新，音源重启与重新下载均为0。这里的验证是浏览器与信号级测试，不代表对模型音质进行主观评价。

21个原始FOA替换后、T2A删减前，重新核对了103个页面音频的真实通道数，清单与文件全部一致；64个FOA均在Chrome中成功解码为原始四通道。另实际监听浏览器音频图，验证T2A WAV、Ground Truth FLAC、新替换的两条V2A及VT2A共5次播放均为四通道输入、实时双声道输出；三个视频播放的拖拽均更新8次旋转，无音源重启或重新下载。更新后的页面再次通过70项完整回归和38项页面/视角检查。

T2A移除原第6、7条并统一Ground Truth名称后，当时页面共27个样例、101个音频版本。已重新通过38项浏览器检查及12种组别/屏宽布局检查；原第8条正确顺延为第6条，9个Ground Truth名称与文件引用均正确。

自动验证需本机 Node.js、Playwright 和 Chromium/Chrome：

```bash
# 先保持 python3 -m http.server 8000 运行
node scripts/check_browser.cjs
node scripts/check_cancellation.cjs
node scripts/check_current_revision.cjs
node scripts/test_audio.mjs
```

可用 `PLAYWRIGHT_PACKAGE` 指定 Playwright 包路径，`CHROME_PATH` 指定 Chrome 可执行文件；`DEMO_URL` 可改默认本地网址。音频测试涵盖各 WAV 格式、四通道 FLAC 原序、左右方向、头部旋转、垂直 HRTF 和全部 WYZX 分量贡献。

页面风格与 FOA 播放参考 https://swansphere.github.io/ 。Omnitone 原始许可及来源位于 `vendor/OMNITONE-LICENSE`、`vendor/README.txt`。
