# Emulator Dock for Android

**VS Code lacks Android Studio's docked emulator experience, forcing developers to constantly switch windows. This extension brings the Android emulator directly into VS Code as a native, dockable panel.**

## The problem

Android Studio lets developers run the emulator in a panel docked inside the IDE, so code and app preview sit side by side. VS Code has no equivalent: the emulator runs as a separate window, and developers have to keep switching between the editor and the emulator while building and testing. This breaks focus and slows down the edit, run, and verify loop, especially for Flutter and React Native developers who prefer VS Code.

This extension solves that by embedding the Android emulator natively within VS Code, giving a seamless, docked experience without leaving the editor.

| | |
|---|---|
| **Problem** | VS Code doesn't support a docked Android emulator, so developers must switch between separate windows to view and interact with their running app. |
| **Impact** | Constant context switching disrupts workflow and slows the development and testing cycle. |
| **Solution** | A VS Code extension that embeds the Android emulator as a native, dockable panel inside the editor, matching the seamless experience of Android Studio. |

## Features

- **Docked, live emulator screen.** Shows in its own view, which you can drag anywhere in VS Code: the secondary side bar, the bottom panel, or next to your code. You can also open it as an editor tab beside your code (**Android Emulator: Open Emulator Beside Editor**).
- **Full interaction.** Click and drag to tap and swipe. Scroll with the mouse wheel or trackpad, and hold <kbd>Alt</kbd> and drag to pinch-zoom. Typed keys go to the device.
- **Hardware controls.** Back, Home, Overview, Power (hold for the power menu), volume, and rotate left/right.
- **Clipboard sync.** <kbd>Cmd/Ctrl</kbd>+<kbd>V</kbd> pastes your computer's clipboard into the device, and <kbd>Cmd/Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> copies device text back. <kbd>Cmd/Ctrl</kbd>+<kbd>A</kbd> and <kbd>Z</kbd> work too.
- **Launch AVDs from VS Code.** By default the emulator starts without its own window, so it only appears docked.
- **Attach to emulators that are already running**, whether they were started by Android Studio, `flutter run`, `npx react-native run-android`, or the command line.
- **Physical devices too.** Every device that `adb devices` lists shows up under **Connected devices**, over USB or wireless debugging. Pick one to mirror its screen in the panel and control it with the mouse and keyboard. Devices that aren't ready yet (for example, waiting for you to allow USB debugging) are listed with what to do.
- **Screenshots.** Saves full-resolution PNGs.
- **Fullscreen.** Hides the toolbar and navigation bar so the device screen fills the panel. Toggle it from the toolbar, the view or editor title bar, or **Android Emulator: Toggle Fullscreen**.
- **Sharp and responsive.** The screen streams at your panel's exact pixel size and always shows the newest frame. Streaming pauses while the panel is hidden.

## Requirements

- Android SDK with the **Android Emulator** package, version 30 or newer (needed for the gRPC streaming API; any recent install qualifies).
- At least one Android Virtual Device (AVD). Create one in Android Studio's Device Manager or with `avdmanager create avd`.
- VS Code 1.85+ or a compatible editor (Cursor, Windsurf, VSCodium).

