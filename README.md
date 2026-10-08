# RocketLauncherController

Camera-based target tracking for the Dream Cheeky USB missile launcher on macOS.
The webcam spots an object (a person by default), the launcher turns to face it, and it fires when you tell it to.

Inspired by [Firing up BeagleBone Black, webcam, missile launcher and OpenCV](https://community.sap.com/t5/product-lifecycle-management-blog-posts-by-sap/firing-up-beaglebone-black-webcam-missile-launcher-and-opencv/ba-p/13164889).

## How it works

```
 Browser (localhost:8080)                      Node server                    USB
 ┌───────────────────────────┐  WebSocket  ┌──────────────────────┐  HID   ┌──────────┐
 │ camera → COCO-SSD (TF.js) │ ──────────▶ │ tracker (control loop)│ ─────▶ │ launcher │
 │ overlay, controls         │ ◀────────── │ launcher driver       │        └──────────┘
 └───────────────────────────┘    state    └──────────────────────┘
```

- **`public/`**: the UI. It captures the camera with `getUserMedia` and detects objects with TensorFlow.js COCO-SSD (80 classes, including person, cat, dog and sports ball). It sends the chosen target's position to the server.
- **`src/launcher.js`**: the USB driver, built on `node-hid`. It needs no kernel driver or libusb.
- **`src/tracker.js`**: turns target positions into motor pulses.
- **`src/server.js`**: serves the UI and handles the WebSocket.
- **`src/cli.js`**: drives the launcher from the terminal.

### Launcher protocol

The device is the Dream Cheeky "Thunder" (VID `0x2123`, PID `0x1010`; macOS shows it as *Syntek USB Missile Launcher*). Each command is an 8-byte HID output report:

| Report                    | Meaning                                                                 |
|---------------------------|-------------------------------------------------------------------------|
| `02 01 00 00 00 00 00 00` | down                                                                    |
| `02 02 …`                 | up                                                                      |
| `02 04 …`                 | left                                                                    |
| `02 08 …`                 | right                                                                   |
| `02 10 …`                 | fire (a full cycle takes about 4.5 s)                                   |
| `02 20 …`                 | stop                                                                    |
| `03 01 …` / `03 00 …`     | LED on/off (the app turns the LED on while the launcher is armed)       |

A motor keeps running until it gets a stop command, and the device reports no position. Every move is therefore a timed pulse, and the app estimates the position from milliseconds of travel. Driving into the left and bottom limit switches ("Home") resets that estimate.

## Setup

Requirements: macOS, Node 18 or later, and Chrome or Safari.

```sh
npm install
npm run cli -- list          # check the launcher is detected
npm run cli -- led on        # harmless USB test
npm run cli -- right 300     # nudge right for 300 ms
npm start                    # then open http://localhost:8080
```

`npm run dry-run` starts the UI without the launcher attached.

The browser asks for camera permission the first time. If you already denied it, re-enable it in **System Settings → Privacy & Security → Camera**.

## Tracking modes

### Fixed camera (default)

Use this mode when the camera stays still, for example the Mac's built-in camera with the launcher next to it. Moving the launcher doesn't change the image, so the app needs a mapping from image position to launcher position:

1. Click **Home**. The launcher drives to its limits and then returns to the centre (about 11 s).
2. Use the arrow keys to jog the launcher until it points at something visible in the frame.
3. **Shift-click** that spot in the video to record a calibration point.
4. Repeat for 3–5 spots spread across the frame. Once both axes show ✓, the app has enough points to fit the mapping.

Calibration is saved in `config.json`. It stays valid as long as the camera and launcher don't move relative to each other, but you need to **Home** again after each restart. Starting tracking homes the launcher automatically if needed.

### Camera mounted on the launcher

Use this mode if you strap a USB webcam (or an iPhone with Continuity Camera) to the launcher. This is closed-loop tracking: the app pulses the motors until the target sits on the aim point. **Click** the video to set the aim point, i.e. where the darts actually land relative to the camera.

## Controls

| Input                  | Action                                                          |
|------------------------|-----------------------------------------------------------------|
| Arrow keys / pad       | Move while held (this stops tracking)                           |
| `T`                    | Start or stop tracking                                          |
| **Arm**                | Enables firing and turns on the launcher LED                    |
| `Space` / **FIRE**     | Fire one dart (only when armed)                                 |
| Auto-fire checkbox     | Fires when locked on (only when armed)                          |

## Tuning (`config.json`)

The file is created the first time you change a setting. Defaults are in `src/config.js`.

| Key                                   | Meaning                                                                                                        |
|---------------------------------------|----------------------------------------------------------------------------------------------------------------|
| `panRangeMs`, `tiltRangeMs`           | Full travel time of each axis. Time your launcher end to end and set these, because homing and clamping depend on them. |
| `deadband`                            | Mounted mode: how close counts as on target (fraction of the frame).                                           |
| `panGainMs`, `tiltGainMs`             | Mounted mode: pulse length per full frame of error. Lower them if the launcher overshoots and oscillates.      |
| `settleMs`                            | Delay after moving before new detections are trusted, so motion blur and camera lag are ignored.               |
| `invertPan`, `invertTilt`             | Mounted mode: set these if the camera is mounted upside down or mirrored.                                      |
| `fixedDeadbandMs`                     | Fixed mode: positional tolerance in milliseconds of motor travel.                                              |
| `lockFrames`                          | Number of consecutive on-target updates before the status shows LOCKED ON.                                     |

## Safety

Foam darts still hurt if they hit an eye. Keep the launcher disarmed unless you mean to fire, and don't aim at faces. The tracker aims at the centre of the bounding box, which for a person is usually the torso.
