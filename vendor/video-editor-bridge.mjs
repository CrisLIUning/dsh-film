// src/host-contract.ts
var VIDEO_EDITOR_CAPABILITIES = [
  "caption-font",
  "transcribe",
  "tts",
  "music",
  "repair",
  "restoration",
  "segmentation",
  "depth",
  "avatar",
  "face-swap",
  "auto-edit",
  "vocal-separation",
  "voice-conversion",
  "audio-extraction",
  "optical-flow"
];
function isVideoEditorCapabilityId(value) {
  return typeof value === "string" && VIDEO_EDITOR_CAPABILITIES.includes(value);
}
var HOST_PROJECT_ASPECTS = ["9:16", "16:9", "1:1", "4:5", "21:9", "2.39:1"];
var VideoEditorHostError = class extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "VideoEditorHostError";
    this.code = code;
    if (details !== void 0) this.details = details;
  }
};
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateVideoEditorCommandRequest(request, currentRevision) {
  if (!isJsonObject(request) || request.schemaVersion !== 1) {
    throw new VideoEditorHostError(
      "EDITOR_COMMAND_SCHEMA_UNSUPPORTED",
      "Video editor command schemaVersion must be 1"
    );
  }
  const operationId = request.operationId;
  if (typeof operationId !== "string" || operationId.trim().length === 0) {
    throw new VideoEditorHostError(
      "EDITOR_OPERATION_ID_REQUIRED",
      "Video editor command operationId is required"
    );
  }
  const baseRevision = request.baseRevision;
  if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new VideoEditorHostError(
      "EDITOR_REVISION_CONFLICT",
      "Video editor command baseRevision is invalid",
      { currentRevision }
    );
  }
  if (baseRevision !== currentRevision) {
    throw new VideoEditorHostError(
      "EDITOR_REVISION_CONFLICT",
      `Video editor revision ${String(baseRevision)} is stale; current revision is ${currentRevision}`,
      { baseRevision, currentRevision }
    );
  }
  if (!isJsonObject(request.command)) {
    throw new VideoEditorHostError(
      "EDITOR_COMMAND_INVALID",
      "Video editor command must be an object"
    );
  }
  return request;
}
function createVideoEditorMountManager(mountImplementation) {
  const mountedContainers = /* @__PURE__ */ new WeakMap();
  return {
    mount(container, options) {
      if (mountedContainers.has(container)) {
        throw new VideoEditorHostError(
          "EDITOR_ALREADY_MOUNTED",
          `Video editor host is already mounted: ${options.hostId}`
        );
      }
      const implementation = mountImplementation(container, options);
      let unmounted = false;
      const mounted = {
        // Whatever the implementation offers passes through; the entries below
        // only fill in what it left out. Listing the methods instead of
        // spreading is what once dropped `generateVoiceover` before it reached
        // the host, which then read every answer as "no such caption".
        ...implementation,
        updateDocument: implementation.updateDocument ?? (() => {
        }),
        resolveCommand: implementation.resolveCommand ?? (() => {
        }),
        notify: implementation.notify ?? (() => {
        }),
        generateVoiceover: implementation.generateVoiceover ?? (async () => ({ status: "missing" })),
        unmount() {
          if (unmounted) return;
          unmounted = true;
          try {
            implementation.unmount();
          } finally {
            mountedContainers.delete(container);
          }
        }
      };
      mountedContainers.set(container, mounted);
      return mounted;
    }
  };
}

// src/editor-host-environment.ts
var activeSurface = null;
function registerEditorHostEnvironment(surface) {
  if (activeSurface !== null) {
    throw new VideoEditorHostError(
      "EDITOR_ALREADY_MOUNTED",
      "Only one embedded Film editor environment may be active"
    );
  }
  activeSurface = surface;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (activeSurface === surface) activeSurface = null;
  };
}
function resolveEmbeddedEditorPortalTarget(fallback) {
  return activeSurface?.overlayRoot ?? fallback;
}
function setEmbeddedEditorLanguage(locale) {
  if (activeSurface === null) {
    document.documentElement.lang = locale;
    return;
  }
  activeSurface.mountPoint.lang = locale;
  activeSurface.overlayRoot.lang = locale;
}

// src/editor-lifecycle.ts
var CSS_CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/;
function pauseOwnedMedia(root) {
  for (const element of root.querySelectorAll("audio, video")) {
    try {
      element.pause();
    } catch {
    }
  }
}
function createEditorSurface(container, options) {
  if (container.shadowRoot !== null) {
    throw new VideoEditorHostError(
      "EDITOR_ALREADY_MOUNTED",
      "Video editor container already owns a shadow root"
    );
  }
  const previousRootMarker = container.dataset.vibedevVideoEditorRoot;
  const previousTheme = /* @__PURE__ */ new Map();
  const appliedThemeKeys = [];
  for (const [property, value] of Object.entries(options.theme)) {
    if (!CSS_CUSTOM_PROPERTY.test(property)) continue;
    previousTheme.set(property, {
      value: container.style.getPropertyValue(property),
      priority: container.style.getPropertyPriority(property)
    });
    container.style.setProperty(property, value);
    appliedThemeKeys.push(property);
  }
  container.dataset.vibedevVideoEditorRoot = "true";
  const shadowRoot = container.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.dataset.videoEditorStyles = "true";
  style.textContent = options.css;
  const mountPoint = document.createElement("div");
  mountPoint.dataset.videoEditorBody = "true";
  mountPoint.lang = options.locale;
  const overlayRoot = document.createElement("div");
  overlayRoot.dataset.videoEditorOverlayRoot = "true";
  overlayRoot.lang = options.locale;
  shadowRoot.append(style, mountPoint, overlayRoot);
  let disposed = false;
  return {
    shadowRoot,
    mountPoint,
    overlayRoot,
    dispose() {
      if (disposed) return;
      disposed = true;
      pauseOwnedMedia(shadowRoot);
      shadowRoot.replaceChildren();
      if (previousRootMarker === void 0) delete container.dataset.vibedevVideoEditorRoot;
      else container.dataset.vibedevVideoEditorRoot = previousRootMarker;
      for (const property of appliedThemeKeys) {
        const previous = previousTheme.get(property);
        if (!previous || previous.value === "") container.style.removeProperty(property);
        else container.style.setProperty(property, previous.value, previous.priority);
      }
    }
  };
}

