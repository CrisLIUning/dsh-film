# dsh-film · VibeDev 影视工作台

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 VibeDev 里做片：聊天右侧的侧栏多出四个标签——**剧本、分镜画布、剪辑台、导演台**。左边和 Agent 聊，右边看和改成果。项目是工作区里 `film/` 下的普通文件；Agent 用专门的影视工具改剧本、分镜和剪辑（见下），和右边看到的是同一份。

> 现在是 0.0.x 预览版。分镜画布（含导演台）和剪辑台用的是 VibeDev 的原版前端，跑在插件自己的接口上；剧本标签是按 DSH 界面重写的，文件格式与 VibeDev Studio 的编剧台相同。图片、视频的生成由 [dsh-media](https://github.com/CrisLIUning/dsh-media) 负责，剪辑台的编辑器来自 [vibedev-video-editor](https://github.com/CrisLIUning/vibedev-video-editor)。

A film workbench for DeepSeek Harness and VibeDev: four right-sidebar tabs — script, storyboard, editing desk and director desk — working on one film per workspace, kept as plain files under `film/`. In this 0.0.x preview the storyboard (with the director desk) and the editing desk are VibeDev's original front ends running on the plugin's own API, and the script tab is a DSH-native rewrite. The agent works on the same film through its own film tools.

## 安装 · Install

- **VibeDev**：在设置的插件页安装 `dsh-film`。
- **DeepSeek Harness 命令行**：`dsh plugin add dsh-film`。
- **DeepSeek Harness 桌面版**：先完全退出桌面版，再运行 `dsh plugin --profile desktop add dsh-film`。

装好后打开任意会话的右侧侧栏，在“开始”页点“剧本”等入口。会话需要有工作区。

In VibeDev, install `dsh-film` from the plugin page in settings. In DeepSeek Harness, run `dsh plugin add dsh-film`, or `dsh plugin --profile desktop add dsh-film` for the desktop app (quit it fully first). Then open the right sidebar of a session that has a workspace and pick a part on its start page.

## 文件 · Files

```
<workspace>/
  film/film.json             项目信息：片名、画幅（format vibedev.film, version 1）
  film/story/<id>.md         剧本：正文是 Markdown，场次、镜头、人物等记在隐藏的结构标记里
  film/canvas/document.json  分镜画布
  film/canvas/timeline.json  剪辑台的剪辑和撤销历史（与 VibeDev Studio 同一格式）
  film/canvas/media/         生成、导入的素材
  film/canvas/renders/       剪辑台导出的成片
  media/                     dsh-media 生成的素材；剪辑台第一次用到时复制进 film/
```

一个工作区放一部片。已有的 `film/film.json` 不会被覆盖。

## Agent 的影视工具 · Agent tools

每个会话都有 `film_project`：查看工作区的影片项目，或在用户要做片时新建一个。工作区有影片项目的会话还会常驻 34 个工具、`film_tools` 和一段说明（没有影片的会话不带它们；新建项目后从下一步起就有）。导演台和建模两组工具按需加载：画板上有导演台节点时自动带上导演组，其余由 Agent 用 `film_tools` 开启，不用时不占 token。

- **剧本** `story_query` `story_asset_bindings` `story_create` `story_apply_ops` `story_history` `story_checkpoint` `story_restore` `story_revert`：和剧本标签用同一套接口，按保存的版本号写入（先 dryRun 预览），每次写入都有版本和操作记录，可以单独撤回某次操作。`story_asset_bindings` 给人物、地点、道具和镜头绑定参考图（只认选中的那份字节，五种解析结果分开报告），工作区 `media/` 下的图片先复制进影片再绑定。
- **导入导出** `story_import` `story_export`：先预览再导入为新副本（从不覆盖）；导出完整 Markdown、仅正文，或连同参考图打成素材包存到 `film/story-exports/`。
- **剧本到分镜** `story_source` `story_handoff` `story_adopt` `story_impact` `story_director_links`：把保存的人物、场景、道具、场次或镜头读成制作素材，送到画布成为独立的剧本来源卡（可同时准备一个连好线、只待确认提示词的图片节点，不会自动生成）；按节点保存的字段显式采用描述或参考图（参考图另存一份字节快照）；剧本改动后查看影响了哪些采用、产物、导演镜头和剪辑片段；给导演台已保存的机位记下剧本来源。分镜标签不开也能用。
- **分镜画布** `canvas_list_clients` `canvas_get_state` `canvas_get_selection` `canvas_read_node` `canvas_get_generation_status` `canvas_get_document` `canvas_create_text_nodes` `canvas_create_generation_flow` `canvas_run_generation` `canvas_connect_nodes` `canvas_delete_nodes` `canvas_apply_ops` `canvas_attach_media`：分镜标签开着时，改动交给页面执行，用户看着它出现，也能撤销；没开时，改动写进保存的画布，下次打开就在。运行生成要分镜页开着。`canvas_attach_media` 把已经生成好的文件（如 dsh-media 存在 `media/` 的图片）放进指定节点，不重复生成。
- **剪辑台** `timeline_query` `timeline_edit`：读剪辑（版本号、各轨道片段）和画布可用的素材、剧本；按版本号放素材、放台词字幕和音效配乐、换镜头的候选版本，或执行原始命令。
- **原声字幕** `timeline_transcribe` `timeline_apply_captions` `media_get_task` `media_cancel_task`：识别剪辑里的原声对白，后台任务产出待审的字幕草稿（按句分页读），审过后先 dryRun 再写入，只改识别范围内的字幕，人工和已审过的字幕不动。两个引擎、不会互相替补：`whisper`（默认，免费，在打开的 VibeDev/DSH 窗口里的隐藏页面运行，需同意下载模型）和 `gateway`（VibeDev 网关转写，只支持普通话，按分钟计费，音频会上传）。`timeline_query` 的 `caption-tasks` 列出最近的识别和是否已写入。
- **导演组（按需）** `director_query` `director_stage` `director_render` `director_render_status` `director_render_cancel` `director_inspect_model` `director_review` `director_compile_motion` `director_modeling_brief`：读导演台场景（结构、采样、事件、诊断、动作），按指纹分步调度（先 dryRun），编译动作，管理审阅版本。查询和调度在导演标签关着时作用于保存的节点，开着时作用于桌面上的实时场景；渲染、检视模型和审阅版本要导演标签开着。后台无头渲染暂未接入。
- **建模组（按需）** `space_plan_compile` `model_brief` `model_review` `model_adopt` `model_status` `model_report` `model_cancel`：按毫米写平面，编译成 `film/spaces/` 下导演台能打开的 GLB（先 dryRun 看尺寸、警告和楼梯可达性）；为程序化模型准备建模任务，读 `film/models/<id>/model.json` 里的记录、写审阅、记录用户采用的版本。运行模型、拍检查图、导出和回读 GLB 需要无头浏览器，暂未接入。

工具名和参数沿用 VibeDev Studio 的影视工具；工作区就是项目，所以不再需要 `project` 参数。

Every conversation has `film_project` (read or start the workspace's film). Conversations in a film workspace also carry 34 screenplay, storyboard, cut and caption tools, `film_tools` and guidance; the director desk's and the modeling tools are groups taken on when needed (the director group starts enabled when the board has a director node). All of them go through the same API as the workbench's pages. With the storyboard open, board edits run in the page (live and undoable); with it closed they are saved to the board, and running a generation needs the page.

### 编剧技能 · Screenwriting skill

插件随包带一个技能 `film-screenwriting`（编剧，`skills/film-screenwriting/`），通过 DSH 的技能服务登记，每个会话的技能目录里都有它，也可以用 `/film-screenwriting` 直接调用。它写给上面的 `story_*` 工具：怎样找到和保存剧本（先预览再保存、冲突时重读）、场景/动作/对白的写法和自检、竖屏短剧与单集、剧本诊断（证据、严重程度、哪些不算套路），以及交给分镜和剪辑。操作示例都经过测试，能直接用。没有技能服务的配置照常加载插件。

The plugin ships the `film-screenwriting` skill (`skills/film-screenwriting/`), registered with DSH's skill registry: listed in every conversation's skill catalog and invocable as `/film-screenwriting`. It covers finding and saving screenplays with the `story_*` tools, scene, action and dialogue craft with self-checks, short-form and episodes, evidence-based diagnosis, and handoff to the storyboard and the cut; its example batches are tested against the screenplay contracts.

## 剪辑台的 AI 模型 · Editor models

配音、人声分离、抠像、景深、擦除、超分、数字人和字幕字体要用到本地模型。模型不打进插件包：剪辑台第一次要用某个模型时，先弹框说明用途、大小、许可和来源，同意后才由插件从 VibeDev 模型镜像下载，逐个文件核对大小和 SHA-256，存在 `$DSH_HOME/cache/dsh-film/video-editor-models/`（设置项 `modelsDir` 可改），以后直接用。同意记录在同一目录的 `consents.json`；字幕字体同属 OFL-1.1，可以一次同意全部。

可下载的模型列在 `models/video-editor-models.json`，由 `scripts/editor-models.mjs` 从 VibeDev Studio 的模型清单生成，只收许可清楚的：去掉了 Studio 标为受限的换脸模型（研究用权重）和 Stable Audio（Stability AI 社区许可，尚未确认）。各模型的许可以清单里声明的为准。

The editing desk downloads its models only after the person agrees, verifies every file's size and SHA-256, and keeps them once per machine; the list carries only models whose licence is clear.

## 原声字幕 · Original-audio captions

识别原声对白有两个引擎，设置项 `captionEngine` 选默认的一个（`whisper`），每次识别也可以单独指定；一个引擎跑不了就报错，不会换另一个。

- `whisper`：剪辑台自带的 Whisper small（q8）加 Silero 语音检测，免费、不出本机，要先同意下载这两个模型。宿主没有浏览器，识别在打开的 VibeDev/DSH 窗口里的一个隐藏页面中运行（`apps/editor/caption-runner.html`）；没有窗口开着时会直接说明。
- `gateway`：VibeDev 网关转写，只支持普通话，约 ¥0.05/分钟，音频会上传到第三方转写服务，需要 dsh-media 0.1.3 以上并登录。网关目前不返回时间，所以先在窗口里按 Silero 检测到的语音分段，每段单独转写、按段的起止给时间（标记 `region-timing`），从不编造时间；网关返回分句时间时改用它的。取消只能停止等待，已提交的段仍会计费。

识别是后台任务（`film/.tasks/`），结果是待审草稿；写入剪辑前要按原声核对，只改识别范围内的字幕。

Captions come from one of two engines with no fallback between them: `whisper` (free, local, run in a hidden page of an open window) or `gateway` (VibeDev's ASR through dsh-media: Mandarin only, paid per minute, timed by speech regions until the gateway returns timings). The plugin setting `captionEngine` picks the default.

## 开发 · Development

```bash
npm install
npm run typecheck
npm test
npm run build      # lib/ (Host half) + client/ (browser half)
```

原版前端另行构建后放进 `apps/`（不进 git）：`node scripts/build-apps.mjs canvas editor`，分别从相邻的 vibedev-canvas 和 vibedev-video-editor 检出构建。剪辑台的时间线命令引擎（Host 一侧执行放置命令用）是 vibedev-video-editor 的桥接合约构建，放在 `vendor/video-editor-bridge.mjs`。

浏览器端按 DSH 的模块加载格式打包：`client/client.js` 每次启动加载，只登记四个标签；工作台本体在 `client/client.workbench.js`，第一次打开标签时才加载。`scripts/check-client.mjs` 会检查打包结果（文件清单、加载器首行、只引用宿主提供的模块）。

## License

MIT

导演台的场景数学（`src/director/vendor/director-math/`，构建后在 `lib/director/vendor/director-math/`）原样复制自 [vibedev-director-desk](https://github.com/CrisLIUning/vibedev-director-desk)，Copyright (c) 2026 YZ，以 MIT 许可证发布（条款与上文相同，原文见该目录的 `LICENSE`）。
