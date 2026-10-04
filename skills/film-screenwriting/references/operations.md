# story_* operations

## Contents
- Rules
- Operation shapes
- Batch A — a scene without dialogue
- Batch B — a place, a person, a spoken line
- Batch C — lines added to an existing scene
- Batch D — revise prose, rename a person
- Errors

## Rules
- `story_apply_ops {documentId, expectedRevision, operations, operationId?, dryRun?, label?}` takes up to 500 operations and applies them atomically. The final document is validated as a whole, so a scene, its blocks and its speech links go in one batch.
- Ids start with a letter or digit and use letters, digits and `_ . : -`. Every id — block or record — is unique in the document. Use readable opaque ids (`scene_rain_01`, `blk_rain_01_line2`) and keep them when retrying.
- Block kinds: `scene-heading`, `action`, `speech`, `entity-profile`, `shot-plan`; planning prose `outline`, `beat`, `brief`, `structure`. Keep kinds you do not recognise.
- Markdown: heading `## 内景 · 修表铺 · 夜`; profile `### 名字` then optional notes; speech `**名字**` alone on the first line, a blank line, then the words — one speaker's turn per block, acting notes in action blocks.
- A scene's `blockIds` begin with its `headingBlockId`, follow document order, and no block belongs to two scenes. Upserts merge fields but replace arrays: always send the whole `blockIds`.
- To grow an existing scene, `appendBlock` with `afterBlockId`, then `upsertScene` with the full `blockIds` (Batch C). `upsertScene.blocks` is for new scenes; on an existing scene it would put new blocks at the end of the document.
- Only a `speech` record `{id, blockId, speakerId}` links a line to a person; the bold label is display text. `speakerId` must be a person, `placeId` a place.
- `expectedMarkdown` is the block's `markdown` exactly as `story_query` (kind `content`) returned it, leading newline included. Never retype it.

## Operation shapes
| Kind | Fields |
|---|---|
| appendBlock | `block:{id,kind,markdown}`, `afterBlockId?` (default: document end) |
| replaceBlock | `blockId`, `markdown`, `expectedMarkdown?` |
| upsertEntity | `entity:{id, kind:"person"/"place"/"prop", profileBlockId, visualIdentity?, visualState?}`, `profileMarkdown?` (creates the profile block) |
| upsertScene | `scene:{id, headingBlockId, blockIds, placeId?}`, `blocks?`, `beforeSceneId?` |
| upsertShot | `shot:{id, descriptionBlockId, sourceBlockIds, entityIds, sceneId?}`, `descriptionMarkdown?` |
| upsertRecord | `collection:"speech"`, `record:{id,blockId,speakerId}`; or `collection:"appearances"`, `record:{id,entityId,sceneId,visualState}` |
| removeRecord | `collection`, `id` |
| renameEntity | `entityId`, `name` |
| setSpeechSpeaker | `speechId` (the record id), `speakerId` |
| reorderScenes / reorderShots | `sceneIds` / `shotIds` — the complete new order |
| updateDocument | `changes:{title?, kind?, targetSeconds?, visualStyle?}` |
| setObjectArchived | `target:{kind:"entity"/"scene"/"shot", id}`, `archived` |
| deleteObject / restoreObject | `target` — dry-run first; refused while something references it; prose stays |

Other collections (`beats`, `relationships`, `claims`) have no fixed shape: leave them unless the person asks. Reference images go through `story_asset_bindings`, never through records.

## Batch A — a scene without dialogue
New document. No person, place or speech record is needed.
<!-- batch:A -->
```json
[
  {
    "kind": "upsertScene",
    "scene": { "id": "scene_shop_night", "headingBlockId": "blk_shop_heading", "blockIds": ["blk_shop_heading", "blk_shop_action"] },
    "blocks": [
      { "id": "blk_shop_heading", "kind": "scene-heading", "markdown": "## 内景 · 修表铺 · 夜\n" },
      { "id": "blk_shop_action", "kind": "action", "markdown": "一个人收起门口的伞，把灯留亮。\n" }
    ]
  }
]
```