// src/editor-runtime.ts
var EMBEDDED_LAYOUT_CSS = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  contain: layout paint style;
  color-scheme: var(--vibedev-editor-color-scheme, light);
  color: var(--vibedev-editor-text, #eef5f7);
  background: var(--vibedev-editor-background, #07090d);
}
:host-context(html[data-theme="dark"]) {
  --vibedev-editor-color-scheme: dark;
}
:host-context(html[data-theme="light"]) {
  --vibedev-editor-color-scheme: light;
}
[data-video-editor-body] {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container-name: vibedev-editor;
  container-type: size;
}
.app-shell {
  width: 100%;
  height: 100%;
  min-width: 0;
  color: var(--vibedev-editor-text, #eef5f7);
  background: var(--vibedev-editor-background, #090b0f) !important;
}
[data-video-editor-body] {
  color: var(--vibedev-editor-text, #eef5f7);
  background: var(--vibedev-editor-background, #07090d);
}
.topbar {
  color: var(--vibedev-editor-text, #eef5f7);
  border-color: var(--vibedev-editor-border, rgba(255,255,255,.08)) !important;
  background: var(--vibedev-editor-surface, #0e1117) !important;
}
[class*="panel"], [class*="dialog"], [class*="workspace"], [class*="inspector"] {
  border-color: var(--vibedev-editor-border, rgba(255,255,255,.08));
  background-color: var(--vibedev-editor-surface, #111820);
  color: var(--vibedev-editor-text, #eef5f7);
}
.transition-popover, .timeline-context-menu, .timeline-selection-menu, .popover {
  color: var(--vibedev-editor-text, #1a1916) !important;
  border-color: var(--vibedev-editor-border, #e1e5eb) !important;
  background: var(--vibedev-editor-elevated, #fffefc) !important;
  box-shadow: 0 14px 36px rgba(0, 0, 0, .24) !important;
}
button:focus-visible, [role="button"]:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline-color: var(--vibedev-editor-accent, #35ead9);
}
[data-video-editor-overlay-root] {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
}
[data-video-editor-overlay-root] > * {
  pointer-events: auto;
}
`;
function semanticHexColor(value) {
  const normalized = value.toLowerCase();
  const match = /^#([0-9a-f]{6})$/.exec(normalized);
  if (!match) return null;
  const encoded = match[1];
  const red = Number.parseInt(encoded.slice(0, 2), 16);
  const green = Number.parseInt(encoded.slice(2, 4), 16);
  const blue = Number.parseInt(encoded.slice(4, 6), 16);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
  if (maximum > 0 && maximum <= 12) {
    return `var(--vibedev-editor-background, ${normalized})`;
  }
  if (maximum <= 28) {
    return `var(--vibedev-editor-surface, ${normalized})`;
  }
  if (maximum <= 52 && red <= 44) {
    return `var(--vibedev-editor-elevated, ${normalized})`;
  }
  if (minimum >= 190 && saturation <= 0.22) {
    return `var(--vibedev-editor-text, ${normalized})`;
  }
  if (minimum >= 85 && maximum <= 190 && saturation <= 0.24) {
    return `var(--vibedev-editor-text-muted, ${normalized})`;
  }
  return null;
}
function themeUpstreamAccent(source) {
  const containerSized = source.replace(/(-?(?:\d+\.?\d*|\.\d+))d?vh\b/gi, "$1cqh").replace(/(-?(?:\d+\.?\d*|\.\d+))vw\b/gi, "$1cqw");
  const palette = /* @__PURE__ */ new Map([
    ["#07090d", "var(--vibedev-editor-background, #07090d)"],
    ["#080a0e", "var(--vibedev-editor-background, #080a0e)"],
    ["#090b0f", "var(--vibedev-editor-background, #090b0f)"],
    ["#0e1117", "var(--vibedev-editor-surface, #0e1117)"],
    ["#111820", "var(--vibedev-editor-surface, #111820)"],
    ["#11151b", "var(--vibedev-editor-surface, #11151b)"],
    ["#11161d", "var(--vibedev-editor-surface, #11161d)"],
    ["#121820", "var(--vibedev-editor-surface, #121820)"],
    ["#10151b", "var(--vibedev-editor-surface-muted, #10151b)"],
    ["#10141a", "var(--vibedev-editor-surface-muted, #10141a)"],
    ["#10161c", "var(--vibedev-editor-surface-muted, #10161c)"],
    ["#171b22", "var(--vibedev-editor-elevated, #171b22)"],
    ["#171d25", "var(--vibedev-editor-elevated, #171d25)"],
    ["#1b2028", "var(--vibedev-editor-elevated, #1b2028)"],
    ["#1c232c", "var(--vibedev-editor-elevated, #1c232c)"],
    ["#20252d", "var(--vibedev-editor-elevated, #20252d)"],
    ["#222831", "var(--vibedev-editor-elevated, #222831)"],
    ["#242629", "var(--vibedev-editor-elevated, #242629)"],
    ["#eef5f7", "var(--vibedev-editor-text, #eef5f7)"],
    ["#eef5f6", "var(--vibedev-editor-text, #eef5f6)"],
    ["#e9f2f4", "var(--vibedev-editor-text, #e9f2f4)"],
    ["#eafcff", "var(--vibedev-editor-text, #eafcff)"],
    ["#edf7f8", "var(--vibedev-editor-text, #edf7f8)"],
    ["#eef7f7", "var(--vibedev-editor-text, #eef7f7)"],
    ["#f0f7f8", "var(--vibedev-editor-text, #f0f7f8)"],
    ["#f1f8fa", "var(--vibedev-editor-text, #f1f8fa)"],
    ["#f4fbff", "var(--vibedev-editor-text, #f4fbff)"],
    ["#dce7ea", "var(--vibedev-editor-text, #dce7ea)"],
    ["#dce8eb", "var(--vibedev-editor-text, #dce8eb)"],
    ["#dce8ee", "var(--vibedev-editor-text, #dce8ee)"],
    ["#e2edf1", "var(--vibedev-editor-text, #e2edf1)"],
    ["#e4edef", "var(--vibedev-editor-text, #e4edef)"],
    ["#e6eef0", "var(--vibedev-editor-text, #e6eef0)"],
    ["#7f8d97", "var(--vibedev-editor-text-muted, #7f8d97)"],
    ["#7f8a95", "var(--vibedev-editor-text-muted, #7f8a95)"],
    ["#7f8b96", "var(--vibedev-editor-text-muted, #7f8b96)"],
    ["#82919b", "var(--vibedev-editor-text-muted, #82919b)"],
    ["#84929d", "var(--vibedev-editor-text-muted, #84929d)"],
    ["#8e9aa5", "var(--vibedev-editor-text-muted, #8e9aa5)"],
    ["#93a1ab", "var(--vibedev-editor-text-muted, #93a1ab)"],
    ["#98a3ad", "var(--vibedev-editor-text-muted, #98a3ad)"],
    ["#9aa6af", "var(--vibedev-editor-text-muted, #9aa6af)"],
    ["#9aa8b8", "var(--vibedev-editor-text-muted, #9aa8b8)"],
    ["#aeb8c2", "var(--vibedev-editor-text-muted, #aeb8c2)"],
    ["#aebbc3", "var(--vibedev-editor-text-muted, #aebbc3)"],
    ["#35ead9", "var(--vibedev-editor-accent, #35ead9)"],
    ["#35e9d6", "var(--vibedev-editor-accent, #35ead9)"],
    ["#45e8d8", "var(--vibedev-editor-accent, #35ead9)"],
    ["#45f5e4", "var(--vibedev-editor-accent, #35ead9)"],
    ["#26cfc0", "var(--vibedev-editor-accent, #35ead9)"],
    ["#66ddce", "var(--vibedev-editor-accent, #35ead9)"],
    ["#42eadb", "var(--vibedev-editor-accent, #35ead9)"],
    ["#55eadc", "var(--vibedev-editor-accent, #35ead9)"],
    ["#57e8d8", "var(--vibedev-editor-accent, #35ead9)"],
    ["#29d9c8", "var(--vibedev-editor-accent, #35ead9)"],
    ["#20d2bf", "var(--vibedev-editor-accent, #35ead9)"],
    ["#2ce6d4", "var(--vibedev-editor-accent, #35ead9)"],
    ["#2ee9d9", "var(--vibedev-editor-accent, #35ead9)"],
    ["#31ead7", "var(--vibedev-editor-accent, #35ead9)"],
    ["#33e6d3", "var(--vibedev-editor-accent, #35ead9)"],
    ["#33e8d6", "var(--vibedev-editor-accent, #35ead9)"],
    ["#33ead8", "var(--vibedev-editor-accent, #35ead9)"],
    ["#34ead8", "var(--vibedev-editor-accent, #35ead9)"],
    ["#36dace", "var(--vibedev-editor-accent, #35ead9)"],
    ["#37e8d8", "var(--vibedev-editor-accent, #35ead9)"],
    ["#38e4d6", "var(--vibedev-editor-accent, #35ead9)"],
    ["#3eebda", "var(--vibedev-editor-accent, #35ead9)"],
    ["#43f3df", "var(--vibedev-editor-accent, #35ead9)"],
    ["#49f4df", "var(--vibedev-editor-accent, #35ead9)"],
    ["#4af0dc", "var(--vibedev-editor-accent, #35ead9)"],
    ["#5ef0e2", "var(--vibedev-editor-accent, #35ead9)"],
    ["#69f2e5", "var(--vibedev-editor-accent, #35ead9)"],
    ["#70ded3", "var(--vibedev-editor-accent, #35ead9)"],
    ["#74f3e7", "var(--vibedev-editor-accent, #35ead9)"],
    ["#7affef", "var(--vibedev-editor-accent, #35ead9)"],
    ["#83fff3", "var(--vibedev-editor-accent, #35ead9)"]
  ]);
  const themedHex = containerSized.replace(
    /#[0-9a-f]{6}/gi,
    (value) => palette.get(value.toLowerCase()) ?? semanticHexColor(value) ?? value
  );
  const themedBorders = themedHex.replace(
    /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(?:0?\.08|0\.080)\s*\)/gi,
    "var(--vibedev-editor-border, rgba(255,255,255,.08))"
  );
  const themedTranslucentText = themedBorders.replace(
    /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(0?(?:\.\d+)|1(?:\.0+)?)\s*\)/gi,
    (_match, alpha) => {
      const percent = Math.round(Number(alpha) * 1e4) / 100;
      return `color-mix(in srgb, var(--vibedev-editor-text, #eef5f7) ${percent}%, transparent)`;
    }
  );
  const themedTranslucentSurfaces = themedTranslucentText.replace(
    /rgba\(\s*(?:14\s*,\s*17\s*,\s*23|17\s*,\s*21\s*,\s*27|17\s*,\s*22\s*,\s*29|17\s*,\s*27\s*,\s*33|20\s*,\s*27\s*,\s*32)\s*,\s*(0?(?:\.\d+)|1(?:\.0+)?)\s*\)/gi,
    (_match, alpha) => {
      const percent = Math.round(Number(alpha) * 1e4) / 100;
      return `color-mix(in srgb, var(--vibedev-editor-elevated, #171b22) ${percent}%, transparent)`;
    }
  );
  const themedLongTailSurfaces = themedTranslucentSurfaces.replace(
    /rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0?(?:\.\d+)|1(?:\.0+)?)\s*\)/gi,
    (match, redText, greenText, blueText, alpha) => {
      const red = Number(redText);
      const green = Number(greenText);
      const blue = Number(blueText);
      const maximum = Math.max(red, green, blue);
      if (maximum === 0 || maximum > 52 || red > 44) return match;
      const percent = Math.round(Number(alpha) * 1e4) / 100;
      return `color-mix(in srgb, var(--vibedev-editor-surface, rgb(${red},${green},${blue})) ${percent}%, transparent)`;
    }
  );
  const themedScheme = themedLongTailSurfaces.replace(
    /color-scheme\s*:\s*dark/gi,
    "color-scheme: var(--vibedev-editor-color-scheme, light)"
  );
  return themedScheme.replace(
    /rgba\(\s*(?:53\s*,\s*234\s*,\s*217|46\s*,\s*234\s*,\s*216|69\s*,\s*245\s*,\s*228|49\s*,\s*239\s*,\s*217|38\s*,\s*221\s*,\s*202|48\s*,\s*240\s*,\s*219)\s*,\s*(0?(?:\.\d+)|1(?:\.0+)?)\s*\)/gi,
    (_match, alpha) => {
      const percent = Math.round(Number(alpha) * 1e4) / 100;
      return `color-mix(in srgb, var(--vibedev-editor-accent, #35ead9) ${percent}%, transparent)`;
    }
  );
}
function containerWidthQueries(source) {
  let output = "";
  let copiedThrough = 0;
  const header = /@media\s*([^{}]+)\{/g;
  let match;
  while (match = header.exec(source)) {
    const condition = match[1]?.trim() ?? "";
    if (!/(?:min|max)-width\s*:/i.test(condition)) continue;
    if (condition.includes(",")) continue;
    const clauses = condition.split(/\s+and\s+/i).map((clause) => clause.trim()).filter(Boolean);
    const widthClauses = clauses.filter((clause) => /\((?:min|max)-width\s*:/i.test(clause));
    if (widthClauses.length === 0) continue;
    const mediaClauses = clauses.filter((clause) => !/\((?:min|max)-width\s*:/i.test(clause));
    const openBrace = header.lastIndex - 1;
    let depth = 1;
    let cursor = openBrace + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) continue;
    const body = source.slice(openBrace + 1, cursor - 1);
    const containerRule = `@container vibedev-editor ${widthClauses.join(" and ")} {${body}}`;
    output += source.slice(copiedThrough, match.index);
    output += mediaClauses.length > 0 ? `@media ${mediaClauses.join(" and ")} {${containerRule}}` : containerRule;
    copiedThrough = cursor;
    header.lastIndex = cursor;
  }
  return copiedThrough > 0 ? output + source.slice(copiedThrough) : source;
}
function prepareEmbeddedEditorCss(source) {
  const themed = themeUpstreamAccent(source);
  const scoped = themed.replace(/(^|})\s*:root\s*\{/gm, "$1\n:host {").replace(/(^|})\s*body\s*\{/gm, "$1\n[data-video-editor-body] {");
  return `${containerWidthQueries(scoped)}
${EMBEDDED_LAYOUT_CSS}`;
}
function createVideoEditorRuntime(runtimeOptions) {
  const manager = createVideoEditorMountManager((container, options) => {
    const surface = createEditorSurface(container, {
      css: prepareEmbeddedEditorCss(runtimeOptions.css),
      locale: options.locale,
      theme: options.theme
    });
    let rendered;
    try {
      rendered = runtimeOptions.render(surface, options);
      options.onEvent({ type: "ready", revision: options.document.revision });
    } catch (error) {
      surface.dispose();
      throw error;
    }
    return {
      ...rendered,
      unmount() {
        try {
          rendered.unmount();
        } finally {
          surface.dispose();
        }
      }
    };
  });
  return {
    mountVideoEditor(container, options) {
      return manager.mount(container, options);
    }
  };
}

// src/host-project-sync.ts
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function projectJson(document2) {
  return stableJson(objectValue(document2.upstreamDocument.project));
}
function stableJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
function assetsJson(document2) {
  return JSON.stringify(document2.assets);
}
function importFile(document2) {
  const payload = {
    ...document2.upstreamDocument,
    // useProjectFiles also supports this JSON transport. It restores the same
    // project state without requiring the bridge to create a zip merely to
    // cross the React boundary; explicit user exports remain .timeline zips.
    format: "timeline-studio-project"
  };
  return new File(
    [JSON.stringify(payload)],
    `${document2.compositeId}.timeline.json`,
    { type: "application/json" }
  );
}
function createEditorHostBridge(initialDocument, onEvent, capabilityRuntime, hostActions) {
  let currentDocument = initialDocument;
  let expectedProjectJson = projectJson(initialDocument);
  let editorProjectJson = expectedProjectJson;
  let expectedAssetsJson = assetsJson(initialDocument);
  let expectedProjectFilesJson = JSON.stringify(initialDocument.projectFiles ?? []);
  let expectedProjectTitle = initialDocument.projectTitle;
  let expectedProjectAspect = initialDocument.projectAspect;
  let publishedAspect = null;
  let api = null;
  let ready = false;
  let connected = false;
  let idle = Promise.resolve();
  let importGeneration = 0;
  let history = Promise.resolve();
  let movingHistory = false;
  const takeAspectToPublish = () => {
    const aspect = currentDocument.projectAspect;
    if (!shouldAdoptHostAspect({
      hostAspect: aspect,
      lastAdopted: publishedAspect,
      current: void 0,
      allowed: HOST_PROJECT_ASPECTS
    })) return void 0;
    publishedAspect = aspect ?? null;
    return aspect;
  };
  const enqueueImport = (document2, emitReady) => {
    const target = api;
    if (!target) return;
    const generation = ++importGeneration;
    ready = false;
    target.setDocumentBusy?.(true);
    expectedProjectJson = projectJson(document2);
    idle = idle.catch(() => void 0).then(async () => {
      if (api !== target || generation !== importGeneration) return;
      await target.importProject(importFile(document2), {
        hostDocument: true,
        authorizedAssets: document2.assets.map((asset) => ({ ...asset }))
      });
      if (api !== target || generation !== importGeneration) return;
      editorProjectJson = target.getProjectSnapshot ? stableJson(target.getProjectSnapshot()) : projectJson(document2);
      ready = true;
      target.setDocumentBusy?.(movingHistory);
      if (emitReady) onEvent({ type: "ready", revision: document2.revision });
    }).catch((reason) => {
      if (api !== target || generation !== importGeneration) return;
      ready = false;
      onEvent({
        type: "error",
        code: "EDITOR_DOCUMENT_IMPORT_FAILED",
        message: reason instanceof Error ? reason.message : String(reason)
      });
    });
  };
  const bridge = {
    ...capabilityRuntime ? { capabilityRuntime } : {},
    ...hostActions ? { hostActions } : {},
    connect(nextApi) {
      api = nextApi;
      connected = true;
      nextApi.updateAuthorizedAssets?.(currentDocument.assets.map((asset) => ({ ...asset })));
      nextApi.updateProjectFiles?.((currentDocument.projectFiles ?? []).map((file) => ({ ...file })));
      const aspect = takeAspectToPublish();
      nextApi.updateProjectMetadata?.({
        title: currentDocument.projectTitle || "",
        ...aspect ? { aspect } : {}
      });
      enqueueImport(currentDocument, true);
      return () => {
        if (api !== nextApi) return;
        api = null;
        ready = false;
        connected = false;
      };
    },
    updateDocument(document2) {
      const changedProject = projectJson(document2) !== expectedProjectJson;
      const changedAssets = assetsJson(document2) !== expectedAssetsJson;
      const nextProjectFilesJson = JSON.stringify(document2.projectFiles ?? []);
      const changedProjectFiles = nextProjectFilesJson !== expectedProjectFilesJson;
      const changedProjectTitle = document2.projectTitle !== expectedProjectTitle;
      const changedProjectAspect = document2.projectAspect !== expectedProjectAspect;
      currentDocument = document2;
      if (changedProjectTitle || changedProjectAspect) {
        expectedProjectTitle = document2.projectTitle;
        expectedProjectAspect = document2.projectAspect;
        const aspect = takeAspectToPublish();
        api?.updateProjectMetadata?.({
          title: document2.projectTitle || "",
          ...aspect ? { aspect } : {}
        });
      }
      if (changedAssets) {
        expectedAssetsJson = assetsJson(document2);
        api?.updateAuthorizedAssets?.(document2.assets.map((asset) => ({ ...asset })));
      }
      if (changedProjectFiles) {
        expectedProjectFilesJson = nextProjectFilesJson;
        api?.updateProjectFiles?.((document2.projectFiles ?? []).map((file) => ({ ...file })));
      }
      if (connected && changedProject) enqueueImport(document2, false);
      else if (ready) api?.acceptProjectBaseline?.(objectValue(document2.upstreamDocument.project));
    },
    onProjectSnapshot(project) {
      if (!ready || movingHistory) return;
      const projectionJson = stableJson(project);
      if (projectionJson === editorProjectJson) return;
      const carried = objectValue(currentDocument.upstreamDocument.project);
      const merged = { ...project };
      for (const key of Object.keys(carried)) {
        const value = carried[key];
        if (!(key in merged) && value !== void 0) merged[key] = value;
      }
      project = merged;
      const nextProjectJson = stableJson(project);
      editorProjectJson = projectionJson;
      if (nextProjectJson === expectedProjectJson) return;
      expectedProjectJson = nextProjectJson;
      api?.acceptProjectBaseline?.(project);
      currentDocument = {
        ...currentDocument,
        upstreamDocument: {
          ...currentDocument.upstreamDocument,
          project
        }
      };
      onEvent({ type: "dirty", baseRevision: currentDocument.revision });
      onEvent({
        type: "save-request",
        baseRevision: currentDocument.revision,
        upstreamDocument: currentDocument.upstreamDocument
      });
    },
    requestHistoryMove(direction) {
      const target = api;
      history = history.catch(() => void 0).then(async () => {
        await bridge.flushChanges();
        if (!target || api !== target || !ready) return;
        movingHistory = true;
        target.setDocumentBusy?.(true);
        try {
          await onEvent({ type: "history-request", direction, baseRevision: currentDocument.revision });
          await idle;
        } finally {
          movingHistory = false;
          target.setDocumentBusy?.(!ready);
        }
      }).catch((reason) => onEvent({ type: "error", code: "EDITOR_HISTORY_FAILED", message: reason instanceof Error ? reason.message : String(reason) }));
      return history;
    },
    requestRender(settings) {
      if (!ready) return;
      onEvent({
        type: "render-request",
        baseRevision: currentDocument.revision,
        settings: { ...settings }
      });
    },
    notifyEditor(notice) {
      api?.notify?.(notice);
    },
    async generateVoiceover(captionId) {
      if (!api?.generateVoiceover) return { status: "missing" };
      return api.generateVoiceover(captionId);
    },
    playheadSeconds() {
      const seconds = api?.playheadSeconds?.();
      return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    },
    selectedClip() {
      const selection = api?.selectedClip?.();
      return selection && typeof selection.clipId === "string" && selection.clipId ? selection : null;
    },
    whenIdle() {
      return idle;
    },
    async flushChanges() {
      await idle;
      if (!ready) throw new Error("Editor document is not ready");
      const snapshot = api?.getProjectSnapshot?.();
      if (snapshot) bridge.onProjectSnapshot(snapshot);
    }
  };
  return bridge;
}
function shouldAdoptHostAspect(input) {
  const { hostAspect, lastAdopted, current, allowed } = input;
  if (!hostAspect) return false;
  if (!allowed.includes(hostAspect)) return false;
  if (lastAdopted === hostAspect) return false;
  return hostAspect !== current;
}

// ../../vendor/ai-video-editor/src/lib/sourceAudioMapping.js
function resolveLinkedAssetId(visualSegments, sourceAudioAssetId) {
  if (sourceAudioAssetId) return sourceAudioAssetId;
  const assetIds = Array.from(new Set(
    visualSegments.filter((segment) => segment.type === "video" && segment.assetId).map((segment) => segment.assetId)
  ));
  return assetIds.length === 1 ? assetIds[0] : "";
}
function getVisualAudioSource(segment, { hasSourceAudio = false, sourceAudioAssetId = "", visualSegments = [] } = {}) {
  if (!segment || segment.type !== "video" || segment.sourceAudioDisabled || segment.muted === true) return "silent";
  if (!hasSourceAudio) return "embedded";
  const explicit = visualSegments.some((item) => item.type === "video" && Number.isFinite(item.sourceAudioOffset));
  const mapped = Number.isFinite(segment.sourceAudioOffset) || !explicit && segment.assetId && segment.assetId === resolveLinkedAssetId(visualSegments, sourceAudioAssetId);
  return mapped ? "source" : "embedded";
}
function getLinkedSourceAudioSegments(visualSegments = [], sourceAudioAssetId = "", sourceAudioDuration = 0) {
  const hasMappedOffsets = visualSegments.some((segment) => segment.type === "video" && Number.isFinite(segment.sourceAudioOffset));
  const linkedAssetId = resolveLinkedAssetId(visualSegments, sourceAudioAssetId);
  if (!hasMappedOffsets && !linkedAssetId) return [];
  let cursor = 0;
  const timeline = visualSegments.map((segment) => {
    const duration = Math.max(0, segment.duration || 0);
    const start = cursor;
    cursor += duration;
    return { start, duration };
  });
  const maximumSourceTime = Math.max(0, Number(sourceAudioDuration) || 0);
  return visualSegments.flatMap((segment, index) => {
    const hasSegmentMapping = Number.isFinite(segment.sourceAudioOffset);
    const matchesLegacyAssetMapping = !hasMappedOffsets && segment.assetId === linkedAssetId;
    if (segment.type !== "video" || segment.sourceAudioDisabled || segment.muted === true || !hasSegmentMapping && !matchesLegacyAssetMapping) return [];
    const range = timeline[index];
    const playbackRate = Math.max(0.25, Math.min(4, Number.isFinite(Number(segment.playbackRate)) ? Number(segment.playbackRate) : 1));
    const sourceStart = Math.max(0, Number(segment.sourceAudioOffset) || 0) + Math.max(0, Number(segment.sourceStart) || 0);
    const requestedSourceDuration = Math.max(0, Number(segment.sourceDuration) || segment.duration * playbackRate);
    const curved = segment.speedCurve && segment.speedCurve.enabled !== false;
    const availableSourceDuration = maximumSourceTime ? Math.max(0, Math.min(requestedSourceDuration, maximumSourceTime - sourceStart)) : requestedSourceDuration;
    const sourceDuration = curved ? requestedSourceDuration : availableSourceDuration;
    if (!range || availableSourceDuration <= 0) return [];
    const timelineOffset = Number.isFinite(Number(segment.sourceAudioTimelineOffset)) ? Number(segment.sourceAudioTimelineOffset) : 0;
    return [{
      id: segment.id,
      assetId: segment.assetId || linkedAssetId,
      start: Math.max(0, range.start + timelineOffset),
      duration: curved ? range.duration : Math.min(range.duration, sourceDuration / playbackRate),
      ...curved && availableSourceDuration < requestedSourceDuration ? { availableSourceDuration } : {},
      sourceStart,
      sourceDuration,
      playbackRate,
      speedCurve: segment.speedCurve
    }];
  });
}

// ../../vendor/ai-video-editor/src/lib/colorGrade.js
var DEFAULT_WHEEL = Object.freeze({ hue: 0, saturation: 0, luminance: 0 });
var COLOR_GRADE_KEYFRAME_KEYS = Object.freeze([
  "colorGrade.temperature",
  "colorGrade.tint",
  "colorGrade.saturation",
  ...["shadows", "midtones", "highlights", "offset"].flatMap((wheel) => [
    `colorGrade.${wheel}.hue`,
    `colorGrade.${wheel}.saturation`,
    `colorGrade.${wheel}.luminance`
  ])
]);
var DEFAULT_COLOR_GRADE = Object.freeze({
  temperature: 0,
  tint: 0,
  saturation: 0,
  shadows: DEFAULT_WHEEL,
  midtones: DEFAULT_WHEEL,
  highlights: DEFAULT_WHEEL,
  offset: DEFAULT_WHEEL
});
function clamp(value, min, max, fallback = 0) {
  const number2 = Number(value);
  return Number.isFinite(number2) ? Math.max(min, Math.min(max, number2)) : fallback;
}
function normalizeHue(value) {
  const number2 = Number(value);
  if (!Number.isFinite(number2)) return 0;
  return (number2 % 360 + 360) % 360;
}
function normalizeWheel(value = {}) {
  return {
    hue: normalizeHue(value.hue),
    saturation: clamp(value.saturation, 0, 100),
    luminance: clamp(value.luminance, -100, 100)
  };
}
function getColorGradeProperty(value = {}, key = "") {
  const path = String(key).replace(/^colorGrade\./, "").split(".");
  return path.reduce((current, part) => current?.[part], normalizeColorGrade(value));
}
function normalizeColorGradeProperty(key, value) {
  if (key.endsWith(".hue")) return normalizeHue(value);
  return clamp(value, -100, 100);
}
function normalizeColorGrade(value = {}) {
  return {
    temperature: clamp(value.temperature, -100, 100),
    tint: clamp(value.tint, -100, 100),
    saturation: clamp(value.saturation, -100, 100),
    shadows: normalizeWheel(value.shadows),
    midtones: normalizeWheel(value.midtones),
    highlights: normalizeWheel(value.highlights),
    offset: normalizeWheel(value.offset)
  };
}
function isColorGradeNeutral(value = {}) {
  const grade = normalizeColorGrade(value);
  return grade.temperature === 0 && grade.tint === 0 && grade.saturation === 0 && [grade.shadows, grade.midtones, grade.highlights, grade.offset].every((wheel) => wheel.saturation === 0 && wheel.luminance === 0);
}

// ../../vendor/ai-video-editor/src/lib/finalColorGrade.js
var WHEEL_WEIGHTS = Object.freeze({
  shadows: 0.34,
  midtones: 0.42,
  highlights: 0.24,
  offset: 0.56
});
function number(value) {
  const rounded = Math.round(Number(value) * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}
function propertyExpression(baseGrade, keyframes, key, timeExpression) {
  const base = normalizeColorGradeProperty(key, getColorGradeProperty(baseGrade, key));
  const points = (keyframes || []).filter((frame) => frame && Number.isFinite(Number(frame.time)) && Number.isFinite(Number(frame[key]))).map((frame) => ({
    time: Math.max(0, Number(frame.time) || 0),
    value: normalizeColorGradeProperty(key, frame[key])
  })).sort((left, right) => left.time - right.time);
  if (!points.length) return number(base);
  const unwrapped = [];
  points.forEach((point, index) => {
    if (!key.endsWith(".hue") || index === 0) {
      unwrapped.push({ ...point });
      return;
    }
    const previousRaw = points[index - 1];
    const previous = unwrapped[index - 1];
    const delta = (point.value - previousRaw.value + 540) % 360 - 180;
    unwrapped.push({ ...point, value: previous.value + delta });
  });
  let expression = number(unwrapped.at(-1).value);
  for (let index = unwrapped.length - 2; index >= 0; index -= 1) {
    const left = unwrapped[index];
    const right = unwrapped[index + 1];
    const duration = Math.max(1e-4, right.time - left.time);
    const interpolated = Math.abs(right.value - left.value) < 1e-9 ? number(left.value) : `(${number(left.value)}+(${number(right.value - left.value)})*((${timeExpression}-${number(left.time)})/${number(duration)}))`;
    expression = `if(lte(${timeExpression},${number(right.time)}),${interpolated},${expression})`;
  }
  const first = unwrapped[0];
  return first.time > 0 ? `if(lt(${timeExpression},${number(first.time)}),${number(base)},${expression})` : expression;
}
function rgbGeq(red, green, blue) {
  return `geq=r='clip(${red},0,255)':g='clip(${green},0,255)':b='clip(${blue},0,255)'`;
}
function buildFfmpegColorGradeFilter(colorGrade = {}, keyframes = [], timeExpression = "T") {
  const grade = normalizeColorGrade(colorGrade);
  const hasKeyframes = (keyframes || []).some((frame2) => frame2 && Object.keys(frame2).some((key) => key.startsWith("colorGrade.")));
  if (isColorGradeNeutral(grade) && !hasKeyframes) return "";
  const derived = (clock) => {
    const value = (key) => propertyExpression(grade, keyframes, `colorGrade.${key}`, clock);
    const temperature = value("temperature");
    const tint = value("tint");
    const authoredSaturation = value("saturation");
    const wheel = {};
    for (const [name, weight] of Object.entries(WHEEL_WEIGHTS)) {
      wheel[name] = {
        hue: value(`${name}.hue`),
        saturation: value(`${name}.saturation`),
        luminance: value(`${name}.luminance`),
        weight: number(weight)
      };
    }
    const vectorX = `(${Object.values(wheel).map((entry) => `cos((${entry.hue})*PI/180)*((${entry.saturation})/100)*${entry.weight}`).join("+")})`;
    const vectorY = `(${Object.values(wheel).map((entry) => `sin((${entry.hue})*PI/180)*((${entry.saturation})/100)*${entry.weight}`).join("+")})`;
    const luminance = `(${Object.values(wheel).map((entry) => `((${entry.luminance})/100)*${entry.weight}`).join("+")})`;
    const chroma = `min(1,sqrt(pow(${vectorX},2)+pow(${vectorY},2)))`;
    const hue = `if(gt(${chroma},0.0001),atan2(${vectorY},${vectorX})*180/PI,0)`;
    const warmth = `max(0,(${temperature}))/100`;
    const cool = `max(0,-(${temperature}))/100`;
    return {
      sepia: `min(0.34,(${warmth})*0.2+(${chroma})*0.26)`,
      hueRotate: `((${hue})*(${chroma})+(${tint})*0.18+(${cool})*188)`,
      brightness: `max(0.72,1+(${luminance})*0.24+(${wheel.offset.luminance})*0.0014+(${temperature})*0.0003)`,
      contrast: `max(0.78,1+((${wheel.highlights.luminance})-(${wheel.shadows.luminance}))*0.0011)`,
      saturation: `max(0,1+(${authoredSaturation})/100+(${chroma})*0.42)`
    };
  };
  const pixel = derived(timeExpression);
  const frame = derived("t");
  const r = "r(X,Y)";
  const g = "g(X,Y)";
  const b = "b(X,Y)";
  const brightnessStage = rgbGeq(
    `${r}*(${pixel.brightness})`,
    `${g}*(${pixel.brightness})`,
    `${b}*(${pixel.brightness})`
  );
  const contrastSaturationStage = `eq=contrast='${frame.contrast}':saturation='${frame.saturation}':eval=frame`;
  const sepiaR = `(0.393*${r}+0.769*${g}+0.189*${b})`;
  const sepiaG = `(0.349*${r}+0.686*${g}+0.168*${b})`;
  const sepiaB = `(0.272*${r}+0.534*${g}+0.131*${b})`;
  const sepiaStage = rgbGeq(
    `${r}*(1-(${pixel.sepia}))+(${pixel.sepia})*${sepiaR}`,
    `${g}*(1-(${pixel.sepia}))+(${pixel.sepia})*${sepiaG}`,
    `${b}*(1-(${pixel.sepia}))+(${pixel.sepia})*${sepiaB}`
  );
  const hueStage = `hue=h='${frame.hueRotate}':s=1`;
  return `format=gbrp,${brightnessStage},${contrastSaturationStage},${sepiaStage},${hueStage}`;
}

// ../../vendor/ai-video-editor/src/lib/captionFonts.js
var DEFAULT_CAPTION_FONT_ID = "default";
var CAPTION_FONT_REVISION = import.meta.env?.VITE_CAPTION_FONT_REVISION || "v1.0.0";
var SYSTEM_CAPTION_STACK = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
var font = (id, family, label, options = {}) => ({
  id,
  family,
  label,
  weight: options.weight || 400,
  category: options.category || "display",
  sample: options.sample || "\u5B57\u5E55 Caption",
  googleFamily: options.googleFamily === false ? "" : options.googleFamily || family,
  file: options.file || `${id}/font.ttf`,
  fallback: options.fallback || SYSTEM_CAPTION_STACK,
  license: options.license || "OFL-1.1"
});
var CAPTION_FONT_CATALOG = [
  {
    id: DEFAULT_CAPTION_FONT_ID,
    family: "",
    label: "Default",
    weight: 700,
    category: "sans",
    sample: "\u5B57\u5E55 Caption",
    googleFamily: "",
    file: "",
    fallback: SYSTEM_CAPTION_STACK,
    license: "system"
  },
  font("noto-sans-sc", "Noto Sans SC", "\u601D\u6E90\u9ED1\u4F53", { weight: 700, category: "sans", sample: "\u6E05\u6670\u5B57\u5E55" }),
  font("noto-serif-sc", "Noto Serif SC", "\u601D\u6E90\u5B8B\u4F53", { weight: 700, category: "serif", sample: "\u7535\u5F71\u5B57\u5E55" }),
  font("zcool-kuaile", "ZCOOL KuaiLe", "\u7AD9\u9177\u5FEB\u4E50\u4F53", { sample: "\u5FEB\u4E50\u5B57\u5E55" }),
  font("zcool-qingke-huangyou", "ZCOOL QingKe HuangYou", "\u5E86\u79D1\u9EC4\u6CB9\u4F53", { sample: "\u590D\u53E4\u6807\u9898" }),
  font("zcool-xiaowei", "ZCOOL XiaoWei", "\u7AD9\u9177\u5C0F\u8587\u4F53", { category: "serif", sample: "\u6587\u827A\u5B57\u5E55" }),
  font("ma-shan-zheng", "Ma Shan Zheng", "\u9A6C\u5584\u653F\u6BDB\u7B14\u6977\u4E66", { category: "script", sample: "\u56FD\u98CE\u5B57\u5E55" }),
  font("long-cang", "Long Cang", "\u9F99\u85CF\u4F53", { category: "script", sample: "\u6325\u6BEB\u5B57\u5E55" }),
  font("liu-jian-mao-cao", "Liu Jian Mao Cao", "\u5218\u5EFA\u6BDB\u8349", { category: "script", sample: "\u6BDB\u7B14\u5B57\u5E55" }),
  font("zhi-mang-xing", "Zhi Mang Xing", "\u5FD7\u83BD\u884C\u4E66", { category: "script", sample: "\u884C\u4E66\u5B57\u5E55" }),
  font("noto-sans-tc", "Noto Sans TC", "\u601D\u6E90\u9ED1\u4F53\u7E41\u4F53", { weight: 700, category: "sans", sample: "\u7E41\u9AD4\u5B57\u5E55" }),
  font("noto-sans-jp", "Noto Sans JP", "Noto Sans JP", { weight: 700, category: "sans", sample: "\u65E5\u672C\u8A9E\u5B57\u5E55" }),
  font("noto-serif-jp", "Noto Serif JP", "Noto Serif JP", { weight: 700, category: "serif", sample: "\u6620\u753B\u5B57\u5E55" }),
  font("m-plus-1p", "M PLUS 1p", "M PLUS 1p", { weight: 700, category: "sans", sample: "\u8AAD\u307F\u3084\u3059\u3044\u5B57\u5E55" }),
  font("klee-one", "Klee One", "Klee One", { weight: 600, category: "handwriting", sample: "\u624B\u66F8\u304D\u306E\u5B57\u5E55" }),
  font("zen-kaku-gothic-new", "Zen Kaku Gothic New", "Zen Kaku Gothic", { weight: 700, category: "sans", sample: "\u73FE\u4EE3\u7684\u306A\u5B57\u5E55" }),
  font("zen-maru-gothic", "Zen Maru Gothic", "Zen Maru Gothic", { weight: 700, category: "rounded", sample: "\u4E38\u3044\u5B57\u5E55" }),
  font("zen-old-mincho", "Zen Old Mincho", "Zen Old Mincho", { weight: 700, category: "serif", sample: "\u7269\u8A9E\u306E\u5B57\u5E55" }),
  font("shippori-mincho", "Shippori Mincho", "Shippori Mincho", { weight: 700, category: "serif", sample: "\u4E0A\u54C1\u306A\u5B57\u5E55" }),
  font("kaisei-decol", "Kaisei Decol", "Kaisei Decol", { weight: 700, category: "display", sample: "\u88C5\u98FE\u5B57\u5E55" }),
  font("hachi-maru-pop", "Hachi Maru Pop", "Hachi Maru Pop", { category: "handwriting", sample: "\u697D\u3057\u3044\u5B57\u5E55" }),
  font("noto-sans-kr", "Noto Sans KR", "Noto Sans KR", { weight: 700, category: "sans", sample: "\uD55C\uAD6D\uC5B4 \uC790\uB9C9" }),
  font("noto-serif-kr", "Noto Serif KR", "Noto Serif KR", { weight: 700, category: "serif", sample: "\uC601\uD654 \uC790\uB9C9" }),
  font("black-han-sans", "Black Han Sans", "Black Han Sans", { category: "display", sample: "\uAC15\uD55C \uC790\uB9C9" }),
  font("do-hyeon", "Do Hyeon", "Do Hyeon", { category: "display", sample: "\uB610\uB837\uD55C \uC790\uB9C9" }),
  font("jua", "Jua", "Jua", { category: "rounded", sample: "\uC990\uAC70\uC6B4 \uC790\uB9C9" }),
  font("gamja-flower", "Gamja Flower", "Gamja Flower", { category: "handwriting", sample: "\uC190\uAE00\uC528 \uC790\uB9C9" }),
  font("gowun-batang", "Gowun Batang", "Gowun Batang", { weight: 700, category: "serif", sample: "\uAC10\uC131 \uC790\uB9C9" }),
  font("gowun-dodum", "Gowun Dodum", "Gowun Dodum", { category: "sans", sample: "\uD3B8\uC548\uD55C \uC790\uB9C9" }),
  font("song-myung", "Song Myung", "Song Myung", { category: "serif", sample: "\uACE0\uC804 \uC790\uB9C9" }),
  font("nanum-pen-script", "Nanum Pen Script", "Nanum Pen Script", { category: "handwriting", sample: "\uD39C\uAE00\uC528 \uC790\uB9C9" }),
  font("inter", "Inter", "Inter", { weight: 700, category: "sans", sample: "Clear captions" }),
  font("montserrat", "Montserrat", "Montserrat", { weight: 700, category: "sans", sample: "Modern captions" }),
  font("poppins", "Poppins", "Poppins", { weight: 700, category: "rounded", sample: "Friendly captions" }),
  font("oswald", "Oswald", "Oswald", { weight: 700, category: "condensed", sample: "Bold captions" }),
  font("barlow-condensed", "Barlow Condensed", "Barlow Condensed", { weight: 700, category: "condensed", sample: "Compact captions" }),
  font("playfair-display", "Playfair Display", "Playfair Display", { weight: 700, category: "serif", sample: "Cinematic captions" }),
  font("bebas-neue", "Bebas Neue", "Bebas Neue", { category: "display", sample: "TITLE CAPTIONS" }),
  font("caveat", "Caveat", "Caveat", { weight: 700, category: "handwriting", sample: "Handwritten captions" }),
  font("lobster", "Lobster", "Lobster", { category: "script", sample: "Stylish captions" }),
  font("libre-baskerville", "Libre Baskerville", "Libre Baskerville", { weight: 700, category: "serif", sample: "Editorial captions" }),
  font("be-vietnam-pro", "Be Vietnam Pro", "Be Vietnam Pro", { weight: 700, category: "sans", sample: "Ph\u1EE5 \u0111\u1EC1 ti\u1EBFng Vi\u1EC7t" }),
  font("noto-sans", "Noto Sans", "Noto Sans", { weight: 700, category: "sans", sample: "Ph\u1EE5 \u0111\u1EC1 r\xF5 r\xE0ng" }),
  font("noto-serif", "Noto Serif", "Noto Serif", { weight: 700, category: "serif", sample: "Ph\u1EE5 \u0111\u1EC1 \u0111i\u1EC7n \u1EA3nh" }),
  font("merriweather", "Merriweather", "Merriweather", { weight: 700, category: "serif", sample: "Ph\u1EE5 \u0111\u1EC1 n\u1ED5i b\u1EADt" }),
  font("baloo-2", "Baloo 2", "Baloo 2", { weight: 700, category: "rounded", sample: "Ph\u1EE5 \u0111\u1EC1 vui v\u1EBB" }),
  font("coiny", "Coiny", "Coiny", { category: "display", sample: "Ph\u1EE5 \u0111\u1EC1 c\xE1 t\xEDnh" }),
  font("rubik", "Rubik", "Rubik", { weight: 700, category: "rounded", sample: "\u0420\u0443\u0441\u0441\u043A\u0438\u0435 \u0441\u0443\u0431\u0442\u0438\u0442\u0440\u044B" }),
  font("pt-sans", "PT Sans", "PT Sans", { weight: 700, category: "sans", sample: "\u0427\u0451\u0442\u043A\u0438\u0435 \u0441\u0443\u0431\u0442\u0438\u0442\u0440\u044B" }),
  font("pt-serif", "PT Serif", "PT Serif", { weight: 700, category: "serif", sample: "\u041A\u0438\u043D\u043E\u0441\u0443\u0431\u0442\u0438\u0442\u0440\u044B" }),
  font("russo-one", "Russo One", "Russo One", { category: "display", sample: "\u042F\u0420\u041A\u0418\u0415 \u0422\u0418\u0422\u0420\u042B" }),
  font("comfortaa", "Comfortaa", "Comfortaa", { weight: 700, category: "rounded", sample: "\u041C\u044F\u0433\u043A\u0438\u0435 \u0441\u0443\u0431\u0442\u0438\u0442\u0440\u044B" }),
  font("cormorant-garamond", "Cormorant Garamond", "Cormorant Garamond", { weight: 700, category: "serif", sample: "\u042D\u043B\u0435\u0433\u0430\u043D\u0442\u043D\u044B\u0435 \u0442\u0438\u0442\u0440\u044B" }),
  font("noto-sans-thai", "Noto Sans Thai", "Noto Sans Thai", { weight: 700, category: "sans", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22" }),
  font("noto-serif-thai", "Noto Serif Thai", "Noto Serif Thai", { weight: 700, category: "serif", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E20\u0E32\u0E1E\u0E22\u0E19\u0E15\u0E23\u0E4C" }),
  font("ibm-plex-sans-thai", "IBM Plex Sans Thai", "IBM Plex Sans Thai", { weight: 700, category: "sans", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E0A\u0E31\u0E14\u0E40\u0E08\u0E19" }),
  font("ibm-plex-sans-thai-looped", "IBM Plex Sans Thai Looped", "IBM Plex Thai Looped", { weight: 700, category: "sans", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E23\u0E48\u0E27\u0E21\u0E2A\u0E21\u0E31\u0E22" }),
  font("bai-jamjuree", "Bai Jamjuree", "Bai Jamjuree", { weight: 700, category: "sans", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E17\u0E31\u0E19\u0E2A\u0E21\u0E31\u0E22" }),
  font("kanit", "Kanit", "Kanit", { weight: 700, category: "display", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E42\u0E14\u0E14\u0E40\u0E14\u0E48\u0E19" }),
  font("prompt", "Prompt", "Prompt", { weight: 700, category: "sans", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E2D\u0E48\u0E32\u0E19\u0E07\u0E48\u0E32\u0E22" }),
  font("sarabun", "Sarabun", "Sarabun", { weight: 700, category: "sans", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E2A\u0E1A\u0E32\u0E22\u0E15\u0E32" }),
  font("mitr", "Mitr", "Mitr", { weight: 700, category: "rounded", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E40\u0E1B\u0E47\u0E19\u0E21\u0E34\u0E15\u0E23" }),
  font("chonburi", "Chonburi", "Chonburi", { category: "display", sample: "\u0E04\u0E33\u0E1A\u0E23\u0E23\u0E22\u0E32\u0E22\u0E28\u0E34\u0E25\u0E1B\u0E4C" })
];
var BY_ID = new Map(CAPTION_FONT_CATALOG.map((item) => [item.id, item]));
function getCaptionFont(fontId = DEFAULT_CAPTION_FONT_ID) {
  return BY_ID.get(fontId) || BY_ID.get(DEFAULT_CAPTION_FONT_ID);
}

// ../../vendor/ai-video-editor/src/lib/audioSpatialEffects.js
var DEFAULT_SPATIAL_EFFECT_ID = "original";
var AUDIO_SPATIAL_EFFECTS = [
  { id: "original", labelKey: "audioSpaceOriginal", duration: 0, decay: 0, wet: 0, dry: 1, preDelay: 0, tone: 18e3, output: 1, reflections: [] },
  { id: "bedroom", labelKey: "audioSpaceBedroom", duration: 0.42, decay: 3.8, wet: 0.3, dry: 0.95, preDelay: 6e-3, tone: 7200, output: 0.98, reflections: [[0.012, 0.34], [0.026, 0.2], [0.051, 0.12]] },
  { id: "living-room", labelKey: "audioSpaceLivingRoom", duration: 0.68, decay: 3.25, wet: 0.38, dry: 0.92, preDelay: 9e-3, tone: 8600, output: 0.96, reflections: [[0.016, 0.38], [0.034, 0.24], [0.072, 0.14]] },
  { id: "bathroom", labelKey: "audioSpaceBathroom", duration: 1.25, decay: 2.55, wet: 0.56, dry: 0.84, preDelay: 0.012, tone: 13500, output: 0.84, reflections: [[0.018, 0.46], [0.041, 0.31], [0.083, 0.2], [0.132, 0.13]] },
  { id: "hall", labelKey: "audioSpaceHall", duration: 2.35, decay: 2.7, wet: 0.5, dry: 0.86, preDelay: 0.026, tone: 9800, output: 0.86, reflections: [[0.032, 0.42], [0.071, 0.3], [0.143, 0.2], [0.238, 0.13]] },
  { id: "corridor", labelKey: "audioSpaceCorridor", duration: 1.72, decay: 2.85, wet: 0.5, dry: 0.86, preDelay: 0.02, tone: 8200, output: 0.87, reflections: [[0.047, 0.48], [0.094, 0.34], [0.188, 0.23], [0.282, 0.15]] },
  { id: "plaza", labelKey: "audioSpacePlaza", duration: 1.38, decay: 3.15, wet: 0.38, dry: 0.92, preDelay: 0.052, tone: 11500, output: 0.93, reflections: [[0.086, 0.37], [0.171, 0.24], [0.296, 0.14]] },
  { id: "valley", labelKey: "audioSpaceValley", duration: 3.4, decay: 3.35, wet: 0.6, dry: 0.82, preDelay: 0.11, tone: 10500, output: 0.8, reflections: [[0.22, 0.52], [0.46, 0.36], [0.78, 0.24], [1.14, 0.15]] },
  { id: "studio", labelKey: "audioSpaceStudio", duration: 0.24, decay: 5.2, wet: 0.18, dry: 0.99, preDelay: 3e-3, tone: 6400, output: 1, reflections: [[8e-3, 0.18], [0.019, 0.1], [0.036, 0.06]] },
  { id: "office", labelKey: "audioSpaceOffice", duration: 0.58, decay: 3.7, wet: 0.3, dry: 0.95, preDelay: 8e-3, tone: 7600, output: 0.98, reflections: [[0.014, 0.31], [0.032, 0.19], [0.067, 0.11]] },
  { id: "cafe", labelKey: "audioSpaceCafe", duration: 0.86, decay: 3.05, wet: 0.38, dry: 0.92, preDelay: 0.012, tone: 8900, output: 0.95, reflections: [[0.019, 0.35], [0.046, 0.23], [0.094, 0.15], [0.151, 0.08]] },
  { id: "classroom", labelKey: "audioSpaceClassroom", duration: 1.12, decay: 2.9, wet: 0.43, dry: 0.9, preDelay: 0.016, tone: 9600, output: 0.92, reflections: [[0.023, 0.39], [0.054, 0.27], [0.108, 0.18], [0.178, 0.1]] },
  { id: "theater", labelKey: "audioSpaceTheater", duration: 2.85, decay: 3.15, wet: 0.54, dry: 0.84, preDelay: 0.038, tone: 8700, output: 0.84, reflections: [[0.052, 0.41], [0.119, 0.29], [0.238, 0.2], [0.41, 0.12]] },
  { id: "church", labelKey: "audioSpaceChurch", duration: 4.4, decay: 2.75, wet: 0.66, dry: 0.78, preDelay: 0.064, tone: 11200, output: 0.76, reflections: [[0.074, 0.48], [0.167, 0.35], [0.342, 0.25], [0.61, 0.16], [0.94, 0.1]] },
  { id: "forest", labelKey: "audioSpaceForest", duration: 1.08, decay: 3.9, wet: 0.31, dry: 0.95, preDelay: 0.044, tone: 7900, output: 0.97, reflections: [[0.071, 0.27], [0.163, 0.18], [0.31, 0.1]] },
  { id: "subway", labelKey: "audioSpaceSubway", duration: 1.62, decay: 2.45, wet: 0.53, dry: 0.86, preDelay: 0.024, tone: 12800, output: 0.84, reflections: [[0.031, 0.48], [0.066, 0.36], [0.132, 0.25], [0.264, 0.16], [0.396, 0.09]] }
];
var PRESET_BY_ID = new Map(AUDIO_SPATIAL_EFFECTS.map((preset) => [preset.id, preset]));
function normalizeAudioSpatialEffect(value) {
  return PRESET_BY_ID.has(value) ? value : DEFAULT_SPATIAL_EFFECT_ID;
}
function normalizeAudioSpatialAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 1;
}
function getAudioSpatialEffect(value) {
  return PRESET_BY_ID.get(normalizeAudioSpatialEffect(value));
}

// ../../vendor/ai-video-editor/src/lib/finalTimeRemap.js
var MIN_RATE = 0.25;
var MAX_RATE = 4;
var clamp2 = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
function normalizePoints(value) {
  const points = (Array.isArray(value?.points) ? value.points : []).filter((point) => point && Number.isFinite(Number(point.progress)) && Number.isFinite(Number(point.rate))).map((point) => ({
    progress: clamp2(Number(point.progress), 0, 1),
    rate: clamp2(Number(point.rate), MIN_RATE, MAX_RATE)
  })).sort((left, right) => left.progress - right.progress);
  if (points.length < 2) return [{ progress: 0, rate: 1 }, { progress: 1, rate: 1 }];
  points[0] = { ...points[0], progress: 0 };
  points[points.length - 1] = { ...points.at(-1), progress: 1 };
  return points;
}
function baseSourceProgress(value, progress) {
  const points = normalizePoints(value);
  const target = clamp2(Number(progress) || 0, 0, 1);
  const smooth = value?.smooth !== false;
  const segmentIntegral = (left, right, local = 1) => {
    const time = clamp2(local, 0, 1);
    const easingIntegral = smooth ? time ** 3 - 0.5 * time ** 4 : 0.5 * time ** 2;
    return (right.progress - left.progress) * (left.rate * time + (right.rate - left.rate) * easingIntegral);
  };
  const total = points.slice(0, -1).reduce((sum, point, index) => sum + segmentIntegral(point, points[index + 1]), 0) || 1;
  let consumed = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (target >= right.progress) consumed += segmentIntegral(left, right);
    else if (target > left.progress) {
      consumed += segmentIntegral(
        left,
        right,
        (target - left.progress) / Math.max(1e-4, right.progress - left.progress)
      );
      break;
    } else break;
  }
  return clamp2(consumed / total, 0, 1);
}
function getFinalSpeedCurveSourceTime(segment, localTime) {
  const duration = Math.max(1e-3, Number(segment?.duration) || 1e-3);
  const sourceStart = Math.max(0, Number(segment?.sourceStart) || 0);
  const sourceDuration = Math.max(1e-3, Number(segment?.sourceDuration) || duration);
  const progress = clamp2((Number(localTime) || 0) / duration, 0, 1);
  return sourceStart + sourceDuration * getFinalSpeedCurveSourceProgress(segment?.speedCurve, progress);
}
function getFinalSpeedCurveSourceProgress(value, progress) {
  const start = clamp2(Number(value?.window?.start) || 0, 0, 1);
  const end = clamp2(Number(value?.window?.end ?? 1), start, 1);
  const from = baseSourceProgress(value, start);
  const to = baseSourceProgress(value, end);
  return (baseSourceProgress(value, start + (end - start) * clamp2(Number(progress) || 0, 0, 1)) - from) / Math.max(1e-12, to - from);
}

// ../../vendor/ai-video-editor/src/lib/effectRegistry.js
var descriptors = Object.freeze([
  Object.freeze({
    id: "vibedev.blur",
    version: 1,
    mediaTypes: Object.freeze(["image", "video"]),
    finalRenderer: true,
    parameters: Object.freeze({
      radius: Object.freeze({ type: "number", min: 0.1, max: 20, default: 4 })
    }),
    ffmpeg(parameters) {
      return `gblur=sigma=${Number(parameters.radius).toFixed(6).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, "")}`;
    }
  }),
  Object.freeze({
    id: "vibedev.noir",
    version: 1,
    mediaTypes: Object.freeze(["image", "video"]),
    finalRenderer: true,
    parameters: Object.freeze({}),
    ffmpeg() {
      return "hue=s=0,eq=contrast=1.18";
    }
  }),
  // Kept in the registry so preview code can recognize persisted upstream
  // projects, but deliberately blocked from formal delivery until a paired
  // authoritative renderer exists.
  Object.freeze({
    id: "vibedev.preview-outline",
    version: 1,
    mediaTypes: Object.freeze(["image", "video"]),
    finalRenderer: false,
    parameters: Object.freeze({})
  })
]);
var byIdentity = new Map(descriptors.map((descriptor) => [
  `${descriptor.id}@${descriptor.version}`,
  descriptor
]));
function effectError(code, message) {
  return Object.assign(new Error(message), { code });
}
function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function normalizeParameters(descriptor, value) {
  const input = value == null ? {} : value;
  if (!plainObject(input)) {
    throw effectError("EFFECT_PARAMETERS_INVALID", `${descriptor.id} parameters must be an object`);
  }
  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(descriptor.parameters, key));
  if (unknown.length) {
    throw effectError("EFFECT_PARAMETERS_INVALID", `${descriptor.id} has unknown parameter: ${unknown[0]}`);
  }
  return Object.fromEntries(Object.entries(descriptor.parameters).map(([name, schema]) => {
    const candidate = Object.hasOwn(input, name) ? input[name] : schema.default;
    if (schema.type === "number") {
      if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < schema.min || candidate > schema.max) {
        throw effectError(
          "EFFECT_PARAMETERS_INVALID",
          `${descriptor.id}.${name} must be between ${schema.min} and ${schema.max}`
        );
      }
    }
    return [name, candidate];
  }));
}
function normalizeRegisteredEffect(value, options = {}) {
  if (!plainObject(value) || typeof value.id !== "string" || !Number.isInteger(value.version)) {
    throw effectError("EFFECT_PARAMETERS_INVALID", "Effect id and integer version are required");
  }
  const descriptor = byIdentity.get(`${value.id}@${value.version}`);
  if (!descriptor) {
    throw effectError("UNSUPPORTED_RENDER_FEATURE", `Unknown effect: ${value.id}@${value.version}`);
  }
  if (options.requireFinalRenderer !== false && descriptor.finalRenderer !== true) {
    throw effectError("UNSUPPORTED_RENDER_FEATURE", `Effect has no authoritative renderer: ${value.id}@${value.version}`);
  }
  if (options.mediaType && !descriptor.mediaTypes.includes(options.mediaType)) {
    throw effectError("UNSUPPORTED_RENDER_FEATURE", `${value.id} does not support ${options.mediaType}`);
  }
  return {
    id: descriptor.id,
    version: descriptor.version,
    parameters: normalizeParameters(descriptor, value.parameters)
  };
}
function buildRegisteredEffectFfmpegChain(effects, options = {}) {
  return (Array.isArray(effects) ? effects : []).map((effect) => {
    const normalized = normalizeRegisteredEffect(effect, options);
    const descriptor = byIdentity.get(`${normalized.id}@${normalized.version}`);
    return descriptor.ffmpeg(normalized.parameters);
  }).filter(Boolean).join(",");
}

// ../../vendor/ai-video-editor/src/lib/subjectEffects.js
var SUBJECT_EFFECT_PRESETS = Object.freeze([
  {
    id: "cyan-outline",
    kind: "person",
    titleKey: "effectPresetCyanOutline",
    hintKey: "effectPresetCyanOutlineHint",
    patch: {
      enabled: true,
      outline: { enabled: true, color: "#32ead8", width: 5, opacity: 1, softness: 0, glow: 0.38, glowRadius: 14 }
    }
  },
  {
    id: "white-sticker",
    kind: "person",
    titleKey: "effectPresetWhiteSticker",
    hintKey: "effectPresetWhiteStickerHint",
    patch: {
      enabled: true,
      outline: { enabled: true, color: "#ffffff", width: 9, opacity: 1, softness: 0, glow: 0.12, glowRadius: 7 }
    }
  },
  {
    id: "neon-pulse",
    kind: "person",
    titleKey: "effectPresetNeonPulse",
    hintKey: "effectPresetNeonPulseHint",
    patch: {
      enabled: true,
      outline: { enabled: true, color: "#ff4fc8", width: 4, opacity: 1, softness: 1, glow: 0.85, glowRadius: 24 }
    }
  },
  {
    id: "color-background",
    kind: "background",
    titleKey: "effectPresetColorBackground",
    hintKey: "effectPresetColorBackgroundHint",
    patch: {
      enabled: true,
      background: { mode: "color", color: "#17252b", fit: "cover", opacity: 1, blur: 18, darken: 0 }
    }
  },
  {
    id: "blur-background",
    kind: "background",
    titleKey: "effectPresetBlurBackground",
    hintKey: "effectPresetBlurBackgroundHint",
    patch: {
      enabled: true,
      background: { mode: "blur", color: "#111820", fit: "cover", opacity: 1, blur: 22, darken: 0.12 }
    }
  }
]);
var DEFAULT_SUBJECT_EFFECT = Object.freeze({
  enabled: false,
  presetId: "",
  targetKind: "person",
  analysisQuality: "balanced",
  outline: {
    enabled: false,
    color: "#f3efe4",
    width: 12,
    opacity: 1,
    softness: 0,
    glow: 0.35,
    glowRadius: 14
  },
  material: {
    id: "paper",
    textureScale: 1,
    textureStrength: 0.82,
    irregularity: 0.42,
    edgeDensity: 0.5,
    grain: 0.5,
    diffusion: 0.42,
    shadowDepth: 0.32,
    relief: 0.55,
    bleed: 0.48,
    contrast: 0.72,
    rings: 2,
    ringGap: 8
  },
  background: {
    visible: true,
    mode: "original",
    color: "#17252b",
    src: "",
    assetId: "",
    fit: "cover",
    opacity: 1,
    blur: 20,
    darken: 0
  },
  edge: {
    feather: 1,
    contract: 0,
    decontaminate: 0.25
  }
});
var clamp3 = (value, minimum, maximum, fallback) => {
  const number2 = Number(value);
  return Number.isFinite(number2) ? Math.max(minimum, Math.min(maximum, number2)) : fallback;
};
function normalizeSubjectEffect(value) {
  const effect = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_SUBJECT_EFFECT,
    ...effect,
    enabled: effect.enabled === true,
    targetKind: effect.targetKind === "object" ? "object" : "person",
    analysisQuality: ["fast", "balanced", "quality"].includes(effect.analysisQuality) ? effect.analysisQuality : DEFAULT_SUBJECT_EFFECT.analysisQuality,
    outline: {
      ...DEFAULT_SUBJECT_EFFECT.outline,
      ...effect.outline || {},
      enabled: effect.outline?.enabled === true,
      width: clamp3(effect.outline?.width, 0, 32, DEFAULT_SUBJECT_EFFECT.outline.width),
      opacity: clamp3(effect.outline?.opacity, 0, 1, DEFAULT_SUBJECT_EFFECT.outline.opacity),
      softness: clamp3(effect.outline?.softness, 0, 20, DEFAULT_SUBJECT_EFFECT.outline.softness),
      glow: clamp3(effect.outline?.glow, 0, 1, DEFAULT_SUBJECT_EFFECT.outline.glow),
      glowRadius: clamp3(effect.outline?.glowRadius, 0, 60, DEFAULT_SUBJECT_EFFECT.outline.glowRadius)
    },
    material: {
      ...DEFAULT_SUBJECT_EFFECT.material,
      ...effect.material || {},
      id: ["paper", "frosted", "halo", "chrome", "impasto", "ink"].includes(effect.material?.id) ? effect.material.id : DEFAULT_SUBJECT_EFFECT.material.id,
      textureScale: clamp3(effect.material?.textureScale, 0.35, 3, DEFAULT_SUBJECT_EFFECT.material.textureScale),
      textureStrength: clamp3(effect.material?.textureStrength, 0, 1, DEFAULT_SUBJECT_EFFECT.material.textureStrength),
      irregularity: clamp3(effect.material?.irregularity, 0, 1, DEFAULT_SUBJECT_EFFECT.material.irregularity),
      edgeDensity: clamp3(effect.material?.edgeDensity, 0, 1, DEFAULT_SUBJECT_EFFECT.material.edgeDensity),
      grain: clamp3(effect.material?.grain, 0, 1, DEFAULT_SUBJECT_EFFECT.material.grain),
      diffusion: clamp3(effect.material?.diffusion, 0, 1, DEFAULT_SUBJECT_EFFECT.material.diffusion),
      shadowDepth: clamp3(effect.material?.shadowDepth, 0, 1, DEFAULT_SUBJECT_EFFECT.material.shadowDepth),
      relief: clamp3(effect.material?.relief, 0, 1, DEFAULT_SUBJECT_EFFECT.material.relief),
      bleed: clamp3(effect.material?.bleed, 0, 1, DEFAULT_SUBJECT_EFFECT.material.bleed),
      contrast: clamp3(effect.material?.contrast, 0, 1, DEFAULT_SUBJECT_EFFECT.material.contrast),
      rings: Math.round(clamp3(effect.material?.rings, 1, 3, DEFAULT_SUBJECT_EFFECT.material.rings)),
      ringGap: clamp3(effect.material?.ringGap, 2, 24, DEFAULT_SUBJECT_EFFECT.material.ringGap)
    },
    background: {
      ...DEFAULT_SUBJECT_EFFECT.background,
      ...effect.background || {},
      visible: effect.background?.visible !== false,
      mode: ["original", "color", "blur", "image", "video"].includes(effect.background?.mode) ? effect.background.mode : DEFAULT_SUBJECT_EFFECT.background.mode,
      opacity: clamp3(effect.background?.opacity, 0, 1, DEFAULT_SUBJECT_EFFECT.background.opacity),
      blur: clamp3(effect.background?.blur, 0, 80, DEFAULT_SUBJECT_EFFECT.background.blur),
      darken: clamp3(effect.background?.darken, 0, 1, DEFAULT_SUBJECT_EFFECT.background.darken)
    },
    edge: {
      ...DEFAULT_SUBJECT_EFFECT.edge,
      ...effect.edge || {},
      feather: clamp3(effect.edge?.feather, 0, 20, DEFAULT_SUBJECT_EFFECT.edge.feather),
      contract: clamp3(effect.edge?.contract, -20, 20, DEFAULT_SUBJECT_EFFECT.edge.contract),
      decontaminate: clamp3(effect.edge?.decontaminate, 0, 1, DEFAULT_SUBJECT_EFFECT.edge.decontaminate)
    }
  };
}
function hasSubjectEffect(effect) {
  const normalized = normalizeSubjectEffect(effect);
  return normalized.enabled && (normalized.outline.enabled || normalized.background.visible === false || normalized.background.mode !== "original");
}

// ../../vendor/ai-video-editor/src/lib/depthOfField.js
var DEFAULT_CINEMATIC_DEPTH = Object.freeze({
  enabled: false,
  focus: 0.72,
  focusRange: 0.16,
  blur: 18,
  quality: "balanced",
  highlightBoost: 0.22
});
var clamp4 = (value, minimum, maximum, fallback) => {
  const number2 = Number(value);
  return Number.isFinite(number2) ? Math.max(minimum, Math.min(maximum, number2)) : fallback;
};
function normalizeCinematicDepth(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_CINEMATIC_DEPTH,
    ...source,
    enabled: source.enabled === true,
    focus: clamp4(source.focus, 0, 1, DEFAULT_CINEMATIC_DEPTH.focus),
    focusRange: clamp4(source.focusRange, 0.04, 0.48, DEFAULT_CINEMATIC_DEPTH.focusRange),
    blur: clamp4(source.blur, 0, 40, DEFAULT_CINEMATIC_DEPTH.blur),
    quality: ["fast", "balanced", "quality"].includes(source.quality) ? source.quality : DEFAULT_CINEMATIC_DEPTH.quality,
    highlightBoost: clamp4(source.highlightBoost, 0, 0.7, DEFAULT_CINEMATIC_DEPTH.highlightBoost)
  };
}

// ../../vendor/ai-video-editor/src/lib/photoParallax.js
var DEFAULT_PHOTO_PARALLAX = Object.freeze({
  enabled: false,
  quality: "balanced",
  direction: "orbit",
  strength: 0.58,
  speed: 1,
  zoom: 1.06,
  foregroundDepth: 0.68,
  backgroundDepth: 0.34,
  edgeFeather: 0.1
});
var clamp5 = (value, minimum, maximum, fallback) => {
  const number2 = Number(value);
  return Number.isFinite(number2) ? Math.max(minimum, Math.min(maximum, number2)) : fallback;
};
function normalizePhotoParallax(value) {
  const source = value && typeof value === "object" ? value : {};
  const backgroundDepth = clamp5(source.backgroundDepth, 0.08, 0.6, DEFAULT_PHOTO_PARALLAX.backgroundDepth);
  const foregroundDepth = Math.max(
    backgroundDepth + 0.12,
    clamp5(source.foregroundDepth, 0.4, 0.92, DEFAULT_PHOTO_PARALLAX.foregroundDepth)
  );
  return {
    ...DEFAULT_PHOTO_PARALLAX,
    ...source,
    enabled: source.enabled === true,
    quality: ["fast", "balanced", "quality"].includes(source.quality) ? source.quality : DEFAULT_PHOTO_PARALLAX.quality,
    direction: ["horizontal", "vertical", "orbit"].includes(source.direction) ? source.direction : DEFAULT_PHOTO_PARALLAX.direction,
    strength: clamp5(source.strength, 0, 1, DEFAULT_PHOTO_PARALLAX.strength),
    speed: clamp5(source.speed, 0.35, 2, DEFAULT_PHOTO_PARALLAX.speed),
    zoom: clamp5(source.zoom, 1.01, 1.16, DEFAULT_PHOTO_PARALLAX.zoom),
    foregroundDepth,
    backgroundDepth,
    edgeFeather: clamp5(source.edgeFeather, 0.02, 0.24, DEFAULT_PHOTO_PARALLAX.edgeFeather)
  };
}

// ../../vendor/ai-video-editor/src/lib/projectRenderPlan.js
var RATIO_SIZES = Object.freeze({
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 864, height: 1080 },
  // FORK: cinema frames, same short side as 16:9.
  "21:9": { width: 1680, height: 720 },
  "2.39:1": { width: 1720, height: 720 }
});
var VISUAL_FILTERS = Object.freeze({
  none: "",
  cool: "eq=contrast=1.04:saturation=0.96,hue=h=8",
  film: "eq=contrast=1.12:saturation=0.82,lutrgb=r='val*0.92':g='val*0.92':b='val*0.92'",
  bright: "lutrgb=r='val*1.08':g='val*1.08':b='val*1.08',eq=contrast=0.98:saturation=1.05",
  "effect-clean": "eq=contrast=1.08:saturation=1.08,lutrgb=r='val*1.03':g='val*1.03':b='val*1.03'",
  "effect-soft": "lutrgb=r='val*1.08':g='val*1.08':b='val*1.08',eq=contrast=0.94:saturation=1.06",
  "effect-cinematic": "eq=contrast=1.18:saturation=0.86,lutrgb=r='val*0.92':g='val*0.92':b='val*0.92'",
  "effect-vivid": "eq=contrast=1.08:saturation=1.28",
  "effect-night": "lutrgb=r='val*0.82':g='val*0.82':b='val*0.82',eq=contrast=1.2:saturation=1.08",
  "effect-warm": "colorchannelmixer=rr=0.90288:rg=0.12304:rb=0.03024:gr=0.05584:gg=0.94976:gb=0.02688:br=0.04352:bg=0.08544:bb=0.86096,eq=saturation=1.12,lutrgb=r='val*1.04':g='val*1.04':b='val*1.04'",
  "effect-cold": "hue=h=12,eq=saturation=0.98:contrast=1.06",
  "effect-noir": "hue=s=0,eq=contrast=1.18",
  "effect-dream": "lutrgb=r='val*1.1':g='val*1.1':b='val*1.1',eq=saturation=1.18,gblur=sigma=0.2"
});
var SUPPORTED_VISUAL_FILTER_IDS = Object.freeze(Object.keys(VISUAL_FILTERS));
var VISUAL_ANIMATION_IDS = /* @__PURE__ */ new Set(["none", "fade", "zoom", "slide-left", "slide-up"]);
var TRANSITION_XFADE_IDS = Object.freeze({
  fade: "fade",
  "wipe-left": "wipeleft",
  "wipe-up": "wipeup",
  zoom: "zoomin",
  flash: "fadewhite",
  blur: "hblur",
  split: "vertopen"
});
var CUSTOM_TRANSITION_IDS = /* @__PURE__ */ new Set(["glitch"]);
function renderError(code, message) {
  return Object.assign(new Error(message), { code });
}
function evenDimension(value, fallback, name) {
  const number2 = value == null ? fallback : Number(value);
  if (!Number.isFinite(number2) || number2 < 2) throw renderError("INVALID_RENDER_SETTINGS", `${name} must be at least 2`);
  return Math.max(2, Math.round(number2 / 2) * 2);
}
function finitePositive(value, name) {
  const number2 = Number(value);
  if (!Number.isFinite(number2) || number2 <= 0) throw renderError("INVALID_PROJECT", `${name} must be greater than zero`);
  return number2;
}
function atempoChain(rate) {
  const filters = [];
  let remaining = rate;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters.join(",");
}
function visibleCaptions(project) {
  if (project.captionsEnabled === false || project.trackVisibility?.caption === false) return [];
  return (project.captionSegments || []).filter((item) => !item.hidden);
}
function visibleOverlays(project) {
  if (project.trackVisibility?.overlay === false) return [];
  return (project.visualOverlaySegments || []).filter((item) => item.hidden !== true).map((item, index) => ({ item, index })).sort((left, right) => (Number(left.item.layer) || 1) - (Number(right.item.layer) || 1) || left.index - right.index).map(({ item }) => item);
}
function visibleStickers(project) {
  if (project.trackVisibility?.sticker === false) return [];
  const lanes = packTimedSegmentsIntoLanes(project.stickerSegments || [], "lane");
  return lanes.flatMap((lane, laneIndex) => project.trackVisibility?.[`sticker-${laneIndex}`] === false ? [] : lane).filter((item) => item.hidden !== true).map((item, index) => ({ item, index })).sort((left, right) => (Number(left.item.layer) || 1) - (Number(right.item.layer) || 1) || left.index - right.index).map(({ item }) => item);
}
function subjectAnalysisRecord(segment) {
  const record2 = segment?.vision?.hostAnalysis;
  if (!record2 || record2.kind !== "video-analysis-record") return null;
  const expectedKind = segment?.subjectEffect?.targetKind === "object" ? "object" : "subject";
  if (record2.analysisKind !== expectedKind || !Array.isArray(record2.artifacts)) return null;
  const roles = expectedKind === "object" ? /* @__PURE__ */ new Set(["object-mask", "object-cutout"]) : /* @__PURE__ */ new Set(["subject-mask", "subject-cutout"]);
  const artifact = record2.artifacts.find((item) => roles.has(item?.role));
  return artifact?.sourceUrl && artifact?.assetId && artifact?.versionId ? { record: record2, artifact } : null;
}
function subjectEffectRenderSpec(segment) {
  const effect = normalizeSubjectEffect(segment?.subjectEffect);
  if (!hasSubjectEffect(effect)) return null;
  const analysis = subjectAnalysisRecord(segment);
  if (!analysis) throw renderError("MISSING_RENDER_RESOURCE", `Subject effect has no pinned analysis mask: ${segment?.id || "unknown"}`);
  if (!["original", "color", "blur"].includes(effect.background.mode)) {
    throw renderError("UNSUPPORTED_RENDER_FEATURE", `Subject background mode is not renderable: ${effect.background.mode}`);
  }
  return { effect, analysis };
}
function depthEffectRenderSpec(segment) {
  const cinematicDepth = normalizeCinematicDepth(segment?.cinematicDepth);
  const photoParallax = normalizePhotoParallax(segment?.photoParallax);
  if (!cinematicDepth.enabled && !photoParallax.enabled) return null;
  if (cinematicDepth.enabled && photoParallax.enabled) {
    throw renderError("UNSUPPORTED_RENDER_FEATURE", "Cinematic depth and photo parallax cannot render on the same clip");
  }
  const record2 = segment?.depth?.hostAnalysis;
  const artifact = record2?.kind === "video-analysis-record" && record2.analysisKind === "depth" ? record2.artifacts?.find((item) => item?.role === "depth-map") : null;
  if (!artifact?.sourceUrl || !artifact?.assetId || !artifact?.versionId) {
    throw renderError("MISSING_RENDER_RESOURCE", `Depth effect has no pinned depth map: ${segment?.id || "unknown"}`);
  }
  return { cinematicDepth, photoParallax, analysis: { record: record2, artifact } };
}
function isNoopOverlayMask(mask) {
  if (!mask || !mask.type || mask.type === "none") return true;
  return mask.type === "rectangle" && Number(mask.width ?? 100) === 100 && Number(mask.height ?? 100) === 100 && Number(mask.centerX ?? 50) === 50 && Number(mask.centerY ?? 50) === 50 && Number(mask.feather ?? 0) === 0 && mask.inverted !== true;
}
function isSupportedVisualMask(mask) {
  if (isNoopOverlayMask(mask)) return true;
  if (!mask || !["rectangle", "rounded", "circle"].includes(mask.type)) return false;
  const bounded = (value, fallback, min, max) => {
    const number2 = Number(value ?? fallback);
    return Number.isFinite(number2) && number2 >= min && number2 <= max;
  };
  if (!bounded(mask.centerX, 50, 0, 100) || !bounded(mask.centerY, 50, 0, 100)) return false;
  if (!bounded(mask.feather, 0, 0, 40)) return false;
  if (mask.type === "circle") return bounded(mask.size, 72, 0.1, 100);
  if (!bounded(mask.width, 80, 0.1, 100) || !bounded(mask.height, 80, 0.1, 100)) return false;
  return mask.type !== "rounded" || bounded(mask.cornerRadius, 12, 0, 50);
}
function animationPhase(value) {
  return {
    id: value?.id || "none",
    duration: Math.max(0.1, Math.min(3, Number(value?.duration) || 0.6))
  };
}
function hasVisualAnimation(animation) {
  return [animationPhase(animation?.in), animationPhase(animation?.out)].some((phase) => phase.id !== "none");
}
function hasUnsupportedVisualAnimation(animation) {
  return [animation?.in?.id, animation?.out?.id].some((id) => id && !VISUAL_ANIMATION_IDS.has(id));
}
function isSupportedVisualFilterId(value) {
  return value == null || value === "" || Object.hasOwn(VISUAL_FILTERS, value);
}
function visualFilterChain(value) {
  return VISUAL_FILTERS[value || "none"] || "";
}
function packTimedSegmentsIntoLanes(segments, preferredLaneKey = "") {
  const lanes = [];
  const ordered = preferredLaneKey ? [...segments] : [...segments].sort((left, right) => (Number(left.start) || 0) - (Number(right.start) || 0));
  ordered.forEach((segment) => {
    const accepts = (lane = []) => {
      const start = Number(segment.start) || 0;
      const end = start + (Number(segment.duration) || 0);
      return lane.every((item) => {
        const itemStart = Number(item.start) || 0;
        const itemEnd = itemStart + (Number(item.duration) || 0);
        return itemEnd <= start + 1e-3 || end <= itemStart + 1e-3;
      });
    };
    const preferred = preferredLaneKey && Number.isInteger(segment?.[preferredLaneKey]) ? Math.max(0, segment[preferredLaneKey]) : -1;
    while (preferred >= lanes.length) lanes.push([]);
    const laneIndex = preferred >= 0 && accepts(lanes[preferred]) ? preferred : lanes.findIndex(accepts);
    if (laneIndex >= 0) {
      lanes[laneIndex].push(segment);
      lanes[laneIndex].sort((left, right) => (Number(left.start) || 0) - (Number(right.start) || 0));
    } else lanes.push([segment]);
  });
  return lanes.length ? lanes : [[]];
}
function audibleSegments(project, segments, track) {
  const visibility = project.trackVisibility || {};
  if (visibility[track] === false) return [];
  const lanes = packTimedSegmentsIntoLanes(segments, track === "audio" ? "lane" : "");
  return lanes.flatMap((lane, laneIndex) => visibility[`${track}-${laneIndex}`] === false ? [] : lane).filter((segment) => segment.hidden !== true && segment.muted !== true);
}
function getFfmpegRenderMediaRequirements(project = {}) {
  const visualAnalyses = (project.visualSegments || []).flatMap((segment) => {
    const specs = [subjectEffectRenderSpec(segment), depthEffectRenderSpec(segment)].filter(Boolean);
    return specs.map((spec) => ({
      id: spec.analysis.record.analysisId,
      segmentId: segment.id,
      ...spec.analysis.artifact
    }));
  });
  return {
    visuals: project.visualSegments || [],
    overlays: visibleOverlays(project),
    stickers: visibleStickers(project),
    audioSegments: audibleSegments(project, project.audioSegments || [], "audio"),
    musicSegments: audibleSegments(project, project.musicSegments || [], "music"),
    // FORK: the video clips whose own sound plays — the browser export
    // extracts it per clip (embeddedVideoAudioExport); a headless host says
    // which of these files carry a sound stream through
    // `media.sourceAudioSegments`, and only those join the mix.
    sourceAudio: sourceAudioCandidates(project),
    analyses: visualAnalyses
  };
}
function sourceAudioCandidates(project) {
  if (project.trackVisibility?.source === false) return [];
  const volume = project.sourceAudioVolume ?? 1;
  const origin = project.sourceAudioSource;
  const hasSourceAudio = Boolean(origin?.assetVersionId || origin?.sourceUrl);
  const extracted = [];
  if (hasSourceAudio && Number(volume) !== 0) {
    const linked = project.sourceAudioLinked !== false ? getLinkedSourceAudioSegments(project.visualSegments || [], project.sourceAudioAssetId || "", project.sourceAudioDuration || 0) : [{ id: "source-audio", start: project.sourceAudioStart || 0, duration: project.sourceAudioDuration || 0, sourceStart: 0, sourceDuration: project.sourceAudioDuration || 0, playbackRate: 1 }];
    extracted.push(...linked.filter((segment) => segment.duration > 0).map((segment) => ({
      ...segment,
      ...origin,
      id: segment.id,
      volume,
      spatialEffect: project.sourceAudioSpatialEffect,
      spatialAmount: project.sourceAudioSpatialAmount
    })));
  }
  let cursor = 0;
  return [...extracted, ...(project.visualSegments || []).flatMap((segment) => {
    const start = cursor;
    cursor += Math.max(0, Number(segment.duration) || 0);
    if (getVisualAudioSource(segment, { hasSourceAudio, sourceAudioAssetId: project.sourceAudioAssetId, visualSegments: project.visualSegments }) !== "embedded") return [];
    return [{
      ...segment,
      start,
      volume: segment.volume ?? 1,
      sourceStart: Math.max(0, Number(segment.sourceStart) || 0),
      sourceDuration: Number(segment.sourceDuration) || segment.duration * (Number(segment.playbackRate) || 1)
    }];
  })];
}
function sourceAudioSegmentsForRender(project, entries) {
  const known = new Set(entries.map((entry) => entry.id));
  return sourceAudioCandidates(project).filter((segment) => known.has(segment.id));
}
function assColor(value, opacity = 1) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || ""));
  const hex = match?.[1] || "ffffff";
  const alpha = Math.round((1 - Math.max(0, Math.min(1, Number(opacity)))) * 255);
  return `&H${alpha.toString(16).padStart(2, "0")}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
}
function assTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(centiseconds / 36e4);
  const minutes = Math.floor(centiseconds % 36e4 / 6e3);
  const secs = Math.floor(centiseconds % 6e3 / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}
function assText(value) {
  return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}").replace(/\r?\n/g, "\\N");
}
function captionPoint(placement, width, height) {
  const named = {
    top: { x: 50, y: 18 },
    middle: { x: 50, y: 50 },
    bottom: { x: 50, y: 78 }
  };
  const point = typeof placement === "string" ? named[placement] || named.bottom : placement || named.bottom;
  const x = Number.isFinite(Number(point.x)) ? Number(point.x) : 50;
  const y = Number.isFinite(Number(point.y)) ? Number(point.y) : 78;
  return { x: Math.round(width * x / 100), y: Math.round(height * y / 100) };
}
function buildCaptionAss(project, width, height, duration, rendererResources = {}) {
  const captions = visibleCaptions(project);
  if (!captions.length) return null;
  const style = project.captionStyle || {};
  const scale = Math.min(width, height) / 360;
  const fontSize = Math.max(1, (Number(project.captionSize) || 14) * scale);
  const primary = assColor(style.textColor || "#f5fbff", 1);
  const backgroundOpacity = Number.isFinite(Number(style.backgroundOpacity)) ? Number(style.backgroundOpacity) : 0.62;
  const background = assColor(style.backgroundColor || "#05080d", backgroundOpacity);
  const outline = assColor(style.borderColor || "#ffffff", 1);
  const borderWidth = Math.max(0, Number(style.borderWidth) || 0) * scale;
  const shadow = Math.max(0, Number(style.shadowOpacity ?? 0.45)) > 0 ? Math.max(1, scale) * (style.effect === "neon" ? 2.6 : 1) : 0;
  const fontById = /* @__PURE__ */ new Map();
  const captionFonts = rendererResources.captionFonts || {};
  captions.forEach((caption) => {
    const fontId = caption.fontId || style.fontId || "default";
    if (fontById.has(fontId)) return;
    if (fontId === "default") {
      fontById.set(fontId, { id: fontId, family: "Arial", weight: 700 });
      return;
    }
    const resource = captionFonts[fontId];
    const catalogFont = getCaptionFont(fontId);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(fontId) || !resource || catalogFont.id !== fontId || typeof resource.path !== "string" || !resource.path.trim()) {
      throw renderError("MISSING_RENDER_RESOURCE", `Verified caption font is unavailable: ${fontId}`);
    }
    fontById.set(fontId, {
      id: fontId,
      family: catalogFont.family,
      weight: catalogFont.weight || 700,
      sourcePath: resource.path,
      filename: `caption-font-${fontId}.ttf`
    });
  });
  const fonts = [...fontById.values()];
  const styleNameById = new Map(fonts.map((font2, index) => [font2.id, index === 0 ? "Default" : `Font${index}`]));
  const events = captions.map((caption) => {
    const start = Math.max(0, Number(caption.start) || 0);
    const end = Math.min(duration, Number(caption.end));
    if (!caption.text || !Number.isFinite(end) || end <= start) {
      throw renderError("INVALID_PROJECT", `Caption ${caption.id || "unknown"} must have text and a positive time range`);
    }
    const point = captionPoint(caption.placement ?? project.captionPlacement ?? project.captionPosition, width, height);
    const fontId = caption.fontId || style.fontId || "default";
    return `Dialogue: 0,${assTimestamp(start)},${assTimestamp(end)},${styleNameById.get(fontId)},,0,0,0,,{\\pos(${point.x},${point.y})}${assText(caption.text)}`;
  });
  const assStyles = fonts.map((font2) => `Style: ${styleNameById.get(font2.id)},${font2.family},${fontSize.toFixed(2)},${primary},${primary},${outline},${background},${font2.weight >= 600 ? -1 : 0},0,0,0,100,100,0,0,3,${borderWidth.toFixed(2)},${shadow.toFixed(2)},5,0,0,0,1`);
  return {
    content: [
      "[Script Info]",
      "ScriptType: v4.00+",
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      "WrapStyle: 2",
      "ScaledBorderAndShadow: yes",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      ...assStyles,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...events,
      ""
    ].join("\n"),
    fontSidecars: fonts.filter((font2) => font2.sourcePath).map((font2) => ({ filename: font2.filename, sourcePath: font2.sourcePath }))
  };
}
function assertSupportedProject(project) {
  const unsupported = [];
  const overlays = visibleOverlays(project);
  const audio = audibleSegments(project, project.audioSegments || [], "audio");
  const music = audibleSegments(project, project.musicSegments || [], "music");
  const unresolvedMigrationWarnings = (project.vibedevMigrationWarnings || []).filter((warning) => !String(warning).endsWith(":loop-requires-native-fallback"));
  if (unresolvedMigrationWarnings.length) unsupported.push("unresolved migration features");
  if (project.captionStyle?.effect && !["none", "normal", "neon"].includes(project.captionStyle.effect)) unsupported.push("caption effects");
  if (visibleStickers(project).some((item) => item.type && item.type !== "image")) unsupported.push("sticker media types");
  if (overlays.some((item) => !["image", "video"].includes(item.type))) unsupported.push("overlay media types");
  if (overlays.some((item) => !isSupportedVisualMask(item.mask))) unsupported.push("overlay masks");
  overlays.forEach((item) => buildRegisteredEffectFfmpegChain(item.effects, { mediaType: item.type }));
  if (overlays.some((item) => !isSupportedVisualFilterId(item.filterId) || item.filter && item.filter !== "none")) unsupported.push("overlay filters");
  if (overlays.some((item) => hasUnsupportedVisualAnimation(item.animation))) unsupported.push("overlay animations");
  if (overlays.some((item) => item.vision || item.subjectEffect || item.depth || item.cinematicDepth?.enabled || item.photoParallax?.enabled)) unsupported.push("overlay effects");
  if (project.trackVisibility?.source !== false && (project.sourceAudioSegments || []).length) unsupported.push("source audio");
  if ((project.visualSegments || []).some((item) => item.transition?.id && item.transition.id !== "none" && !Object.hasOwn(TRANSITION_XFADE_IDS, item.transition.id) && !CUSTOM_TRANSITION_IDS.has(item.transition.id))) unsupported.push("transitions");
  (project.visualSegments || []).forEach((item) => buildRegisteredEffectFfmpegChain(item.effects, { mediaType: item.type }));
  if (!isSupportedVisualFilterId(project.selectedFilterId) || (project.visualSegments || []).some((item) => !isSupportedVisualFilterId(item.filterId) || hasUnsupportedVisualAnimation(item.animation) || !isSupportedVisualMask(item.mask) || item.filter && item.filter !== "none")) unsupported.push("visual effects");
  (project.visualSegments || []).forEach((item) => {
    const spec = subjectEffectRenderSpec(item);
    const depthSpec = depthEffectRenderSpec(item);
    if ((spec || depthSpec) && (item.baseTransform || hasVisualAnimation(item.animation) || normalizeRenderVisualKeyframes(item.keyframes).length || !isNoopOverlayMask(item.mask))) {
      unsupported.push("analysis effect transforms");
    }
    if (spec && depthSpec) unsupported.push("combined subject and depth effects");
  });
  if (unsupported.length) {
    throw renderError("UNSUPPORTED_RENDER_FEATURE", `Headless render does not yet support: ${[...new Set(unsupported)].join(", ")}`);
  }
}
function resolveVisualPath(segment, media, extractedFiles) {
  const entry = (media.visuals || []).find((item) => [segment.id, segment.archiveMediaId, segment.assetId].includes(item.id));
  const path = entry?.path ? extractedFiles.get(entry.path) : null;
  if (!path) throw renderError("MISSING_MEDIA", `Portable media is missing for visual clip: ${segment.id}`);
  return path;
}
function resolveOverlayPath(segment, media, extractedFiles) {
  const entry = (media.overlays || []).find((item) => [segment.id, segment.archiveMediaId, segment.assetId].includes(item.id));
  const path = entry?.path ? extractedFiles.get(entry.path) : null;
  if (!path) throw renderError("MISSING_MEDIA", `Portable media is missing for visual overlay: ${segment.id}`);
  return path;
}
function resolveStickerPath(segment, media, extractedFiles) {
  const entry = (media.stickers || []).find((item) => [segment.id, segment.archiveMediaId, segment.assetId].includes(item.id));
  const path = entry?.path ? extractedFiles.get(entry.path) : null;
  if (!path) throw renderError("MISSING_MEDIA", `Portable media is missing for Sticker: ${segment.id}`);
  return path;
}
function resolveAnalysisPath(spec, media, extractedFiles) {
  const entry = (media.analyses || []).find((item) => item.id === spec.analysis.record.analysisId);
  const path = entry?.path ? extractedFiles.get(entry.path) : null;
  if (!path) throw renderError("MISSING_MEDIA", `Portable analysis mask is missing: ${spec.analysis.record.analysisId}`);
  return path;
}
function ffmpegHexColor(value, fallback = "000000") {
  const match = /^#?([0-9a-f]{6})$/iu.exec(String(value || ""));
  return `0x${match?.[1] || fallback}`;
}
function addSubjectEffectSource({
  args,
  filters,
  inputs,
  segment,
  index,
  visualInput,
  trim,
  visualFilterSuffix,
  colorGradeSuffix,
  media,
  extractedFiles,
  width,
  height,
  frameRate,
  clipDuration
}) {
  const spec = subjectEffectRenderSpec(segment);
  if (!spec) return null;
  const maskPath = resolveAnalysisPath(spec, media, extractedFiles);
  const maskInput = inputs.count++;
  const isImageMask = String(spec.analysis.artifact.mimeType || "").startsWith("image/");
  if (isImageMask) args.push("-loop", "1", "-t", String(clipDuration), "-i", maskPath);
  else args.push("-i", maskPath);
  const source = `[vsubjectsource${index}]`;
  const mask = `[vsubjectmask${index}]`;
  filters.push(`${visualInput}${trim}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black${visualFilterSuffix}${colorGradeSuffix},fps=${frameRate},setsar=1,format=rgba,setpts=PTS-STARTPTS${source}`);
  filters.push(`[${maskInput}:v]trim=duration=${graphNumber(clipDuration)},scale=${width}:${height},fps=${frameRate},format=gray,setpts=PTS-STARTPTS${mask}`);
  const effect = spec.effect;
  const outlineEnabled = effect.outline.enabled && effect.outline.width > 0;
  const maskLabels = outlineEnabled ? [`[vsubjectmaskcut${index}]`, `[vsubjectmaskgrow${index}]`, `[vsubjectmaskinner${index}]`] : [`[vsubjectmaskcut${index}]`];
  filters.push(`${mask}${maskLabels.length > 1 ? `split=${maskLabels.length}${maskLabels.join("")}` : `null${maskLabels[0]}`}`);
  const background = `[vsubjectbackground${index}]`;
  const subjectInput = `[vsubjectinput${index}]`;
  if (effect.background.visible === false) {
    filters.push(`${source}null${subjectInput}`);
    filters.push(`color=c=black:s=${width}x${height}:r=${frameRate}:d=${graphNumber(clipDuration)},format=rgba${background}`);
  } else if (effect.background.mode === "color") {
    filters.push(`${source}null${subjectInput}`);
    filters.push(`color=c=${ffmpegHexColor(effect.background.color)}:s=${width}x${height}:r=${frameRate}:d=${graphNumber(clipDuration)},format=rgba${background}`);
  } else {
    const backgroundInput = `[vsubjectbackgroundinput${index}]`;
    filters.push(`${source}split=2${subjectInput}${backgroundInput}`);
    filters.push(effect.background.mode === "blur" ? `${backgroundInput}gblur=sigma=${graphNumber(Math.max(0.1, effect.background.blur))}${background}` : `${backgroundInput}null${background}`);
  }
  const cutout = `[vsubjectcutout${index}]`;
  filters.push(`${subjectInput}${maskLabels[0]}alphamerge${cutout}`);
  let composite = background;
  if (outlineEnabled) {
    const grown = `[vsubjectgrown${index}]`;
    const outlineMask = `[vsubjectoutlinemask${index}]`;
    const outlineColor = `[vsubjectoutlinecolor${index}]`;
    const outlineLayer = `[vsubjectoutline${index}]`;
    const dilation = new Array(Math.max(1, Math.round(effect.outline.width))).fill("dilation=coordinates=255").join(",");
    filters.push(`${maskLabels[1]}${dilation}${grown}`);
    filters.push(`${grown}${maskLabels[2]}blend=all_mode=subtract${outlineMask}`);
    filters.push(`color=c=${ffmpegHexColor(effect.outline.color, "ffffff")}:s=${width}x${height}:r=${frameRate}:d=${graphNumber(clipDuration)},format=rgba${outlineColor}`);
    filters.push(`${outlineColor}${outlineMask}alphamerge,colorchannelmixer=aa=${graphNumber(effect.outline.opacity)}${outlineLayer}`);
    const outlined = `[vsubjectoutlined${index}]`;
    filters.push(`${background}${outlineLayer}overlay=eof_action=pass:repeatlast=1${outlined}`);
    composite = outlined;
  }
  filters.push(`${composite}${cutout}overlay=eof_action=pass:repeatlast=1,format=yuv420p[v${index}]`);
  return `[v${index}]`;
}
function addDepthEffectSource({
  args,
  filters,
  inputs,
  segment,
  index,
  visualInput,
  trim,
  visualFilterSuffix,
  colorGradeSuffix,
  media,
  extractedFiles,
  width,
  height,
  frameRate,
  clipDuration
}) {
  const spec = depthEffectRenderSpec(segment);
  if (!spec) return null;
  const depthPath = resolveAnalysisPath(spec, media, extractedFiles);
  const depthInput = inputs.count++;
  const isImageDepth = String(spec.analysis.artifact.mimeType || "").startsWith("image/");
  if (isImageDepth) args.push("-loop", "1", "-t", String(clipDuration), "-i", depthPath);
  else args.push("-i", depthPath);
  const source = `[vdepthsource${index}]`;
  const depth = `[vdepthmap${index}]`;
  filters.push(`${visualInput}${trim}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black${visualFilterSuffix}${colorGradeSuffix},fps=${frameRate},setsar=1,format=rgba,setpts=PTS-STARTPTS${source}`);
  filters.push(`[${depthInput}:v]trim=duration=${graphNumber(clipDuration)},scale=${width}:${height},fps=${frameRate},format=gray,setpts=PTS-STARTPTS${depth}`);
  if (spec.cinematicDepth.enabled) {
    const sharp = `[vdepthsharp${index}]`;
    const blurInput = `[vdepthblurinput${index}]`;
    const blurred = `[vdepthblurred${index}]`;
    const blurMask = `[vdepthblurmask${index}]`;
    const blurLayer = `[vdepthblurlayer${index}]`;
    const focus = Math.round(spec.cinematicDepth.focus * 255);
    const range = Math.round(spec.cinematicDepth.focusRange * 255);
    filters.push(`${source}split=2${sharp}${blurInput}`);
    filters.push(`${blurInput}gblur=sigma=${graphNumber(spec.cinematicDepth.blur)},format=rgba${blurred}`);
    filters.push(`${depth}lut=y='if(gt(abs(val-${focus}),${range}),255,0)'${blurMask}`);
    filters.push(`${blurred}${blurMask}alphamerge${blurLayer}`);
    filters.push(`${sharp}${blurLayer}overlay=eof_action=pass:repeatlast=1,format=yuv420p[v${index}]`);
    return `[v${index}]`;
  }
  const effect = spec.photoParallax;
  const background = `[vparallaxbackground${index}]`;
  const foregroundInput = `[vparallaxforegroundinput${index}]`;
  const foregroundMask = `[vparallaxmask${index}]`;
  const foreground = `[vparallaxforeground${index}]`;
  const amplitude = Math.round(Math.min(width, height) * 0.045 * effect.strength);
  const threshold = Math.round(effect.foregroundDepth * 255);
  const phase = `${graphNumber(effect.speed * Math.PI / 2)}*t`;
  filters.push(`${source}split=2${background}${foregroundInput}`);
  filters.push(`${depth}lut=y='if(gte(val,${threshold}),255,0)'${foregroundMask}`);
  filters.push(`${foregroundInput}${foregroundMask}alphamerge,scale=w='trunc(iw*${graphNumber(effect.zoom)}/2)*2':h='trunc(ih*${graphNumber(effect.zoom)}/2)*2'${foreground}`);
  const backgroundScaled = `[vparallaxbgscaled${index}]`;
  filters.push(`${background}scale=w='trunc(iw*${graphNumber(effect.zoom + 0.055)}/2)*2':h='trunc(ih*${graphNumber(effect.zoom + 0.055)}/2)*2',crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2${backgroundScaled}`);
  const x = effect.direction === "vertical" ? `-${amplitude}*0.16*cos(${phase})` : `-${amplitude}*sin(${phase})`;
  const y = effect.direction === "horizontal" ? `-${amplitude}*0.16*cos(${phase})` : `-${Math.round(amplitude * 0.62)}*cos(${phase})`;
  filters.push(`${backgroundScaled}${foreground}overlay=x='(W-w)/2+(${x})':y='(H-h)/2+(${y})':eval=frame:eof_action=pass:repeatlast=1,format=yuv420p[v${index}]`);
  return `[v${index}]`;
}
function finiteNumber(value, fallback = 0) {
  const number2 = Number(value);
  return Number.isFinite(number2) ? number2 : fallback;
}
function graphNumber(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}
function normalizedTimeRemapRuntime(segment, name) {
  let runtime = segment?.vibedevTimeRemapRuntime;
  if (!runtime && segment?.speedCurve?.enabled) {
    const duration2 = finitePositive(segment.duration, `${name} speed curve duration`);
    const pointCount = Array.isArray(segment.speedCurve.points) ? segment.speedCurve.points.length : 0;
    const sliceCount = Math.max(12, Math.min(48, pointCount * 12));
    runtime = {
      duration: duration2,
      segments: Array.from({ length: sliceCount }, (_, index) => {
        const timelineStart = duration2 * index / sliceCount;
        const timelineEnd = duration2 * (index + 1) / sliceCount;
        const sourceInSeconds = getFinalSpeedCurveSourceTime(segment, timelineStart);
        const sourceOutSeconds = getFinalSpeedCurveSourceTime(segment, timelineEnd);
        const durationSeconds = timelineEnd - timelineStart;
        return {
          kind: "play",
          sourceInSeconds,
          sourceOutSeconds,
          durationSeconds,
          rate: Math.max(0.25, Math.min(4, Math.abs(sourceOutSeconds - sourceInSeconds) / durationSeconds)),
          reverse: sourceOutSeconds < sourceInSeconds
        };
      })
    };
  }
  if (!runtime) return null;
  if (!Array.isArray(runtime.segments) || runtime.segments.length < 1 || runtime.segments.length > 64) {
    throw renderError("INVALID_PROJECT", `${name} time remap must contain 1-64 steps`);
  }
  const steps = runtime.segments.map((step, index) => {
    const durationSeconds = finitePositive(step?.durationSeconds, `${name} time remap step ${index + 1} duration`);
    if (step?.kind === "freeze") {
      const sourceSeconds = Number(step.sourceSeconds);
      if (!Number.isFinite(sourceSeconds) || sourceSeconds < 0) {
        throw renderError("INVALID_PROJECT", `${name} freeze step ${index + 1} has an invalid source time`);
      }
      return { kind: "freeze", sourceSeconds, durationSeconds };
    }
    if (step?.kind !== "play") {
      throw renderError("INVALID_PROJECT", `${name} time remap step ${index + 1} has an invalid kind`);
    }
    const sourceInSeconds = Number(step.sourceInSeconds);
    const sourceOutSeconds = Number(step.sourceOutSeconds);
    const rate = Number(step.rate);
    if (!Number.isFinite(sourceInSeconds) || !Number.isFinite(sourceOutSeconds) || sourceInSeconds < 0 || sourceOutSeconds < 0 || Math.abs(sourceOutSeconds - sourceInSeconds) < 1e-3 || !Number.isFinite(rate) || rate < 0.25 || rate > 4) {
      throw renderError("INVALID_PROJECT", `${name} play step ${index + 1} is invalid`);
    }
    return {
      kind: "play",
      sourceInSeconds,
      sourceOutSeconds,
      durationSeconds,
      rate,
      reverse: step.reverse === true || sourceOutSeconds < sourceInSeconds
    };
  });
  const duration = finitePositive(runtime.duration, `${name} time remap duration`);
  const summedDuration = steps.reduce((total, step) => total + step.durationSeconds, 0);
  if (Math.abs(duration - summedDuration) > 0.05 || Math.abs(duration - Number(segment.duration)) > 0.05) {
    throw renderError("INVALID_PROJECT", `${name} time remap duration does not match its clip`);
  }
  return { duration, steps };
}
function addRemappedVideoSource({ filters, inputIndex, segment, prefix, frameRate }) {
  const runtime = normalizedTimeRemapRuntime(segment, `Visual clip ${segment.id || prefix}`);
  if (!runtime) return null;
  const inputLabels = runtime.steps.map((_, index) => `[${prefix}step${index}in]`);
  if (runtime.steps.length === 1) filters.push(`[${inputIndex}:v]null${inputLabels[0]}`);
  else filters.push(`[${inputIndex}:v]split=${runtime.steps.length}${inputLabels.join("")}`);
  const outputLabels = runtime.steps.map((step, index) => {
    const output2 = `[${prefix}step${index}]`;
    if (step.kind === "freeze") {
      const frameEnd = step.sourceSeconds + 1 / frameRate;
      filters.push(`${inputLabels[index]}trim=start=${graphNumber(step.sourceSeconds)}:end=${graphNumber(frameEnd)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${graphNumber(step.durationSeconds)},trim=duration=${graphNumber(step.durationSeconds)},setpts=PTS-STARTPTS${output2}`);
    } else {
      const sourceStart = Math.min(step.sourceInSeconds, step.sourceOutSeconds);
      const sourceDuration = Math.abs(step.sourceOutSeconds - step.sourceInSeconds);
      filters.push(`${inputLabels[index]}trim=start=${graphNumber(sourceStart)}:duration=${graphNumber(sourceDuration)},${step.reverse ? "reverse," : ""}setpts=(PTS-STARTPTS)/${graphNumber(step.rate)},trim=duration=${graphNumber(step.durationSeconds)},setpts=PTS-STARTPTS${output2}`);
    }
    return output2;
  });
  const output = `[${prefix}]`;
  filters.push(`${outputLabels.join("")}concat=n=${outputLabels.length}:v=1:a=0${output}`);
  return output;
}
function addRemappedAudioSource({ filters, inputIndex, segment, prefix }) {
  const runtime = normalizedTimeRemapRuntime(segment, `Audio clip ${segment.id || prefix}`);
  if (!runtime) return null;
  const playSteps = runtime.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.kind === "play");
  const playInputs = /* @__PURE__ */ new Map();
  if (playSteps.length === 1) {
    playInputs.set(playSteps[0].index, `[${prefix}play${playSteps[0].index}in]`);
    filters.push(`[${inputIndex}:a]anull${playInputs.get(playSteps[0].index)}`);
  } else if (playSteps.length > 1) {
    const labels = playSteps.map(({ index }) => `[${prefix}play${index}in]`);
    filters.push(`[${inputIndex}:a]asplit=${labels.length}${labels.join("")}`);
    playSteps.forEach(({ index }, position) => playInputs.set(index, labels[position]));
  }
  const outputLabels = runtime.steps.map((step, index) => {
    const output2 = `[${prefix}step${index}]`;
    if (step.kind === "freeze") {
      filters.push(`anullsrc=r=48000:cl=stereo:d=${graphNumber(step.durationSeconds)}${output2}`);
    } else {
      const sourceStart = Math.min(step.sourceInSeconds, step.sourceOutSeconds);
      const sourceDuration = Math.abs(step.sourceOutSeconds - step.sourceInSeconds);
      filters.push(`${playInputs.get(index)}atrim=start=${graphNumber(sourceStart)}:duration=${graphNumber(sourceDuration)},${step.reverse ? "areverse," : ""}asetpts=PTS-STARTPTS,${atempoChain(step.rate)},atrim=duration=${graphNumber(step.durationSeconds)},aformat=sample_rates=48000:channel_layouts=stereo${output2}`);
    }
    return output2;
  });
  const output = `[${prefix}source]`;
  filters.push(`${outputLabels.join("")}concat=n=${outputLabels.length}:v=0:a=1${output}`);
  return output;
}
function normalizeRenderVisualTransform(value = {}) {
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    scale: Math.max(0.1, Number(value.scale) || 1),
    rotation: Number(value.rotation) || 0,
    opacity: Math.max(0, Math.min(1, Number.isFinite(Number(value.opacity)) ? Number(value.opacity) : 1))
  };
}
function normalizeRenderVisualKeyframes(keyframes = []) {
  return keyframes.filter((frame) => frame && Number.isFinite(Number(frame.time))).map((frame) => ({ ...frame, time: Math.max(0, Number(frame.time)) })).sort((left, right) => left.time - right.time).reduce((frames, frame) => {
    const previous = frames.at(-1);
    if (!previous || Math.abs(previous.time - frame.time) > 0.04) {
      frames.push(frame);
    } else {
      frames[frames.length - 1] = { ...previous, ...frame };
    }
    return frames;
  }, []);
}
function visualPropertyValue(field, value) {
  const number2 = Number(value);
  if (field === "scale") return Math.max(0.1, number2 || 1);
  if (field === "opacity") return Math.max(0, Math.min(1, Number.isFinite(number2) ? number2 : 1));
  return number2 || 0;
}
function interpolateVisualExpression(left, right, timeExpression) {
  if (Math.abs(left.value - right.value) < 1e-9) return graphNumber(left.value);
  const duration = Math.max(1e-4, right.time - left.time);
  return `(${graphNumber(left.value)}+(${graphNumber(right.value - left.value)})*((${timeExpression}-${graphNumber(left.time)})/${graphNumber(duration)}))`;
}
function visualFieldExpression(transform, keyframes, field, timeExpression) {
  const base = normalizeRenderVisualTransform(transform)[field];
  const points = normalizeRenderVisualKeyframes(keyframes).filter((frame) => Number.isFinite(Number(frame[field]))).map((frame) => ({
    time: Math.max(0, Number(frame.time) || 0),
    value: visualPropertyValue(field, frame[field])
  }));
  if (!points.length) return graphNumber(base);
  let expression = graphNumber(points.at(-1).value);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const left = points[index];
    const right = points[index + 1];
    expression = `if(lte(${timeExpression},${graphNumber(right.time)}),${interpolateVisualExpression(left, right, timeExpression)},${expression})`;
  }
  const first = points[0];
  return first.time > 0 ? `if(lt(${timeExpression},${graphNumber(first.time)}),${graphNumber(base)},${expression})` : expression;
}
function animationPhaseFieldExpression(phase, direction, field, timeExpression, clipDuration) {
  if (phase.id === "none" || field === "rotation") return ["scale", "opacity"].includes(field) ? "1" : "0";
  const duration = graphNumber(phase.duration);
  const start = graphNumber(Math.max(0, clipDuration - phase.duration));
  const active = direction === "in" ? `lt(${timeExpression},${duration})` : `gt(${timeExpression},${start})`;
  const remaining = direction === "in" ? `pow(1-${timeExpression}/${duration},3)` : `pow((${timeExpression}-${start})/${duration},3)`;
  if (field === "opacity" && phase.id === "fade") return `if(${active},(1-${remaining}),1)`;
  if (field === "scale" && phase.id === "zoom") return `if(${active},(1-0.18*${remaining}),1)`;
  if (field === "x" && phase.id === "slide-left") return `if(${active},-18*${remaining},0)`;
  if (field === "y" && phase.id === "slide-up") return `if(${active},18*${remaining},0)`;
  return ["scale", "opacity"].includes(field) ? "1" : "0";
}
function animatedVisualFieldExpression(transform, keyframes, animation, clipDuration, field, timeExpression) {
  const base = visualFieldExpression(transform, keyframes, field, timeExpression);
  if (!hasVisualAnimation(animation) || field === "rotation") return base;
  const incoming = animationPhaseFieldExpression(animationPhase(animation?.in), "in", field, timeExpression, clipDuration);
  const outgoing = animationPhaseFieldExpression(animationPhase(animation?.out), "out", field, timeExpression, clipDuration);
  if (["scale", "opacity"].includes(field)) {
    if (incoming === "1" && outgoing === "1") return base;
    return `(${base})*(${incoming})*(${outgoing})`;
  }
  if (incoming === "0" && outgoing === "0") return base;
  return `(${base})+(${incoming})+(${outgoing})`;
}
function visualMaskAlphaExpression(mask) {
  if (isNoopOverlayMask(mask)) return "";
  const centerX = graphNumber(Number(mask.centerX ?? 50) / 100);
  const centerY = graphNumber(Number(mask.centerY ?? 50) / 100);
  let distance;
  let featherBase;
  if (mask.type === "circle") {
    const diameter = graphNumber(Number(mask.size ?? 72) / 100);
    const radius = graphNumber(Number(mask.size ?? 72) / 200);
    distance = `sqrt(pow(X-W*${centerX},2)+pow(Y-H*${centerY},2))-min(W,H)*${radius}`;
    featherBase = `min(W,H)*${diameter}`;
  } else {
    const width = graphNumber(Number(mask.width ?? 80) / 100);
    const height = graphNumber(Number(mask.height ?? 80) / 100);
    const halfWidth = graphNumber(Number(mask.width ?? 80) / 200);
    const halfHeight = graphNumber(Number(mask.height ?? 80) / 200);
    const radiusRatio = mask.type === "rounded" ? graphNumber(Number(mask.cornerRadius ?? 12) / 100) : "0";
    const radius = `min(W*${width},H*${height})*${radiusRatio}`;
    const qx = `abs(X-W*${centerX})-W*${halfWidth}+(${radius})`;
    const qy = `abs(Y-H*${centerY})-H*${halfHeight}+(${radius})`;
    distance = `sqrt(pow(max(${qx},0),2)+pow(max(${qy},0),2))+min(max(${qx},${qy}),0)-(${radius})`;
    featherBase = `min(W*${width},H*${height})`;
  }
  const feather = Number(mask.feather ?? 0);
  const alpha = feather > 0 ? `clip(0.5-(${distance})/(2*(${featherBase})*${graphNumber(feather / 400)}),0,1)` : `if(lte(${distance},0),1,0)`;
  return mask.inverted === true ? `1-(${alpha})` : alpha;
}
function visualMaskFilter(mask) {
  const alpha = visualMaskAlphaExpression(mask);
  return alpha ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${alpha})'` : "";
}
function addStickerOverlays({ args, filters, inputs, stickers, media, extractedFiles, width, height, frameRate, inputLabel }) {
  const baseSize = Math.max(1, Math.min(width, height) * 0.22);
  return stickers.reduce((baseLabel, segment, index) => {
    const path = resolveStickerPath(segment, media, extractedFiles);
    const start = Math.max(0, finiteNumber(segment.start));
    const duration = Math.max(1e-3, finiteNumber(segment.duration));
    const inputIndex = inputs.count++;
    const animated = segment.animated === true || /\.(?:gif|webp)$/iu.test(path);
    if (animated) args.push("-stream_loop", "-1", "-t", String(duration), "-i", path);
    else args.push("-loop", "1", "-t", String(duration), "-i", path);
    const keyframes = normalizeRenderVisualKeyframes(segment.keyframes || []);
    const localScale = visualFieldExpression(segment, keyframes, "scale", "t");
    const localRotation = visualFieldExpression(segment, keyframes, "rotation", "t");
    const localOpacity = visualFieldExpression(segment, keyframes, "opacity", "T");
    const widthExpression = `if(gte(iw/ih,1),${graphNumber(baseSize)}*(${localScale}),${graphNumber(baseSize)}*(${localScale})*iw/ih)`;
    const heightExpression = `if(gte(iw/ih,1),${graphNumber(baseSize)}*(${localScale})/(iw/ih),${graphNumber(baseSize)}*(${localScale}))`;
    const stickerLabel = `[sticker${index}]`;
    filters.push(`[${inputIndex}:v]scale=w='max(2,trunc((${widthExpression})/2)*2)':h='max(2,trunc((${heightExpression})/2)*2)':eval=frame,rotate=angle='PI/180*(${localRotation})':ow=rotw(iw):oh=roth(ih):c=none,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${localOpacity})',fps=${frameRate},setpts=PTS-STARTPTS+${graphNumber(start)}/TB${stickerLabel}`);
    const localTimelineTime = start === 0 ? "t" : `(t-${graphNumber(start)})`;
    const x = visualFieldExpression(segment, keyframes, "x", localTimelineTime);
    const y = visualFieldExpression(segment, keyframes, "y", localTimelineTime);
    const outputLabel = `[vsticker${index}]`;
    filters.push(`${baseLabel}${stickerLabel}overlay=x='(${x})/100*W-w/2':y='(${y})/100*H-h/2':eval=frame:eof_action=pass:repeatlast=0:enable='gte(t,${graphNumber(start)})*lt(t,${graphNumber(start + duration)})'${outputLabel}`);
    return outputLabel;
  }, inputLabel);
}
function addVisualOverlays({ args, filters, inputs, overlays, media, extractedFiles, width, height, frameRate, inputLabel }) {
  return overlays.reduce((baseLabel, segment, index) => {
    const path = resolveOverlayPath(segment, media, extractedFiles);
    const overlayDuration = finitePositive(segment.duration, `Visual overlay ${segment.id} duration`);
    const start = Math.max(0, finiteNumber(segment.start));
    const inputIndex = inputs.count++;
    if (segment.type === "image") args.push("-loop", "1", "-t", String(overlayDuration), "-i", path);
    else args.push("-i", path);
    const remappedInput = segment.type === "video" ? addRemappedVideoSource({ filters, inputIndex, segment, prefix: `voverlayremap${index}`, frameRate }) : null;
    const visualInput = remappedInput || `[${inputIndex}:v]`;
    const sourceStart = Math.max(0, finiteNumber(segment.sourceStart));
    const rate = Math.max(0.25, Math.min(4, finiteNumber(segment.playbackRate, 1)));
    const sourceDuration = Math.max(1e-3, finiteNumber(segment.sourceDuration, overlayDuration * rate));
    const transform = segment.baseTransform || {};
    const keyframes = normalizeRenderVisualKeyframes(segment.keyframes || []);
    const dynamic = keyframes.length > 0 || hasVisualAnimation(segment.animation);
    const x = finiteNumber(transform.x);
    const y = finiteNumber(transform.y);
    const rawScale = finiteNumber(transform.scale, 1);
    const scale = Math.max(0.1, rawScale === 0 ? 1 : rawScale);
    const rotation = finiteNumber(transform.rotation);
    const opacity = Math.max(0, Math.min(1, finiteNumber(transform.opacity, 1)));
    const scaledWidth = Math.max(2, Math.round(width * scale / 2) * 2);
    const scaledHeight = Math.max(2, Math.round(height * scale / 2) * 2);
    const trim = segment.type === "video" && !remappedInput ? `trim=start=${graphNumber(sourceStart)}:duration=${graphNumber(sourceDuration)},setpts=(PTS-STARTPTS)/${graphNumber(rate)},` : "";
    const dynamicScale = animatedVisualFieldExpression(transform, keyframes, segment.animation, overlayDuration, "scale", "t");
    const dynamicRotation = visualFieldExpression(transform, keyframes, "rotation", "t");
    const dynamicOpacity = animatedVisualFieldExpression(transform, keyframes, segment.animation, overlayDuration, "opacity", "T");
    const rotate = dynamic ? `,rotate=angle='PI/180*(${dynamicRotation})':ow=rotw(iw):oh=roth(ih):c=none` : Math.abs(rotation) > 1e-9 ? `,rotate=angle=${graphNumber(rotation)}*PI/180:ow=rotw(iw):oh=roth(ih):c=none` : "";
    const overlayLabel = `[overlay${index}]`;
    const mask = visualMaskFilter(segment.mask);
    const visualFilter = [
      visualFilterChain(segment.filterId),
      buildRegisteredEffectFfmpegChain(segment.effects, { mediaType: segment.type })
    ].filter(Boolean).join(",");
    const colorGradeFilter = buildFfmpegColorGradeFilter(segment.colorGrade, segment.keyframes, "T");
    const colorGradeSuffix = colorGradeFilter ? `,${colorGradeFilter}` : "";
    const transformFilters = dynamic ? `scale=w='max(2,trunc(iw*(${dynamicScale})/2)*2)':h='max(2,trunc(ih*(${dynamicScale})/2)*2)':eval=frame${rotate},geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${dynamicOpacity})'` : `scale=${scaledWidth}:${scaledHeight}${rotate},colorchannelmixer=aa=${graphNumber(opacity)}`;
    filters.push(`${visualInput}${trim}scale=${width}:${height}:force_original_aspect_ratio=decrease,format=rgba${visualFilter ? `,${visualFilter}` : ""}${colorGradeSuffix}${mask},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=${frameRate},setsar=1,${transformFilters},setpts=PTS-STARTPTS+${graphNumber(start)}/TB${overlayLabel}`);
    const outputLabel = `[vcomposite${index}]`;
    if (dynamic) {
      const localTime = start === 0 ? "t" : `(t-${graphNumber(start)})`;
      const xExpression = animatedVisualFieldExpression(transform, keyframes, segment.animation, overlayDuration, "x", localTime);
      const yExpression = animatedVisualFieldExpression(transform, keyframes, segment.animation, overlayDuration, "y", localTime);
      filters.push(`${baseLabel}${overlayLabel}overlay=x='(W-w)/2+(${xExpression})/100*W':y='(H-h)/2+(${yExpression})/100*H':eval=frame:eof_action=pass:repeatlast=0:enable='between(t,${graphNumber(start)},${graphNumber(start + overlayDuration)})'${outputLabel}`);
    } else {
      const xOffset = graphNumber(x / 100 * width);
      const yOffset = graphNumber(y / 100 * height);
      filters.push(`${baseLabel}${overlayLabel}overlay=x=(W-w)/2${x < 0 ? "" : "+"}${xOffset}:y=(H-h)/2${y < 0 ? "" : "+"}${yOffset}:eof_action=pass:repeatlast=0:enable='between(t,${graphNumber(start)},${graphNumber(start + overlayDuration)})'${outputLabel}`);
    }
    return outputLabel;
  }, inputLabel);
}
function addAudioTrack({ args, filters, inputs, segments, mediaEntry, mediaEntries = [], extractedFiles, duration, prefix, defaultVolume = 1 }) {
  if (!segments.length) return [];
  return segments.filter((segment) => segment.muted !== true && Number(segment.volume ?? defaultVolume) !== 0).map((segment, index) => {
    if (segment.availableSourceDuration !== void 0 && segment.availableSourceDuration < segment.sourceDuration) throw renderError("INVALID_PROJECT", "Speed curve extends beyond the saved source audio; repair the source range before rendering");
    const segmentEntry = mediaEntries.find((entry) => [segment.id, segment.archiveMediaId].includes(entry.id)) || mediaEntry;
    const path = segmentEntry?.path ? extractedFiles.get(segmentEntry.path) : null;
    if (!path) throw renderError("MISSING_MEDIA", `Portable media is missing for ${prefix} clip: ${segment.id}`);
    const inputIndex = inputs.count++;
    const loop = segment.vibedevLoop === true;
    if (loop) args.push("-stream_loop", "-1");
    args.push("-i", path);
    const rate = Math.max(0.25, Math.min(4, Number(segment.playbackRate) || 1));
    const sourceStart = Math.max(0, Number(segment.sourceStart) || 0);
    const segmentDuration = finitePositive(segment.duration, `${prefix} duration`);
    const sourceDuration = loop ? segmentDuration * rate : Math.max(1e-3, Number(segment.sourceDuration) || segmentDuration * rate);
    const start = Math.max(0, Number(segment.start) || 0);
    const volume = Math.max(0, Math.min(4, Number.isFinite(Number(segment.volume)) ? Number(segment.volume) : defaultVolume));
    const fadeIn = Math.min(segmentDuration / 2, Math.max(0, Number(segment.fadeIn) || 0));
    const fadeOut = Math.min(segmentDuration / 2, Math.max(0, Number(segment.fadeOut) || 0));
    const label = `${prefix}${index}`;
    const tempo = Math.abs(rate - 1) < 1e-6 ? "" : `${atempoChain(rate)},`;
    const remappedSource = addRemappedAudioSource({
      filters,
      inputIndex,
      segment,
      prefix: `${label}remap`
    });
    const fades = [
      fadeIn > 0 ? `afade=t=in:st=0:d=${graphNumber(fadeIn)}` : "",
      fadeOut > 0 ? `afade=t=out:st=${graphNumber(segmentDuration - fadeOut)}:d=${graphNumber(fadeOut)}` : ""
    ].filter(Boolean).join(",");
    const envelope = volumeEnvelopeExpression(segment.volumeEnvelope, segmentDuration);
    const automation = envelope ? `,volume='${envelope}':eval=frame` : "";
    const preset = getAudioSpatialEffect(segment.spatialEffect);
    const spatialAmount = normalizeAudioSpatialAmount(segment.spatialAmount);
    if (preset.id === "original" || spatialAmount <= 0) {
      if (remappedSource) {
        filters.push(`${remappedSource}${fades || "anull"},volume=${volume}${automation},adelay=${Math.round(start * 1e3)}:all=1,asetpts=N/SR/TB,apad,atrim=duration=${duration}[${label}]`);
      } else {
        filters.push(`[${inputIndex}:a]atrim=start=${sourceStart}:duration=${sourceDuration},asetpts=PTS-STARTPTS,${tempo}atrim=duration=${graphNumber(segmentDuration)}${fades ? `,${fades}` : ""},volume=${volume}${automation},adelay=${Math.round(start * 1e3)}:all=1,asetpts=N/SR/TB,apad,atrim=duration=${duration}[${label}]`);
      }
      return `[${label}]`;
    }
    const sourceLabel = `[${label}source]`;
    const dryInputLabel = `[${label}spatialdryin]`;
    const wetInputLabel = `[${label}spatialwetin]`;
    const dryLabel = `[${label}spatialdry]`;
    const wetLabel = `[${label}spatialwet]`;
    const spatialLabel = `[${label}spatial]`;
    const dryGain = 1 - spatialAmount * (1 - preset.dry);
    const wetGain = preset.wet * spatialAmount;
    const outputGain = 1 - spatialAmount * (1 - preset.output);
    const diffuseTail = Array.from({ length: 16 }, (_, tailIndex) => {
      const progress = (tailIndex + 1) / 16;
      return [
        preset.duration * progress,
        4e-3 + 0.04 * Math.pow(1 - progress, preset.decay)
      ];
    });
    const echoes = [
      ...preset.reflections,
      ...diffuseTail
    ].map(([seconds, gain]) => [Math.max(1, Math.round(seconds * 1e3)), Math.max(1e-3, Math.min(0.99, gain))]).filter(([delay], index2, values) => values.findIndex(([candidate]) => candidate === delay) === index2);
    const echoDelays = echoes.map(([delay]) => delay).join("|");
    const echoDecays = echoes.map(([, gain]) => graphNumber(gain)).join("|");
    const wetDuration = segmentDuration + preset.preDelay + preset.duration;
    if (remappedSource) filters.push(`${remappedSource}anull${sourceLabel}`);
    else filters.push(`[${inputIndex}:a]atrim=start=${sourceStart}:duration=${sourceDuration},asetpts=PTS-STARTPTS,${tempo}atrim=duration=${graphNumber(segmentDuration)},aformat=sample_rates=48000:channel_layouts=stereo${sourceLabel}`);
    filters.push(`${sourceLabel}asplit=2${dryInputLabel}${wetInputLabel}`);
    filters.push(`${dryInputLabel}volume=${graphNumber(dryGain)}${dryLabel}`);
    filters.push(`${wetInputLabel}adelay=${Math.round(preset.preDelay * 1e3)}:all=1,apad=pad_dur=${graphNumber(preset.duration)},aecho=1:1:${echoDelays}:${echoDecays},lowpass=f=${graphNumber(preset.tone)},atrim=duration=${graphNumber(wetDuration)},volume=${graphNumber(wetGain)}${wetLabel}`);
    filters.push(`${dryLabel}${wetLabel}amix=inputs=2:duration=longest:normalize=0,asetpts=N/SR/TB,volume=${graphNumber(outputGain)}${spatialLabel}`);
    filters.push(`${spatialLabel}${fades || "anull"},volume=${volume}${automation},adelay=${Math.round(start * 1e3)}:all=1,asetpts=N/SR/TB,apad,atrim=duration=${duration}[${label}]`);
    return `[${label}]`;
  });
}
function volumeEnvelopeExpression(value, duration) {
  const points = Array.isArray(value) ? value : [];
  if (!points.length) return "";
  let previous = -1;
  const normalized = points.map((point) => {
    const time = Number(point?.time);
    const gain = Number(point?.gain);
    if (!Number.isFinite(time) || time < 0 || time > duration || time <= previous || !Number.isFinite(gain) || gain < 0 || gain > 4) {
      throw renderError("INVALID_PROJECT", "BGM volume envelope is invalid");
    }
    previous = time;
    return { time, gain };
  });
  if (normalized.length === 1) return graphNumber(normalized[0].gain);
  let expression = graphNumber(normalized.at(-1).gain);
  for (let index = normalized.length - 2; index >= 0; index -= 1) {
    const from = normalized[index];
    const to = normalized[index + 1];
    const interpolation = `${graphNumber(from.gain)}+(${graphNumber(to.gain - from.gain)})*(t-${graphNumber(from.time)})/${graphNumber(to.time - from.time)}`;
    expression = `if(lt(t,${graphNumber(to.time)}),${interpolation},${expression})`;
  }
  return expression;
}
function validateMusicDucking(value) {
  if (!value || value.enabled !== true) return null;
  const fields = {
    threshold: [1e-3, 1, 0.05],
    floorGain: [0.01, 1, 0.2],
    attackMs: [0.1, 2e3, 5],
    releaseMs: [10, 9e3, 300]
  };
  if (value.speechBus !== "voiceover") {
    throw renderError("INVALID_PROJECT", "BGM ducking requires the voiceover speech bus");
  }
  const result = { enabled: true, speechBus: "voiceover" };
  Object.entries(fields).forEach(([key, [minimum, maximum, fallback]]) => {
    const candidate = value[key] == null ? fallback : Number(value[key]);
    if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
      throw renderError("INVALID_PROJECT", `BGM ducking ${key} must be between ${minimum} and ${maximum}`);
    }
    result[key] = candidate;
  });
  return result;
}
function renderTransitionFilter({ id, left, right, duration, offset, output, index }) {
  const transition = TRANSITION_XFADE_IDS[id];
  if (transition) {
    return [`${left}${right}xfade=transition=${transition}:duration=${duration}:offset=${offset},trim=duration=${offset + duration},setpts=PTS-STARTPTS${output}`];
  }
  if (id !== "glitch") {
    throw renderError("UNSUPPORTED_RENDER_FEATURE", `Unsupported transition: ${id}`);
  }
  const leftRgb = `[vglitch${index}left]`;
  const rightRgb = `[vglitch${index}right]`;
  const pulse = "max(0,sin(P*PI*8))*0.12";
  const cyanPlane = "if(eq(PLANE,0),234,if(eq(PLANE,1),217,53))";
  const blend = "(A*(1-P)+B*P)";
  const expression = `clip(${blend}*(1-(${pulse}))+(${cyanPlane})*(${pulse}),0,255)`;
  return [
    `${left}format=gbrp${leftRgb}`,
    `${right}format=gbrp${rightRgb}`,
    `${leftRgb}${rightRgb}xfade=transition=custom:duration=${duration}:offset=${offset}:expr='${expression}',format=yuv420p,trim=duration=${offset + duration},setpts=PTS-STARTPTS${output}`
  ];
}
function buildFfmpegRenderPlan({ project, media = {}, extractedFiles, settings = {}, rendererResources = {} }) {
  if (!(extractedFiles instanceof Map)) throw renderError("INVALID_ARGUMENT", "extractedFiles must be a Map");
  assertSupportedProject(project || {});
  const requirements = getFfmpegRenderMediaRequirements(project || {});
  const visuals = requirements.visuals;
  if (!visuals.length) throw renderError("EMPTY_TIMELINE", "Headless render requires at least one visual clip");
  const ratio = RATIO_SIZES[project.ratioId] || RATIO_SIZES["16:9"];
  const width = evenDimension(settings.width, ratio.width, "width");
  const height = evenDimension(settings.height, ratio.height, "height");
  const frameRate = Math.max(1, Math.min(60, Math.round(Number(settings.frameRate) || 30)));
  const targetLoudnessLufs = project.targetLoudnessLufs == null ? -14 : Number(project.targetLoudnessLufs);
  if (!Number.isFinite(targetLoudnessLufs) || targetLoudnessLufs < -24 || targetLoudnessLufs > -6) {
    throw renderError("INVALID_PROJECT", "target loudness must be between -24 and -6 LUFS");
  }
  const duration = visuals.reduce((sum, segment) => sum + finitePositive(segment.duration, `Visual clip ${segment.id} duration`), 0);
  const junctions = visuals.map((segment, index) => {
    const id = segment.transition?.id;
    if (!id || id === "none") return null;
    if (index >= visuals.length - 1) throw renderError("INVALID_PROJECT", `Visual clip ${segment.id} cannot transition without a following clip`);
    const transitionDuration = finitePositive(segment.transition?.duration || 0.5, `Transition after ${segment.id} duration`);
    const nextDuration = finitePositive(visuals[index + 1].duration, `Visual clip ${visuals[index + 1].id} duration`);
    if (transitionDuration >= Math.min(Number(segment.duration), nextDuration)) {
      throw renderError("INVALID_PROJECT", `Transition after ${segment.id} must be shorter than both clips`);
    }
    return { id, duration: transitionDuration };
  });
  const args = ["-hide_banner", "-y"];
  const filters = [];
  const inputs = { count: 0 };
  const videoLabels = visuals.map((segment, index) => {
    const path = resolveVisualPath(segment, media, extractedFiles);
    const clipDuration = Number(segment.duration);
    const inputIndex = inputs.count++;
    if (segment.type === "image") args.push("-loop", "1", "-t", String(clipDuration), "-i", path);
    else args.push("-i", path);
    const remappedInput = segment.type === "video" ? addRemappedVideoSource({ filters, inputIndex, segment, prefix: `vremap${index}`, frameRate }) : null;
    const visualInput = remappedInput || `[${inputIndex}:v]`;
    const sourceStart = Math.max(0, Number(segment.sourceStart) || 0);
    const rate = Math.max(0.25, Math.min(4, Number(segment.playbackRate) || 1));
    const trim = segment.type === "video" && !remappedInput ? `trim=start=${sourceStart}:duration=${clipDuration * rate},setpts=(PTS-STARTPTS)/${rate},` : "";
    const visualFilter = [
      visualFilterChain(segment.filterId || project.selectedFilterId),
      buildRegisteredEffectFfmpegChain(segment.effects, { mediaType: segment.type })
    ].filter(Boolean).join(",");
    const visualFilterSuffix = visualFilter ? `,${visualFilter}` : "";
    const colorGradeFilter = buildFfmpegColorGradeFilter(segment.colorGrade, segment.keyframes, "T");
    const colorGradeSuffix = colorGradeFilter ? `,${colorGradeFilter}` : "";
    const keyframes = normalizeRenderVisualKeyframes(segment.keyframes || []);
    const mask = visualMaskFilter(segment.mask);
    const subjectEffectLabel = addSubjectEffectSource({
      args,
      filters,
      inputs,
      segment,
      index,
      visualInput,
      trim,
      visualFilterSuffix,
      colorGradeSuffix,
      media,
      extractedFiles,
      width,
      height,
      frameRate,
      clipDuration
    });
    if (subjectEffectLabel) return subjectEffectLabel;
    const depthEffectLabel = addDepthEffectSource({
      args,
      filters,
      inputs,
      segment,
      index,
      visualInput,
      trim,
      visualFilterSuffix,
      colorGradeSuffix,
      media,
      extractedFiles,
      width,
      height,
      frameRate,
      clipDuration
    });
    if (depthEffectLabel) return depthEffectLabel;
    const hasTransform = segment.baseTransform != null || keyframes.length > 0 || hasVisualAnimation(segment.animation) || Boolean(mask);
    if (!hasTransform) {
      filters.push(`${visualInput}${trim}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black${visualFilterSuffix}${colorGradeSuffix},fps=${frameRate},setsar=1,format=yuv420p[v${index}]`);
      return `[v${index}]`;
    }
    const transform = segment.baseTransform || {};
    const scale = animatedVisualFieldExpression(transform, keyframes, segment.animation, clipDuration, "scale", "t");
    const rotation = visualFieldExpression(transform, keyframes, "rotation", "t");
    const opacity = animatedVisualFieldExpression(transform, keyframes, segment.animation, clipDuration, "opacity", "T");
    const x = animatedVisualFieldExpression(transform, keyframes, segment.animation, clipDuration, "x", "t");
    const y = animatedVisualFieldExpression(transform, keyframes, segment.animation, clipDuration, "y", "t");
    const sourceLabel = `[vprimarysource${index}]`;
    const layerLabel = `[vprimarylayer${index}]`;
    const backgroundLabel = `[vprimarybg${index}]`;
    filters.push(`${visualInput}${trim}scale=${width}:${height}:force_original_aspect_ratio=decrease,format=rgba,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0${visualFilterSuffix}${colorGradeSuffix}${mask},fps=${frameRate},setsar=1,setpts=PTS-STARTPTS${sourceLabel}`);
    filters.push(`${sourceLabel}scale=w='max(2,trunc(iw*(${scale})/2)*2)':h='max(2,trunc(ih*(${scale})/2)*2)':eval=frame,rotate=angle='PI/180*(${rotation})':ow=rotw(iw):oh=roth(ih):c=none,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacity})'${layerLabel}`);
    filters.push(`color=c=black:s=${width}x${height}:r=${frameRate}:d=${graphNumber(clipDuration)},format=rgba${backgroundLabel}`);
    filters.push(`${backgroundLabel}${layerLabel}overlay=x='(W-w)/2+(${x})/100*W':y='(H-h)/2+(${y})/100*H':eval=frame:eof_action=pass:repeatlast=0,format=yuv420p[v${index}]`);
    return `[v${index}]`;
  });
  const mainLabels = [...videoLabels];
  const previewLabels = new Array(videoLabels.length).fill(null);
  junctions.forEach((junction, index) => {
    if (!junction) return;
    const nextIndex = index + 1;
    const main = `[v${nextIndex}main]`;
    const preview = `[v${nextIndex}preview]`;
    filters.push(`${videoLabels[nextIndex]}split=2${main}${preview}`);
    mainLabels[nextIndex] = main;
    previewLabels[nextIndex] = preview;
  });
  const renderedVideoLabels = mainLabels.map((label, index) => {
    const junction = junctions[index];
    if (!junction) return label;
    const clipDuration = Number(visuals[index].duration);
    const output = `[vjunction${index}]`;
    filters.push(...renderTransitionFilter({
      id: junction.id,
      left: label,
      right: previewLabels[index + 1],
      duration: junction.duration,
      offset: clipDuration - junction.duration,
      output,
      index
    }));
    return output;
  });
  const captionAss = buildCaptionAss(project, width, height, duration, rendererResources);
  const overlays = requirements.overlays;
  const stickers = requirements.stickers;
  const needsPostProcessing = stickers.length > 0 || overlays.length > 0 || captionAss;
  filters.push(`${renderedVideoLabels.join("")}concat=n=${renderedVideoLabels.length}:v=1:a=0${needsPostProcessing ? "[vbase]" : "[vout]"}`);
  const stickerLabel = addStickerOverlays({
    args,
    filters,
    inputs,
    stickers,
    media,
    extractedFiles,
    width,
    height,
    frameRate,
    inputLabel: "[vbase]"
  });
  const compositedLabel = addVisualOverlays({
    args,
    filters,
    inputs,
    overlays,
    media,
    extractedFiles,
    width,
    height,
    frameRate,
    inputLabel: stickerLabel
  });
  if (captionAss) filters.push(`${compositedLabel}subtitles=filename=captions.ass${captionAss.fontSidecars.length ? ":fontsdir=." : ""}[vout]`);
  else if (stickers.length > 0 || overlays.length > 0) filters.push(`${compositedLabel}null[vout]`);
  const voiceLabels = addAudioTrack({ args, filters, inputs, segments: requirements.audioSegments, mediaEntry: media.audio, mediaEntries: media.audioSegments || [], extractedFiles, duration, prefix: "voice" });
  const musicVolume = Number.isFinite(Number(project.musicVolume)) ? Number(project.musicVolume) : 0.35;
  const musicLabels = addAudioTrack({ args, filters, inputs, segments: requirements.musicSegments, mediaEntry: media.music, extractedFiles, duration, prefix: "music", defaultVolume: musicVolume });
  const sourceLabels = addAudioTrack({
    args,
    filters,
    inputs,
    segments: sourceAudioSegmentsForRender(project, media.sourceAudioSegments || []),
    mediaEntries: media.sourceAudioSegments || [],
    extractedFiles,
    duration,
    prefix: "source"
  });
  let audioLabels = [...voiceLabels, ...musicLabels, ...sourceLabels];
  const ducking = requirements.musicSegments.map((segment) => validateMusicDucking(segment.ducking)).find(Boolean);
  if (ducking && voiceLabels.length && musicLabels.length) {
    const mixBus = (labels, output) => {
      filters.push(labels.length === 1 ? `${labels[0]}anull${output}` : `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0${output}`);
    };
    mixBus(voiceLabels, "[voicebus]");
    mixBus(musicLabels, "[musicbus]");
    filters.push("[voicebus]asplit=2[voicekey][voicepass]");
    const threshold = ducking.threshold;
    const floorGain = ducking.floorGain;
    const reductionDb = -20 * Math.log10(floorGain);
    const ratio2 = Math.max(1, Math.min(20, 1 + reductionDb * 7 / 12));
    const attack = ducking.attackMs;
    const release = ducking.releaseMs;
    filters.push(`[musicbus][voicekey]sidechaincompress=threshold=${graphNumber(threshold)}:ratio=${graphNumber(ratio2)}:attack=${graphNumber(attack)}:release=${graphNumber(release)}[musicducked]`);
    audioLabels = ["[voicepass]", "[musicducked]", ...sourceLabels];
  }
  if (audioLabels.length) {
    const mixedAudio = audioLabels.length === 1 ? `${audioLabels[0]}anull` : `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,asetpts=N/SR/TB`;
    filters.push(`${mixedAudio},atrim=duration=${duration},loudnorm=I=${targetLoudnessLufs}:TP=-1.5:LRA=11,aeval=exprs='if(isnan(val(ch))+isinf(val(ch)),0,val(ch))':c=same,aresample=48000[aout]`);
  }
  args.push("-filter_complex", filters.join(";"), "-map", "[vout]");
  if (audioLabels.length) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push("-c:v", "libx264", "-preset", settings.preset || "medium", "-crf", String(Number(settings.crf) || 18), "-pix_fmt", "yuv420p", "-r", String(frameRate), "-t", String(duration), "-movflags", "+faststart");
  return {
    args,
    duration,
    width,
    height,
    frameRate,
    hasAudio: audioLabels.length > 0,
    targetLoudnessLufs,
    ...captionAss ? { sidecars: [{ filename: "captions.ass", content: captionAss.content }, ...captionAss.fontSidecars] } : {}
  };
}

// src/upstream-render-plan.ts
function buildNativeTimelineFfmpegPlan(input) {
  return buildFfmpegRenderPlan(input);
}
function getNativeTimelineFfmpegMediaRequirements(project) {
  return getFfmpegRenderMediaRequirements(project);
}

// src/commands/diff.ts
function normalizeVideoEditorCommandDiff(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    projectFields: Array.isArray(source.projectFields) ? source.projectFields : [],
    tracks: source.tracks && typeof source.tracks === "object" && !Array.isArray(source.tracks) ? source.tracks : {}
  };
}

// src/commands/registry.ts
var nativeCommands = [
  ["asset.place_version", true, "Place a VibeDev AssetVersion"],
  ["asset.import", true, "Import a prepared archive asset"],
  ["timed.move", true, "Move a timed clip"],
  ["timed.resize", true, "Resize a timed clip"],
  ["visual.trim", true, "Trim or restore a video source range at its existing speed; sourceIn/sourceOut are source-media seconds. Restoration requires known source bounds; curves/reverse/freeze cannot be extended."],
  ["visual.split", true, "Split a visual clip"],
  ["visual.reorder", true, "Reorder the visual sequence"],
  ["visual.append", true, "Append a visual clip"],
  ["visual.insert", true, "Insert a visual clip"],
  ["overlay.add", true, "Add a visual overlay"],
  ["transition.set", true, "Set a transition"],
  ["caption.add", true, "Add a caption"],
  ["caption.replace_ranges", true, "Apply reviewed original-audio captions only in specified ranges"],
  ["caption.update", true, "Update a caption"],
  ["caption.unlink_audio", true, "Detach a caption from voiceover"],
  ["caption.link_audio", true, "Attach a caption to voiceover"],
  ["clip.delete", true, "Delete a clip"],
  ["clip.set_property", true, "Set a numeric clip property"],
  ["clip.set_speed", true, "Set clip playback speed"],
  ["clip.set_muted", true, "Mute or unmute a clip"],
  ["track.set_visibility", true, "Show or hide a track"],
  ["track.set_locked", true, "Lock or unlock a track"],
  ["project.set_ratio", true, "Set the project aspect ratio"],
  ["color.set", true, "Set or merge a clip colour grade (temperature, tint, saturation, four wheels)"],
  ["filter.set", true, "Set the rendered filter of a clip, or the project default"],
  ["effect.apply", true, "Apply an allowlisted versioned effect"],
  ["effect.remove", true, "Remove an effect from a clip"],
  ["sticker.add", true, "Add an owned Sticker AssetVersion"],
  ["sticker.update", true, "Update Sticker timing and transform"],
  ["sticker.remove", true, "Remove a Sticker"],
  ["music.automation.set", true, "Set BGM gain envelope and speech ducking"],
  ["audio.set_loudness", true, "Set the loudness the render normalises to (LUFS)"],
  ["subject.effect.set", true, "Configure a person or object effect from pinned analysis"],
  ["depth.effect.set", true, "Configure cinematic depth from pinned analysis"],
  ["parallax.set", true, "Configure photo parallax from pinned analysis"]
];
var uiFallbackCommands = [
  ["keyframe.add", "Add or update a keyframe"],
  ["keyframe.delete", "Delete a keyframe"],
  ["effect.set", "Set a visual effect"]
];
var commands = Object.freeze([
  ...nativeCommands.map(([type, destructive, summary]) => ({
    type,
    availability: "native",
    destructive,
    summary
  })),
  ...uiFallbackCommands.map(([type, summary]) => ({
    type,
    availability: "ui-fallback",
    destructive: true,
    summary
  }))
]);
var commandByType = new Map(commands.map((command) => [command.type, command]));
function listVideoEditorCommands() {
  return commands;
}
function getVideoEditorCommand(type) {
  return commandByType.get(type);
}

// ../../vendor/ai-video-editor/src/lib/clipTimeMapping.js
var MIN_MAPPING_SECONDS = 1e-3;
var MIN_VISUAL_PLAYBACK_RATE = 0.25;
var MAX_VISUAL_PLAYBACK_RATE = 4;
function normalizeVisualPlaybackRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return Math.max(MIN_VISUAL_PLAYBACK_RATE, Math.min(MAX_VISUAL_PLAYBACK_RATE, rate));
}
function getVibedevTimeRemapState(segment, localTime = 0) {
  const runtime = segment?.vibedevTimeRemapRuntime;
  const steps = Array.isArray(runtime?.segments) ? runtime.segments : [];
  if (!steps.length) return null;
  const duration = Math.max(0, Number(runtime.duration) || steps.reduce(
    (total, step) => total + Math.max(0, Number(step?.durationSeconds) || 0),
    0
  ));
  const target = Math.max(0, Math.min(duration, Number(localTime) || 0));
  let cursor = 0;
  for (const step of steps) {
    const stepDuration = Math.max(0, Number(step?.durationSeconds) || 0);
    const end = cursor + stepDuration;
    if (target <= end + 1e-7) {
      if (step?.kind === "freeze") {
        return {
          sourceTime: Math.max(0, Number(step.sourceSeconds) || 0),
          playbackRate: normalizeVisualPlaybackRate(segment?.playbackRate)
        };
      }
      const progress = stepDuration > 0 ? Math.max(0, Math.min(1, (target - cursor) / stepDuration)) : 0;
      const sourceIn = Math.max(0, Number(step?.sourceInSeconds) || 0);
      const sourceOut = Math.max(0, Number(step?.sourceOutSeconds) || sourceIn);
      return {
        sourceTime: sourceIn + (sourceOut - sourceIn) * progress,
        playbackRate: normalizeVisualPlaybackRate(step?.rate)
      };
    }
    cursor = end;
  }
  return null;
}
function getVisualSourceTime(segment, localTime = 0) {
  const remapped = getVibedevTimeRemapState(segment, localTime);
  if (remapped) return remapped.sourceTime;
  const start = Math.max(0, Number(segment?.sourceStart) || 0);
  const duration = Math.max(MIN_MAPPING_SECONDS, Number(segment?.duration) || MIN_MAPPING_SECONDS);
  const sourceDuration = Math.max(MIN_MAPPING_SECONDS, Number(segment?.sourceDuration) || duration * normalizeVisualPlaybackRate(segment?.playbackRate));
  if (segment?.speedCurve?.enabled && Array.isArray(segment.speedCurve.points)) {
    const progress = Math.max(0, Math.min(1, Math.max(0, Number(localTime) || 0) / duration));
    return start + sourceDuration * getFinalSpeedCurveSourceProgress(segment.speedCurve, progress);
  }
  return start + Math.max(0, Number(localTime) || 0) * normalizeVisualPlaybackRate(segment?.playbackRate);
}

// ../../vendor/ai-video-editor/src/lib/clipSourceRange.js
function sliceClipSource(segment, from, to) {
  const duration = Math.max(1e-3, Number(segment.duration) || 1e-3);
  const start = Math.max(0, Math.min(duration, from));
  const end = Math.max(start, Math.min(duration, to));
  const result = { ...segment, duration: end - start };
  if (Array.isArray(segment.keyframes)) result.keyframes = segment.keyframes.filter((frame) => frame.time >= start && frame.time <= end).map((frame) => ({ ...frame, time: frame.time - start }));
  if (segment.type === "image") return result;
  result.sourceStart = getVisualSourceTime(segment, start);
  result.sourceDuration = Math.abs(getVisualSourceTime(segment, end) - result.sourceStart);
  result.sourceMediaDuration = segment.sourceMediaDuration || segment.trackFrameDuration || (Number(segment.sourceStart) || 0) + (Number(segment.sourceDuration) || duration * normalizeVisualPlaybackRate(segment.playbackRate));
  if (segment.speedCurve?.enabled) {
    const old = segment.speedCurve.window || { start: 0, end: 1 };
    result.speedCurve = { ...segment.speedCurve, window: {
      start: old.start + (old.end - old.start) * start / duration,
      end: old.start + (old.end - old.start) * end / duration
    } };
  }
  if (segment.vibedevTimeRemapRuntime?.segments?.length) {
    let cursor = 0;
    const steps = segment.vibedevTimeRemapRuntime.segments.flatMap((step) => {
      const at = cursor;
      cursor += step.durationSeconds;
      const left = Math.max(start, at), right = Math.min(end, cursor);
      if (right <= left) return [];
      if (step.kind === "freeze") return [{ ...step, durationSeconds: right - left }];
      const span = step.sourceOutSeconds - step.sourceInSeconds;
      return [{
        ...step,
        durationSeconds: right - left,
        sourceInSeconds: step.sourceInSeconds + span * (left - at) / step.durationSeconds,
        sourceOutSeconds: step.sourceInSeconds + span * (right - at) / step.durationSeconds
      }];
    });
    result.vibedevTimeRemapRuntime = { ...segment.vibedevTimeRemapRuntime, duration: end - start, segments: steps };
  }
  return result;
}
function getClipTrimBounds(segment) {
  if (segment.speedCurve?.enabled || segment.vibedevTimeRemapRuntime?.segments?.length) return { from: 0, to: segment.duration };
  const rate = normalizeVisualPlaybackRate(segment.playbackRate);
  const start = Math.max(0, Number(segment.sourceStart) || 0);
  const mediaEnd = segment.sourceMediaDuration || segment.trackFrameDuration || start + (segment.sourceDuration || segment.duration * rate);
  return { from: -start / rate, to: (mediaEnd - start) / rate };
}
function trimClipRange(segment, requestedFrom, requestedTo) {
  const media = segment.type === "video" || segment.type === "audio";
  const bounds = media ? getClipTrimBounds(segment) : { from: -Infinity, to: Infinity };
  const from = Math.max(bounds.from, Math.min(bounds.to - 1e-3, requestedTo - 1e-3, requestedFrom));
  const to = Math.min(bounds.to, Math.max(from + 1e-3, requestedTo));
  if (from === 0 && to === segment.duration) return segment;
  if (from >= 0 && to <= segment.duration) return sliceClipSource(segment, from, to);
  const result = { ...segment, duration: to - from };
  if (Array.isArray(segment.keyframes)) result.keyframes = segment.keyframes.filter((frame) => frame.time >= from && frame.time <= to).map((frame) => ({ ...frame, time: frame.time - from }));
  if (!media) return result;
  const rate = normalizeVisualPlaybackRate(segment.playbackRate);
  const sourceStart = Math.max(0, Number(segment.sourceStart) || 0);
  return {
    ...result,
    sourceStart: sourceStart + from * rate,
    sourceDuration: result.duration * rate,
    sourceMediaDuration: sourceStart + bounds.to * rate
  };
}
function trimClipDuration(segment, requestedDuration) {
  return trimClipRange(segment, 0, Math.max(0.1, Number(requestedDuration) || 0.1));
}
function sourceTimeToClipTime(segment, sourceTime) {
  if (segment.vibedevTimeRemapRuntime?.segments?.some((step) => step.reverse || step.kind === "freeze")) {
    throw Object.assign(new Error("Source trim is ambiguous for reverse/freeze; split by timeline time instead"), { code: "INVALID_RANGE" });
  }
  if (!segment.speedCurve?.enabled && !segment.vibedevTimeRemapRuntime?.segments?.length) return (sourceTime - (segment.sourceStart || 0)) / normalizeVisualPlaybackRate(segment.playbackRate);
  let low = 0, high = segment.duration;
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2;
    if (getVisualSourceTime(segment, mid) < sourceTime) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

// ../../vendor/ai-video-editor/src/lib/projectCommandEngine.js
var PROJECT_COMMAND_SCHEMA_VERSION = 1;
var COMMAND_STATE_KEY = "commandState";
function failure(code, message, operationId = "") {
  return { ok: false, code, message, ...operationId ? { operationId } : {} };
}
function finiteNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error(`${name} must be a finite non-negative number`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}
function finitePositive2(value, name) {
  const result = finiteNonNegative(value, name);
  if (result <= 0) throw Object.assign(new Error(`${name} must be greater than zero`), { code: "INVALID_ARGUMENT" });
  return result;
}
function findById(items, id, kind) {
  const item = (Array.isArray(items) ? items : []).find((entry) => entry.id === id);
  if (!item) throw Object.assign(new Error(`${kind} not found: ${id}`), { code: "CLIP_NOT_FOUND" });
  return item;
}
function commandState(project) {
  const value = project?.[COMMAND_STATE_KEY];
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
    appliedOperationIds: Array.isArray(value?.appliedOperationIds) ? [...new Set(value.appliedOperationIds)] : []
  };
}
function moveTimed(project, operation) {
  if (operation.track !== "audio") {
    throw Object.assign(new Error(`Unsupported timed track: ${operation.track}`), { code: "UNSUPPORTED_TRACK" });
  }
  const segment = findById(project.audioSegments, operation.clipId, "Audio clip");
  const nextStart = finiteNonNegative(operation.start, "start");
  const previousStart = Number(segment.start) || 0;
  segment.start = nextStart;
  const delta = nextStart - previousStart;
  project.captionSegments = (project.captionSegments || []).map((caption) => caption.audioSegmentId === segment.id ? { ...caption, start: finiteNonNegative((Number(caption.start) || 0) + delta, "caption start"), end: finiteNonNegative((Number(caption.end) || 0) + delta, "caption end") } : caption);
}
function resizeTimed(project, operation) {
  const collections = { audio: "audioSegments", sticker: "stickerSegments", overlay: "visualOverlaySegments" };
  const key = collections[operation.track];
  if (!key) throw Object.assign(new Error(`Unsupported timed track: ${operation.track}`), { code: "UNSUPPORTED_TRACK" });
  const segment = findById(project[key], operation.clipId, "Timed clip");
  const previousStart = Number(segment.start) || 0;
  const start = Object.hasOwn(operation, "start") ? finiteNonNegative(operation.start, "start") : previousStart;
  const duration = finitePositive2(operation.duration, "duration");
  if (operation.track === "audio" || operation.track === "overlay" && segment.type === "video") {
    Object.assign(segment, trimClipDuration({ ...segment, type: segment.type || "audio" }, duration));
  } else segment.duration = duration;
  segment.start = start;
  if (operation.track === "audio") {
    const delta = start - previousStart;
    const clipEnd = start + segment.duration;
    project.captionSegments = (project.captionSegments || []).map((caption) => {
      if (caption.audioSegmentId !== segment.id) return caption;
      const captionStart = finiteNonNegative((Number(caption.start) || 0) + delta, "caption start");
      const captionEnd = Math.min(clipEnd, finiteNonNegative((Number(caption.end) || 0) + delta, "caption end"));
      return { ...caption, start: Math.min(captionStart, captionEnd), end: captionEnd };
    });
  }
}
function visualPlaybackRate(segment) {
  const value = Number(segment?.playbackRate) || 1;
  return Math.max(0.25, Math.min(4, value));
}
function remapKeyframes(keyframes, start, end) {
  return (Array.isArray(keyframes) ? keyframes : []).filter((frame) => Number(frame?.time) >= start && Number(frame?.time) <= end).map((frame) => ({ ...frame, time: Number(frame.time) - start }));
}
function trimVisual(project, operation) {
  if (project.trackLocks?.image) throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
  const segment = findById(project.visualSegments, operation.clipId, "Visual clip");
  if (segment.type !== "video") throw Object.assign(new Error("visual.trim currently supports video clips only"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  const sourceIn = finiteNonNegative(operation.sourceIn, "sourceIn");
  const sourceOut = finiteNonNegative(operation.sourceOut, "sourceOut");
  if (sourceOut <= sourceIn) throw Object.assign(new Error("sourceOut must be after sourceIn"), { code: "INVALID_RANGE" });
  const previousSourceIn = Math.max(0, Number(segment.sourceStart) || 0);
  const nonlinear = segment.speedCurve?.enabled || segment.vibedevTimeRemapRuntime?.segments?.length;
  const bounds = getClipTrimBounds(segment);
  const minimum = nonlinear ? previousSourceIn : 0;
  const maximum = nonlinear ? previousSourceIn + (Number(segment.sourceDuration) || segment.duration * visualPlaybackRate(segment)) : previousSourceIn + bounds.to * visualPlaybackRate(segment);
  if (sourceIn < minimum || sourceOut > maximum) {
    throw Object.assign(new Error(`Trim range must stay within ${minimum}-${maximum}${nonlinear ? "; extending a speed curve, reverse or freeze is not supported" : ""}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const from = sourceTimeToClipTime(segment, sourceIn);
  const to = sourceTimeToClipTime(segment, sourceOut);
  Object.assign(segment, trimClipRange(segment, from, to));
}
function splitVisual(project, operation) {
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const index = visuals.findIndex((segment2) => segment2.id === operation.clipId);
  if (index < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  const segment = visuals[index];
  const at = finitePositive2(operation.at, "at");
  const duration = finitePositive2(Number(segment.duration), "clip duration");
  if (at >= duration) throw Object.assign(new Error("at must be inside the visual clip"), { code: "INVALID_RANGE" });
  const rightClipId = typeof operation.rightClipId === "string" ? operation.rightClipId.trim() : "";
  if (!rightClipId) throw Object.assign(new Error("rightClipId is required"), { code: "INVALID_ARGUMENT" });
  if (visuals.some((item) => item.id === rightClipId)) throw Object.assign(new Error(`Visual clip already exists: ${rightClipId}`), { code: "CLIP_ALREADY_EXISTS" });
  const left = sliceClipSource(segment, 0, at);
  const right = { ...sliceClipSource(segment, at, duration), id: rightClipId };
  project.visualSegments = [...visuals.slice(0, index), left, right, ...visuals.slice(index + 1)];
}
function reorderVisual(project, operation) {
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const from = visuals.findIndex((segment) => segment.id === operation.clipId);
  if (from < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  if (!Number.isInteger(operation.toIndex) || operation.toIndex < 0 || operation.toIndex >= visuals.length) {
    throw Object.assign(new Error("toIndex must identify an existing visual position"), { code: "INVALID_ARGUMENT" });
  }
  const next = [...visuals];
  const [moved] = next.splice(from, 1);
  next.splice(operation.toIndex, 0, moved);
  project.visualSegments = next;
}
function requireNewClipId(project, clipId) {
  const id = typeof clipId === "string" ? clipId.trim() : "";
  if (!id) throw Object.assign(new Error("clipId is required"), { code: "INVALID_ARGUMENT" });
  const exists = Object.values(TRACK_COLLECTIONS).some((key) => (project?.[key] || []).some((clip) => clip.id === id));
  if (exists) throw Object.assign(new Error(`Clip already exists: ${id}`), { code: "CLIP_ALREADY_EXISTS" });
  return id;
}
function findVisualSource(project, sourceClipId) {
  const source = [...project.visualSegments || [], ...project.visualOverlaySegments || []].find((clip) => clip.id === sourceClipId);
  if (!source) throw Object.assign(new Error(`Visual source clip not found: ${sourceClipId}`), { code: "CLIP_NOT_FOUND" });
  return source;
}
function cloneVisualForSequence(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  const source = findVisualSource(project, operation.sourceClipId);
  const maximumDuration = finitePositive2(Number(source.duration), "source clip duration");
  const duration = Object.hasOwn(operation, "duration") ? finitePositive2(operation.duration, "duration") : maximumDuration;
  if (source.type === "video" && duration > maximumDuration) {
    throw Object.assign(new Error(`Video duration cannot exceed source clip duration ${maximumDuration}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const next = { ...source, id, archiveMediaId: source.archiveMediaId || source.id, duration };
  delete next.start;
  delete next.layer;
  delete next.baseTransform;
  delete next.transition;
  if (source.type === "video") next.sourceDuration = duration * visualPlaybackRate(source);
  if (Array.isArray(source.keyframes)) next.keyframes = remapKeyframes(source.keyframes, 0, duration);
  return next;
}
function appendVisual(project, operation) {
  project.visualSegments = [...project.visualSegments || [], cloneVisualForSequence(project, operation)];
}
function importClipId(project, operation) {
  const id = typeof operation.clipId === "string" ? operation.clipId.trim() : "";
  if (id && operation.replaceClipId === id) return id;
  return requireNewClipId(project, operation.clipId);
}
function importAsset(project, operation) {
  const id = importClipId(project, operation);
  if (!["visuals", "audio", "music", "source"].includes(operation.track)) throw Object.assign(new Error("asset.import supports Visuals, Voiceover, or Music"), { code: "UNSUPPORTED_TRACK" });
  if (!operation.prepared || !["image", "video", "audio"].includes(operation.mediaType) || !operation.sha256 || !operation.archivePath) {
    throw Object.assign(new Error("asset.import must be prepared by an archive media service"), { code: "ASSET_NOT_PREPARED" });
  }
  if (project.trackLocks?.[operation.track === "visuals" ? "visual" : operation.track]) throw Object.assign(new Error("Target track is locked"), { code: "TRACK_LOCKED" });
  const duration = finitePositive2(operation.duration, "duration");
  const integrity = { sha256: operation.sha256, size: operation.size, mimeType: operation.mimeType, archivePath: operation.archivePath };
  if (operation.track === "source") {
    if (operation.mediaType !== "audio" && !(operation.restoreOriginal && operation.mediaType === "video")) throw Object.assign(new Error("Source lane requires audio"), { code: "UNSUPPORTED_MEDIA_TYPE" });
    if (operation.replace !== true) throw Object.assign(new Error("Source lane replacement must be explicit"), { code: "REPLACEMENT_REQUIRED" });
    const previous = project.sourceAudioSource;
    if (operation.restoreOriginal && previous?.original?.assetVersionId !== operation.assetVersionId) throw Object.assign(new Error("Original source version mismatch"), { code: "ORIGINAL_VERSION_MISMATCH" });
    const original = operation.preserveOriginal ? previous?.original || (previous ? { ...previous, name: project.sourceAudioName } : null) : null;
    if (operation.preserveOriginal && !original?.assetVersionId) throw Object.assign(new Error("Persist original audio before conversion"), { code: "ORIGINAL_VERSION_REQUIRED" });
    project.sourceAudioSource = { assetId: operation.assetId, assetVersionId: operation.assetVersionId, sourceUrl: operation.sourceUrl, sourceKind: operation.mediaType === "video" ? "video" : "audio", ...original && !operation.restoreOriginal ? { original } : {} };
    project.sourceAudioName = operation.name || id;
    project.sourceAudioDuration = duration;
    project.sourceAudioStart = operation.start ?? project.sourceAudioStart ?? 0;
    project.sourceAudioAssetId = operation.linkedSourceAssetId ?? project.sourceAudioAssetId ?? "";
    if (operation.sourceOffsets) {
      if (!Array.isArray(operation.sourceOffsets) || operation.sourceOffsets.length > 256) throw new Error("Invalid source audio mapping");
      if (project.trackLocks?.visual) throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
      for (const mapping of operation.sourceOffsets) {
        const visual = findById(project.visualSegments, mapping.clipId, "Source visual clip");
        visual.sourceAudioOffset = finiteNonNegative(mapping.offset, "source audio offset");
      }
    }
    return;
  }
  if (operation.track === "audio" || operation.track === "music") {
    if (operation.mediaType !== "audio" && !(operation.restoreOriginal && operation.mediaType === "video")) throw Object.assign(new Error(`${operation.track} import requires audio media`), { code: "UNSUPPORTED_MEDIA_TYPE" });
    const start = Object.hasOwn(operation, "start") ? finiteNonNegative(operation.start, "start") : 0;
    const segment2 = { id, assetId: operation.assetId, assetVersionId: operation.assetVersionId, sourceUrl: operation.sourceUrl, name: operation.name || id, start, duration, sourceStart: operation.sourceStart === void 0 ? 0 : finiteNonNegative(operation.sourceStart, "sourceStart"), sourceDuration: operation.sourceDuration === void 0 ? duration : finitePositive2(operation.sourceDuration, "sourceDuration"), playbackRate: operation.playbackRate === void 0 ? 1 : finitePositive2(operation.playbackRate, "playbackRate"), volume: operation.volume ?? (operation.track === "music" ? 0.35 : 1), fadeIn: 0, fadeOut: 0, muted: operation.muted === true, integrity };
    if (operation.disableSourceClipId) {
      if (project.trackLocks?.source || project.trackLocks?.visual) throw Object.assign(new Error("Source track is locked"), { code: "TRACK_LOCKED" });
      const visual = findById(project.visualSegments, operation.disableSourceClipId, "Source visual clip");
      if (visual.sourceAudioDisabled) throw Object.assign(new Error("Original sound is already detached"), { code: "SOURCE_ALREADY_DETACHED" });
      if (operation.preserveOriginal) {
        const origin = project.sourceAudioSource || { assetId: visual.assetId, assetVersionId: visual.assetVersionId, sourceUrl: visual.sourceUrl, sourceKind: "video" };
        if (!origin.assetVersionId) throw Object.assign(new Error("Persist original before conversion"), { code: "ORIGINAL_VERSION_REQUIRED" });
        const start2 = (project.visualSegments || []).slice(0, project.visualSegments.indexOf(visual)).reduce((n, clip) => n + clip.duration, 0);
        Object.assign(segment2, {
          start: start2,
          duration: visual.duration,
          sourceStart: (visual.sourceAudioOffset || 0) + (visual.sourceStart || 0),
          sourceDuration: visual.sourceDuration || visual.duration * (visual.playbackRate || 1),
          playbackRate: visual.playbackRate || 1,
          ...visual.speedCurve ? { speedCurve: visual.speedCurve } : {},
          volume: project.sourceAudioVolume ?? 1,
          voiceColorOriginal: { ...origin, name: project.sourceAudioName || visual.name, sourceClipId: visual.id }
        });
      }
      segment2.sourceVisualSegmentId = visual.id;
      segment2.sourceAudioWasLinked = true;
      visual.sourceAudioDisabled = true;
    }
    if (operation.muteMusicClipId) {
      if (project.trackLocks?.music) throw Object.assign(new Error("Music track is locked"), { code: "TRACK_LOCKED" });
      const musicLane = packTimedSegmentsIntoLanes(project.musicSegments || []).findIndex((items) => items.some((item) => item.id === operation.muteMusicClipId));
      if (project.trackLocks?.[`music-${musicLane}`]) throw Object.assign(new Error("Music lane is locked"), { code: "TRACK_LOCKED" });
      findById(project.musicSegments, operation.muteMusicClipId, "Music").muted = true;
    }
    if (operation.muteOverlayClipId) {
      if (project.trackLocks?.visual) throw Object.assign(new Error("Visual track is locked"), { code: "TRACK_LOCKED" });
      findById(project.visualOverlaySegments, operation.muteOverlayClipId, "Overlay").muted = true;
    }
    if (operation.track === "audio") {
      const audioSegments = project.audioSegments || [];
      const lanes = packTimedSegmentsIntoLanes(audioSegments, "lane");
      if (operation.replaceClipId) {
        const replaceIndex = audioSegments.findIndex((item) => item.id === operation.replaceClipId);
        if (replaceIndex < 0) throw Object.assign(new Error(`Audio replacement clip not found: ${operation.replaceClipId}`), { code: "CLIP_NOT_FOUND" });
        const previous = audioSegments[replaceIndex];
        const lane = lanes.findIndex((items) => items.some((item) => item.id === previous.id));
        if (project.trackLocks?.[`audio-${lane}`]) throw Object.assign(new Error("Audio lane is locked"), { code: "TRACK_LOCKED" });
        segment2.lane = lane;
        for (const key of ["sourceVisualSegmentId", "sourceAudioWasLinked", "captionId"]) if (previous[key] !== void 0) segment2[key] = previous[key];
        if (operation.preserveOriginal) {
          const original = previous.voiceColorOriginal || Object.fromEntries(Object.entries(previous).filter(([key, value]) => !["blob", "url", "peaks"].includes(key) && !(typeof value === "string" && value.startsWith("blob:"))));
          if (!original.assetVersionId) throw Object.assign(new Error("Persist original audio before conversion"), { code: "ORIGINAL_VERSION_REQUIRED" });
          Object.assign(segment2, {
            ...previous,
            ...segment2,
            start: previous.start,
            duration: previous.duration,
            sourceStart: previous.sourceStart ?? 0,
            sourceDuration: previous.sourceDuration ?? previous.duration,
            playbackRate: previous.playbackRate ?? 1,
            volume: previous.volume ?? 1,
            muted: previous.muted === true,
            fadeIn: previous.fadeIn ?? 0,
            fadeOut: previous.fadeOut ?? 0,
            voiceColorOriginal: original
          });
          delete segment2.blob;
          delete segment2.url;
          delete segment2.peaks;
        }
        if (operation.restoreOriginal) {
          if (!previous.voiceColorOriginal || previous.voiceColorOriginal.assetVersionId !== operation.assetVersionId) throw Object.assign(new Error("Original audio version mismatch"), { code: "ORIGINAL_VERSION_MISMATCH" });
          Object.assign(segment2, previous, {
            assetId: operation.assetId,
            assetVersionId: operation.assetVersionId,
            sourceUrl: operation.sourceUrl,
            integrity,
            name: previous.voiceColorOriginal.name || previous.name,
            sourceKind: previous.voiceColorOriginal.sourceKind,
            voiceColorOriginal: null
          });
          delete segment2.blob;
          delete segment2.url;
          delete segment2.peaks;
        }
        segment2.lane = lane;
        project.audioSegments = [
          ...audioSegments.slice(0, replaceIndex),
          segment2,
          ...audioSegments.slice(replaceIndex + 1)
        ];
      } else {
        if (operation.replace === true && lanes.some((items, index) => items.length && project.trackLocks?.[`audio-${index}`])) throw Object.assign(new Error("Audio lane is locked"), { code: "TRACK_LOCKED" });
        const accepts = (items, index) => !project.trackLocks?.[`audio-${index}`] && items.every((item) => item.start + item.duration <= segment2.start || segment2.start + segment2.duration <= item.start);
        let lane = lanes.findIndex(accepts);
        if (lane < 0) {
          lane = lanes.length;
          while (project.trackLocks?.[`audio-${lane}`]) lane++;
        }
        segment2.lane = lane;
        project.audioSegments = operation.replace === true ? [segment2] : [...audioSegments, segment2];
      }
      project.audioDuration = project.audioSegments.reduce((end, item) => Math.max(end, (Number(item.start) || 0) + (Number(item.duration) || 0)), 0);
    } else {
      if (Object.entries(project.trackLocks || {}).some(([key, locked]) => locked && key.startsWith("music-"))) throw Object.assign(new Error("Music lane is locked"), { code: "TRACK_LOCKED" });
      project.musicSegments = [segment2];
      project.musicName = segment2.name;
      project.musicDuration = duration;
      project.musicStart = start;
      project.musicVolume = segment2.volume;
    }
    return;
  }
  if (!["image", "video"].includes(operation.mediaType)) throw Object.assign(new Error("Visuals import requires image or video media"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  const segment = {
    id,
    assetId: operation.assetId || `asset-${operation.sha256.slice(0, 16)}`,
    assetVersionId: operation.assetVersionId,
    sourceUrl: operation.sourceUrl,
    src: operation.sourceUrl,
    archiveMediaId: operation.assetVersionId || id,
    name: operation.name || id,
    type: operation.mediaType,
    duration,
    width: Math.max(0, Number(operation.width) || 0),
    height: Math.max(0, Number(operation.height) || 0),
    sourceStart: 0,
    sourceDuration: operation.mediaType === "video" ? duration : 0,
    playbackRate: 1,
    muted: operation.muted === true,
    integrity,
    // FORK: the shot a placed clip stands for (shotId, cameraId, scene source
    // range, index). Free-form on the segment; a slot replacement keeps it.
    ...operation.director && typeof operation.director === "object" && !Array.isArray(operation.director) ? { director: { ...operation.director } } : {}
  };
  if (operation.replaceClipId) {
    const visuals = project.visualSegments || [];
    const replaceIndex = visuals.findIndex((item) => item.id === operation.replaceClipId);
    if (replaceIndex < 0) {
      throw Object.assign(new Error(`Visual replacement clip not found: ${operation.replaceClipId}`), { code: "CLIP_NOT_FOUND" });
    }
    const previous = { ...visuals[replaceIndex] };
    delete previous.blob;
    delete previous.enhancement;
    delete previous.repair;
    const replacement = {
      ...previous,
      ...segment,
      duration: finitePositive2(Number(previous.duration) || segment.duration, "replacement duration"),
      sourceStart: 0,
      playbackRate: operation.mediaType === "video" ? finitePositive2(Number(previous.playbackRate) || 1, "replacement playbackRate") : 1,
      muted: previous.muted === true
    };
    project.visualSegments = [
      ...visuals.slice(0, replaceIndex),
      replacement,
      ...visuals.slice(replaceIndex + 1)
    ];
    return;
  }
  project.visualSegments = [...project.visualSegments || [], segment];
}
function insertVisual(project, operation) {
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  if (!Number.isInteger(operation.atIndex) || operation.atIndex < 0 || operation.atIndex > visuals.length) {
    throw Object.assign(new Error("atIndex must be a valid visual insertion position"), { code: "INVALID_ARGUMENT" });
  }
  const next = cloneVisualForSequence(project, operation);
  project.visualSegments = [...visuals.slice(0, operation.atIndex), next, ...visuals.slice(operation.atIndex)];
}
function addOverlay(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  const source = findVisualSource(project, operation.sourceClipId);
  const start = finiteNonNegative(operation.start, "start");
  const sourceDuration = finitePositive2(Number(source.duration), "source clip duration");
  const duration = Object.hasOwn(operation, "duration") ? finitePositive2(operation.duration, "duration") : Math.min(5, sourceDuration);
  if (source.type === "video" && duration > sourceDuration) {
    throw Object.assign(new Error(`Overlay duration cannot exceed source clip duration ${sourceDuration}`), { code: "SOURCE_RANGE_EXCEEDED" });
  }
  const layer = Object.hasOwn(operation, "layer") ? finitePositive2(operation.layer, "layer") : (project.visualOverlaySegments || []).reduce((maximum, clip) => Math.max(maximum, Number(clip.layer) || 1), 0) + 1;
  const transform = operation.transform || {};
  for (const key of ["x", "y", "scale", "rotation", "opacity"]) {
    if (Object.hasOwn(transform, key) && (typeof transform[key] !== "number" || !Number.isFinite(transform[key]))) {
      throw Object.assign(new Error(`transform.${key} must be finite`), { code: "INVALID_ARGUMENT" });
    }
  }
  const rate = visualPlaybackRate(source);
  const overlay = {
    id,
    assetId: source.assetId || "",
    archiveMediaId: source.archiveMediaId || source.id,
    name: source.name || "Overlay",
    type: source.type === "video" ? "video" : "image",
    width: Number(source.width) || 0,
    height: Number(source.height) || 0,
    sourceStart: Math.max(0, Number(source.sourceStart) || 0),
    sourceDuration: source.type === "video" ? duration * rate : Math.max(0, Number(source.sourceDuration) || 0),
    playbackRate: rate,
    start,
    duration,
    muted: operation.muted === true,
    layer,
    baseTransform: { x: 27, y: -24, scale: 0.34, rotation: 0, opacity: 1, ...transform },
    keyframes: []
  };
  project.visualOverlaySegments = [...project.visualOverlaySegments || [], overlay];
}
function setTransition(project, operation) {
  const transitions = /* @__PURE__ */ new Set(["none", "fade", "zoom", "flash", "wipe-left", "wipe-up", "blur", "split", "glitch"]);
  if (!transitions.has(operation.transitionId)) throw Object.assign(new Error(`Unknown transition: ${operation.transitionId}`), { code: "INVALID_TRANSITION" });
  const visuals = Array.isArray(project.visualSegments) ? project.visualSegments : [];
  const index = visuals.findIndex((clip) => clip.id === operation.clipId);
  if (index < 0) throw Object.assign(new Error(`Visual clip not found: ${operation.clipId}`), { code: "CLIP_NOT_FOUND" });
  if (operation.transitionId !== "none" && index >= visuals.length - 1) {
    throw Object.assign(new Error("A transition requires a following visual clip"), { code: "INVALID_TRANSITION_TARGET" });
  }
  const maximum = index < visuals.length - 1 ? Math.max(0.1, Math.min(2, Number(visuals[index].duration) / 2, Number(visuals[index + 1].duration) / 2)) : 0.5;
  const duration = Object.hasOwn(operation, "duration") ? finitePositive2(operation.duration, "duration") : 0.5;
  if (duration > maximum) throw Object.assign(new Error(`Transition duration cannot exceed ${maximum}`), { code: "INVALID_RANGE" });
  visuals[index].transition = { id: operation.transitionId, duration: Math.min(duration, maximum) };
}
function updateCaption(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  if (Object.hasOwn(operation, "text")) {
    if (typeof operation.text !== "string") throw Object.assign(new Error("text must be a string"), { code: "INVALID_ARGUMENT" });
    caption.text = operation.text;
    caption.reviewStatus = "edited";
  }
  if (Object.hasOwn(operation, "start")) caption.start = finiteNonNegative(operation.start, "start");
  if (Object.hasOwn(operation, "end")) caption.end = finiteNonNegative(operation.end, "end");
  if (Number(caption.end) < Number(caption.start)) {
    throw Object.assign(new Error("caption end must not be before start"), { code: "INVALID_RANGE" });
  }
  project.script = (project.captionSegments || []).map((item) => item.text).join("\n");
}
function addCaption(project, operation) {
  const id = typeof operation.clipId === "string" ? operation.clipId.trim() : "";
  if (!id) throw Object.assign(new Error("clipId is required"), { code: "INVALID_ARGUMENT" });
  const captions = Array.isArray(project.captionSegments) ? project.captionSegments : [];
  if (captions.some((caption) => caption.id === id)) {
    throw Object.assign(new Error(`Caption clip already exists: ${id}`), { code: "CLIP_ALREADY_EXISTS" });
  }
  if (typeof operation.text !== "string") throw Object.assign(new Error("text must be a string"), { code: "INVALID_ARGUMENT" });
  const start = finiteNonNegative(operation.start, "start");
  const end = finiteNonNegative(operation.end, "end");
  if (end < start) throw Object.assign(new Error("caption end must not be before start"), { code: "INVALID_RANGE" });
  let audioSegmentId = "";
  if (operation.audioClipId) audioSegmentId = findById(project.audioSegments, operation.audioClipId, "Audio clip").id;
  const previousCaption = [...captions].sort((left, right) => (Number(left.start) || 0) - (Number(right.start) || 0)).filter((caption) => (Number(caption.start) || 0) <= start).at(-1);
  project.captionSegments = [...captions, {
    id,
    text: operation.text,
    start,
    end,
    fontId: operation.fontId || previousCaption?.fontId || project.captionStyle?.fontId || "default",
    ...audioSegmentId ? { audioSegmentId } : {}
  }].sort((left, right) => (Number(left.start) || 0) - (Number(right.start) || 0));
  project.script = project.captionSegments.map((item) => item.text).join("\n");
}
function replaceCaptionRanges(project, operation) {
  if (project.trackLocks?.caption) throw Object.assign(new Error("Caption track is locked"), { code: "TRACK_LOCKED" });
  const ranges = operation.ranges;
  const incoming = operation.segments;
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 64 || !Array.isArray(incoming) || !incoming.length || incoming.length > 1e4) throw Object.assign(new Error("Invalid caption draft"), { code: "INVALID_ARGUMENT" });
  for (const r of ranges) if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end <= r.start) throw Object.assign(new Error("Invalid caption range"), { code: "INVALID_RANGE" });
  const ids = /* @__PURE__ */ new Set();
  for (const c of incoming) {
    if (!c.id || ids.has(c.id) || typeof c.text !== "string" || !c.text.trim() || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start || !ranges.some((r) => c.start >= r.start - 1e-6 && c.end <= r.end + 1e-6)) throw Object.assign(new Error("Caption must be inside the requested range"), { code: "INVALID_RANGE" });
    ids.add(c.id);
  }
  const sourceClipIds = new Set(operation.sourceClipIds || []);
  const protectedCaption = (c) => sourceClipIds.size && c.source?.clipId && !sourceClipIds.has(c.source.clipId) || c.reviewStatus === "reviewed" || c.reviewStatus === "edited" || c.source?.reviewStatus === "reviewed" || c.source !== "asr" && c.source?.kind !== "asr";
  const protectedRanges = (project.captionSegments || []).filter(protectedCaption);
  const replaceableIncoming = incoming.filter((c) => !protectedRanges.some((p) => c.start < p.end && c.end > p.start));
  if (!replaceableIncoming.length) throw Object.assign(new Error("Selected captions are protected; no captions were changed"), { code: "CAPTION_PROTECTED_RANGE" });
  let kept = project.captionSegments || [];
  for (const [i, r] of ranges.entries()) kept = kept.flatMap((c) => {
    if (protectedCaption(c) || c.end <= r.start || c.start >= r.end) return [c];
    return [...c.start < r.start ? [{ ...c, end: r.start }] : [], ...c.end > r.end ? [{ ...c, id: `${c.id}:after:${operation.id}:${i}`, start: r.end }] : []];
  });
  if (kept.some((c) => ids.has(c.id))) throw Object.assign(new Error("Caption id conflicts outside selected range"), { code: "CLIP_ALREADY_EXISTS" });
  const nextCaptions = [...kept, ...replaceableIncoming.map((c) => ({ ...c, fontId: c.fontId || project.captionStyle?.fontId || "default" }))].sort((a, b) => a.start - b.start);
  const captionLanes = (captions) => packTimedSegmentsIntoLanes(captions.map((c) => ({ ...c, duration: c.end - c.start })));
  const beforeLanes = captionLanes(project.captionSegments || []);
  const afterLanes = captionLanes(nextCaptions);
  for (const [key, locked] of Object.entries(project.trackLocks || {})) {
    if (!locked || !/^caption-\d+$/.test(key)) continue;
    const index = Number(key.slice("caption-".length));
    if (JSON.stringify(beforeLanes[index] || []) !== JSON.stringify(afterLanes[index] || [])) {
      throw Object.assign(new Error("Caption row is locked"), { code: "TRACK_LOCKED" });
    }
  }
  project.captionSegments = nextCaptions;
  project.script = project.captionSegments.map((c) => c.text).join("\n");
}
function deleteClip(project, operation) {
  const collections = { caption: "captionSegments", audio: "audioSegments", visual: "visualSegments", overlay: "visualOverlaySegments" };
  const key = collections[operation.track];
  if (!key) throw Object.assign(new Error(`Unsupported clip track: ${operation.track}`), { code: "UNSUPPORTED_TRACK" });
  const labels = { caption: "Caption", audio: "Audio", visual: "Visual", overlay: "Overlay" };
  findById(project[key], operation.clipId, `${labels[operation.track]} clip`);
  project[key] = project[key].filter((item) => item.id !== operation.clipId);
  if (operation.track === "visual" || operation.track === "overlay") return;
  if (operation.track === "caption") {
    project.script = project.captionSegments.map((item) => item.text).join("\n");
  } else {
    project.captionSegments = (project.captionSegments || []).map((caption) => caption.audioSegmentId === operation.clipId || caption.detachedAudioSegmentId === operation.clipId ? { ...caption, audioSegmentId: "", detachedAudioSegmentId: "" } : caption);
  }
}
function unlinkCaption(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  if (caption.audioSegmentId) caption.detachedAudioSegmentId = caption.audioSegmentId;
  caption.audioSegmentId = "";
}
function linkCaption(project, operation) {
  const caption = findById(project.captionSegments, operation.clipId, "Caption clip");
  const audioId = operation.audioClipId || caption.detachedAudioSegmentId;
  if (!audioId) throw Object.assign(new Error("audioClipId is required"), { code: "INVALID_ARGUMENT" });
  const audio = findById(project.audioSegments, audioId, "Audio clip");
  caption.audioSegmentId = audio.id;
  caption.detachedAudioSegmentId = "";
  if (operation.align === true) {
    caption.start = Number(audio.start) || 0;
    caption.end = caption.start + finiteNonNegative(audio.duration, "audio duration");
  }
}
function findClipMatch(project, clipId) {
  const matches = Object.entries(TRACK_COLLECTIONS).flatMap(([track, key]) => {
    const clips = Array.isArray(project?.[key]) ? project[key] : [];
    return clips.flatMap((clip, index) => clip.id === clipId ? [{ track, key, clip, index }] : []);
  });
  if (!matches.length) throw Object.assign(new Error(`Clip not found: ${clipId}`), { code: "CLIP_NOT_FOUND" });
  if (matches.length > 1) throw Object.assign(new Error(`Clip ID is not globally unique: ${clipId}`), { code: "CLIP_ID_AMBIGUOUS" });
  return matches[0];
}
var NUMERIC_CLIP_PROPERTIES = Object.freeze({
  x: { min: -1e3, max: 1e3 },
  y: { min: -1e3, max: 1e3 },
  scale: { min: 0.1, max: 20 },
  rotation: { min: -36e3, max: 36e3 },
  opacity: { min: 0, max: 1 },
  volume: { min: 0, max: 4 },
  fadeIn: { min: 0, max: 1800 },
  fadeOut: { min: 0, max: 1800 },
  layer: { min: 0, max: 1e3 }
});
function setClipProperty(project, operation) {
  const { clip } = findClipMatch(project, operation.clipId);
  const limits = NUMERIC_CLIP_PROPERTIES[operation.property];
  if (!limits) throw Object.assign(new Error(`Unsupported clip property: ${operation.property}`), { code: "UNSUPPORTED_PROPERTY" });
  if (typeof operation.value !== "number" || !Number.isFinite(operation.value) || operation.value < limits.min || operation.value > limits.max) {
    throw Object.assign(new Error(`${operation.property} must be between ${limits.min} and ${limits.max}`), { code: "INVALID_ARGUMENT" });
  }
  clip[operation.property] = operation.value;
}
function setClipSpeed(project, operation) {
  const match = findClipMatch(project, operation.clipId);
  if (match.track === "captions" || match.track === "stickers" || match.track === "visuals" && match.clip.type !== "video" || match.track === "overlays" && match.clip.type !== "video") {
    throw Object.assign(new Error(`Speed is unsupported for ${match.track} clip ${operation.clipId}`), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const speed = finitePositive2(operation.speed, "speed");
  if (speed < 0.25 || speed > 4) throw Object.assign(new Error("speed must be between 0.25 and 4"), { code: "INVALID_ARGUMENT" });
  const clip = match.clip;
  const previousDuration = finitePositive2(Number(clip.duration), "clip duration");
  const previousRate = visualPlaybackRate(clip);
  const sourceDuration = Math.max(1e-3, Number(clip.sourceDuration) || previousDuration * previousRate);
  const duration = sourceDuration / speed;
  clip.playbackRate = speed;
  clip.sourceDuration = sourceDuration;
  clip.duration = duration;
  if (Array.isArray(clip.keyframes)) {
    const timeScale = duration / previousDuration;
    clip.keyframes = clip.keyframes.map((frame) => ({ ...frame, time: Math.max(0, Number(frame.time) || 0) * timeScale }));
  }
  if (match.track === "audio") {
    const clipEnd = (Number(clip.start) || 0) + duration;
    project.captionSegments = (project.captionSegments || []).map((caption) => caption.audioSegmentId === clip.id ? { ...caption, end: Math.max(Number(caption.start) || 0, Math.min(Number(caption.end) || 0, clipEnd)) } : caption);
  }
}
function setClipMuted(project, operation) {
  if (typeof operation.muted !== "boolean") throw Object.assign(new Error("muted must be a boolean"), { code: "INVALID_ARGUMENT" });
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "audio", "overlays"].includes(track)) {
    throw Object.assign(new Error(`Mute is unsupported for ${track} clips`), { code: "UNSUPPORTED_TRACK" });
  }
  if ((track === "visuals" || track === "overlays") && clip.type !== "video") {
    throw Object.assign(new Error("Mute is supported only for video or audio clips"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  }
  clip.muted = operation.muted;
}
var TRACK_STATE_KEYS = Object.freeze({
  visuals: "image",
  image: "image",
  captions: "caption",
  caption: "caption",
  audio: "audio",
  stickers: "sticker",
  sticker: "sticker",
  overlays: "overlay",
  overlay: "overlay",
  source: "source",
  music: "music"
});
function setTrackState(project, operation, stateKey) {
  const track = TRACK_STATE_KEYS[operation.track];
  if (!track) throw Object.assign(new Error(`Unknown track: ${operation.track}`), { code: "TRACK_NOT_FOUND" });
  const value = operation[stateKey];
  if (typeof value !== "boolean") throw Object.assign(new Error(`${stateKey} must be a boolean`), { code: "INVALID_ARGUMENT" });
  const projectKey = stateKey === "visible" ? "trackVisibility" : "trackLocks";
  project[projectKey] = { ...project[projectKey] || {}, [track]: value };
}
var COLOR_GRADE_WHEELS = Object.freeze(["shadows", "midtones", "highlights", "offset"]);
var COLOR_GRADE_SCALARS = Object.freeze(["temperature", "tint", "saturation"]);
function boundedGradeNumber(value, name, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw Object.assign(new Error(`${name} must be between ${minimum} and ${maximum}`), { code: "INVALID_ARGUMENT" });
  }
  return value;
}
function gradePatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("colorGrade must be an object"), { code: "INVALID_ARGUMENT" });
  }
  const allowed = /* @__PURE__ */ new Set([...COLOR_GRADE_SCALARS, ...COLOR_GRADE_WHEELS]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw Object.assign(new Error(`colorGrade has unknown field: ${unknown}`), { code: "INVALID_ARGUMENT" });
  const patch = {};
  for (const key of COLOR_GRADE_SCALARS) {
    if (Object.hasOwn(value, key)) patch[key] = boundedGradeNumber(value[key], `colorGrade.${key}`, -100, 100);
  }
  for (const wheel of COLOR_GRADE_WHEELS) {
    if (!Object.hasOwn(value, wheel)) continue;
    const input = value[wheel];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw Object.assign(new Error(`colorGrade.${wheel} must be an object`), { code: "INVALID_ARGUMENT" });
    }
    const unknownWheelKey = Object.keys(input).find((key) => !["hue", "saturation", "luminance"].includes(key));
    if (unknownWheelKey) throw Object.assign(new Error(`colorGrade.${wheel} has unknown field: ${unknownWheelKey}`), { code: "INVALID_ARGUMENT" });
    patch[wheel] = {};
    if (Object.hasOwn(input, "hue")) patch[wheel].hue = boundedGradeNumber(input.hue, `colorGrade.${wheel}.hue`, -360, 360);
    if (Object.hasOwn(input, "saturation")) patch[wheel].saturation = boundedGradeNumber(input.saturation, `colorGrade.${wheel}.saturation`, 0, 100);
    if (Object.hasOwn(input, "luminance")) patch[wheel].luminance = boundedGradeNumber(input.luminance, `colorGrade.${wheel}.luminance`, -100, 100);
  }
  return patch;
}
function setColorGrade(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track)) {
    throw Object.assign(new Error(`Colour grading is unsupported for ${track} clips`), { code: "UNSUPPORTED_TRACK" });
  }
  if (operation.reset === true) {
    delete clip.colorGrade;
    return;
  }
  const patch = gradePatch(operation.colorGrade);
  const mode = operation.mode ?? "merge";
  if (!["merge", "replace"].includes(mode)) throw Object.assign(new Error("mode must be merge or replace"), { code: "INVALID_ARGUMENT" });
  const base = mode === "replace" ? DEFAULT_COLOR_GRADE : normalizeColorGrade(clip.colorGrade || {});
  const merged = { ...base, ...patch };
  for (const wheel of COLOR_GRADE_WHEELS) {
    if (patch[wheel]) merged[wheel] = { ...base[wheel], ...patch[wheel] };
  }
  const next = normalizeColorGrade(merged);
  if (isColorGradeNeutral(next)) delete clip.colorGrade;
  else clip.colorGrade = next;
}
function setVisualFilter(project, operation) {
  const { filterId } = operation;
  if (filterId !== null && (typeof filterId !== "string" || !SUPPORTED_VISUAL_FILTER_IDS.includes(filterId))) {
    throw Object.assign(new Error(`Unsupported filter: ${String(filterId)}; use one of ${SUPPORTED_VISUAL_FILTER_IDS.join(", ")}`), { code: "UNSUPPORTED_FILTER" });
  }
  if (operation.clipId === void 0) {
    if (filterId === null) throw Object.assign(new Error("the project filter cannot be cleared; set it to none"), { code: "INVALID_ARGUMENT" });
    project.selectedFilterId = filterId;
    return;
  }
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track)) {
    throw Object.assign(new Error(`Filters are unsupported for ${track} clips`), { code: "UNSUPPORTED_TRACK" });
  }
  if (filterId === null) delete clip.filterId;
  else clip.filterId = filterId;
}
function setProjectRatio(project, operation) {
  const supportedRatios = /* @__PURE__ */ new Set(["16:9", "9:16", "1:1", "4:5", "21:9", "2.39:1"]);
  if (!supportedRatios.has(operation.ratio)) throw Object.assign(new Error(`Unsupported project ratio: ${operation.ratio}`), { code: "INVALID_RATIO" });
  project.ratioId = operation.ratio;
}
function applyEffect(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track)) {
    throw Object.assign(new Error(`Effects are unsupported for ${track} clips`), { code: "UNSUPPORTED_TRACK" });
  }
  const effect = normalizeRegisteredEffect({
    id: operation.effectId,
    version: operation.effectVersion,
    parameters: operation.parameters
  }, { mediaType: clip.type, requireFinalRenderer: true });
  const current = Array.isArray(clip.effects) ? clip.effects : [];
  clip.effects = [...current.filter((item) => item?.id !== effect.id), effect];
}
function removeEffect(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track)) {
    throw Object.assign(new Error(`Effects are unsupported for ${track} clips`), { code: "UNSUPPORTED_TRACK" });
  }
  if (typeof operation.effectId !== "string" || !operation.effectId.trim()) {
    throw Object.assign(new Error("effectId is required"), { code: "EFFECT_PARAMETERS_INVALID" });
  }
  clip.effects = (Array.isArray(clip.effects) ? clip.effects : []).filter((item) => item?.id !== operation.effectId);
}
function assertBoundedObject(value, name, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error(`${name} contains unsupported fields`), { code: "INVALID_ARGUMENT" });
  }
}
function setSubjectEffect(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (!["visuals", "overlays"].includes(track)) {
    throw Object.assign(new Error(`Subject effects are unsupported for ${track} clips`), { code: "UNSUPPORTED_TRACK" });
  }
  assertBoundedObject(operation.effect, "effect", /* @__PURE__ */ new Set([
    "enabled",
    "presetId",
    "targetKind",
    "analysisQuality",
    "outline",
    "material",
    "background",
    "edge"
  ]));
  if (operation.effect.targetKind !== "person" && operation.effect.targetKind !== "object") {
    throw Object.assign(new Error("effect.targetKind must be person or object"), { code: "INVALID_ARGUMENT" });
  }
  if (operation.effect.outline !== void 0) assertBoundedObject(operation.effect.outline, "effect.outline", /* @__PURE__ */ new Set(["enabled", "color", "width", "opacity", "softness", "glow", "glowRadius"]));
  if (operation.effect.material !== void 0) assertBoundedObject(operation.effect.material, "effect.material", /* @__PURE__ */ new Set(["id", "textureScale", "textureStrength", "irregularity", "edgeDensity", "grain", "diffusion", "shadowDepth", "relief", "bleed", "contrast", "rings", "ringGap"]));
  if (operation.effect.background !== void 0) assertBoundedObject(operation.effect.background, "effect.background", /* @__PURE__ */ new Set(["visible", "mode", "color", "src", "assetId", "fit", "opacity", "blur", "darken"]));
  if (operation.effect.edge !== void 0) assertBoundedObject(operation.effect.edge, "effect.edge", /* @__PURE__ */ new Set(["feather", "contract", "decontaminate"]));
  const analysis = clip?.vision?.hostAnalysis;
  const expectedKind = operation.effect.targetKind === "object" ? "object" : "subject";
  const expectedRoles = expectedKind === "object" ? /* @__PURE__ */ new Set(["object-mask", "object-cutout"]) : /* @__PURE__ */ new Set(["subject-mask", "subject-cutout"]);
  const source = analysis?.source;
  const artifact = Array.isArray(analysis?.artifacts) ? analysis.artifacts.find((item) => expectedRoles.has(item?.role)) : null;
  if (analysis?.kind !== "video-analysis-record" || analysis.analysisKind !== expectedKind || source?.clipId !== clip.id || clip.assetId && source?.assetId !== clip.assetId || clip.assetVersionId && source?.versionId !== clip.assetVersionId || !artifact?.assetId || !artifact?.versionId || !artifact?.sourceUrl) {
    throw Object.assign(new Error("Subject effect requires immutable analysis for the current clip AssetVersion"), { code: "ANALYSIS_ASSET_REQUIRED" });
  }
  clip.subjectEffect = normalizeSubjectEffect(operation.effect);
}
function assertDepthAnalysis(clip) {
  const analysis = clip?.depth?.hostAnalysis;
  const source = analysis?.source;
  const artifact = Array.isArray(analysis?.artifacts) ? analysis.artifacts.find((item) => item?.role === "depth-map") : null;
  if (analysis?.kind !== "video-analysis-record" || analysis.analysisKind !== "depth" || source?.clipId !== clip.id || clip.assetId && source?.assetId !== clip.assetId || clip.assetVersionId && source?.versionId !== clip.assetVersionId || !artifact?.assetId || !artifact?.versionId || !artifact?.sourceUrl) {
    throw Object.assign(new Error("Depth effect requires immutable analysis for the current clip AssetVersion"), { code: "ANALYSIS_ASSET_REQUIRED" });
  }
}
function setDepthEffect(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (track !== "visuals") throw Object.assign(new Error("Cinematic depth currently supports primary visuals"), { code: "UNSUPPORTED_TRACK" });
  assertBoundedObject(operation.effect, "effect", /* @__PURE__ */ new Set(["enabled", "focus", "focusRange", "blur", "quality", "highlightBoost"]));
  assertDepthAnalysis(clip);
  clip.cinematicDepth = normalizeCinematicDepth(operation.effect);
  if (clip.cinematicDepth.enabled && clip.photoParallax?.enabled) clip.photoParallax = { ...clip.photoParallax, enabled: false };
}
function setPhotoParallax(project, operation) {
  const { track, clip } = findClipMatch(project, operation.clipId);
  if (track !== "visuals" || clip.type !== "image") throw Object.assign(new Error("Photo parallax requires a primary image clip"), { code: "UNSUPPORTED_TRACK" });
  assertBoundedObject(operation.effect, "effect", /* @__PURE__ */ new Set(["enabled", "quality", "direction", "strength", "speed", "zoom", "foregroundDepth", "backgroundDepth", "edgeFeather"]));
  assertDepthAnalysis(clip);
  clip.photoParallax = normalizePhotoParallax(operation.effect);
  if (clip.photoParallax.enabled && clip.cinematicDepth?.enabled) clip.cinematicDepth = { ...clip.cinematicDepth, enabled: false };
}
function boundedStickerNumber(value, name, minimum, maximum, fallback) {
  const candidate = value == null ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
    throw Object.assign(new Error(`${name} must be between ${minimum} and ${maximum}`), { code: "INVALID_ARGUMENT" });
  }
  return candidate;
}
function normalizeStickerKeyframes(value, duration) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) {
    throw Object.assign(new Error("Sticker keyframes must be a bounded array"), { code: "INVALID_ARGUMENT" });
  }
  const allowed = /* @__PURE__ */ new Set(["time", "x", "y", "scale", "rotation", "opacity"]);
  return value.map((frame) => {
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || Object.keys(frame).some((key) => !allowed.has(key))) {
      throw Object.assign(new Error("Sticker keyframe fields are invalid"), { code: "INVALID_ARGUMENT" });
    }
    const next = { time: boundedStickerNumber(frame.time, "keyframe.time", 0, duration, 0) };
    if (Object.hasOwn(frame, "x")) next.x = boundedStickerNumber(frame.x, "keyframe.x", -100, 200, 82);
    if (Object.hasOwn(frame, "y")) next.y = boundedStickerNumber(frame.y, "keyframe.y", -100, 200, 20);
    if (Object.hasOwn(frame, "scale")) next.scale = boundedStickerNumber(frame.scale, "keyframe.scale", 0.2, 3, 1);
    if (Object.hasOwn(frame, "rotation")) next.rotation = boundedStickerNumber(frame.rotation, "keyframe.rotation", -36e3, 36e3, 0);
    if (Object.hasOwn(frame, "opacity")) next.opacity = boundedStickerNumber(frame.opacity, "keyframe.opacity", 0, 1, 1);
    return next;
  }).sort((left, right) => left.time - right.time);
}
function addSticker(project, operation) {
  const id = requireNewClipId(project, operation.clipId);
  if (operation.prepared !== true || operation.mediaType !== "image" || !operation.assetId || !operation.assetVersionId || !operation.sourceUrl || !operation.archivePath || !operation.sha256) {
    throw Object.assign(new Error("sticker.add must be prepared from an owned image AssetVersion"), { code: "ASSET_NOT_PREPARED" });
  }
  const duration = finitePositive2(operation.duration, "duration");
  const segment = {
    id,
    type: "image",
    assetId: operation.assetId,
    assetVersionId: operation.assetVersionId,
    sourceUrl: operation.sourceUrl,
    src: operation.sourceUrl,
    archiveMediaId: operation.assetVersionId,
    name: operation.name || id,
    start: finiteNonNegative(operation.start ?? 0, "start"),
    duration,
    layer: boundedStickerNumber(operation.layer, "layer", 0, 1e3, 1),
    x: boundedStickerNumber(operation.x, "x", -100, 200, 82),
    y: boundedStickerNumber(operation.y, "y", -100, 200, 20),
    scale: boundedStickerNumber(operation.scale, "scale", 0.2, 3, 1),
    rotation: boundedStickerNumber(operation.rotation, "rotation", -36e3, 36e3, 0),
    opacity: boundedStickerNumber(operation.opacity, "opacity", 0, 1, 1),
    keyframes: normalizeStickerKeyframes(operation.keyframes, duration),
    integrity: {
      sha256: operation.sha256,
      size: operation.size,
      mimeType: operation.mimeType,
      archivePath: operation.archivePath
    }
  };
  project.stickerSegments = [...project.stickerSegments || [], segment];
}
function updateSticker(project, operation) {
  const sticker = findById(project.stickerSegments, operation.clipId, "Sticker clip");
  if (!operation.patch || typeof operation.patch !== "object" || Array.isArray(operation.patch)) {
    throw Object.assign(new Error("patch must be an object"), { code: "INVALID_ARGUMENT" });
  }
  const allowed = /* @__PURE__ */ new Set(["start", "duration", "layer", "x", "y", "scale", "rotation", "opacity", "keyframes", "hidden"]);
  if (Object.keys(operation.patch).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error("Sticker patch contains unsupported fields"), { code: "INVALID_ARGUMENT" });
  }
  const duration = Object.hasOwn(operation.patch, "duration") ? finitePositive2(operation.patch.duration, "duration") : finitePositive2(sticker.duration, "duration");
  if (Object.hasOwn(operation.patch, "start")) sticker.start = finiteNonNegative(operation.patch.start, "start");
  sticker.duration = duration;
  const bounds = {
    layer: [0, 1e3, sticker.layer ?? 1],
    x: [-100, 200, sticker.x ?? 82],
    y: [-100, 200, sticker.y ?? 20],
    scale: [0.2, 3, sticker.scale ?? 1],
    rotation: [-36e3, 36e3, sticker.rotation ?? 0],
    opacity: [0, 1, sticker.opacity ?? 1]
  };
  Object.entries(bounds).forEach(([key, [minimum, maximum, fallback]]) => {
    if (Object.hasOwn(operation.patch, key)) {
      sticker[key] = boundedStickerNumber(operation.patch[key], key, minimum, maximum, fallback);
    }
  });
  if (Object.hasOwn(operation.patch, "hidden")) {
    if (typeof operation.patch.hidden !== "boolean") throw Object.assign(new Error("hidden must be boolean"), { code: "INVALID_ARGUMENT" });
    sticker.hidden = operation.patch.hidden;
  }
  if (Object.hasOwn(operation.patch, "keyframes")) {
    sticker.keyframes = normalizeStickerKeyframes(operation.patch.keyframes, duration);
  } else if (Array.isArray(sticker.keyframes) && sticker.keyframes.some((frame) => frame.time > duration)) {
    throw Object.assign(new Error("Existing Sticker keyframes exceed the new duration"), { code: "INVALID_RANGE" });
  }
}
function removeSticker(project, operation) {
  findById(project.stickerSegments, operation.clipId, "Sticker clip");
  project.stickerSegments = project.stickerSegments.filter((item) => item.id !== operation.clipId);
}
function normalizeMusicEnvelope(value, duration) {
  if (!Array.isArray(value) || value.length > 64) {
    throw Object.assign(new Error("Music envelope must contain at most 64 points"), { code: "INVALID_ARGUMENT" });
  }
  let previous = -1;
  return value.map((point) => {
    if (!point || typeof point !== "object" || Array.isArray(point) || Object.keys(point).some((key) => !["time", "gain"].includes(key))) {
      throw Object.assign(new Error("Music envelope point is invalid"), { code: "INVALID_ARGUMENT" });
    }
    const time = boundedStickerNumber(point.time, "envelope.time", 0, duration, 0);
    const gain = boundedStickerNumber(point.gain, "envelope.gain", 0, 4, 1);
    if (time <= previous) {
      throw Object.assign(new Error("Music envelope points must be strictly increasing"), { code: "INVALID_ARGUMENT" });
    }
    previous = time;
    return { time, gain };
  });
}
function normalizeMusicDucking(value) {
  if (value == null) return { enabled: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Music ducking must be an object"), { code: "INVALID_ARGUMENT" });
  }
  if (value.enabled === false) return { enabled: false };
  if (value.enabled !== true || value.speechBus !== "voiceover") {
    throw Object.assign(new Error("Music ducking requires the voiceover speech bus"), { code: "INVALID_ARGUMENT" });
  }
  return {
    enabled: true,
    speechBus: "voiceover",
    threshold: boundedStickerNumber(value.threshold, "ducking.threshold", 1e-3, 1, 0.05),
    floorGain: boundedStickerNumber(value.floorGain, "ducking.floorGain", 0.01, 1, 0.2),
    attackMs: boundedStickerNumber(value.attackMs, "ducking.attackMs", 0.1, 2e3, 5),
    releaseMs: boundedStickerNumber(value.releaseMs, "ducking.releaseMs", 10, 9e3, 300)
  };
}
function setAudioLoudness(project, operation) {
  const value = operation.targetLoudnessLufs;
  if (value === null || value === void 0) {
    delete project.targetLoudnessLufs;
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < -24 || value > -6) {
    throw Object.assign(new Error("targetLoudnessLufs must be between -24 and -6 LUFS, or null to reset"), { code: "INVALID_ARGUMENT" });
  }
  project.targetLoudnessLufs = value;
}
function setMusicAutomation(project, operation) {
  const music = findById(project.musicSegments, operation.clipId, "Music clip");
  const duration = finitePositive2(music.duration, "music duration");
  music.volumeEnvelope = normalizeMusicEnvelope(operation.envelope ?? [], duration);
  music.ducking = normalizeMusicDucking(operation.ducking);
}
var reducers = {
  "asset.import": importAsset,
  "timed.move": moveTimed,
  "timed.resize": resizeTimed,
  "visual.trim": trimVisual,
  "visual.split": splitVisual,
  "visual.reorder": reorderVisual,
  "visual.append": appendVisual,
  "visual.insert": insertVisual,
  "overlay.add": addOverlay,
  "transition.set": setTransition,
  "caption.add": addCaption,
  "caption.replace_ranges": replaceCaptionRanges,
  "caption.update": updateCaption,
  "caption.unlink_audio": unlinkCaption,
  "caption.link_audio": linkCaption,
  "clip.delete": deleteClip,
  "clip.set_property": setClipProperty,
  "clip.set_speed": setClipSpeed,
  "clip.set_muted": setClipMuted,
  "track.set_visibility": (project, operation) => setTrackState(project, operation, "visible"),
  "track.set_locked": (project, operation) => setTrackState(project, operation, "locked"),
  "project.set_ratio": setProjectRatio,
  "color.set": setColorGrade,
  "filter.set": setVisualFilter,
  "effect.apply": applyEffect,
  "effect.remove": removeEffect,
  "sticker.add": addSticker,
  "sticker.update": updateSticker,
  "sticker.remove": removeSticker,
  "music.automation.set": setMusicAutomation,
  "audio.set_loudness": setAudioLoudness,
  "subject.effect.set": setSubjectEffect,
  "depth.effect.set": setDepthEffect,
  "parallax.set": setPhotoParallax
};
function validateCommandPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return failure("INVALID_PLAN", "Plan must be an object");
  if (plan.schemaVersion !== PROJECT_COMMAND_SCHEMA_VERSION) return failure("UNSUPPORTED_SCHEMA", "schemaVersion must be 1");
  if (!Number.isInteger(plan.baseRevision) || plan.baseRevision < 0) return failure("INVALID_PLAN", "baseRevision must be a non-negative integer");
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) return failure("INVALID_PLAN", "operations must be a non-empty array");
  const ids = /* @__PURE__ */ new Set();
  for (const operation of plan.operations) {
    if (!operation || typeof operation.id !== "string" || !operation.id.trim()) return failure("INVALID_PLAN", "Every operation requires an id");
    if (ids.has(operation.id)) return failure("DUPLICATE_OPERATION_ID", `Duplicate operation id: ${operation.id}`, operation.id);
    ids.add(operation.id);
    if (!reducers[operation.type]) return failure("UNKNOWN_OPERATION", `Unknown operation type: ${operation.type}`, operation.id);
  }
  return { ok: true };
}
function inspectProject(project) {
  const state = commandState(project);
  const captions = Array.isArray(project?.captionSegments) ? project.captionSegments : [];
  const audio = Array.isArray(project?.audioSegments) ? project.audioSegments : [];
  const visuals = Array.isArray(project?.visualSegments) ? project.visualSegments : [];
  const stickers = Array.isArray(project?.stickerSegments) ? project.stickerSegments : [];
  const overlays = Array.isArray(project?.visualOverlaySegments) ? project.visualOverlaySegments : [];
  const music = Array.isArray(project?.musicSegments) ? project.musicSegments : [];
  const visualDuration = visuals.reduce((total, item) => total + Math.max(0, Number(item.duration) || 0), 0);
  const duration = [
    visualDuration,
    ...captions.map((item) => Number(item.end) || 0),
    ...audio.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...stickers.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...overlays.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0)),
    ...music.map((item) => (Number(item.start) || 0) + (Number(item.duration) || 0))
  ].reduce((maximum, value) => Math.max(maximum, value), 0);
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: state.revision,
    duration,
    ratio: project?.ratioId || "16:9",
    tracks: { captions: captions.length, audio: audio.length, visuals: visuals.length, stickers: stickers.length, overlays: overlays.length, music: music.length },
    appliedOperationIds: state.appliedOperationIds,
    warnings: audio.length ? [] : ["Project has no serialized voiceover clips"]
  };
}
var TRACK_COLLECTIONS = Object.freeze({
  visuals: "visualSegments",
  captions: "captionSegments",
  audio: "audioSegments",
  stickers: "stickerSegments",
  overlays: "visualOverlaySegments",
  music: "musicSegments"
});
function clipSummary(track, clip, index, visualStart = 0) {
  if (track === "visuals") {
    const duration2 = Math.max(0, Number(clip.duration) || 0);
    return {
      id: clip.id,
      index,
      type: clip.type || "image",
      start: visualStart,
      end: visualStart + duration2,
      duration: duration2,
      assetId: clip.assetId || "",
      name: clip.name || ""
    };
  }
  if (track === "captions") {
    const start2 = Math.max(0, Number(clip.start) || 0);
    const end = Math.max(start2, Number(clip.end) || start2);
    return { id: clip.id, index, start: start2, end, duration: end - start2, text: clip.text || "", audioSegmentId: clip.audioSegmentId || "" };
  }
  const start = Math.max(0, Number(clip.start) || 0);
  const duration = Math.max(0, Number(clip.duration) || 0);
  return { id: clip.id, index, start, end: start + duration, duration, name: clip.name || "" };
}
function inspectTrack(project, track) {
  const key = TRACK_COLLECTIONS[track];
  if (!key) throw Object.assign(new Error(`Unknown track: ${track}`), { code: "TRACK_NOT_FOUND" });
  const clips = Array.isArray(project?.[key]) ? project[key] : [];
  let visualCursor = 0;
  const summaries = clips.map((clip, index) => {
    const summary = clipSummary(track, clip, index, visualCursor);
    if (track === "visuals") visualCursor = summary.end;
    return summary;
  }).sort((left, right) => left.start - right.start || left.index - right.index);
  return {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision: commandState(project).revision,
    track,
    visible: project?.trackVisibility?.[TRACK_STATE_KEYS[track]] ?? true,
    locked: project?.trackLocks?.[TRACK_STATE_KEYS[track]] ?? false,
    clipCount: summaries.length,
    duration: summaries.reduce((maximum, clip) => Math.max(maximum, clip.end), 0),
    clips: summaries
  };
}
function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function diffProjects(beforeProject, afterProject) {
  const projectFields = ["ratioId", "fitMode", "trackVisibility", "trackLocks", "script", "selectedFilterId", "targetLoudnessLufs", "sourceAudioSource", "sourceAudioName", "sourceAudioDuration", "sourceAudioStart", "sourceAudioAssetId"].flatMap((field) => sameValue(beforeProject?.[field], afterProject?.[field]) ? [] : [{ field, before: beforeProject?.[field] ?? null, after: afterProject?.[field] ?? null }]);
  const tracks = Object.fromEntries(Object.entries(TRACK_COLLECTIONS).flatMap(([track, key]) => {
    const before = Array.isArray(beforeProject?.[key]) ? beforeProject[key] : [];
    const after = Array.isArray(afterProject?.[key]) ? afterProject[key] : [];
    const beforeById = new Map(before.map((clip) => [clip.id, clip]));
    const afterById = new Map(after.map((clip) => [clip.id, clip]));
    const added = after.filter((clip) => !beforeById.has(clip.id)).map((clip) => clip.id);
    const removed = before.filter((clip) => !afterById.has(clip.id)).map((clip) => clip.id);
    const modified = after.flatMap((clip) => {
      const previous = beforeById.get(clip.id);
      if (!previous || sameValue(previous, clip)) return [];
      const fields = [.../* @__PURE__ */ new Set([...Object.keys(previous), ...Object.keys(clip)])].filter((field) => !sameValue(previous[field], clip[field]));
      return [{ id: clip.id, fields, before: Object.fromEntries(fields.map((field) => [field, previous[field] ?? null])), after: Object.fromEntries(fields.map((field) => [field, clip[field] ?? null])) }];
    });
    const orderBefore = before.map((clip) => clip.id);
    const orderAfter = after.map((clip) => clip.id);
    if (!added.length && !removed.length && !modified.length && sameValue(orderBefore, orderAfter)) return [];
    return [[track, { added, removed, modified, ...sameValue(orderBefore, orderAfter) ? {} : { orderBefore, orderAfter } }]];
  }));
  return { projectFields, tracks };
}
function applyCommandPlan(project, plan) {
  const validity = validateCommandPlan(plan);
  if (!validity.ok) return validity;
  const current = commandState(project);
  const alreadyApplied = new Set(current.appliedOperationIds);
  if (plan.operations.every((operation) => alreadyApplied.has(operation.id))) {
    return {
      ok: true,
      revision: current.revision,
      appliedOperationIds: [],
      warnings: [],
      project: structuredClone(project),
      before: inspectProject(project),
      after: inspectProject(project),
      changes: { projectFields: [], tracks: {} }
    };
  }
  if (plan.baseRevision !== current.revision) {
    return failure("REVISION_CONFLICT", `Expected revision ${plan.baseRevision}, found ${current.revision}`);
  }
  const next = structuredClone(project);
  const appliedOperationIds = [];
  let operationId = "";
  try {
    for (const operation of plan.operations) {
      if (alreadyApplied.has(operation.id)) continue;
      operationId = operation.id;
      reducers[operation.type](next, operation);
      appliedOperationIds.push(operation.id);
    }
  } catch (error) {
    return failure(error?.code || "OPERATION_FAILED", error instanceof Error ? error.message : "Operation failed", operationId);
  }
  const revision = appliedOperationIds.length ? current.revision + 1 : current.revision;
  next[COMMAND_STATE_KEY] = {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    revision,
    appliedOperationIds: [...current.appliedOperationIds, ...appliedOperationIds]
  };
  return {
    ok: true,
    revision,
    appliedOperationIds,
    warnings: [],
    project: next,
    before: inspectProject(project),
    after: inspectProject(next),
    changes: diffProjects(project, next)
  };
}

// src/commands/execute.ts
function failure2(code, message, operationId) {
  return { ok: false, code, message, ...operationId ? { operationId } : {} };
}
function cloneObject(value) {
  return structuredClone(value);
}
function projectFromDocument(document2) {
  const project = document2.project;
  return project && typeof project === "object" && !Array.isArray(project) ? project : void 0;
}
function validateDocument(document2) {
  if (document2.format !== "timeline-studio-archive" || document2.version !== 3) {
    return failure2("INVALID_TIMELINE_DOCUMENT", "Expected a Timeline Studio v3 archive");
  }
  const project = projectFromDocument(document2);
  if (!project) return failure2("INVALID_TIMELINE_DOCUMENT", "Timeline archive project is missing");
  return { ok: true, project };
}
function inspectVideoEditorDocument(document2) {
  const validation = validateDocument(document2);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.message), { code: validation.code });
  }
  return inspectProject(validation.project);
}
var VIDEO_EDITOR_TRACKS = ["visuals", "captions", "audio", "stickers", "overlays", "music"];
function inspectVideoEditorTracks(document2) {
  const validation = validateDocument(document2);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.message), { code: validation.code });
  }
  const out = {};
  for (const track of VIDEO_EDITOR_TRACKS) {
    out[track] = inspectTrack(validation.project, track);
  }
  return out;
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function retainStoryProvenance(before, after, plan, appliedIds) {
  const collections = ["visualSegments", "audioSegments", "musicSegments", "visualOverlaySegments"];
  const lineage = /* @__PURE__ */ new Map();
  for (const key of collections) {
    const clips = before[key];
    if (!Array.isArray(clips)) continue;
    for (const raw of clips) {
      const clip = record(raw);
      if (!clip || typeof clip.id !== "string") continue;
      const metadata = {};
      if (Object.hasOwn(clip, "storyMediaSource")) metadata.storyMediaSource = structuredClone(clip.storyMediaSource);
      if (Object.hasOwn(clip, "director")) metadata.director = structuredClone(clip.director);
      lineage.set(clip.id, metadata);
    }
  }
  const applied = new Set(appliedIds);
  for (const operation of plan.operations) {
    if (!applied.has(operation.id)) continue;
    if (operation.type === "asset.import" && typeof operation.clipId === "string") {
      const previous = typeof operation.replaceClipId === "string" ? lineage.get(operation.replaceClipId) : void 0;
      const director = previous?.director ?? operation.director;
      if (typeof operation.replaceClipId === "string") lineage.delete(operation.replaceClipId);
      lineage.set(operation.clipId.trim(), {
        // A newly imported file cannot inherit the former file's generation.
        storyMediaSource: structuredClone(record(operation.storyMediaSource) ?? null),
        ...director !== void 0 ? { director: structuredClone(director) } : {}
      });
    } else if (operation.type === "visual.split" && typeof operation.clipId === "string" && typeof operation.rightClipId === "string") {
      lineage.set(operation.rightClipId.trim(), structuredClone(lineage.get(operation.clipId) ?? {}));
    } else if (operation.type === "visual.append" && typeof operation.clipId === "string" && typeof operation.sourceClipId === "string") {
      lineage.set(operation.clipId.trim(), structuredClone(lineage.get(operation.sourceClipId) ?? {}));
    } else if (operation.type === "clip.delete" && typeof operation.clipId === "string") lineage.delete(operation.clipId);
  }
  for (const key of collections) {
    const clips = after[key];
    if (!Array.isArray(clips)) continue;
    for (const raw of clips) {
      const clip = record(raw);
      if (!clip || typeof clip.id !== "string") continue;
      const metadata = lineage.get(clip.id);
      if (metadata) Object.assign(clip, structuredClone(metadata));
    }
  }
}
function executeVideoEditorCommandPlan(document2, plan) {
  const validation = validateDocument(document2);
  if (!validation.ok) return validation;
  for (const operation of plan.operations) {
    const descriptor = getVideoEditorCommand(operation.type);
    if (!descriptor) {
      return failure2("UNKNOWN_OPERATION", `Unknown operation type: ${operation.type}`, operation.id);
    }
    if (descriptor.availability !== "native") {
      return failure2(
        "COMMAND_REQUIRES_UI_FALLBACK",
        `${operation.type} is not yet exposed by the upstream command engine`,
        operation.id
      );
    }
  }
  const candidate = cloneObject(document2);
  const project = projectFromDocument(candidate);
  if (!project) return failure2("INVALID_TIMELINE_DOCUMENT", "Timeline archive project is missing");
  const previousState = project.commandState;
  const previousOperationIds = previousState && typeof previousState === "object" && !Array.isArray(previousState) && Array.isArray(previousState.appliedOperationIds) ? previousState.appliedOperationIds : [];
  project.commandState = {
    schemaVersion: 1,
    revision: plan.baseRevision,
    appliedOperationIds: previousOperationIds
  };
  const result = applyCommandPlan(project, plan);
  if (result.ok !== true) {
    return failure2(
      typeof result.code === "string" ? result.code : "COMMAND_FAILED",
      typeof result.message === "string" ? result.message : "Timeline command failed",
      typeof result.operationId === "string" ? result.operationId : void 0
    );
  }
  candidate.project = result.project;
  retainStoryProvenance(project, candidate.project, plan, result.appliedOperationIds);
  return {
    ok: true,
    revision: Number(result.revision),
    appliedOperationIds: result.appliedOperationIds,
    warnings: result.warnings,
    document: candidate,
    before: result.before,
    after: result.after,
    changes: normalizeVideoEditorCommandDiff(result.changes)
  };
}

