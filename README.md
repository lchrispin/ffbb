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

The rules follow the original game's stat duels, played in real time:

| Stat | What it does |
| --- | --- |
| **HP** | Stamina. Carrying the ball and sprinting drain it. When it runs low you swim slower and lose tackles more easily. |
| **SP** | Swim speed. |
| **EN** | Endurance. Resists tackles. |
| **AT** | Attack. Wins tackles and knocks HP off the carrier. |
| **PA** | Pass strength. A pass loses power to every defender it passes near. If its power drops to zero, it's intercepted. |
| **BL** | Block. How much power a defender takes off a pass or shot it gets near. |
| **SH** | Shot strength. Shots also lose power over distance. |
| **CA** | Catch. The keeper's grip. A shot scores only if its remaining power beats the grip roll. |

While you carry the ball, the HUD shows your odds of beating the keeper from where you are, counting the defenders standing in the lane.

Completed passes, tackles, blocks and saves charge the **Jecht Shot** meter. When it's full, the special shot hits 1.5× harder and knocks the first two defenders in its path out of the way.

## Controls

| Keyboard / mouse | Touch | Action |
| --- | --- | --- |
| `W` `A` `S` `D` | Left stick | Swim where the camera looks |
| `Space` / `C` | Rise / Dive | Up and down |
| Mouse (click to capture), arrow keys | Drag the view | Look around |
| `J` / left click | Pass · Tackle | Pass to the ringed teammate, or tackle the carrier |
| `K` / right click | Shoot | Shoot. On defence, switch swimmer |
| `E` | Jecht | Jecht Shot when the meter is full |
| `Shift` | Sprint | Sprint (drains HP) |
| `Q` | Switch | Take control of the teammate nearest the ball |
| `F` | Face | Turn toward the goal (with the ball) or toward the ball |
| `Esc` / `P` | Pause | Pause |
| `M` | | Mute |

## Code map

| File | What's in it |
| --- | --- |
| `src/config.js` | Rosters, stats, formations and all balance numbers |
| `src/match.js` | Rules: possession, passes, shots, tackles, blocks, keeper duels, clock, score |
| `src/ai.js` | Team AI for carriers, support runs, marking, pressing, lane blocking and the keeper |
| `src/player.js` | Swimmer model, swim animation, movement and stamina |
| `src/ball.js` | Ball flight, trail and glow |
| `src/arena.js` | Water sphere shader, goals, stadium, crowd, bubbles and light shafts |
| `src/input.js` | Keyboard, mouse (pointer lock) and touch controls |
| `src/hud.js` | Scoreboard, radar, player card, event feed |
| `src/audio.js` | Synthesised whistle, crowd, bubbles and impacts |
| `src/main.js` | Boot, camera rig, menus and the frame loop |

three.js loads from jsdelivr through `src/lib.js`. To vendor it, change that one import.

In the browser console, `window.ffbb.match` gives you the live match.

## Credits

This is a non-commercial fan project. Final Fantasy X, Blitzball and the team and character names belong to Square Enix. This project isn't affiliated with or endorsed by Square Enix.
