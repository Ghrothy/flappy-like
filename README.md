# Pip's Peril

A small original arcade game in the "tap to flap, pass the gates" genre.
Plain HTML + CSS + JavaScript, no external dependencies, no downloaded art or
audio — every shape is drawn with canvas primitives.

## Run it

Option A — open the file directly:

    index.html

Option B — serve the folder (any static server works):

    npx serve .
    # or:  python -m http.server 8000

Then visit the printed URL.

## Controls

| Action | Desktop | Mobile |
| --- | --- | --- |
| Flap / start / restart | `Space`, `W`, `↑`, or click | Tap / click |
| Start | "Start flying" button | "Start flying" button |
| Restart | "Restart" button | "Restart" button |

Physics: gravity pulls continuously; each flap gives an upward impulse. Score
increments when you pass a gate. The run ends on the ceiling, the ground or a
gate. Best score is kept in `localStorage`.

## Structure

    index.html      page shell, canvas, HUD, start/game-over overlays
    css/style.css   layout, overlay cards, buttons, responsive sizing
    js/config.js    all tunables (gravity, flap, gap, speed, colors)
    js/entities.js  Player, Obstacle, Ground, Particles
    js/game.js      state machine, loop, input, collisions, effects, rendering
    js/main.js      bootstrap + fixed-timestep requestAnimationFrame loop

## Tests

    node tests/game.test.js        # 16 headless logic tests (no browser)
    node tests/playability.js 200  # 200 seeded autopilot runs: no unreachable gates
    node tests/server.js           # static server on :8123 (leave running)
    node tests/browser.test.js     # 16 headless-browser tests via CDP
    node tests/screenshot.js       # writes PNGs to screenshots/

`browser.test.js` launches Edge/Chrome headless with a temporary profile and
drives the page over the DevTools protocol using only Node built-ins — there is
no dependency to install. `package.json` exposes these as `npm test`,
`npm run test:browser` and `npm start`.

## Tuning

Change numbers in `js/config.js`; everything else reads from there. The logical
world is 640 units tall and 300–620 wide depending on screen aspect, so the
game plays the same on a phone and a desktop.

## Notes

The game is fixed-timestep (60 Hz) with a clamped frame delta, so physics stay
stable if the tab throttles. `window.__game` is exposed for debugging and for
the automated checks in `tests/`.