// src/empty-archive.ts
function createEmptyTimelineArchive(ratioId) {
  return {
    format: "timeline-studio-archive",
    version: 3,
    project: {
      ...ratioId ? { ratioId } : {},
      visualSegments: [],
      visualOverlaySegments: [],
      audioSegments: [],
      musicSegments: [],
      captionSegments: []
    },
    media: { visuals: [], overlays: [], audioSegments: [], audio: null, sourceAudio: null, music: null },
    vibedevBootstrap: { source: "canvas-board" }
  };
}
function isTimelineArchive(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const archive = value;
  return archive.format === "timeline-studio-archive" && archive.version === 3 && !!archive.project && typeof archive.project === "object" && !Array.isArray(archive.project);
}

// src/timeline-source-time.ts
function getTimelineSourceTime(clip, localSeconds) {
  if (clip.speedCurve && clip.speedCurve.enabled !== false)
    return getFinalSpeedCurveSourceTime(clip, localSeconds);
  const start = Math.max(0, Number(clip.sourceStart) || 0);
  const span = Number(clip.sourceDuration);
  const advance = Math.max(0, Math.min(Number(clip.duration) || 0, localSeconds)) * Math.max(0.25, Math.min(4, Number(clip.playbackRate) || 1));
  return start + (Number.isFinite(span) && span > 0 ? Math.min(span, advance) : advance);
}
function getTimelineLocalTime(clip, sourceSeconds) {
  if (!clip.speedCurve || clip.speedCurve.enabled === false)
    return Math.max(
      0,
      Math.min(
        Number(clip.duration) || 0,
        (sourceSeconds - (Number(clip.sourceStart) || 0)) / Math.max(0.25, Math.min(4, Number(clip.playbackRate) || 1))
      )
    );
  let low = 0, high = Math.max(0, Number(clip.duration) || 0);
  for (let i = 0; i < 48; i++) {
    const middle = (low + high) / 2;
    if (getTimelineSourceTime(clip, middle) < sourceSeconds) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
export {
  HOST_PROJECT_ASPECTS,
  VIDEO_EDITOR_CAPABILITIES,
  VIDEO_EDITOR_TRACKS,
  VideoEditorHostError,
  buildNativeTimelineFfmpegPlan,
  createEditorHostBridge,
  createEditorSurface,
  createEmptyTimelineArchive,
  createVideoEditorMountManager,
  createVideoEditorRuntime,
  executeVideoEditorCommandPlan,
  getNativeTimelineFfmpegMediaRequirements,
  getTimelineLocalTime,
  getTimelineSourceTime,
  getVideoEditorCommand,
  inspectVideoEditorDocument,
  inspectVideoEditorTracks,
  isTimelineArchive,
  isVideoEditorCapabilityId,
  listVideoEditorCommands,
  normalizeVideoEditorCommandDiff,
  prepareEmbeddedEditorCss,
  registerEditorHostEnvironment,
  resolveEmbeddedEditorPortalTarget,
  setEmbeddedEditorLanguage,
  shouldAdoptHostAspect,
  validateVideoEditorCommandRequest
};
