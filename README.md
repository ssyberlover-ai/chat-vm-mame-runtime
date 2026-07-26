# chat-vm-mame-runtime

Browser-hosted Robby Roto arcade runtime for desktop and mobile.

## Current architecture

The published site no longer runs DOS MAME inside a v86/FreeDOS virtual machine. The active runtime is:

- GitHub Pages hosting
- EmulatorJS `4.2.3`
- Libretro `mame2003_plus` WebAssembly core
- Canvas/WebGL game output
- custom multitouch D-pad, FIRE, COIN, and START controls

Public page:

- https://ssyberlover-ai.github.io/chat-vm-mame-runtime/

## Why the architecture changed

The previous DOS MAME build booted successfully in v86, but its VGA output was corrupted in both tweaked VGA and tested VESA modes. The native WebAssembly core removes the DOS, FreeDOS, BIOS, virtual disk, and virtual VGA layers.

## ROM policy

No commercial arcade ROM set is bundled with the published site.

Robby Roto is loaded from the official MAMEdev repository under the non-commercial-use terms stated by MAMEdev:

- https://www.mamedev.org/roms/robby/

The launch page requires acknowledgement of those terms before starting the emulator.

## Deployment and verification

`.github/workflows/deploy-pages.yml` publishes `site/index.html` to GitHub Pages.

The browser smoke test verifies:

1. the public page loads
2. the `mame2003_plus` core starts
3. a visible game canvas is created
4. the mobile virtual gamepad is displayed
5. FIRE, COIN, and START controls are visible
6. COIN and START can receive touch input

Results are recorded in:

- `deployment-status.json`
- `live-smoke-status.json`

## Legacy files

Some v86, FreeDOS, and DOS MAME assets may remain in the repository as migration history. They are not used by the current GitHub Pages deployment.

## Upstream projects

- EmulatorJS: https://github.com/EmulatorJS/EmulatorJS
- MAME 2003 Plus: https://github.com/libretro/mame2003-plus-libretro
- MAMEdev Robby Roto distribution: https://www.mamedev.org/roms/robby/
