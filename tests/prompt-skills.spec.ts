/**
 * Prompt skills (提示词技能, spec C1/C2/C3) as dsh-film writes and reads them:
 * the frozen snapshot a node keeps, the sanitizers, the template rendering and
 * which skills a node composes — ported from the canvas's prompt-skills.ts and
 * prompt-composition.ts (feat/dsh-host ad85ff3). The port was compared with
 * the canvas's own modules on tens of thousands of randomized inputs (render,
 * sanitize, skill uses, composed prompts) before these cases were written; the
 * catalogue is the canvas's file (tests/fixtures/catalog/vibedev-skills.json).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardNode } from '../src/canvas/board-ops.js'
import type { PromptSkillCatalog } from '../src/canvas/catalog.js'
import {
  attachPromptSkill, avoidLine, compactPromptSkills, compactSkillNode, missingSkillVars, newNodePromptSkill, normalizeVideoMode, promptSkillUses, readSkillNode, renderPromptSkill,
  renderSkillTemplate, sanitizePromptSkills, skillApplies, skillNodeMetadata, skillPurposePatch, skillTakesMode, snapshotOfSkill, storedPromptSkills,
} from '../src/canvas/prompt-skills.js'

const catalog = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'catalog', 'vibedev-skills.json'), 'utf8')) as PromptSkillCatalog
const skill = (id: string) => catalog.skills.find(entry => entry.id === id)!
const node = (id: string, type: string, metadata: Record<string, unknown> = {}): BoardNode => ({ id, type, position: { x: 0, y: 0 }, width: 340, height: 240, metadata })
const link = (fromNodeId: string, toNodeId: string) => ({ id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId })

describe('what a node keeps of a skill', () => {
  it('freezes the catalogue text and the declared variables, and fills the defaults but not the auto values (C.4)', () => {
    const entry = skill('vd.camera-move-detail')
    const snapshot = snapshotOfSkill(entry)
    expect(snapshot).toEqual({
      name: entry.name, kind: 'wrap', appliesTo: ['video'], template: entry.template, negative: entry.negative, composes: { motion: 'slot', camera: 'slot' },
      variables: [{ key: 'speed', label: { zh: '速度', en: 'Speed' }, default: '平稳' }, { key: 'duration', label: { zh: '总时长（秒）', en: 'Duration (s)' }, auto: 'video.seconds' }],
    })
    // A copy: changing the snapshot leaves the catalogue alone.
    snapshot.variables[0]!.label.zh = 'x'
    expect(entry.variables[0]!.label.zh).toBe('速度')
    expect(newNodePromptSkill(entry, { duration: '8' })).toEqual({ id: 'vd.camera-move-detail', version: 1, vars: { speed: '平稳', duration: '8' }, snapshot: snapshotOfSkill(entry) })
    expect(newNodePromptSkill(entry)).not.toHaveProperty('appliedBy')
    expect(skillNodeMetadata(skill('vd.style-lock'), '2026-10-05.1', { style: '水墨' }, 'at')).toEqual({
      skillSnapshot: { ...snapshotOfSkill(skill('vd.style-lock')), id: 'vd.style-lock', version: 1, catalogVersion: '2026-10-05.1', frozenAt: 'at' },
      skillVars: { style: '水墨' },
    })
    expect(skillPurposePatch(skill('vd.character-sheet'))).toEqual({ promptPurpose: 'character-sheet', count: 1 })
    expect(skillPurposePatch(skill('vd.storyboard-frame'))).toEqual({ promptPurpose: 'shot' })
    expect(skillPurposePatch(skill('vd.style-lock'))).toEqual({})
  })

  it('reads a node\'s skills as the page does: broken, unknown and repeated ones dropped, one wrap and two append skills kept', () => {
    const frame = newNodePromptSkill(skill('vd.storyboard-frame'))
    const poster = newNodePromptSkill(skill('vd.cover-poster'), { title: '雨' })
    const appends = ['vd.style-lock', 'vd.lighting-mood', 'vd.identity-lock'].map(id => newNodePromptSkill(skill(id)))
    expect(sanitizePromptSkills([frame, poster, ...appends, frame, { id: 'vd.x', version: 1, snapshot: {} }, { id: 'bad', snapshot: frame.snapshot }]).map(item => item.id))
      .toEqual(['vd.storyboard-frame', 'vd.style-lock', 'vd.lighting-mood'])
    // Values of declared variables only, as text; a broken version reads as 1; appliedBy kept only as 'writer'.
    expect(sanitizePromptSkills([{ ...frame, version: 'v2', vars: { setting: 3, mood: 'x', shot_size: ['近景'] }, appliedBy: 'agent' }])).toEqual([{ ...frame, vars: { setting: '3' } }])
    expect(sanitizePromptSkills([{ ...frame, appliedBy: 'writer' }])[0]).toMatchObject({ appliedBy: 'writer' })
    for (const cleared of [null, undefined, {}, 'vd.style-lock']) expect(sanitizePromptSkills(cleared)).toEqual([])
    expect(storedPromptSkills([])).toBeNull()
    expect(compactPromptSkills([frame, { ...poster, appliedBy: 'writer' }])).toEqual([
      { id: 'vd.storyboard-frame', version: 1, kind: 'wrap', name: '分镜画面描述', vars: { shot_size: '中景', placement: '画面三分线处' } },
    ])
    expect(compactPromptSkills(null)).toBeUndefined()
  })

  it('attaches as the canvas\'s picker does: a wrap skill first and replacing another, no third append skill, an attached skill left alone', () => {
    const frame = newNodePromptSkill(skill('vd.storyboard-frame'))
    const lock = newNodePromptSkill(skill('vd.style-lock'), { style: '水墨' })
    expect(attachPromptSkill([lock], skill('vd.storyboard-frame'))).toEqual({ skills: [frame, lock], outcome: 'added' })
    expect(attachPromptSkill([frame, lock], skill('vd.cover-poster'), { title: '雨' })).toMatchObject({ outcome: 'replaced', replaced: frame, skills: [{ id: 'vd.cover-poster' }, lock] })
    expect(attachPromptSkill([lock, newNodePromptSkill(skill('vd.lighting-mood'))], skill('vd.identity-lock')).outcome).toBe('limit')
    expect(attachPromptSkill([lock], skill('vd.style-lock'), { style: '别的' })).toEqual({ skills: [lock], outcome: 'exists' })
  })

  it('reads a skill node only with a readable skill, and shows it without its template', () => {
    const metadata = skillNodeMetadata(skill('vd.lighting-mood'), '2026-10-05.1', { mood: '冷峻', extra: 'x' })
    expect(readSkillNode(node('s', 'skill', metadata))).toMatchObject({ id: 'vd.lighting-mood', version: 1, catalogVersion: '2026-10-05.1', vars: { mood: '冷峻' } })
    expect(readSkillNode(node('s', 'image', metadata))).toBeNull()
    expect(readSkillNode(node('s', 'skill', { skillSnapshot: { ...metadata.skillSnapshot, id: 'lighting' } }))).toBeNull()
    expect(compactSkillNode(metadata)).toEqual({ id: 'vd.lighting-mood', version: 1, catalogVersion: '2026-10-05.1', kind: 'append', name: '光影氛围', appliesTo: ['image', 'video'], vars: { mood: '冷峻' } })
  })
})

describe('rendering a skill (C2)', () => {
  it('fills variables, the person\'s text and the reserved slots, and leaves out what stays empty', () => {
    const detail = skill('vd.camera-move-detail')
    expect(renderPromptSkill(snapshotOfSkill(detail), { speed: '缓慢' }, { prompt: '林推门而入', motion: '镜头缓慢地向前推进，逐渐靠近主体', seconds: '5' })).toBe([
      '运镜分段：林推门而入',
      '镜头运动：镜头缓慢地向前推进，逐渐靠近主体。',
      '总时长约5秒。',
      '镜头运动按时间展开：起幅画面（开头构图）→ 运动过程（方向、速度、与主体距离的变化）→ 落幅画面（结束时的构图与焦点）；运动速度：缓慢。',
      '运动由主体动作或视线牵引，起落自然，不急停、不抖动；全程主体在画面内且对焦清晰。',
    ].join('\n'))
    // On the {{prompt}} line an empty placeholder goes with the punctuation after it; elsewhere an all-empty segment goes, and the line keeps its '。'.
    expect(renderSkillTemplate('角色：{{name}}，{{prompt}}', { name: '', prompt: '林' })).toBe('角色：林')
    expect(renderSkillTemplate('角色：{{prompt}}，{{name}}', { name: '', prompt: '林' })).toBe('角色：林')
    expect(renderSkillTemplate('场景：{{a}}；时间：{{b}}。', { a: '客栈', b: ' ' })).toBe('场景：客栈。')
    expect(renderSkillTemplate('场景：{{a}}；时间：{{b}}。\n固定一行', { a: '', b: '' })).toBe('固定一行')
    expect(renderSkillTemplate('第一行\n\n{{a}}', { a: '值' })).toBe('第一行\n\n值')
  })

  it('merges the avoid terms of the active skills into one line, without repeats', () => {
    const terms = [skill('vd.storyboard-frame'), skill('vd.identity-lock'), { negative: '水印；多余人物。' }]
    expect(avoidLine(terms, 'zh')).toBe('避免：分格拼贴、设定卡排版、文字标签、水印、多余人物、换脸、身份漂移、照搬设定卡排版')
    expect(avoidLine([{ negative: 'blur, watermark' }], 'en')).toBe('Avoid: blur, watermark')
    expect(avoidLine([skill('vd.sound-bed')], 'zh')).toBe('')
  })

  it('applies a skill only in the modes it names, and a video skill only in its video modes', () => {
    const bridge = skill('vd.first-last-bridge')
    expect(skillTakesMode(bridge, 'video')).toBe(true)
    expect(skillApplies(bridge, 'video')).toBe(false)
    expect(skillApplies(bridge, 'video', 'first-last-frame')).toBe(true)
    expect(skillApplies(bridge, 'video', 'frames')).toBe(true)
    expect(skillApplies(bridge, 'image', 'first-last-frame')).toBe(false)
    expect(skillApplies(skill('vd.style-lock'), 'video', 'reference')).toBe(true)
    expect(skillTakesMode(skill('vd.script-to-shots'), 'image')).toBe(false)
    expect(normalizeVideoMode('frames')).toBe('first-last-frame')
    expect(normalizeVideoMode('bogus')).toBeUndefined()
    expect(missingSkillVars(snapshotOfSkill(skill('vd.dialogue-shot')), { speaker: '林', lines: ' ' })).toEqual(['lines'])
  })
})

describe('which skills a node composes (C2)', () => {
  it('takes one wrap skill — the node\'s own before a wired skill node\'s — and two append skills, and says why the others do not compose', () => {
    const own = [newNodePromptSkill(skill('vd.storyboard-frame')), newNodePromptSkill(skill('vd.style-lock'), { style: '水墨' }), { ...newNodePromptSkill(skill('vd.lighting-mood')), appliedBy: 'writer' }]
    const board = [
      node('still', 'image', { promptSkills: own }),
      node('s1', 'skill', skillNodeMetadata(skill('vd.cover-poster'), '1', { title: '雨' })),
      node('s2', 'skill', skillNodeMetadata(skill('vd.identity-lock'), '1')),
      node('s3', 'skill', skillNodeMetadata(skill('vd.style-lock'), '1', { style: '油画' })),
      node('s4', 'skill', skillNodeMetadata(skill('vd.sound-bed'), '1', { ambience: '雨声' })),
    ]
    const uses = promptSkillUses(board[0], board, ['s1', 's2', 's3', 's4'].map(id => link(id, 'still')), 'image')
    expect(uses.map(use => [use.id, use.source, use.state])).toEqual([
      ['vd.storyboard-frame', 'node', 'active'],
      ['vd.style-lock', 'node', 'active'],
      // The writer's skill still holds its place.
      ['vd.lighting-mood', 'node', 'writer'],
      ['vd.cover-poster', 'upstream', 'wrap-ignored'],
      ['vd.identity-lock', 'upstream', 'append-limit'],
      ['vd.style-lock', 'upstream', 'duplicate'],
      ['vd.sound-bed', 'upstream', 'mode'],
    ])
    // Required values left empty are listed on an active skill.
    const empty = promptSkillUses(node('still', 'image', { promptSkills: [newNodePromptSkill(skill('vd.style-lock'))] }), [], [], 'image')
    expect(empty[0]).toMatchObject({ state: 'active', missing: ['style'] })
    // A video skill outside its video modes; a skill node wired into a text node; a text node with content in text mode.
    const bridge = node('gen', 'config', { generationMode: 'video', videoMode: 'reference', promptSkills: [newNodePromptSkill(skill('vd.first-last-bridge'))] })
    expect(promptSkillUses(bridge, [bridge], [], 'video')[0]!.state).toBe('video-mode')
    const text = node('note', 'text', { content: '镜 1', promptSkills: [newNodePromptSkill(skill('vd.script-to-shots'))] })
    expect(promptSkillUses(text, [text], [], 'text')).toEqual([])
    expect(promptSkillUses(node('note', 'text'), [node('s', 'skill', skillNodeMetadata(skill('vd.script-to-shots'), '1'))], [link('s', 'note')], 'text')).toEqual([])
  })
})
