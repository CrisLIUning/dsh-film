# dsh-film · VibeDev 影视工作台

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 VibeDev 里做片：聊天右侧的侧栏多出四个标签——**剧本、分镜画布、剪辑台、导演台**。左边和 Agent 聊，右边看和改成果。项目是工作区里 `film/` 下的普通文件；Agent 用专门的影视工具改剧本、分镜和剪辑（见下），和右边看到的是同一份。

> 0.1 是第一个公开发布的版本，仍属预览。分镜画布（含导演台）和剪辑台用的是 VibeDev 的原版前端，跑在插件自己的接口上；剧本标签是按 DSH 界面重写的，文件格式与 VibeDev Studio 的编剧台相同。图片、视频的生成由可选的 [dsh-media](https://github.com/CrisLIUning/dsh-media) 插件负责，剪辑台的编辑器来自 [vibedev-video-editor](https://github.com/CrisLIUning/vibedev-video-editor)。

A film workbench for DeepSeek Harness and VibeDev: four right-sidebar tabs — script, storyboard, editing desk and director desk — working on one film per workspace, kept as plain files under `film/`. In this 0.1 preview, the first public release, the storyboard (with the director desk) and the editing desk are VibeDev's original front ends running on the plugin's own API, and the script tab is a DSH-native rewrite. The agent works on the same film through its own film tools.

## 安装 · Install

需要 DeepSeek Harness 0.2.x，或基于它的 VibeDev（VibeDev Next）。插件以包名 `dsh-film` 发布在 npm 官方源；中国大陆镜像源（registry.npmmirror.com）从 npm 同步，新版本一般稍后就有。

**插件页（推荐）**：在 VibeDev 或 DeepSeek Harness 的“插件”页点“添加插件”，选“安装第三方插件”（按包名或地址安装），在“包名或地址”里填 `dsh-film`。展开“安装源”，选“npm 官方源”或“中国大陆镜像源”（国内网络选镜像源通常更快），再点“安装”。

**命令行**：

- DeepSeek Harness 桌面版：先完全退出桌面版，再运行下面的命令（`dsh` 命令在桌面版应用菜单的“管理 dsh 命令…”里安装）：

  ```bash
  dsh plugin --profile desktop add dsh-film
  ```

- VibeDev（VibeDev Next）桌面版：命令叫 `vibedev-app`，在应用菜单的“管理 vibedev-app 命令…”里安装。同样先完全退出应用，再运行：

  ```bash
  vibedev-app plugin --profile desktop add dsh-film
  ```

  VibeDev 的数据在 `~/.vibedev-app`，用 `dsh` 命令装的插件到不了它那里。

- 用 npm 安装的 `dsh` 命令行（终端或 Web 版）：

  ```bash
  dsh plugin add dsh-film
  ```

**从 GitHub Release 安装**：插件页的“包名或地址”和上面的命令也接受 Release 里的 `.tgz` 直链，例如

```
https://github.com/CrisLIUning/dsh-film/releases/download/v0.1.0/dsh-film-0.1.0.tgz
```

直链不经过安装源，需要本机能直接访问 GitHub（或配好代理）。包约 40 MB，网速慢时可能超过 pnpm 默认的 60 秒下载时限而失败。这时最省事的是改为按包名从中国大陆镜像源安装；也可以把时限调长：pnpm 11（DeepSeek Harness 和 VibeDev 桌面版自带的就是它）不再从 `~/.npmrc` 读取这个设置，要在 pnpm 的全局配置 `config.yaml` 里加一行 `fetchTimeout: 600000`（Windows：`%LOCALAPPDATA%\pnpm\config\config.yaml`；macOS：`~/Library/Preferences/pnpm/config.yaml`；Linux：`~/.config/pnpm/config.yaml`），或设环境变量 `pnpm_config_fetch_timeout=600000`；pnpm 10 及更早的版本则在 `~/.npmrc` 里加 `fetch-timeout=600000`。

**刚发布的版本**：pnpm 11 默认只安装发布满一天的版本（`minimumReleaseAge`）。第一个版本不受影响：按包名安装一个此前没有任何版本的包时，pnpm 照样装上它，并把它记进 `minimumReleaseAgeExclude`。之后每次发布新版本，头一天按包名安装得到的是上一个版本；要马上装新版本，按确切版本安装（包名写成 `dsh-film@<版本>`），或者用上面的 Release 直链。

**不能从 Git 仓库安装**：不要在插件页填仓库地址 `https://github.com/CrisLIUning/dsh-film`，也不要对它运行 `dsh plugin add`。`lib/`、`client/` 和 `apps/`（分镜画布、导演台、剪辑台的前端）都是构建产物，不在 git 里，从仓库安装会失败（不会留下装了却用不了的插件）。

**dsh-media 是可选的**：只有在分镜画布里生成图片和视频才需要另装 [dsh-media](https://github.com/CrisLIUning/dsh-media)（包名 `dsh-media`，装法相同；走 VibeDev 网关，按用量从 VibeDev 余额扣费）。不装也能写剧本、排分镜、剪辑、识别原声字幕和渲染成片。

**用到时才下载、且要先经你同意的**：

- 原声字幕用的 Whisper small 和 Silero 语音检测模型，合计约 254 MB（254,174,137 字节）；
- 后台渲染用的 FFmpeg（GPL 版本，压缩包约 86 MB，86,333,540 字节）：只在 Windows x64 上、本机找不到 ffmpeg 时才会提出下载；其他系统请自行安装 ffmpeg；
- 剪辑台的其他 AI 模型（配音、抠像等），见下文“剪辑台的 AI 模型”。

装好后打开任意会话的右侧侧栏，在“开始”页点“剧本”等入口。会话需要有工作区。第一次打开任一影视标签时，插件自动在工作区里建好影片（片名取工作区文件夹名，画幅 16:9，连同一张空白分镜画布），不用填表。片名和画幅在四个标签共用的标题栏里改：点片名直接改（最多 80 字，回车或点别处保存，Esc 取消）；画幅菜单列出剪辑台支持的 16:9、9:16、1:1、4:5、21:9、2.39:1，画幅用于新的剪辑，已有剪辑在剪辑台里改。0.1.0 建的 4:3 影片照旧保留并显示为 4:3。

**升级**：插件页暂不支持自动更新，先卸载再按上面的方法装新版本。影片是工作区里 `film/` 下的文件，卸载插件不会动它们。

Requires DeepSeek Harness 0.2.x or VibeDev (VibeDev Next), which is built on it. The plugin is published to npm as `dsh-film`; the npmmirror China mirror syncs from npm.

- **Plugin page** (recommended): Plugins → Add plugin → install a third-party plugin by package name, enter `dsh-film`, pick the npm registry or the China mirror under the install source, and install.
- **Command line**: for the DeepSeek Harness desktop app, quit it fully, then run `dsh plugin --profile desktop add dsh-film` (the `dsh` command is installed from the app menu). VibeDev Next's command is `vibedev-app` (app menu → Manage vibedev-app Command…): quit the app fully, then run `vibedev-app plugin --profile desktop add dsh-film`; it keeps its data in `~/.vibedev-app`, which `dsh` does not reach. With the npm `dsh` CLI, run `dsh plugin add dsh-film`.
- **GitHub Release**: the plugin page and the commands also take the release asset URL, e.g. `https://github.com/CrisLIUning/dsh-film/releases/download/v0.1.0/dsh-film-0.1.0.tgz`. It is fetched straight from GitHub, not through a registry. The file is about 40 MB, and on a slow connection pnpm's default 60-second fetch timeout can cut it off: install by name from the mirror instead, or raise the timeout — pnpm 11 (the one the desktop apps ship) no longer reads it from `~/.npmrc`, so add `fetchTimeout: 600000` to pnpm's global `config.yaml` (Windows `%LOCALAPPDATA%\pnpm\config\config.yaml`, macOS `~/Library/Preferences/pnpm/config.yaml`, Linux `~/.config/pnpm/config.yaml`) or set `pnpm_config_fetch_timeout=600000`; pnpm 10 and earlier take `fetch-timeout=600000` in `~/.npmrc`.
- **A fresh release**: pnpm 11 installs only versions published at least a day ago (`minimumReleaseAge`). The very first version is not held back: installing by name a package with no earlier version installs it and adds it to `minimumReleaseAgeExclude`. After each later release, an install by name gets the previous version for a day; to get the new one at once, install the exact version (`dsh-film@<version>`) or use the release URL.
- **Not from the git repository**: `lib/`, `client/` and `apps/` (the storyboard, director desk and editing desk front ends) are build outputs that are not in git, so installing from the repository URL fails (it does not leave a plugin that cannot work).
- **dsh-media is optional**: only image and video generation on the storyboard needs [dsh-media](https://github.com/CrisLIUning/dsh-media). Everything else works without it.
- **Downloads only after you agree**: the Whisper small and Silero speech-detection models for captions (about 254 MB together, 254,174,137 bytes); the FFmpeg renderer (GPL build, about 86 MB zipped, 86,333,540 bytes), offered only on Windows x64 when no ffmpeg is found — elsewhere install ffmpeg yourself; and the editing desk's other models.

Then open the right sidebar of a session that has a workspace and pick a part on its start page. The first time a film tab opens, the plugin creates the film — named after the workspace folder, 16:9, with an empty storyboard — with no form to fill in. Rename it and pick its frame in the header the four tabs share: click the title to edit it (up to 80 characters; Enter or clicking away saves, Esc cancels); the frame menu offers the editing desk's frames (16:9, 9:16, 1:1, 4:5, 21:9, 2.39:1) and applies to new cuts, while an existing cut's frame is changed in the editing desk. A 4:3 film made by 0.1.0 keeps and shows its frame. To upgrade, uninstall and install the new version; your film stays in the workspace's `film/` folder.

## 文件 · Files

```
<workspace>/
  film/film.json             项目信息：片名、画幅（format vibedev.film, version 1）
  film/story/<id>.md         剧本：正文是 Markdown，场次、镜头、人物等记在隐藏的结构标记里
  film/canvas/document.json  分镜画布
  film/canvas/timeline.json  剪辑台的剪辑和撤销历史（与 VibeDev Studio 同一格式）
  film/canvas/media/         生成、导入的素材
  film/canvas/imports.json   从工作区导入过的文件（没改过的不再列为可导入）
  film/canvas/renders/       剪辑台导出的成片
  media/                     dsh-media 生成的素材；和工作区里其他素材一样，用到时放进 film/
```

一个工作区放一部片。已有的 `film/film.json` 不会被覆盖；建影片时已有的画布（哪怕读不出来）和删除画布留下的记录也不会被覆盖，工作区里原有的画布会沿用它的 id。

工作区里 `film/` 以外的图片、视频和音频都算素材：剪辑台和分镜画布的素材库、工作台的素材列表都会列出它们。隐藏的文件和文件夹、`node_modules`、构建输出和缓存之类的生成目录、`.ssh` 等凭据目录和链接不列；文件太多时只读一部分（最多 2000 个素材、12 层目录），并标明列表不完整。用到时插件把文件硬链接进 `film/canvas/media/`（不能链接时复制），同样的字节只放一份；导入过、之后没改过的文件不再出现在剪辑台的可导入列表里。

Media anywhere in the workspace outside `film/` is material: the editing desk's and the storyboard's libraries and the workbench's media list show it (hidden entries, `node_modules`, build and cache folders, credential folders and links are skipped; a very large workspace is listed in part, and the list says so). A file is hard-linked into `film/canvas/media/` when used (copied where linking is not possible), the same bytes only once; an imported file that has not changed since is no longer offered for import.

## Agent 的影视工具 · Agent tools

每个会话都有 `film_project`：查看工作区的影片项目，在用户要做片时新建一个（用户打开影视标签时也会自动建好），或改片名和画幅（`update`）。工作区有影片项目的会话还会常驻 35 个工具、`film_tools` 和一段说明（没有影片的会话不带它们；新建项目后从下一步起就有）。导演台和建模两组工具按需加载：画板上有导演台节点时自动带上导演组，其余由 Agent 用 `film_tools` 开启，不用时不占 token。

- **剧本** `story_query` `story_asset_bindings` `story_create` `story_apply_ops` `story_history` `story_checkpoint` `story_restore` `story_revert`：和剧本标签用同一套接口，按保存的版本号写入（先 dryRun 预览），每次写入都有版本和操作记录，可以单独撤回某次操作。`story_asset_bindings` 给人物、地点、道具和镜头绑定参考图（只认选中的那份字节，五种解析结果分开报告），工作区里 `film/` 以外的图片先放进影片再绑定。
- **导入导出** `story_import` `story_export`：先预览再导入为新副本（从不覆盖）；导出完整 Markdown、仅正文，或连同参考图打成素材包存到 `film/story-exports/`。
- **剧本到分镜** `story_source` `story_handoff` `story_adopt` `story_impact` `story_director_links`：把保存的人物、场景、道具、场次或镜头读成制作素材，送到画布成为独立的剧本来源卡（可同时准备一个连好线、只待确认提示词的图片节点，不会自动生成）；按节点保存的字段显式采用描述或参考图（参考图另存一份字节快照）；剧本改动后查看影响了哪些采用、产物、导演镜头和剪辑片段；给导演台已保存的机位记下剧本来源。分镜标签不开也能用。
- **分镜画布** `canvas_list_clients` `canvas_get_state` `canvas_get_selection` `canvas_read_node` `canvas_get_generation_status` `canvas_get_document` `canvas_create_text_nodes` `canvas_create_generation_flow` `canvas_run_generation` `canvas_connect_nodes` `canvas_delete_nodes` `canvas_apply_ops` `canvas_attach_media`：分镜标签开着时，改动交给页面执行，用户看着它出现，也能撤销；没开时，改动写进保存的画布，下次打开就在。运行生成要分镜页开着。`canvas_attach_media` 把已经生成好的文件（如 dsh-media 存在 `media/` 的图片，或工作区里别处的图片、视频、音频）放进指定节点，不重复生成。
- **剪辑台** `timeline_query` `timeline_edit`：读剪辑（版本号、各轨道片段）、画布可用的素材和剧本、影片和工作区的素材文件；按版本号放素材（工作区里的文件先放进影片）、放台词字幕和音效配乐、换镜头的候选版本，或执行原始命令。
- **原声字幕** `timeline_transcribe` `timeline_apply_captions` `media_get_task` `media_cancel_task`：识别剪辑里的原声对白，后台任务产出待审的字幕草稿（按句分页读），审过后先 dryRun 再写入，只改识别范围内的字幕，人工和已审过的字幕不动。识别用剪辑台自带的 Whisper：免费、不出本机，在打开的 VibeDev/DSH 窗口里的隐藏页面运行，需同意下载模型。`timeline_query` 的 `caption-tasks` 列出最近的识别和是否已写入。
- **渲染** `timeline_render`：先 `check` 看能不能渲、出什么样的文件，再按版本号在本机把剪辑渲染成 MP4（见下文“后台渲染”），最多等 4 分钟，没完成就交回任务号接着等或取消。
- **导演组（按需）** `director_query` `director_stage` `director_render` `director_render_status` `director_render_cancel` `director_inspect_model` `director_review` `director_compile_motion` `director_modeling_brief`：读导演台场景（结构、采样、事件、诊断、动作），按指纹分步调度（先 dryRun），编译动作，管理审阅版本。查询和调度在导演标签关着时作用于保存的节点，开着时作用于桌面上的实时场景；渲染、检视模型和审阅版本要导演标签开着。后台无头渲染暂未接入。
- **建模组（按需）** `space_plan_compile` `model_brief` `model_review` `model_adopt` `model_status` `model_report` `model_cancel`：按毫米写平面，编译成 `film/spaces/` 下导演台能打开的 GLB（先 dryRun 看尺寸、警告和楼梯可达性）；为程序化模型准备建模任务，读 `film/models/<id>/model.json` 里的记录、写审阅、记录用户采用的版本。运行模型、拍检查图、导出和回读 GLB 需要无头浏览器，暂未接入。

工具名和参数沿用 VibeDev Studio 的影视工具；工作区就是项目，所以不再需要 `project` 参数。

Every conversation has `film_project` (read or start the workspace's film — opening a film tab also starts it — or rename it and change its frame with `update`). Conversations in a film workspace also carry 35 screenplay, storyboard, cut, caption and render tools, `film_tools` and guidance; the director desk's and the modeling tools are groups taken on when needed (the director group starts enabled when the board has a director node). All of them go through the same API as the workbench's pages. With the storyboard open, board edits run in the page (live and undoable); with it closed they are saved to the board, and running a generation needs the page.

### 编剧技能 · Screenwriting skill

插件随包带一个技能 `film-screenwriting`（编剧，`skills/film-screenwriting/`），通过 DSH 的技能服务登记，每个会话的技能目录里都有它，也可以用 `/film-screenwriting` 直接调用。它写给上面的 `story_*` 工具：怎样找到和保存剧本（先预览再保存、冲突时重读）、场景/动作/对白的写法和自检、竖屏短剧与单集、剧本诊断（证据、严重程度、哪些不算套路），以及交给分镜和剪辑。操作示例都经过测试，能直接用。没有技能服务的配置照常加载插件。

The plugin ships the `film-screenwriting` skill (`skills/film-screenwriting/`), registered with DSH's skill registry: listed in every conversation's skill catalog and invocable as `/film-screenwriting`. It covers finding and saving screenplays with the `story_*` tools, scene, action and dialogue craft with self-checks, short-form and episodes, evidence-based diagnosis, and handoff to the storyboard and the cut; its example batches are tested against the screenplay contracts.

## 剪辑台的 AI 模型 · Editor models

配音、人声分离、抠像、景深、擦除、超分、数字人和字幕字体要用到本地模型。模型不打进插件包：剪辑台第一次要用某个模型时，先弹框说明用途、大小、许可和来源，同意后才由插件从 VibeDev 模型镜像下载，逐个文件核对大小和 SHA-256，存在 `$DSH_HOME/cache/dsh-film/video-editor-models/`（设置项 `modelsDir` 可改），以后直接用。同意记录在同一目录的 `consents.json`；字幕字体同属 OFL-1.1，可以一次同意全部。

可下载的模型列在 `models/video-editor-models.json`，由 `scripts/editor-models.mjs` 从 VibeDev Studio 的模型清单生成，只收许可清楚的：去掉了 Studio 标为受限的换脸模型（研究用权重）和 Stable Audio（Stability AI 社区许可，尚未确认）。各模型的许可以清单里声明的为准。

The editing desk downloads its models only after the person agrees, verifies every file's size and SHA-256, and keeps them once per machine; the list carries only models whose licence is clear.

## 原声字幕 · Original-audio captions

原声对白用剪辑台自带的 Whisper small（q8）加 Silero 语音检测识别：免费、不出本机，要先同意下载这两个模型。宿主没有浏览器，识别在打开的 VibeDev/DSH 窗口里的一个隐藏页面中运行（`apps/editor/caption-runner.html`）；没同意下载模型、或没有窗口开着时，会在建任务之前直接说明。

识别是后台任务（`film/.tasks/`），结果是待审草稿；写入剪辑前要按原声核对，只改识别范围内的字幕。

Captions are recognised by the editing desk's own Whisper small (q8) with Silero speech detection: free and local, after the person agrees to download both models. The Host has no browser, so recognition runs in a hidden page of an open VibeDev/DSH window; a recognition is a background task whose result is a draft to review before it reaches the cut.

## 后台渲染 · Background render

剪辑台的“渲染到项目”和 Agent 的 `timeline_render` 不开页面、在宿主里把剪辑渲染成 H.264 MP4：用剪辑台同一份上游渲染规划（`vendor/video-editor-bridge.mjs` 里的无头规划器）把剪辑变成 ffmpeg 参数，在本机的 ffmpeg 上跑，文件落在 `film/canvas/renders/`，并放到分镜画布上。接口与 VibeDev Studio 相同：`POST /api/canvas/timelines/:boardId/render`（`check: true` 只检查），进度和取消走影片任务的 `wait`/`cancel`；取消会结束 ffmpeg 进程树（落地时才取消的也不留文件和画布节点），一部片子同时只渲染一个；渲染期间若有别的文件占了预定的文件名，成片存成下一个空名字，不会覆盖。调色的剪辑很慢（约 20 倍实时），时间上限按帧数和画面大小放宽，最多 6 小时。

ffmpeg 按这个顺序找：设置项 `ffmpegPath`、环境变量 `DSH_FILM_FFMPEG_PATH`、同意后下载的渲染器、已安装的 VibeDev Studio 自带的、PATH、常见安装位置（winget、choco、scoop 等）。都没有时，Windows x64 上剪辑台会提出下载渲染器：VibeDev Studio 同款的 FFmpeg 9.0（BtbN/FFmpeg-Builds `ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-shared-9.0`，压缩包 86,333,540 字节，SHA-256 固定），弹框说明它是独立程序、GPL 许可、大小和来源，同意后先从 VibeDev 网关下载、再退到 GitHub 原发布，用 Windows 自带的 `tar.exe` 解压，只保留 ffmpeg.exe 和它要的 DLL，逐个核对大小和 SHA-256，旁边放 `LICENSE.txt` 和写明源码出处的 `SOURCE.txt`，存在模型目录下。清单在 `models/renderer.json`。

The background render plans the cut with the editor's own headless planner and runs it on this machine's ffmpeg, with no page open. FFmpeg is a separate program: the plugin runs it on the command line and never bundles it. On Windows x64 it can download the same pinned GPL build VibeDev Studio ships, only after the person agrees, verified file by file, with its licence and source note kept beside it.

## 开发 · Development

```bash
npm install
npm run typecheck
npm test
npm run build      # 先删掉 lib/ 和 client/，再构建 lib/（Host 一侧）和 client/（浏览器一侧）
```

从源码只能构建 `lib/` 和 `client/`。`apps/` 里的原版前端不在 git 里，要从相邻的三个检出另行构建：

| 检出 | 分支 | 说明 |
| --- | --- | --- |
| `../canvas` | `feat/dsh-host` | [vibedev-canvas](https://github.com/CrisLIUning/vibedev-canvas)，分镜画布；**私有仓库** |
| `../director-desk` | `feat/dsh-procedural-mannequin` | [vibedev-director-desk](https://github.com/CrisLIUning/vibedev-director-desk)，导演台；画布的构建会一起构建它 |
| `../video-editor` | `main` | [vibedev-video-editor](https://github.com/CrisLIUning/vibedev-video-editor)，剪辑台 |

`node scripts/build-apps.mjs canvas editor`（`npm run build:apps`）构建它们并复制到 `apps/canvas`、`apps/editor`，同时把剪辑台的桥接合约——Host 一侧执行时间线命令、规划渲染用的引擎——复制到 `vendor/video-editor-bridge.mjs`（这个文件在 git 里）。画布仓库是私有的，所以只有维护者能重新构建 `apps/`；其他人要完整的插件请安装发布的包。

构建 `apps/` 时，脚本先删掉 `scripts/app-excludes.mjs` 列出的文件（导演台的实验页、冒烟测试页和基准图片，以及 dsh-film 不打开的模型运行页和它的 three.js 工具链，约 10 MB；留下的文件若还引用其中某个就停下），再把来源仓库的许可证和 `THIRD-PARTY-NOTICES.txt` 写进各应用目录：后者列出应用打包可能含有的全部 npm 生产依赖（按 lockfile 里不带 `"dev": true` 的条目走完整闭包），每个都有版本、许可证、仓库和 node_modules 里 LICENSE/LICENCE/COPYING/NOTICE 的全文，没有许可证文件的会写明。剪辑台另有 `apps/editor/licenses/`：其中的 npm 包自己没带、但条款要求随附的许可证全文（LGPL-2.1、Apache-2.0、ONNX Runtime 的 MIT 和第三方声明、MediaPipe、OpenCV，原文存在本仓库的 `third-party/`，出处见其中的 README），Mediabunny 的 MPL-2.0，以及 libav.js 自编译版的构建记录；它的 `THIRD-PARTY-NOTICES.txt` 开头逐项说明 FFmpeg（LGPL）、Mediabunny（MPL）、ONNX Runtime、MediaPipe 和 OpenCV 的许可与源码出处；`ai-video-editor/MODEL_LICENSES.md` 里的相对链接改指包里的文件或固定版本的公开副本。只重写许可证和声明、不重建前端：`node scripts/build-apps.mjs notices canvas editor`（`npm run build:notices`），要在构建这些前端的检出上运行（只读它们的 lockfile 和 node_modules，不连网）；检出的 HEAD 与应用里 `component-build.json` 记录的提交不同时会警告。只删多余文件：`node scripts/build-apps.mjs trim canvas editor`。

浏览器端按 DSH 的模块加载格式打包：`client/client.js` 每次启动加载，只登记四个标签；工作台本体在 `client/client.workbench.js`，第一次打开标签时才加载。`scripts/check-client.mjs` 会检查打包结果（文件清单、加载器首行、只引用宿主提供的模块）。

**发布**：`npm pack` 和 `npm publish` 先跑 `prepack`——`npm run build`，再用 `scripts/check-package.mjs` 检查 `apps/canvas/index.html`、`apps/editor/index.html`、`apps/editor/caption-runner.html` 和下文列出的许可证、声明文件都在（包括 `apps/editor/licenses/` 和声明里的各节，`MODEL_LICENSES.md` 的链接都能在包里找到），该删的多余文件已删，`lib/` 里没有对不上源码的过期文件，`lib/` 和 `client/` 里没有构建机器的绝对路径，`apps/` 的代码和数据里没有 GPL-3.0 的 eSpeak NG（剪辑台的 VibeDev 构建关掉了带它的 Kokoro 英文配音和 vits-web 的 Piper 语音），缺一样就拒绝打包（没有 `apps/` 的包能装上，但画布和剪辑台两个标签是空的）。`publishConfig` 把发布固定到 npm 官方源，镜像源不接受发布。同一个 `dsh-film-<版本>.tgz` 附到 GitHub Release `v<版本>`。

Only `lib/` and `client/` build from this repository. `apps/` is built by `node scripts/build-apps.mjs canvas editor` from sibling checkouts — `../canvas` on `feat/dsh-host` (vibedev-canvas, a private repository, so only maintainers can rebuild `apps/`), `../director-desk` on `feat/dsh-procedural-mannequin`, and `../video-editor` (vibedev-video-editor) — and the same step removes the files `scripts/app-excludes.mjs` lists (the director desk's experiment and smoke-test pages, benchmark image, and the model-runtime page with its toolchain, about 10 MB) and writes each app's licences and `THIRD-PARTY-NOTICES.txt` (every production npm dependency the bundle can contain, with version, licence, repository and licence text; for the editor also `licenses/` with the texts its packages lack — kept in `third-party/` — and opening sections on FFmpeg under the LGPL, Mediabunny under the MPL, ONNX Runtime, MediaPipe and OpenCV). `node scripts/build-apps.mjs notices canvas editor` rewrites only those, warning when a checkout is not at the commit an app's `component-build.json` records; `trim` only removes the excluded files. `prepack` builds and then runs `scripts/check-package.mjs`, which refuses to pack without the apps, the licence and notice files, with excluded files present, with stale files in `lib/`, with build-machine paths in `lib/` or `client/`, or with GPL-3.0 eSpeak NG code in `apps/` (the editor's VibeDev build turns off the Kokoro English voices and the vits-web Piper voices that carry it). `publishConfig` sends `npm publish` to the npm registry.

## 许可 · License

本插件以 MIT 许可证发布，见 `LICENSE`。包里还带着别人的代码，许可证和第三方声明放在这些地方：

- **导演台的场景数学**：`lib/director/vendor/director-math/`（源码在 `src/director/vendor/director-math/`）原样复制自 [vibedev-director-desk](https://github.com/CrisLIUning/vibedev-director-desk)，Copyright (c) 2026 YZ，MIT；许可证原文在包里的 `lib/director/vendor/director-math/LICENSE`。
- **分镜画布** `apps/canvas/`：vibedev-canvas，MIT，见 `apps/canvas/LICENSE`；其中的导演台 `apps/canvas/director-desk/` 来自 vibedev-director-desk（MIT，Copyright (c) 2026 YZ，见 `apps/canvas/director-desk/LICENSE`）。两者打包进去的 npm 依赖见 `apps/canvas/THIRD-PARTY-NOTICES.txt`；导演台自己的构建另带 `apps/canvas/director-desk/THIRD-PARTY-NOTICES.txt` 和 `licenses/`（Mediabunny，MPL-2.0）。
- **剪辑台** `apps/editor/`：vibedev-video-editor（MIT，`apps/editor/LICENSE`）和它内嵌的 ai-video-editor（MIT，`apps/editor/ai-video-editor/LICENSE`）。这两份 MIT 只管源码，模型和素材的许可边界见 `apps/editor/ai-video-editor/MODEL_LICENSES.md`。npm 依赖和 `vendor/` 下的第三方文件见 `apps/editor/THIRD-PARTY-NOTICES.txt`，它开头单独说明：两处 FFmpeg 代码（libav.js 自编译版和 `@mediabunny/aac-encoder` 里的 AAC 编码器）按 LGPL-2.1 或更高版本发布、源码在哪、怎样替换；Mediabunny（MPL-2.0）固定版本的源码包；ONNX Runtime、MediaPipe 和 OpenCV 的许可。这些组件自己没带的许可证全文在 `apps/editor/licenses/`。
- **剪辑台的桥接合约** `vendor/video-editor-bridge.mjs`：含 vibedev-video-editor 和 ai-video-editor 的代码，两份 MIT 许可证见 `vendor/video-editor-bridge.LICENSE.txt`。

声明文件逐个列出 npm 包时，带了 LICENSE 等文件的附上全文；有些包自己就没带许可证文件，声明里写明了，并给出它在 package.json 里声明的许可证（剪辑台用到的几项另在 `apps/editor/licenses/` 补了全文）。

后台渲染下载的 FFmpeg 是独立程序，不属于本插件，按 GNU GPL 2.0 或更高版本发布；源码见 https://git.ffmpeg.org/ffmpeg.git（提交 46d8f462ee，release/9.0 分支），构建脚本见 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)（autobuild-2026-10-01-13-06）。下载后其许可证全文在程序旁的 `LICENSE.txt`。剪辑台按需下载的模型各按清单 `models/video-editor-models.json` 里声明的许可。

dsh-film is MIT (`LICENSE`). The third-party code in the package and where its licences and notices are: the director desk's scene math (MIT, Copyright (c) 2026 YZ) at `lib/director/vendor/director-math/LICENSE`; the storyboard canvas and its director desk at `apps/canvas/LICENSE`, `apps/canvas/director-desk/LICENSE` and `apps/canvas/THIRD-PARTY-NOTICES.txt` (the desk's own build adds notices in `apps/canvas/director-desk/`); the editing desk at `apps/editor/LICENSE`, `apps/editor/ai-video-editor/LICENSE`, `apps/editor/ai-video-editor/MODEL_LICENSES.md` and `apps/editor/THIRD-PARTY-NOTICES.txt`, which opens with the editor's FFmpeg code under LGPL-2.1-or-later (the custom libav.js build and the AAC encoder in `@mediabunny/aac-encoder`: sources and how to replace them), Mediabunny's MPL-2.0 source tarballs, and ONNX Runtime, MediaPipe and OpenCV, with the licence texts those components lack in `apps/editor/licenses/`; the editor bridge at `vendor/video-editor-bridge.LICENSE.txt`. The notices list every npm package with the licence files it ships; packages that ship none are marked as such, with the licence their package.json declares. The FFmpeg the background render can download is a separate GPL program, not part of this plugin; its licence is kept beside it.
