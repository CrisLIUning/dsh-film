# Short form, episodes and writing for generated video

## Contents
- Short film
- Episodes and 竖屏短剧
- Runtime
- Writing for generated video

## Short film
- One pressure on one person, one central turn, and a closing image that answers the opening image.
- Few places and few people: downstream, each place and person becomes a design, a reference sheet and generation cost.
- End on behaviour, not a statement. Not 两人和解了, but 她把伞往他那边偏了一点. An ambiguous ending is allowed; put what you intend in your reply, not in the script.

## Episodes and 竖屏短剧
- One episode is one document (`kind: "episode"`). Split a series into episode documents rather than one long script.
- The first beat is a hook: a decision, a danger, or a wrong that demands an answer — in the first lines, not after set-up.
- Each episode delivers part of its promise (a local result), then leaves a concrete decision, danger or question. Let costs carry over: if every cost is repaid inside the episode, nothing accumulates.
- Vary the ending: a revelation, a reversal, a decision or a quiet change of meaning all work; the same cliffhanger shape every time wears out.
- End each episode with its handoff state — who knows what, who holds what, what changed — and start the next from it.
- 竖屏 favours faces, hands and objects in close or medium framing; action that needs wide geography to read is hard to deliver.
- Genre formulas (打脸、逆袭、爽点节奏) are options the person may ask for, not defaults.

## Runtime
- Estimate by performing the script in your head: lines at speaking pace, actions at their real length, pauses included. For planning only, Mandarin dialogue runs at about 4 characters per second, punctuation excluded; action has no word rate.
- Say “估计” until timing, a rehearsal or a rendered shot measures it.
- Given a target, store it with `updateDocument {changes: {targetSeconds}}`. To fit it, cut repeated beats, explanations and doubled endings before cutting turns.

## Writing for generated video
- A generated shot runs from a few seconds to about 15 s. Write a scene as a chain of visible moments; a speech that needs 40 seconds needs several shots.
- One speaker's turn per speech block, linked to its person: it becomes one spoken line, and a shot prompt can quote it with its speaker. Keep acting notes short, or put them in an action block — a parenthetical inside a speech block ends up in the spoken line.
- Mark off-screen speech (画外：……). In a shot with several people, say who speaks and who stays silent; a listener on screen does not speak someone else's line.
- Name objects precisely and the same way every time (纸箱快递箱, never 箱子 in one scene and 包裹 in the next); reference images are matched to those words.
- Keep looks in the profile fields (see handoff.md), not repeated in every action line.
