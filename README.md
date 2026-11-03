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
- **Screenshots.** Saves full-resolution PNGs.
- **Fullscreen.** Hides the toolbar and navigation bar so the device screen fills the panel. Toggle it from the toolbar, the view or editor title bar, or **Android Emulator: Toggle Fullscreen**.
- **Sharp and responsive.** The screen streams at your panel's exact pixel size and always shows the newest frame. Streaming pauses while the panel is hidden.

## Requirements

- Android SDK with the **Android Emulator** package, version 30 or newer (needed for the gRPC streaming API; any recent install qualifies).
- At least one Android Virtual Device (AVD). Create one in Android Studio's Device Manager or with `avdmanager create avd`.
- VS Code 1.85+ or a compatible editor (Cursor, Windsurf, VSCodium).

The SDK is found automatically from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the default install location (`~/Library/Android/sdk`, `~/Android/Sdk`, `%LOCALAPPDATA%\Android\Sdk`). If it isn't, set `emulatorDock.sdkPath`.

## Getting started

1. Install **Emulator Dock for Android** from the Extensions view. It's on the VS Code Marketplace, and on Open VSX for Cursor, Windsurf, and VSCodium.
2. Click the **phone icon** in the activity bar.
3. If an emulator is already running, it appears right away. Otherwise click **Launch** next to an AVD.
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
5. **Survives reloads.** Emulators launched from VS Code also get `-idle-grpc-timeout 120`. Every open VS Code window sends them a lightweight status call every 30 seconds, so a window reload doesn't interrupt anything, and panels reattach to the same device. After the last window closes, the calls stop and the emulator shuts itself down gracefully.

```
┌──────────── VS Code ────────────┐         ┌──────── Android Emulator ────────┐
│ Webview (canvas + toolbar)       │         │                                  │
│   ▲ frames        │ input         │  gRPC   │  EmulatorController service      │
│   │               ▼               │ ◄─────► │  streamScreenshot / streamInput  │
│ Extension host (session, registry)│ localhost│  (token from registration file)  │
└──────────────────────────────────┘         └──────────────────────────────────┘
```

## Limitations

- Emulators only. Physical devices aren't mirrored yet; a scrcpy-style transport would be needed for that.
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
| `src/registry.ts` | SDK, AVDs, running emulators, launching and stopping |
| `src/discovery.ts` | Reads emulator registration files |
| `src/emulatorClient.ts` | gRPC client for the emulator controller service |
| `src/session.ts` | Frame streaming with flow control, input mapping, device actions |
| `src/viewController.ts` | Connects a webview (docked view or editor tab) to a session |
| `media/main.js`, `media/main.css` | Webview UI: canvas renderer, input capture, toolbar |
| `resources/proto/` | Emulator gRPC definitions (Apache 2.0, from the Android Emulator) |
