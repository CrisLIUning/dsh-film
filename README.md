# dsh-film · VibeDev 影视工作台

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 VibeDev 里做片：聊天右侧的侧栏多出四个标签——**剧本、分镜画布、剪辑台、导演台**。左边和 Agent 聊，右边看和改成果。项目是工作区里 `film/` 下的普通文件，Agent 用文件工具也能读写。

> 现在是 0.0.x 预览版。分镜画布（含导演台）和剪辑台用的是 VibeDev 的原版前端，跑在插件自己的接口上；剧本标签是按 DSH 界面重写的，文件格式与 VibeDev Studio 的编剧台相同。图片、视频的生成由 [dsh-media](https://github.com/CrisLIUning/dsh-media) 负责，剪辑台的编辑器来自 [vibedev-video-editor](https://github.com/CrisLIUning/vibedev-video-editor)。

A film workbench for DeepSeek Harness and VibeDev: four right-sidebar tabs — script, storyboard, editing desk and director desk — working on one film per workspace, kept as plain files under `film/`. In this 0.0.x preview the storyboard (with the director desk) and the editing desk are VibeDev's original front ends running on the plugin's own API; the script tab is still to come.

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

## 剪辑台的 AI 模型 · Editor models

配音、人声分离、抠像、景深、擦除、超分、数字人和字幕字体要用到本地模型。模型不打进插件包：剪辑台第一次要用某个模型时，先弹框说明用途、大小、许可和来源，同意后才由插件从 VibeDev 模型镜像下载，逐个文件核对大小和 SHA-256，存在 `$DSH_HOME/cache/dsh-film/video-editor-models/`（设置项 `modelsDir` 可改），以后直接用。同意记录在同一目录的 `consents.json`；字幕字体同属 OFL-1.1，可以一次同意全部。

可下载的模型列在 `models/video-editor-models.json`，由 `scripts/editor-models.mjs` 从 VibeDev Studio 的模型清单生成，只收许可清楚的：去掉了 Studio 标为受限的换脸模型（研究用权重）和 Stable Audio（Stability AI 社区许可，尚未确认）。各模型的许可以清单里声明的为准。

The editing desk downloads its models only after the person agrees, verifies every file's size and SHA-256, and keeps them once per machine; the list carries only models whose licence is clear.

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
