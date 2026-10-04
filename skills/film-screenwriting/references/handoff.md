# Handoff to production

## Contents
- Production-ready fields
- Text shots
- Batch E — production fields and a text shot
- Reference images
- To the 分镜 canvas
- To the 剪辑 cut
- Impact, import and export

## Production-ready fields
Only when images or video are planned; an ordinary draft may leave profiles incomplete. Reuse existing entity ids.
- `document.visualStyle` via `updateDocument`: era, realism or stylisation, palette, light.
- Entity `visualIdentity`: what never changes — face, hair, build, marks; for a place its layout, entrances, materials, landmarks; for a prop its shape, scale, details.
- Entity `visualState`: baseline wardrobe or set dressing.
- `appearances` records `{id, entityId, sceneId, visualState}`: only what differs in that scene (湿透的雨衣、包扎的左手、只亮一盏台灯).

Say which details come from the screenplay and which you propose. Never present an invented age or face as the author's.

## Text shots
`upsertShot {shot: {id, descriptionBlockId, sourceBlockIds, entityIds, sceneId}, descriptionMarkdown}` writes a shot as text, tied to the blocks it covers and the people, places and props in frame. One shot is one visible moment: who does what, where, framed how (景别、机位高度、前景是谁), what motivates the light, and the line spoken, if any. `reorderShots` takes the complete order.

## Batch E — production fields and a text shot
Continues Batches A–D in operations.md. Omitting `profileMarkdown` keeps the existing profile block.
<!-- batch:E -->
```json
[
  { "kind": "updateDocument", "changes": { "visualStyle": "当代写实，冷色夜景，台灯暖光是唯一主光" } },
  { "kind": "upsertEntity", "entity": { "id": "person_guest", "kind": "person", "profileBlockId": "blk_guest_profile", "visualIdentity": "三十岁上下，瘦，短发，左手背一道旧疤", "visualState": "深色雨衣，旧帆布鞋" } },
  { "kind": "upsertEntity", "entity": { "id": "place_shop", "kind": "place", "profileBlockId": "blk_shop_profile", "visualIdentity": "窄长铺面，玻璃柜台在左，门在右，后墙挂满钟", "visualState": "夜里只开柜台上一盏台灯" } },
  { "kind": "upsertRecord", "collection": "appearances", "record": { "id": "appear_guest_shop", "entityId": "person_guest", "sceneId": "scene_shop_night", "visualState": "雨衣湿透，裤脚溅泥" } },
  { "kind": "upsertShot", "shot": { "id": "shot_shop_01", "descriptionBlockId": "blk_shot_shop_01", "sourceBlockIds": ["blk_shop_action"], "entityIds": ["person_guest", "place_shop"], "sceneId": "scene_shop_night" }, "descriptionMarkdown": "中景，门内机位：来客把伞靠在门边，门留一道缝，雨声进屋。\n" }
]
```

## Reference images
`story_asset_bindings` ties a chosen image version to a card:
- `action: "list"` shows the film's image library and the images the media tools saved under `media/`, with `filePath` and `sha256`.
- `action: "bind"` with `documentId`, `expectedRevision` and `binding: {target: {kind: "entity" | "shot", id}, scope: {kind: "document"} | {kind: "scene", sceneId}, purpose, primary, filePath, expectedSha256}` — the last two exactly as `list` returned them. `replaceBindingId` swaps the card's earlier binding.
- `action: "references"` resolves every bound version: available, relocated, ambiguous, version-mismatch and missing are different outcomes. Never bind or accept a file because its name looks right; changed bytes are a different version.
- `action: "unbind"` removes the link only. Binding never moves or deletes a file and never starts a generation.

## To the 分镜 canvas
- When `story_source` and `story_handoff` are available: read the object with `story_source`, then call `story_handoff` with the document, its current revision, the object id, an optional scene, and optionally `production: {purpose: "image" | "character-sheet" | "scene-sheet" | "prop-sheet" | "shot", requestId}`. It makes a read-only source card (plus a wired empty image node for `production`); the same object returns its existing card unless a duplicate is requested. It generates nothing. When `story_adopt` is available, it copies chosen fields (`prompt` or `references`) into one production node and needs that node's current saved values as `expectedTarget`; call it only when the person asks.
- Until then: production notes go on the board with `canvas_create_text_nodes`. Never paste the managed screenplay into ordinary text nodes as a second copy.
- Character, place and prop sheets: use the film asset-dossier skill when the catalog lists one.
- When `story_director_links` is available, it links a saved source to a saved director-desk shot as provenance only; it never edits the 3D scene.

## To the 剪辑 cut
`timeline_query` for the cut's revision, then `timeline_edit` with `sound: {script: {storyDocumentId}}` and `baseRevision` (dry run, then apply) places each speech block as one caption on the cut's shots, the speaker taken from its speech record. It reads the saved screenplay, so save first. Unlinked or multi-speaker blocks produce wrong speakers.

## Impact, import and export
When these tools are available:
- `story_impact`: read it before proposing downstream updates. Existing outputs and clips are history, not a to-do list; changing them needs the person's request.
- `story_export`: `markdown` keeps structure; `body` drops ids and relations (say so); `package` adds the reference images, and a missing image needs `allowMissing` and a word to the person.
- `story_import`: `preview`, then `apply` with the returned digest. It creates a new document and never overwrites one; plain text gets no invented relations.
