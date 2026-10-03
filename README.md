# dsh-film · VibeDev 影视工作台

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 VibeDev 里做片：聊天右侧的侧栏多出四个标签——**剧本、分镜画布、剪辑台、导演台**。左边和 Agent 聊，右边看和改成果。项目是工作区里 `film/` 下的普通文件，Agent 用文件工具也能读写。

> 现在是 0.0.x 预览版，只有骨架：新建项目、四个标签、素材列表和视频预览。剧本、分镜画布、剪辑台、导演台会逐个补上。图片、视频、音乐的生成由 [dsh-media](https://github.com/CrisLIUning/dsh-media) 负责。

A film workbench for DeepSeek Harness and VibeDev: four right-sidebar tabs — script, storyboard, editing desk and director desk — working on one film per workspace, kept as plain files under `film/`. This 0.0.x preview ships the skeleton only.

## 安装 · Install

- **VibeDev**：在设置的插件页安装 `dsh-film`。
- **DeepSeek Harness 命令行**：`dsh plugin add dsh-film`。
- **DeepSeek Harness 桌面版**：先完全退出桌面版，再运行 `dsh plugin --profile desktop add dsh-film`。

装好后打开任意会话的右侧侧栏，在“开始”页点“剧本”等入口。会话需要有工作区。

In VibeDev, install `dsh-film` from the plugin page in settings. In DeepSeek Harness, run `dsh plugin add dsh-film`, or `dsh plugin --profile desktop add dsh-film` for the desktop app (quit it fully first). Then open the right sidebar of a session that has a workspace and pick a part on its start page.

## 文件 · Files

```
<workspace>/
  film/film.json   项目信息：片名、画幅（format vibedev.film, version 1）
  media/           dsh-media 生成的素材，素材列表也会列出 film/ 里的媒体
```

一个工作区放一部片。已有的 `film/film.json` 不会被覆盖。

## 开发 · Development

```bash
npm install
npm run typecheck
npm test
npm run build      # lib/ (Host half) + client/ (browser half)
```

浏览器端按 DSH 的模块加载格式打包：`client/client.js` 每次启动加载，只登记四个标签；工作台本体在 `client/client.workbench.js`，第一次打开标签时才加载。`scripts/check-client.mjs` 会检查打包结果（文件清单、加载器首行、只引用宿主提供的模块）。

## License

MIT
