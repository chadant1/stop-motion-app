# Frameloom — stop-motion studio for iPhone & Android

Frameloom is a free, open-source stop-motion animation app. Everything runs on your phone, works offline once installed, and has no ads, accounts or in-app purchases — every feature is included.

## Install it on your phone

**iPhone / iPad (Safari)**
1. Open the app's web address (GitHub Pages link for this repo) in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Open Frameloom from the home screen and allow the camera.

**Android (Chrome)**
- Open the web address in Chrome and tap **Install app** (or ⋮ → *Install app*), **or**
- Download the APK: repo → **Actions** → *Build Android app (APK)* → latest run → **Frameloom-android** artifact. Unzip, copy `app-debug.apk` to your phone and open it (allow "install unknown apps").

> The camera only works over **https** (GitHub Pages) or on `localhost`. Opening `index.html` straight from a file won't give camera access.

## Features

**Capture**
- Live camera with onion skin (1–5 previous frames, adjustable opacity) and hold-to-compare with the last frame
- Front/back/external camera switching, capture quality up to 4K, mirror
- Manual camera controls where the phone allows: focus, exposure, shutter time, ISO, white balance, zoom, torch, plus focus/exposure lock
- Grid overlays (thirds, fine, centre), self-timer, time-lapse (interval + count)
- Shoot on ones/twos/threes, retake (replace) mode, keyboard & Bluetooth shutter support
- **Remote camera**: use a second phone as the camera or as a wireless shutter (WebRTC, no server — devices swap a code)

**Edit**
- Timeline with thumbnails, multi-select, copy / cut / paste, duplicate, delete, move, reverse, boomerang, repeat
- Per-frame hold (duration), insert anywhere, blank frames, undo/redo (60 steps)
- Frame rate 1–60 fps, loop and ping-pong playback

**Pro-level tools (all free)**
- **Green screen** with tap-to-pick key colour, strength, edge softness, spill removal, and colour / picture / video / transparent backgrounds — previewed live on the camera
- **Paint**: brush, marker, eraser, fill, line, box, oval, text, colour picker, per-frame drawing layer, frame-to-frame stepping with onion skin
- **Magic eraser**: paint away rigs, strings and hands using a clean-plate frame
- **Rotoscoping**: trace over a reference video/picture; "drawings only" output mode
- **Import** pictures and videos (video is split into frames at your frame rate, optionally with its sound)
- **Sound**: voice recording (optionally while the animation plays, for lip-sync), music/sound import, 16 built-in synthesized sound effects, per-track start time, volume, trim, mute
- **Titles & credits**: 8 styles, 6 fonts, fade / typewriter / zoom / slide / rolling-credits animations, captions over pictures
- **Effects**: 6 movie themes, 16 filters, brightness/contrast/saturation/warmth, vignette, film grain, deflicker, fade in/out
- **Layers**: foreground overlay picture, reference layer, caption/watermark
- Aspect ratios 16:9, 4:3, 1:1, 9:16, 3:4, 2.39:1

**Export**
- MP4 movie up to 4K with sound (encoded on the phone, faster than real time where supported; falls back to real-time recording elsewhere)
- Animated GIF, PNG or JPEG image sequence (.zip), single frame as PNG
- Project backup (.zip) to move movies between devices; share sheet support

## Notes on platform limits
- iPhone browsers expose very few manual camera controls (Apple's restriction); Frameloom shows only the controls your device actually supports. Use Effects → Deflicker if the light changes between shots.
- Physical volume buttons can't be read by web apps; use the on-screen shutter, the self-timer, a Bluetooth shutter remote, or the remote-camera feature.
- Movies are stored on the device (IndexedDB). Export backups to keep them safe.
- A native iOS App Store build needs a Mac with Xcode and an Apple developer account; the Home Screen install gives the same app without that.

## Development
No build step — plain HTML, CSS and JavaScript modules.
```
python3 -m http.server 8000   # then open http://localhost:8000
```
`js/vendor/mp4-muxer.mjs` is [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT).

## License
MIT