## Batch B — a place, a person, a spoken line
New document. The person may stay unnamed; the profile heading is only a label.
<!-- batch:B -->
```json
[
  { "kind": "upsertEntity", "entity": { "id": "place_shop", "kind": "place", "profileBlockId": "blk_shop_profile" }, "profileMarkdown": "### 修表铺\n" },
  { "kind": "upsertEntity", "entity": { "id": "person_guest", "kind": "person", "profileBlockId": "blk_guest_profile" }, "profileMarkdown": "### 来客\n" },
  {
    "kind": "upsertScene",
    "scene": { "id": "scene_shop_night", "headingBlockId": "blk_shop_heading", "blockIds": ["blk_shop_heading", "blk_shop_action", "blk_guest_line"], "placeId": "place_shop" },
    "blocks": [
      { "id": "blk_shop_heading", "kind": "scene-heading", "markdown": "## 内景 · 修表铺 · 夜\n" },
      { "id": "blk_shop_action", "kind": "action", "markdown": "来客把伞靠在门边，没有关门。\n" },
      { "id": "blk_guest_line", "kind": "speech", "markdown": "**来客**\n\n灯先留着。\n" }
    ]
  },
  { "kind": "upsertRecord", "collection": "speech", "record": { "id": "speech_guest_line", "blockId": "blk_guest_line", "speakerId": "person_guest" } }
]
```

## Batch C — lines added to an existing scene
After B. New blocks go after the scene's last block; the scene gets its full `blockIds`.
<!-- batch:C -->
```json
[
  { "kind": "upsertEntity", "entity": { "id": "person_owner", "kind": "person", "profileBlockId": "blk_owner_profile" }, "profileMarkdown": "### 店主\n" },
  { "kind": "appendBlock", "block": { "id": "blk_owner_action", "kind": "action", "markdown": "店主没抬头，把一只表翻过来。\n" }, "afterBlockId": "blk_guest_line" },
  { "kind": "appendBlock", "block": { "id": "blk_owner_line", "kind": "speech", "markdown": "**店主**\n\n修不好的，我也收。\n" }, "afterBlockId": "blk_owner_action" },
  { "kind": "upsertScene", "scene": { "id": "scene_shop_night", "headingBlockId": "blk_shop_heading", "blockIds": ["blk_shop_heading", "blk_shop_action", "blk_guest_line", "blk_owner_action", "blk_owner_line"] } },
  { "kind": "upsertRecord", "collection": "speech", "record": { "id": "speech_owner_line", "blockId": "blk_owner_line", "speakerId": "person_owner" } }
]
```

## Batch D — revise prose, rename a person
After C. `expectedMarkdown` is copied from the read, so it starts with a newline. The rename changes the profile heading and the linked speaker label only.
<!-- batch:D -->
```json
[
  { "kind": "replaceBlock", "blockId": "blk_shop_action", "expectedMarkdown": "\n来客把伞靠在门边，没有关门。\n", "markdown": "来客把伞靠在门边，门留了一道缝。\n" },
  { "kind": "renameEntity", "entityId": "person_guest", "name": "小舟" }
]
```

Production fields and text shots: Batch E in handoff.md.

## Errors
A refused batch saves nothing; a dry run never saves.

| Code | Meaning | Do |
|---|---|---|
| STORY_CONFLICT | the saved revision moved (the message gives the current one) | read again; rebuild only your change |
| STORY_INVALID_OPERATIONS | batch refused; diagnostics name the ids, e.g. 正文块…已改变 (stale `expectedMarkdown`) | fix the batch; re-read a changed block |
| STORY_NOT_EDITABLE | the document has structure errors or no native structure | report; repair only if asked |
| STORY_OPERATION_REUSED | the operationId belongs to a different request | new request, new operationId |
| STORY_BASELINE_REQUIRED | missing or malformed expectedRevision | read first |
| STORY_TOO_LARGE | over 8 MiB | split into episode documents |
| STORY_NOT_FOUND / STORY_VERSION_NOT_FOUND / STORY_OPERATION_NOT_FOUND | unknown id | list again |
| STORY_REVERT_CONFLICT | later edits overlap the operation | keep the current text; tell the person |
| STORY_OPERATION_NOT_COMMITTED | that operation never saved | nothing to revert |
