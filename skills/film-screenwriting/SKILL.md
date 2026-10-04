---
name: film-screenwriting
description: Writes, revises, structures and diagnoses short-film and episode screenplays in the 剧本 tab of the 影视 sidebar through the story_* tools — one saved document per film or episode, with stable scenes, people, places, props, dialogue links and text shots. Use for 编剧、写剧本、改稿、分场、对白、剧本诊断、短剧/单集, or for getting a script ready for the storyboard and the cut.
metadata:
  zh_name: 编剧
  en_name: Film screenwriting
---

# Film screenwriting

A screenplay here is a saved document, not chat text. One short film or one episode is one document under `film/story/`, changed only through the story_* tools, which keep revisions, versions and the open 剧本 tab in step. Never write or delete anything under `film/` with file or shell tools.

## Find the document

- No story_* tools in this conversation: call `film_project` with `action: "status"` (opening a tab of the 影视 sidebar also creates the film); use `action: "create"` only when the person wants a film made here. The film tools arrive on your next step.
- `story_query` without `documentId` lists the documents. None, and the person asked for a draft: `story_create {title, kind: "short" | "episode"}`, then use the returned `documentId` and `revision`. Never invent either.
- Existing script: `story_query` (kind `index`, the default) for stable ids, then `kind: "content"` with the `ids` you need. `coverage` says what you actually read; a verdict on the whole script needs every page in order from offset 0 until `coverage.truncated` is false (or one read returns `coverage.complete`).

Target order: what the person named (“只改第三场的结尾”) > what they quoted > the scene under discussion. Scene numbers and names are labels; resolve them to ids from the index before writing.

## Save a change

Read [references/operations.md](references/operations.md) before the first `story_apply_ops` of a conversation; it has the exact shapes and tested batches. Do not read plugin source code to learn them.

1. Read the target; keep its `revision`.
2. `story_apply_ops {documentId, expectedRevision, operations, operationId, dryRun: true}`. Check that `changedIds` and `preview` cover exactly the intended scope.
3. Send the same call without `dryRun`: same operations, revision and operationId.
4. Report what was saved — the changed ids and the new revision. `changed: false` saved nothing new.

`STORY_CONFLICT`: someone edited first. Read again and rebuild only your change on the new text; never turn a failed local edit into a rewrite. Lost response: resend with the same operationId; an answer with `changed: false` means it was already applied. `STORY_INVALID_OPERATIONS`: fix the batch from its diagnostics; nothing was saved. Say plainly what is still unsaved.

## Write

Use the lens the request needs; none is a required form:
- an idea: someone wants something, something stands in the way, getting it costs;
- an outline: each scene happens *because of* the one before, not *and then*;
- a scene: goal, obstacle, tactic, turn, cost — the end differs from the start in information, power, relationship, danger or a physical state;
- dialogue: people pursuing, dodging, testing, redefining; what they want sits under what they say.

Write what a camera and a microphone can record: present-tense action and sound, specific nouns (纸箱快递箱, not 箱子), active verbs. Feelings become behaviour: not 她很难过, but 她把杯子洗了第二遍. Anonymous people, one scene, no dialogue, a fragment, a non-linear order and unfinished profiles are all valid. Do not impose scene counts, dialogue ratios or a structure template.

Before handing in, reread as the audience, who only sees and hears what is written:
- every scene changes something, and the turn comes from an action or a revelation, not luck;
- every line is something an actor can play; lines that only explain go;
- nothing restates what the action already shows, and no scene ends on a line that sums up its meaning;
- objects and knowledge are tracked: an umbrella left at a bench needs a pickup before it is in a hand;
- what the person fixed (facts, ending, voice) is intact; anything you invented is labelled as your proposal.

Technique and examples: [references/craft.md](references/craft.md). 竖屏短剧, episodes, hooks, runtime and writing for generated video: [references/short-form.md](references/short-form.md).

## Revise

Change only the named scope; keep the author's voice, untouched passages, comments and unfamiliar Markdown. Prose: `replaceBlock` with `expectedMarkdown` copied from the block you read. A name: `renameEntity` (profile heading and linked speaker labels; mentions in prose stay as written). One attribution: `setSpeechSpeaker`. Even a “rewrite” edits block by block and keeps ids. Before a large rewrite, `story_checkpoint` the current revision.

Undo on the person's terms: `story_revert` one operationId (refused if that text was edited since — keep their edit and say so); `story_restore` a whole version only when asked; `story_history` lists and reads versions. A restore never rolls back the board or the cut.

## Diagnose

A diagnosis changes nothing unless the person asks. Follow [references/diagnosis.md](references/diagnosis.md): name the revision and the scope read, quote the text, separate checkable errors from interpretation, propose a change and its likely effect. Keep sources apart — what the screenplay shows, what a character claims, author settings, your inferences, your proposals. A character saying it does not make it true.

## Hand off

When images or video are planned, give the people, places and props their visual identity and states in the same document and write text shots; [references/handoff.md](references/handoff.md) has the fields, reference images, and how a script reaches the 分镜 canvas and the 剪辑 cut. Handoff never starts a generation, replaces a production node or moves an existing clip.
