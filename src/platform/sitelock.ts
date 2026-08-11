// Production sitelock — the game only boots on the real CrazyGames host.
//
// Why: the shipped bundle is a static HTML5 archive anyone can lift and re-host on their own
// domain to run their own ads. This raises the effort for that — off a legit host, boot halts on
// a blank screen. Like src/game/obfuscate.ts for saves, it's a speed bump, not a wall: any
// client-side lock can be patched out of the bundle, so the goal is only to deter casual
// copy-paste rehosting, not a determined attacker.
//
// The check is a HYBRID of two independent signals (either one grants access):
//   1. hostAllowed() — the iframe's own hostname has `crazygames` as its registrable (2nd-level)
//      domain. Authoritative (the sandbox origin can't be forged without re-hosting under
//      crazygames.com) and survives the SDK being blocked/stripped. It is TIGHTER than CrazyGames'
//      official "crazygames anywhere in the last 3 labels" snippet — which a `crazygames.<attacker>
//      .com` subdomain would satisfy; requiring the 2nd-level label closes that bypass.
//   2. getEnvironment() === the host token — CrazyGames sets `environment` to 'crazygames'
//      server-side for genuine hosts only (we compare against hostToken() so no plaintext
//      'crazygames' literal sits in the unlock path). Used as an ADDITIVE allow so a real host on
//      some non-.com regional TLD (where the 2nd-level label wouldn't be `crazygames`) is never
//      false-locked. It can only ever grant access, never revoke it, so a stripped SDK can't
//      weaken the lock.
//
// The host label is XOR-masked code points, rebuilt at runtime, so the plaintext domain never
// appears in the shipped bundle (a grep of dest/ finds nothing to find-and-replace).

import { getEnvironment } from './crazygames'

// 'crazygames' with each code point XOR the mask. Decoded in hostToken() so the literal is absent
// from source strings and the built bundle alike.
const MASK = 0x3b
const MASKED = [88, 73, 90, 65, 66, 92, 90, 86, 94, 72]

// Rebuild the host label at runtime. Exported for the unit test (a typo-guard on MASK/MASKED); a
// concat loop is used over map/join so no minifier constant-folds it back into a literal string.
export function hostToken(): string {
  let out = ''
  for (let i = 0; i < MASKED.length; i += 1) {
    out += String.fromCharCode(MASKED[i] ^ MASK)
  }
  return out
}

// The registrable (2nd-level) label must equal the host token. Passes every real CrazyGames host
// (<slug>.game-files.crazygames.com, www.crazygames.com, crazygames.com); blocks foreign hosts and
// a `crazygames.<attacker>.com` subdomain. hostname is a parameter so it can be unit-tested.
export function hostAllowed(hostname: string = location.hostname): boolean {
  const parts = hostname.split('.')
  return parts.length >= 2 && parts[parts.length - 2] === hostToken()
}

// The full boot gate. `vite dev` and an opt-in local-preview build (VITE_UNLOCK) are never locked
// — both fold to constants at build, so the shipped release keeps only the real check. Otherwise
// allow only on a genuine CrazyGames host (tight hostname OR the SDK's own verdict — see header).
export function bootAllowed(): boolean {
  if (import.meta.env.DEV) {
    return true
  }
  if (import.meta.env.VITE_UNLOCK) {
    return true
  }
  return hostAllowed() || getEnvironment() === hostToken()
}

// Blank the screen and give a disallowed host nothing — no branding, no link, no console noise.
export function renderLock(root: HTMLElement): void {
  root.replaceChildren()
  root.style.background = '#000'
  document.body.style.background = '#000'
}
