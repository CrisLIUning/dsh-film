# dsh-film · VibeDev 影视工作台

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 VibeDev 里做片：聊天右侧的侧栏多出三个标签——**剧本、分镜画布、导演台**。左边和 Agent 聊，右边看和改成果。项目是工作区里 `film/` 下的普通文件；Agent 用专门的影视工具改剧本和分镜、调度导演台（见下），和右边看到的是同一份。

> 0.2 仍属预览。分镜画布（含导演台）用的是 VibeDev 的原版前端，跑在插件自己的接口上；剧本标签是按 DSH 界面重写的，文件格式与 VibeDev Studio 的编剧台相同。图片、视频的生成由可选的 [dsh-media](https://github.com/CrisLIUning/dsh-media) 插件负责。

A film workbench for DeepSeek Harness and VibeDev: three right-sidebar tabs — script, storyboard and director desk — working on one film per workspace, kept as plain files under `film/`. In this 0.2 preview, the storyboard (with the director desk) is VibeDev's original front end running on the plugin's own API, and the script tab is a DSH-native rewrite. The agent works on the same film through its own film tools.

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
https://github.com/CrisLIUning/dsh-film/releases/download/v0.2.0/dsh-film-0.2.0.tgz
```

直链不经过安装源，需要本机能直接访问 GitHub（或配好代理）。包约 3 MB。网速很慢时仍可能超过 pnpm 默认的 60 秒下载时限而失败：这时改为按包名从中国大陆镜像源安装；也可以把时限调长：pnpm 11（DeepSeek Harness 和 VibeDev 桌面版自带的就是它）不再从 `~/.npmrc` 读取这个设置，要在 pnpm 的全局配置 `config.yaml` 里加一行 `fetchTimeout: 600000`（Windows：`%LOCALAPPDATA%\pnpm\config\config.yaml`；macOS：`~/Library/Preferences/pnpm/config.yaml`；Linux：`~/.config/pnpm/config.yaml`），或设环境变量 `pnpm_config_fetch_timeout=600000`；pnpm 10 及更早的版本则在 `~/.npmrc` 里加 `fetch-timeout=600000`。

**刚发布的版本**：pnpm 11 默认只安装发布满一天的版本（`minimumReleaseAge`）。第一个版本不受影响：按包名安装一个此前没有任何版本的包时，pnpm 照样装上它，并把它记进 `minimumReleaseAgeExclude`。之后每次发布新版本，头一天按包名安装得到的是上一个版本；要马上装新版本，按确切版本安装（包名写成 `dsh-film@<版本>`），或者用上面的 Release 直链。

**不能从 Git 仓库安装**：不要在插件页填仓库地址 `https://github.com/CrisLIUning/dsh-film`，也不要对它运行 `dsh plugin add`。`lib/`、`client/` 和 `apps/`（分镜画布和导演台的前端）都是构建产物，不在 git 里，从仓库安装会失败（不会留下装了却用不了的插件）。

**dsh-media 是可选的**：只有在分镜画布里生成图片和视频才需要另装 [dsh-media](https://github.com/CrisLIUning/dsh-media)（包名 `dsh-media`，装法相同；走 VibeDev 网关，按用量从 VibeDev 余额扣费）。不装也能写剧本、排分镜和调度导演台。分镜画布给每个视频模型列出的模式与 dsh-media 实际接受的一致：声明不收首帧的线路（Seedance 2.5（VibeDev）、2.5 30s（VibeDev）、2.5 480p 30s（山海）和三条 lec 线路；Seedance 2.5 特价按次收首帧，仍有图生视频）不显示“图生视频”，接一张图时改走“全能参考”，图作为参考图发送；以前保存成“图生视频”的节点在这些线路上也按全能参考生成。

装好后打开任意会话的右侧侧栏，在“开始”页点“剧本”等入口。会话需要有工作区。第一次打开任一影视标签时，插件自动在工作区里建好影片（片名取工作区文件夹名，画幅 16:9，连同一张空白分镜画布），不用填表。片名和画幅在三个标签共用的标题栏里改：点片名直接改（最多 80 字，回车或点别处保存，Esc 取消）；画幅是这部片子的画面比例，分镜画布和导演台都按它来，菜单里有 16:9、9:16、1:1、4:5、21:9、2.39:1。0.1.0 建的 4:3 影片照旧保留并显示为 4:3。

**升级**：按上面的方法直接安装新版本即可，会覆盖旧版本，不用先卸载。装好后要重启 DeepSeek Harness / VibeDev，新版本才会生效；重启之前，影视工作台顶部会显示提示横幅，分镜画布和导演台也先不打开。影片是工作区里 `film/` 下的文件，升级和卸载插件都不会动它们。

Requires DeepSeek Harness 0.2.x or VibeDev (VibeDev Next), which is built on it. The plugin is published to npm as `dsh-film`; the npmmirror China mirror syncs from npm.

- **Plugin page** (recommended): Plugins → Add plugin → install a third-party plugin by package name, enter `dsh-film`, pick the npm registry or the China mirror under the install source, and install.
- **Command line**: for the DeepSeek Harness desktop app, quit it fully, then run `dsh plugin --profile desktop add dsh-film` (the `dsh` command is installed from the app menu). VibeDev Next's command is `vibedev-app` (app menu → Manage vibedev-app Command…): quit the app fully, then run `vibedev-app plugin --profile desktop add dsh-film`; it keeps its data in `~/.vibedev-app`, which `dsh` does not reach. With the npm `dsh` CLI, run `dsh plugin add dsh-film`.
- **GitHub Release**: the plugin page and the commands also take the release asset URL, e.g. `https://github.com/CrisLIUning/dsh-film/releases/download/v0.2.0/dsh-film-0.2.0.tgz`. It is fetched straight from GitHub, not through a registry. The file is about 3 MB; if a very slow connection still hits pnpm's default 60-second fetch timeout, install by name from the mirror instead, or raise the timeout — pnpm 11 (the one the desktop apps ship) no longer reads it from `~/.npmrc`, so add `fetchTimeout: 600000` to pnpm's global `config.yaml` (Windows `%LOCALAPPDATA%\pnpm\config\config.yaml`, macOS `~/Library/Preferences/pnpm/config.yaml`, Linux `~/.config/pnpm/config.yaml`) or set `pnpm_config_fetch_timeout=600000`; pnpm 10 and earlier take `fetch-timeout=600000` in `~/.npmrc`.
- **A fresh release**: pnpm 11 installs only versions published at least a day ago (`minimumReleaseAge`). The very first version is not held back: installing by name a package with no earlier version installs it and adds it to `minimumReleaseAgeExclude`. After each later release, an install by name gets the previous version for a day; to get the new one at once, install the exact version (`dsh-film@<version>`) or use the release URL.
- **Not from the git repository**: `lib/`, `client/` and `apps/` (the storyboard and director desk front ends) are build outputs that are not in git, so installing from the repository URL fails (it does not leave a plugin that cannot work).
- **dsh-media is optional**: only image and video generation on the storyboard needs [dsh-media](https://github.com/CrisLIUning/dsh-media). Everything else works without it. The storyboard lists for each video model the modes dsh-media accepts: lanes that declare no first frame (Seedance 2.5 (VibeDev), 2.5 30s (VibeDev), 2.5 480p 30s (山海) and the three lec lanes; Seedance 2.5 特价按次 takes a first frame and keeps image-to-video) offer no image-to-video, and a single image goes as a 全能参考 (multi-reference) reference image instead, also for nodes saved as image-to-video earlier.

Then open the right sidebar of a session that has a workspace and pick a part on its start page. The first time a film tab opens, the plugin creates the film — named after the workspace folder, 16:9, with an empty storyboard — with no form to fill in. Rename it and pick its frame in the header the three tabs share: click the title to edit it (up to 80 characters; Enter or clicking away saves, Esc cancels); the frame is the film's aspect ratio, which the storyboard canvas and the director desk use (16:9, 9:16, 1:1, 4:5, 21:9, 2.39:1). A 4:3 film made by 0.1.0 keeps and shows its frame. To upgrade, install the new version over the old one (no need to uninstall first), then restart DeepSeek Harness / VibeDev: until you do, the workbench shows a banner asking for the restart and does not open the storyboard or the director desk. Your film stays in the workspace's `film/` folder either way.

### 0.2.0 版本说明 · 0.2.0 release note

- **剪辑台已移除**：0.2.0 起影视工作台只有剧本、分镜画布和导演台三个标签，Agent 也不再带剪辑、字幕识别和渲染的工具（常驻工具从 35 个减到 30 个），插件包从约 38 MB 缩到约 3 MB。旧会话里还开着的剪辑台标签会显示 DSH 自带的“不可用”提示，关掉即可。
- **你的文件都还在**：插件不删也不改 0.1 留下的 `film/canvas/timeline.json`（剪辑和撤销历史）和 `film/canvas/renders/`（导出的成片）；旧成片照旧出现在分镜画布的素材库里，`film/.tasks/` 里旧的识别和渲染任务也照旧能读（显示为已中断或已结束）。
- **模型缓存可以手动删**：0.1 剪辑台同意后下载的模型和渲染器在 `$DSH_HOME/cache/dsh-film/video-editor-models/`（可能有几百 MB）。插件不会自己删它；不再需要时可以手动删掉这个文件夹。
- **旧设置不影响加载**：插件设置里 0.1 的 `modelsDir` 和 `ffmpegPath` 两项不再使用，留在配置里也能正常加载。

- **The editing desk is gone**: from 0.2.0 the workbench has three tabs (script, storyboard, director desk), the agent no longer carries the cut, recognition and render tools (30 core tools instead of 35), and the package shrinks from about 38 MB to about 3 MB. An editing-desk tab still open from an older session shows DSH's own "unavailable" placeholder; close it.
- **Your files stay**: the plugin neither deletes nor changes `film/canvas/timeline.json` (0.1's cut and its undo history) or `film/canvas/renders/` (its exported films); old renders still appear in the storyboard's library, and old recognition and render tasks in `film/.tasks/` still read (as interrupted or finished).
- **The model cache can be deleted by hand**: the models and the renderer 0.1's editing desk downloaded with your consent are in `$DSH_HOME/cache/dsh-film/video-editor-models/` (possibly hundreds of MB). The plugin never deletes it; remove the folder yourself when you no longer need it.
- **Old settings still load**: 0.1's `modelsDir` and `ffmpegPath` settings are no longer used, and a profile that still holds them loads normally.

## 文件 · Files

```
<workspace>/
  film/film.json             项目信息：片名、画幅（format vibedev.film, version 1）
  film/story/<id>.md         剧本：正文是 Markdown，场次、镜头、人物等记在隐藏的结构标记里
  film/canvas/document.json  分镜画布
  film/canvas/media/         生成、导入的素材
  film/canvas/models/        从工作区导入的模型（GLB、FBX、OBJ）
  film/canvas/imports.json   从工作区导入过的文件（没改过的不再列为可导入）
  media/                     dsh-media 生成的素材；和工作区里其他素材一样，用到时放进 film/
```

一个工作区放一部片。已有的 `film/film.json` 不会被覆盖；建影片时已有的画布（哪怕读不出来）不会被覆盖，工作区里原有的画布会沿用它的 id。删除画布留下的记录只挡住被删的那块画布：删掉影片后再建的新片有新 id，照常带上自己的空白画布。工作区在隐藏文件夹（名字以 `.` 开头）或 `.ssh`、`.aws` 等凭据文件夹里时不建片，也不播放、不导入那里的素材。

工作区里 `film/` 以外的图片、视频和音频都算素材：分镜画布的素材库会列出它们。隐藏的文件和文件夹、`node_modules`、构建输出和缓存之类的生成目录、`.ssh` 等凭据目录和链接不列；文件太多时只读一部分（最多 2000 个素材、12 层目录），并标明列表不完整。用到时插件把文件复制进 `film/canvas/media/`（文件系统支持时用写时复制的克隆，不占额外空间；从不硬链接，所以之后在别处改了原文件，片里的那份不跟着变），同样的字节只放一份；导入过、之后没改过的文件不再出现在分镜画布的可导入列表里。

Media anywhere in the workspace outside `film/` is material: the storyboard's library shows it (hidden entries, `node_modules`, build and cache folders, credential folders and links are skipped; a very large workspace is listed in part, and the list says so). A file is copied into `film/canvas/media/` when used (as a copy-on-write clone where the file system supports it; never a hard link, so editing the original elsewhere later leaves the film's copy as it was), the same bytes only once; an imported file that has not changed since is no longer offered for import by the storyboard. A workspace inside a hidden folder (a name starting with `.`) or a credential folder such as `.ssh` gets no film, and its media is neither played nor imported.

## Agent 的影视工具 · Agent tools

每个会话都有 `film_project`：查看工作区的影片项目，在用户要做片时新建一个（用户打开影视标签时也会自动建好），或改片名和画幅（`update`）。工作区有影片项目的会话还会常驻 30 个工具、`film_tools` 和一段说明（没有影片的会话不带它们；新建项目后从下一步起就有）。导演台和建模两组工具按需加载：画板上有导演台节点时自动带上导演组，其余由 Agent 用 `film_tools` 开启，不用时不占 token。

- **剧本** `story_query` `story_asset_bindings` `story_create` `story_apply_ops` `story_history` `story_checkpoint` `story_restore` `story_revert`：和剧本标签用同一套接口，按保存的版本号写入（先 dryRun 预览），每次写入都有版本和操作记录，可以单独撤回某次操作。`story_asset_bindings` 给人物、地点、道具和镜头绑定参考图（只认选中的那份字节，五种解析结果分开报告），工作区里 `film/` 以外的图片先放进影片再绑定。
- **导入导出** `story_import` `story_export`：先预览再导入为新副本（从不覆盖）；导出完整 Markdown、仅正文，或连同参考图打成素材包存到 `film/story-exports/`。
- **剧本到分镜** `story_source` `story_handoff` `story_adopt` `story_impact` `story_director_links`：把保存的人物、场景、道具、场次或镜头读成制作素材，送到画布成为独立的剧本来源卡（可同时准备一个连好线、只待确认提示词的图片节点，不会自动生成）；按节点保存的字段显式采用描述或参考图（参考图另存一份字节快照）；剧本改动后查看影响了哪些采用、产物和导演镜头；给导演台已保存的机位记下剧本来源。分镜标签不开也能用。
- **分镜画布** `canvas_list_clients` `canvas_get_state` `canvas_get_selection` `canvas_read_node` `canvas_get_generation_status` `canvas_get_document` `canvas_create_text_nodes` `canvas_create_generation_flow` `canvas_run_generation` `canvas_connect_nodes` `canvas_delete_nodes` `canvas_apply_ops` `canvas_attach_media`：分镜标签开着时，改动交给页面执行，用户看着它出现，也能撤销；没开时，改动写进保存的画布，下次打开就在。运行生成要分镜页开着。`canvas_attach_media` 把已经生成好的文件（如 dsh-media 存在 `media/` 的图片，或工作区里别处的图片、视频、音频）放进指定节点，不重复生成。
- **影片任务** `media_get_task` `media_cancel_task`：读取或取消分镜画布的生成任务（`canvas_get_generation_status` 在 `outputs[].task` 里给出的任务号）。
- **导演组（按需）** `director_query` `director_models` `director_stage` `director_render` `director_render_status` `director_render_cancel` `director_inspect_model` `director_review` `director_compile_motion` `director_modeling_brief`：读导演台场景（结构、采样、事件、诊断、动作），列出能用的模型文件和尺寸，按指纹分步调度（先 dryRun；`place_model` 按真实尺寸放入模型，见下文“导演台里的模型”），编译动作，管理审阅版本（审阅版只能交给画布生成）。查询和调度在导演标签关着时作用于保存的节点，开着时作用于桌面上的实时场景；渲染、检视模型和审阅版本要导演标签开着。后台无头渲染暂未接入。
- **建模组（按需）** `space_plan_compile` `model_brief` `model_review` `model_adopt` `model_status` `model_report` `model_cancel`：按毫米写平面，编译成 `film/spaces/` 下导演台能打开的 GLB（先 dryRun 看尺寸、警告和楼梯可达性）；为程序化模型准备建模任务，读 `film/models/<id>/model.json` 里的记录、写审阅、记录用户采用的版本。运行模型、拍检查图、导出和回读 GLB 需要无头浏览器，暂未接入。

工具名和参数沿用 VibeDev Studio 的影视工具；工作区就是项目，所以不再需要 `project` 参数。

Every conversation has `film_project` (read or start the workspace's film — opening a film tab also starts it — or rename it and change its frame with `update`). Conversations in a film workspace also carry 30 screenplay, storyboard and film-task tools, `film_tools` and guidance; the director desk's and the modeling tools are groups taken on when needed (the director group starts enabled when the board has a director node). All of them go through the same API as the workbench's pages. With the storyboard open, board edits run in the page (live and undoable); with it closed they are saved to the board, and running a generation needs the page.

### 编剧技能 · Screenwriting skill

插件随包带一个技能 `film-screenwriting`（编剧，`skills/film-screenwriting/`），通过 DSH 的技能服务登记，每个会话的技能目录里都有它，也可以用 `/film-screenwriting` 直接调用。它写给上面的 `story_*` 工具：怎样找到和保存剧本（先预览再保存、冲突时重读）、场景/动作/对白的写法和自检、竖屏短剧与单集、剧本诊断（证据、严重程度、哪些不算套路），以及交给分镜。操作示例都经过测试，能直接用。没有技能服务的配置照常加载插件。

The plugin ships the `film-screenwriting` skill (`skills/film-screenwriting/`), registered with DSH's skill registry: listed in every conversation's skill catalog and invocable as `/film-screenwriting`. It covers finding and saving screenplays with the `story_*` tools, scene, action and dialogue craft with self-checks, short-form and episodes, evidence-based diagnosis, and handoff to the storyboard; its example batches are tested against the screenplay contracts.

## 导演台里的模型 · Models in the director desk

工作区里（`film/` 以外）和 `film/` 下的 GLB、FBX、OBJ 文件都会出现在导演台的空间库里，并标出尺寸。点一下工作区里的文件，会先把它复制到 `film/canvas/models/`（同样的字节再点只用已有的那份，工作区里的原文件之后再改也不影响影片里的副本），再按真实尺寸放进场景：GLB 按米，FBX 按文件自己声明的单位（UnitScaleFactor），OBJ 不带单位，按导入面板里选的单位（面板会按尺寸给一个建议，可以改）。`.gltf` 的 `.bin` 和贴图是单独的文件，不能这样导入，请先转成 GLB。`film/motions/` 下编译出来的动作片段不算模型，不会列出。

Agent 这边：`director_models` 列出影片和工作区里的模型，带格式、用途（`film/spaces/` 下的是场景空间）、能否放置、建议的类型、包围盒和已知单位时的米制尺寸；`director_stage` 的 `place_model` 按真实尺寸放入一个模型——它替 Agent 算好 SHA-256、量好尺寸、写好校准，dryRun 不复制文件，应用时才复制到 `film/canvas/models/`。单位依次取 `metresPerUnit`、`size`（例如 `{ height: 1.8 }`，按量出的包围盒换算）和文件自带的单位；OBJ 两者都没给时拒绝，并报出原始尺寸。带骨架的人物不经 `place_model`，要在导演标签的空间库里导入（导演台要检查骨架）。

GLB, FBX and OBJ files in the workspace (outside `film/`) and in `film/` appear in the director desk's 空间库 with their size. Clicking a workspace file copies it into `film/canvas/models/` (the same bytes again reuse that copy, and later edits to the workspace file leave the film's copy alone) and places it at real size: a GLB in metres, an FBX by the unit the file declares (UnitScaleFactor), an OBJ — which carries no unit — by the unit chosen in the import panel (it suggests one from the size; you can change it). A `.gltf` keeps its `.bin` and textures in separate files and cannot be imported this way: convert it to GLB first. Compiled motion clips under `film/motions/` are not models and are not listed. For the agent, `director_models` lists the film's and the workspace's models with format, role (`film/spaces/` holds sets), whether they can be placed, a suggested kind, the bounding box and, with known units, the size in metres; `director_stage`'s `place_model` op places one at real size, hashing, measuring and calibrating it for the agent. A dry run copies nothing; the apply copies a workspace file into `film/canvas/models/`. Units come from `metresPerUnit`, else `size` (for example `{ height: 1.8 }`, against the measured box), else the file's own; an OBJ with neither is refused with its raw size. Rigged characters are imported in the director tab's 空间库, not with `place_model`.

## 开发 · Development

```bash
npm install
npm run typecheck
npm test
npm run build      # 先删掉 lib/ 和 client/，再构建 lib/（Host 一侧）和 client/（浏览器一侧）
```

从源码只能构建 `lib/` 和 `client/`。`apps/` 里的原版前端不在 git 里，要从相邻的两个检出另行构建：

| 检出 | 分支 | 说明 |
| --- | --- | --- |
| `../canvas` | `feat/dsh-host` | vibedev-canvas，分镜画布；**私有仓库** |
| `../director-desk` | `feat/dsh-procedural-mannequin` | vibedev-director-desk，导演台；**私有仓库**；画布的构建会一起构建它 |

`node scripts/build-apps.mjs canvas`（`npm run build:apps`）构建它们并复制到 `apps/canvas`。画布和导演台的仓库是私有的，所以只有维护者能重新构建 `apps/`；其他人要完整的插件请安装发布的包。脚本只替换它构建的 `apps/canvas`：从 0.1 升上来的检出要手动删掉旧的 `apps/` 下其他文件夹，否则打包检查会拒绝。

构建 `apps/` 时，脚本先删掉 `scripts/app-excludes.mjs` 列出的文件（导演台的实验页、冒烟测试页和基准图片，以及 dsh-film 不打开的模型运行页和它的 three.js 工具链，约 10 MB；留下的文件若还引用其中某个就停下），再把来源仓库的许可证和 `THIRD-PARTY-NOTICES.txt` 写进应用目录：后者列出应用打包可能含有的全部 npm 生产依赖（按 lockfile 里不带 `"dev": true` 的条目走完整闭包），每个都有版本、许可证、仓库和 node_modules 里 LICENSE/LICENCE/COPYING/NOTICE 的全文，没有许可证文件的会写明。只重写许可证和声明、不重建前端：`node scripts/build-apps.mjs notices canvas`（`npm run build:notices`），要在构建这些前端的检出上运行（只读它们的 lockfile 和 node_modules，不连网）；检出的 HEAD 与应用里 `component-build.json` 记录的提交不同时会警告。只删多余文件：`node scripts/build-apps.mjs trim canvas`。

浏览器端按 DSH 的模块加载格式打包：`client/client.js` 每次启动加载，只登记三个标签；工作台本体在 `client/client.workbench.js`，第一次打开标签时才加载。`scripts/check-client.mjs` 会检查打包结果（文件清单、加载器首行、只引用宿主提供的模块）。

**发布**：`npm pack` 和 `npm publish` 先跑 `prepack`——`npm run build`，再用 `scripts/check-package.mjs` 检查 `apps/canvas/index.html` 和下文列出的许可证、声明文件都在（导演台带了 glTF 解码器时还要有 `apps/canvas/director-desk/licenses/Apache-2.0.txt`），`apps/` 下除了 `canvas` 没有别的东西、顶层没有 `vendor/` 和 `models/`，该删的多余文件已删，`lib/` 里没有对不上源码的过期文件，`lib/` 和 `client/` 里没有构建机器的绝对路径，缺一样就拒绝打包（没有 `apps/` 的包能装上，但画布和导演台两个标签是空的）。`publishConfig` 把发布固定到 npm 官方源，镜像源不接受发布。同一个 `dsh-film-<版本>.tgz` 附到 GitHub Release `v<版本>`。

Only `lib/` and `client/` build from this repository. `apps/` is built by `node scripts/build-apps.mjs canvas` from sibling checkouts — `../canvas` on `feat/dsh-host` (vibedev-canvas) and `../director-desk` on `feat/dsh-procedural-mannequin` (vibedev-director-desk); both are private repositories, so only maintainers can rebuild `apps/`. The script replaces only `apps/canvas`: a checkout that comes from 0.1 must delete the other folders under `apps/` by hand, or the package check refuses to pack. The same step removes the files `scripts/app-excludes.mjs` lists (the director desk's experiment and smoke-test pages, benchmark image, and the model-runtime page with its toolchain, about 10 MB) and writes the app's licences and `THIRD-PARTY-NOTICES.txt` (every production npm dependency the bundle can contain, with version, licence, repository and licence text). `node scripts/build-apps.mjs notices canvas` rewrites only those, warning when a checkout is not at the commit the app's `component-build.json` records; `trim` only removes the excluded files. `prepack` builds and then runs `scripts/check-package.mjs`, which refuses to pack without the app, the licence and notice files (with the Apache License beside the director desk's glTF decoders when it has them), with anything but `canvas` under `apps/`, with a top-level `vendor/` or `models/`, with excluded files present, with stale files in `lib/`, or with build-machine paths in `lib/` or `client/`. `publishConfig` sends `npm publish` to the npm registry.

## 许可 · License

本插件以 MIT 许可证发布，见 `LICENSE`。包里还带着别人的代码，许可证和第三方声明放在这些地方：

- **导演台的场景数学**：`lib/director/vendor/director-math/`（源码在 `src/director/vendor/director-math/`）原样复制自 vibedev-director-desk（源码仓库不公开），Copyright (c) 2026 YZ，MIT；许可证原文在包里的 `lib/director/vendor/director-math/LICENSE`。
- **分镜画布** `apps/canvas/`：vibedev-canvas，MIT，见 `apps/canvas/LICENSE`。它基于 basketikun 的 Infinite Canvas（MIT）；`apps/canvas/NOTICE` 列出它所基于或改编了代码的每个项目、各自的许可证或授权，以及由每个来源改编的文件（带出处提交）。其中的导演台 `apps/canvas/director-desk/` 来自 vibedev-director-desk（MIT，Copyright (c) 2026 YZ，见 `apps/canvas/director-desk/LICENSE`）。两者打包进去的 npm 依赖见 `apps/canvas/THIRD-PARTY-NOTICES.txt`；导演台自己的构建另带 `apps/canvas/director-desk/THIRD-PARTY-NOTICES.txt` 和 `licenses/`（Mediabunny，MPL-2.0）。

声明文件逐个列出 npm 包时，带了 LICENSE 等文件的附上全文；有些包自己就没带许可证文件，声明里写明了，并给出它在 package.json 里声明的许可证。

dsh-film is MIT (`LICENSE`). The third-party code in the package and where its licences and notices are: the director desk's scene math (MIT, Copyright (c) 2026 YZ) at `lib/director/vendor/director-math/LICENSE`; the storyboard canvas and its director desk at `apps/canvas/LICENSE`, `apps/canvas/NOTICE` (the canvas is based on Infinite Canvas by basketikun, MIT; the NOTICE names each project the canvas is based on or adapts code from, with the licence or permission it is used under, and lists each derived file with its source commit), `apps/canvas/director-desk/LICENSE` and `apps/canvas/THIRD-PARTY-NOTICES.txt` (the desk's own build adds notices in `apps/canvas/director-desk/`). The notices list every npm package with the licence files it ships; packages that ship none are marked as such, with the licence their package.json declares.
