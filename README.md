# FFBB Tactics

A turn-based 3D fan remake of Blitzball, the underwater sport from Final Fantasy X. Two teams of six swim inside a floating sphere of water and try to put the ball through the opponent's goal ring. Instead of steering one swimmer in real time, you coach all six: both sides plan in secret, then a two-second beat plays out and every duel is settled on the stats.

The game runs in the browser with [three.js](https://threejs.org/). There's no build step and it ships no assets: the players, stadium, ball textures and sound are all generated in code.

## Play

Serve the folder with any static file server, then open `index.html`:

```sh
python3 -m http.server 8000
# or: npx http-server -p 8000
```

Then visit http://localhost:8000. Opening the file straight from disk won't work, because browsers block ES modules on `file://` URLs.

Pick the Besaid Aurochs or the Luca Goers, the opposition coach (Rookie, League or Champion) and a match length. Every match is two halves of 12, 18 or 24 beats. The clock shows match minutes, 45 a half.

## How a turn works

Blitzball Tactics uses simultaneous turns (WEGO), like Frozen Synapse.

1. **Plan.** Time is frozen. Every one of your swimmers already has an order, filled in by the auto-planner from your tactics. Change the ones you care about and leave the rest.
2. **Resolve.** Press **Resolve beat**. The opponent's orders are locked in at the same moment, and you only see them once the beat is resolved.
3. **Play out.** Both sides' orders run for 2.0 s of simulated time. Movement is deterministic, and duels are rolled on the stats. A director camera follows the play, cuts to a reverse angle and slows down on shots, and circles the scorer after a goal. You can replay the beat or change the speed (½×, 1×, 2×).
4. The next planning phase starts.

Each half starts with the ball launching from the floor of the sphere, and so does play after every goal.

### Orders

Each player gets one order per beat.

| Order | What it does |
| --- | --- |
| **Move** | Swim to a 3D point inside the player's reach sphere. Reach is set by SP (and HP when tired). |
| **Sprint** | Adds 35% reach to any movement order. It costs HP. |
| **Mark** | Follow a named opponent and stay goal-side of them. |
| **Hold** | Stay put and brace. The zone of control grows by 60% and blocks cut harder. Holding also restores HP. |
| **Press** | Go at the carrier and tackle on contact (AT vs EN). |
| **Dribble** | Carrier only. Swim to a point with the ball. |
| **Pass** | Carrier only. Pass to a teammate. The pass curls after them and they swim to meet it. |
| **Through** | Carrier only. Pass into a point in space. The ball stops there and whoever arrives first takes it. |
| **Shoot** | Carrier only. Shoot at a chosen spot on the goal ring. |
| **Jecht** | Carrier only, when the meter is full. The shot hits 1.5× harder and knocks the first two blockers aside. |

Passes and shots can go **At start** (released straight away, so a tackle can't stop them) or **After dribble** (the carrier dribbles a short leg first, capped at 70% of the beat, then releases). A carrier who releases at the start then runs to the order's destination, which makes one-twos and give-and-goes possible.

### Duels

Every swimmer has a **zone of control**, a radius based on BL. It is larger when bracing and smaller when tired.

- **Block duels.** A pass or shot that passes through an opponent's zone loses BL × 4 (passes) or BL × 4.5 (shots) × a random factor of 0.6–1.3. A braced defender cuts 1.4× harder. If the power drops to zero, the defender takes the ball. Defenders just outside the line of a ball in flight lunge across it.
- **Keeper duel.** The keeper dives for the shot. A shot scores if its remaining power beats the keeper's grip, CA × 8 × 0.6–1.5. Grip drops the further the keeper has to stretch, and a keeper who can't reach the shot in time only gets a fingertip to it. Aiming at a corner makes the keeper stretch but adds a risk of missing the ring. The aim wobble shrinks with SH and grows with distance.
- **Tackle duels.** When a pressing player reaches the carrier, or the carrier swims into a braced player's zone, the tackle succeeds with a chance of 32% + 5% per point of AT over EN, plus up to 30% more as the carrier tires. The loser is stunned for a moment.

Every duel is logged with its numbers, FFX-style, for example "Letty BL 9 blocks: shot power 84 → 49". It shows as a floating callout during playback and in the match log.

### Stamina

HP drains with sprinting and carrying the ball, and when a tackle hits the carrier. It recovers slowly while swimming normally and quickly while holding. Below 40% HP a player's reach and duel stats fall off. Half time restores 30% of everyone's HP. Watch the HP bars on the squad list and the player card, and use your two substitutes.

## Controls

| Mouse / keyboard | Touch | Action |
| --- | --- | --- |
| Click a swimmer, `Tab` / `Shift+Tab`, `1`–`6`, or the squad list | Tap | Select a swimmer. Opponents can be selected to inspect them. |
| Drag from the selected swimmer | Drag from them | Set their destination on the horizontal disc at their height |
| Hold `Shift` while dragging, or toggle `V` Height | Height button | Raise or lower the point |
| Drag empty water, right-drag | One-finger drag | Orbit the camera |
| Mouse wheel | Pinch | Zoom |
| `F` / Focus, `C` / View | Buttons | Orbit the selected swimmer / broadcast view |
| `M` `S` `K` `H` `P` | Order bar | Move, Sprint, Mark, Hold, Press |
| `D` `A` `T` `G` `J` | Order bar | Dribble, Pass, Through ball, Shoot, Jecht Shot |
| `L` | At start / After dribble | Release timing for passes and shots |
| `U` / `Shift+U` | Auto / All auto | Reset a player / the team to the auto-plan |
| `Space` / `Enter` | Resolve beat | Resolve the beat. During playback, skip it. |
| `R`, `X` | Replay, 1× | Replay the last beat, cycle playback speed |
| `O` | Tactics | Open the Tactics screen |
| `Esc` | Menu | Cancel a pick, or pause |
| `N` | Sound | Mute |

To pass, press Pass and click a teammate, or click a point in space for a through ball. To mark, press Mark and click an opponent. To shoot, the inset **goal view** shows the ring as your shooter sees it, with a heat map of your chances, the keeper, and your aim wobble. Click it to aim.

### Reading the sphere

- **Drop-lines** run from every swimmer to the equatorial plane, with a disc where each one lands. This shows height at a glance.
- The two halves of the sphere are tinted by the team that defends them, and the **halfway ring** marks the middle.
- The selected swimmer shows their **reach sphere** and the movement disc. A **ghost** marks where each of your swimmers will end up.
- For a planned pass or shot, every opponent whose zone could reach the line this beat is ringed in red, with their chance of getting a touch. The risk panel shows the estimated success %, the expected power at the keeper against the keeper's grip range, and your chance of keeping the ball on a dribble.
- Hover over an opponent to see their reach sphere and zone of control.

## Tactics

The Tactics screen opens before kickoff and at half time for free. During play (`O` or the Tactics button) it costs one of **3 changes per half**, and the counter is shown on the button.

- **Formation.** Choose a preset (Balanced 1-2-1-2, Wall, Diamond, Overload), or drag players' base positions on the top-view and side-view schematics.
- **Pressing.** How many players go at the carrier, and from how far: Low, Medium, High, or Swarm.
- **Defensive line.** How deep the block sits when defending.
- **Width.** How far players spread around the goal axis.
- **Tempo.** A preference for passing over dribbling.
- **Shooting.** Good odds only, Balanced, or Speculative.
- **Roles.** Support, Target (stays high and holds the ball up, +2 EN on the ball), Runner (runs beyond the last defender), Anchor (braces in the lane in front of goal), or Sweeper (covers deep). The keeper is fixed.
- **Marking.** Who each player picks up when you defend, or Zonal.
- **Substitutes.** Two per match, from a two-player bench.

The auto-planner and the opposing coach both play to these instructions. The opponent uses the same planner with its own tactics:

- **Rookie** misjudges zones of control and barely presses.
- **League** is balanced.
- **Champion** plays a Diamond with runners, presses only when it can get there and win the tackle, and reads every zone before it passes or shoots.

## Balance

`window.ffbb.simulate(n, { difficulty: ['normal', 'normal'] })` plays whole matches headlessly with the planner on both sides. It returns the goals, shots, saves, blocks, tackles and passes per match, and a split by side to check for bias. Every other match swaps which end each club plays.

## Code map

| File | What's in it |
| --- | --- |
| `src/config.js` | Rosters (with benches), stats, formations, roles, team instructions and all balance numbers |
| `src/match.js` | The rules engine: orders, beat resolution into frames and events, duels, stamina, score and clock |
| `src/ai.js` | The planner (auto-plan and opponent) and the risk estimates shown while planning |
| `src/input.js` | Planning UI: selection, 3D point picking, the order bar, overlays, the goal view |
| `src/overlay.js` | Guides and planning overlays in the scene (drop-lines, reach spheres, ghosts, paths) |
| `src/view.js` | Swimmer and ball models, synced to the match or played back from a beat's frames |
| `src/camera.js` | Orbit camera for planning and the playback director |
| `src/hud.js` | Scoreboard, squad list, player card, match log, risk panel, radar, callouts |
| `src/tactics.js` | The Tactics screen |
| `src/selfplay.js` | Headless AI-vs-AI matches for balance checks |
| `src/player.js` | Swimmer model and swim animation |
| `src/ball.js` | Ball visuals, trail and glow |
| `src/arena.js` | Water sphere shader, goals, stadium, crowd, bubbles and light shafts |
| `src/audio.js` | Synthesised whistle, crowd, bubbles and impacts |
| `src/main.js` | Boot, phases (plan, playback, tactics, interval), menus and the frame loop |

three.js loads from jsdelivr through `src/lib.js`. To vendor it, change that one import.

In the browser console, `window.ffbb` exposes the live match and a few helpers (`move`, `pass`, `through`, `shoot`, `resolve`, `simulate`).

## Credits

This is a non-commercial fan project. Final Fantasy X, Blitzball and the team and character names belong to Square Enix. This project isn't affiliated with or endorsed by Square Enix. The bench players Lukka, Vorell and Mezzo are invented for this project.
