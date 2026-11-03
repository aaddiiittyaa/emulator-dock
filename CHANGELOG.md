# Changelog

## 0.1.2

- Reloading the window no longer stops the emulator. Panels reattach to the same device, and fullscreen is remembered.
- "Stop on exit" now uses the emulator's idle timeout: emulators launched from VS Code shut themselves down about 2 minutes after the last VS Code window closes.
- No more "SDK not found" or "No emulator" flash while reconnecting after a reload.

## 0.1.1

- Screen corners now match the device exactly (radius read from Android), so no black corner wedges.
- Fullscreen mode: hides the toolbar and navigation bar and maximizes the screen. Toggle from the toolbar, the view/editor title bar, or **Android Emulator: Toggle Fullscreen**.

## 0.1.0

- First release: docked emulator view and editor tab, live streaming, touch/keyboard/clipboard input, hardware buttons, rotation, AVD launching, screenshots.