To mirror a physical device, turn on **USB debugging** (or wireless debugging) in its Developer options and accept the authorization prompt on the device. This needs adb (the SDK's `platform-tools`, or any `adb` on your `PATH`). Live dragging needs Android 12 or newer. On older versions, a drag is sent as one swipe when you release the mouse button.

The SDK is found automatically from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the default install location (`~/Library/Android/sdk`, `~/Android/Sdk`, `%LOCALAPPDATA%\Android\Sdk`). If it isn't, set `emulatorDock.sdkPath`.

## Getting started

1. Install **Emulator Dock for Android** from the Extensions view. It's on the VS Code Marketplace, and on Open VSX for Cursor, Windsurf, and VSCodium.
2. Click the **phone icon** in the activity bar.
3. If an emulator is already running, it appears right away. Otherwise click **Launch** next to an AVD, or **Show** next to a connected phone.
4. Optional: drag the view into the **secondary side bar** (right-hand side) so your code and app sit side by side, Android Studio-style.

Run your app as usual (`flutter run`, `npx expo run:android`, Gradle, and so on). It deploys to the docked emulator, which is a normal emulator as far as `adb` is concerned.

## Controls

| Action | How |
|---|---|
| Tap / swipe / long-press | Click, drag, or hold on the screen |
| Scroll | Mouse wheel or two-finger trackpad scroll |
| Pinch zoom | Hold <kbd>Alt</kbd> and drag |
| Type | Click the screen to focus it, then type |
| Paste from your computer | <kbd>Cmd/Ctrl</kbd>+<kbd>V</kbd> |
| Copy from the device | <kbd>Cmd/Ctrl</kbd>+<kbd>C</kbd> (or <kbd>X</kbd>) |
| Back / Home / Overview | Buttons under the screen |
| Power menu | Hold the power button |
| Fullscreen | Click the fullscreen button in the toolbar. To exit, move the mouse and click **Exit fullscreen**, or use the title-bar icon |
| Back (in fullscreen) | Swipe in from the screen edge, or press <kbd>Esc</kbd> |

Editor shortcuts like <kbd>Cmd/Ctrl</kbd>+<kbd>P</kbd> keep working while the screen has focus.

On a physical device, a few controls work differently because adb can't do everything the emulator's API can:

- Pasting types the text into the focused field. Only ASCII characters can be typed.
- Copying from the device isn't available, because adb can't read the device clipboard.
- <kbd>Alt</kbd>+drag acts as a one-finger drag, because adb can inject only one pointer.
- Rotating sets the orientation and turns off auto-rotate on the device.
- The Stop button is disabled.

## Settings

| Setting | Default | Description |
|---|---|---|
| `emulatorDock.sdkPath` | auto | Android SDK location |
| `emulatorDock.autoConnect` | `true` | Show a running emulator as soon as the panel opens |
| `emulatorDock.screenQuality` | `auto` | `auto` streams at full pixel density; `performance` streams at half density on high-DPI screens (about 4x less data) |
| `emulatorDock.launch.hideStandaloneWindow` | `true` | Start emulators without their own window |
| `emulatorDock.launch.extraArgs` | `[]` | Extra emulator flags, for example `["-no-snapshot-load"]` |
| `emulatorDock.stopOnExit` | `true` | Shut down emulators launched from VS Code once VS Code is closed (about 2 minutes after the last window closes). Reloading the window keeps them running. Emulators started elsewhere are never stopped. |

## How it works

This uses the same approach as Android Studio's embedded emulator. Every running emulator writes a small registration file that includes a local gRPC port and an access token. The extension:

1. **Discovers** emulators by reading those registration files, so it finds emulators no matter what started them.
2. **Streams** the display with `streamScreenshot`, as raw RGB frames sized to the panel. A frame is sent only after the webview acknowledges the previous one, so latency never builds up and the newest frame always wins.
3. **Forwards input** over one ordered `streamInputEvent` channel (touch, mouse, wheel, keys). It maps panel coordinates into the device's native display space, accounting for rotation.
4. **Launches** AVDs with `-qt-hide-window -grpc-use-token`, so the emulator only appears docked inside VS Code.
5. **Mirrors physical devices over adb.** `adb track-devices` reports devices as they connect, disconnect, or get authorized. The screen streams with `screenrecord --output-format=frames`: the device scales each frame to the panel size and sends raw RGB only when the screen changes. Frames are capped at about one megapixel to keep the frame rate up over the cable. Input goes through one persistent `adb shell` that runs `input` commands one at a time. Pointer moves and scrolls that arrive while a command is still running are merged into the latest one, so input never falls behind the cursor. Devices whose `screenrecord` can't stream frames fall back to polling `screencap`.
6. **Survives reloads.** Emulators launched from VS Code also get `-idle-grpc-timeout 120`. Every open VS Code window sends them a lightweight status call every 30 seconds, so a window reload doesn't interrupt anything, and panels reattach to the same device. After the last window closes, the calls stop and the emulator shuts itself down gracefully.

```
┌──────────── VS Code ────────────┐         ┌──────── Android Emulator ────────┐
│ Webview (canvas + toolbar)       │         │                                  │
│   ▲ frames        │ input         │  gRPC   │  EmulatorController service      │
│   │               ▼               │ ◄─────► │  streamScreenshot / streamInput  │
│ Extension host (session, registry)│ localhost│  (token from registration file)  │
└──────────────────────────────────┘         └──────────────────────────────────┘
```

## Limitations

- Physical devices are mirrored at a lower frame rate than emulators: frames travel uncompressed over adb, so throughput depends on the cable (USB 3 is noticeably smoother than USB 2 or Wi-Fi). Physical devices are never connected automatically; pick one from the list.
- Audio isn't streamed into VS Code. The emulator still plays sound through your computer's speakers.
- Only the main display is shown. Foldable and multi-display layouts show the primary display.
- With remote development (SSH, containers, WSL), the extension runs on your local machine, because that's where the emulator runs.

## Development

```bash
npm install
npm run build        # bundle to dist/extension.js
npm run watch        # rebuild on change
npm run typecheck
npm run package      # produce a .vsix
```

Press <kbd>F5</kbd> to open an Extension Development Host. Logs are under **Output → Android Emulator**.

Project layout:

| Path | Purpose |
|---|---|
| `src/extension.ts` | Activation, commands, view and panel registration |
| `src/registry.ts` | SDK, AVDs, running emulators, adb devices, launching and stopping |
| `src/discovery.ts` | Reads emulator registration files |
| `src/adb.ts` | adb device tracking, device names, adb helpers |
| `src/adbSession.ts` | Physical device session: screenrecord frame stream, display monitor, input over `adb shell` |
| `src/emulatorClient.ts` | gRPC client for the emulator controller service |
| `src/session.ts` | Frame streaming with flow control, input mapping, device actions |
| `src/viewController.ts` | Connects a webview (docked view or editor tab) to a session |
| `media/main.js`, `media/main.css` | Webview UI: canvas renderer, input capture, toolbar |
| `resources/proto/` | Emulator gRPC definitions (Apache 2.0, from the Android Emulator) |
