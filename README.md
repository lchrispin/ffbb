# FFBB: Blitzball

A real-time 3D fan remake of Blitzball, the underwater sport from Final Fantasy X. Two teams of six swim inside a floating sphere of water and try to put the ball through the opponent's goal ring.

The game runs in the browser with [three.js](https://threejs.org/). There's no build step and it ships no assets: the players, stadium, ball textures and sound are all generated in code.

## Play

Serve the folder with any static file server, then open `index.html`:

```sh
python3 -m http.server 8000
# or: npx http-server -p 8000
```

Then visit http://localhost:8000. Opening the file straight from disk won't work, because browsers block ES modules on `file://` URLs.

It also works on GitHub Pages. Point Pages at the repository root.

## How it plays

Pick the Besaid Aurochs or the Luca Goers, a difficulty (Rookie, League or Champion) and a match length. Every match is two halves, and the ball launches from the floor of the sphere at each kickoff.

Like the original, the skill is in the decisions, not the dexterity. Play runs in real time, but at an easy, readable pace: passes and shots travel slowly enough to watch every blocker have a go at them. The camera directs itself like a broadcast.

**Encounters.** Every defender has an encounter radius that grows with their AT. When you have the ball, the radii of nearby opponents show as faint rings. When a new defender's radius touches your carrier, time slows to a crawl and the **command wheel** opens:

| Wheel | What it shows |
| --- | --- |
| **Pass** | Every teammate, with the odds the pass gets through the blockers in its lane. The lanes are drawn in the sphere, green to red. |
| **Shoot** | Your odds against the keeper: estimated power after distance and the lane, against the keeper's grip range. |
| **Break** | The duel as numbers, e.g. *EN 7 vs AT 10 + 8*. Each defender in range rolls a tackle; beat them all and you surge clear. |
| **Tech** | The Jecht Shot when the meter is full. |

If you don't choose within about three seconds, you try to break through. A defender who has just had an encounter with you can't start another for a few seconds, and there's a short cooldown between encounters, so the game doesn't turn into permanent slow motion. You can also open the wheel yourself at any time with the command button.

**On defence**, the wheel opens when your swimmer reaches the carrier: **Tackle** (AT against EN), **Venom Tackle** (a tech that costs a little HP and poisons the carrier, who then loses HP for several seconds), **Hold** (widens your block reach for a few seconds, so passes and shots through you lose more power) or **Switch** swimmer.

**Numbers on screen.** Duels float over the players ("AT 9 vs EN 7"). A pass or shot carries its power with it, and you can watch it count down as each blocker takes a cut (84 → 61 → 40), then see the keeper's grip roll against what's left.

**The camera** frames the ball and the goal it threatens, from whichever side of that line hides the fewest players. It turns slowly and never swings across the line; for big changes it cuts. In an encounter it goes over your shoulder, and it follows shots in slow motion. Hold the overview button to pull right out of the sphere, with time slowed. Movement is relative to the camera. After a cut, keep holding a direction and it keeps its old meaning until you let go.

When the AI shoots at your goal or tackles your carrier, the game briefly slows so you can see what happened.

**Half time** opens a small tactics screen: choose a formation (Balanced, Attack or Wall) and which opponent each of your defenders marks. The AI side changes its own shape depending on the score.

| Stat | What it does |
| --- | --- |
| **HP** | Stamina. Carrying the ball and sprinting drain it. When it runs low you swim slower and lose tackles more easily. |
| **SP** | Swim speed. |
| **EN** | Endurance. Resists tackles. |
| **AT** | Attack. Wins tackles, knocks HP off the carrier and widens your encounter radius. |
| **PA** | Pass strength. A pass loses power over distance and to every defender it passes near. If its power drops to zero, it's intercepted. |
| **BL** | Block. How much power a defender takes off a pass or shot it gets near. |
| **SH** | Shot strength. Shots also lose power over distance. |
| **CA** | Catch. The keeper's grip. A shot scores only if its remaining power beats the grip roll. |

Completed passes, tackles, blocks and saves charge the **Jecht Shot** meter. When it's full, the special shot hits 1.5× harder and knocks the first two defenders in its path out of the way.

## Controls

| Keyboard / mouse | Touch | Action |
| --- | --- | --- |
| `W` `A` `S` `D` | Left stick | Swim, relative to the camera |
| `Space` / `C` | Rise / Dive | Up and down |
| `J` / left click | Command | Open the command wheel (slow motion) |
| `1`–`4`, arrow keys + `Enter` (or `J`), mouse | Tap an option | Choose on the wheel. `Backspace` goes back from the pass list |
| `K` | Shoot | Quick shot without the wheel. On defence, switch swimmer |
| `E` | Jecht | Jecht Shot when the meter is full |
| `Tab` (hold) | View (hold) | Overview from outside the sphere, time slowed |
| Right-drag, arrow keys | Drag the screen | Nudge the camera. It springs back when you let go |
| `Shift` | Sprint | Sprint (drains HP) |
| `Q` / middle click | Switch | Take control of the teammate nearest the ball |
| `Esc` / `P` | Pause | Pause (`Esc` steps back on the wheel) |
| `M` | | Mute |

## Code map

| File | What's in it |
| --- | --- |
| `src/config.js` | Rosters, stats, formation presets, pace, encounter tuning and all balance numbers |
| `src/match.js` | Rules: possession, passes, shots, tackles, blocks, keeper duels, encounters and wheel commands, slow motion, per-team tactics, clock, score |
| `src/ai.js` | Team AI for carriers, support runs, marking, pressing, lane blocking and the keeper |
| `src/director.js` | The self-directing camera: broadcast framing, cuts, encounter, shot and overview shots |
| `src/wheel.js` | The command wheel |
| `src/floaters.js` | Floating duel numbers and power tags |
| `src/lanes.js` | Passing lanes drawn during an encounter |
| `src/player.js` | Swimmer model, swim animation, movement and stamina |
| `src/ball.js` | Ball flight, trail and glow |
| `src/arena.js` | Water sphere shader, goals, stadium, crowd, bubbles and light shafts |
| `src/input.js` | Keyboard, mouse and touch controls |
| `src/hud.js` | Scoreboard, radar, player card, event feed, hints |
| `src/audio.js` | Synthesised whistle, crowd, bubbles and impacts |
| `src/main.js` | Boot, menus, half-time tactics, event presentation and the frame loop |

three.js loads from jsdelivr through `src/lib.js`. To vendor it, change that one import.

In the browser console, `window.ffbb.match` gives you the live match. `match.timeScale` is the current game speed, and `match.update(dt)` takes real seconds and scales them itself.

## Credits

This is a non-commercial fan project. Final Fantasy X, Blitzball and the team and character names belong to Square Enix. This project isn't affiliated with or endorsed by Square Enix.
