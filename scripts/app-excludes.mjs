/**
 * Files of the built apps that dsh-film does not ship.
 *
 * The canvas build copies the director desk's whole dist/ into
 * director-desk/, and that holds pages nothing dsh-film serves ever opens: the
 * desk's experiment and smoke-test entries (Vite inputs in
 * vibedev-director-desk's vite.config.ts), two smoke pages and a benchmark
 * image from its public/, and the model-runtime page with the three.js
 * toolchain beside it, which VibeDev Studio's daemon opens and dsh-film does
 * not (nothing in src/ or in the canvas names it). Together about 10 MB.
 *
 * scripts/build-apps.mjs removes them after copying an app (and `trim` removes
 * them from apps/ already built), then stops if a kept file still names one;
 * scripts/check-package.mjs refuses to pack while one is present.
 *
 * Each rule: `pattern` matches paths relative to apps/<app> ('/' separators);
 * `needle` is the text whose presence in a kept file means it still refers to
 * a removed one (default: the removed file's name); `referencedFrom` and
 * `reference` document a reference that stays but cannot be reached.
 */
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const DESK_EXPERIMENTS = 'gaussianSplatExperiment|actionRuntimeSmoke|characterImportSmoke|panoramaExportSmoke|routeActionSmoke'

export const APP_EXCLUDES = {
  canvas: [
    {
      pattern: new RegExp(`^director-desk/assets/(${DESK_EXPERIMENTS})-[^/]+\\.(js|css)$`, 'u'),
      why: 'the desk\'s experiment and smoke-test entry chunks (gaussian splats, action/route/character/panorama smoke tests)',
    },
    {
      pattern: /^director-desk\/extension-(protocol|video)-smoke\.html$/u,
      why: 'the desk\'s extension smoke-test pages',
    },
    {
      pattern: /^director-desk\/benchmark-panorama\.jpg$/u,
      why: 'the image of the desk\'s heavy performance benchmark',
      referencedFrom: /^director-desk\/assets\/index-[^/]+\.js$/u,
      reference: 'only for the "heavy" preset of the desk\'s ?benchmark= debug mode, which the canvas never requests (it opens the desk with instanceId, theme and hostOrigin)',
    },
    {
      pattern: /^director-desk\/model-runtime\.html$/u,
      why: 'the model-runtime page (a VibeDev Studio daemon page), which needs the toolchain below',
    },
    {
      pattern: /^director-desk\/assets\/modelRuntime-[^/]+\.js$/u,
      why: 'the model-runtime page\'s entry chunk',
    },
    {
      pattern: /^director-desk\/model-toolchain\//u,
      needle: 'model-toolchain/',
      why: 'the three.js toolchain only the model-runtime page loads',
    },
  ],
  editor: [],
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/** The files of apps/<app> (at appDirectory) an exclude rule matches, with the rule. */
export function excludedFiles(app, appDirectory) {
  const rules = APP_EXCLUDES[app] ?? []
  const found = []
  for (const file of walk(appDirectory)) {
    const path = relative(appDirectory, file).split(sep).join('/')
    const entry = rules.find(rule => rule.pattern.test(path))
    if (entry !== undefined) found.push({ path, entry })
  }
  return found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}
