// The player-facing build version, shown in the corner of the title screen. Bumped by hand on each
// release: package.json's version is never bundled (no Vite `define`), so this is the only version
// string the game ships. Keep this file dependency-free so anything can import it.
export const GAME_VERSION = 'ver. 1.1'
