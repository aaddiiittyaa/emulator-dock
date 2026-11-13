import * as vscode from 'vscode';
import { DeviceRegistry } from './registry';
import { activeController, EmulatorViewController } from './viewController';

const VIEW_ID = 'emulatorDock.view';
const PANEL_TYPE = 'emulatorDock.panel';

let registry: DeviceRegistry | undefined;
let viewController: EmulatorViewController | undefined;
const panelControllers = new Map<vscode.WebviewPanel, EmulatorViewController>();

/** What a webview persists: the device key (older versions saved only an emulator pid). */
type SavedState = { key?: string; pid?: number } | undefined;

function savedKey(state: SavedState): string | undefined {
  return state?.key ?? (typeof state?.pid === 'number' ? `run:${state.pid}` : undefined);
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Android Emulator', { log: true });
  registry = new DeviceRegistry(context, log);
  const reg = registry;
  void reg.refresh();

  const iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'phone.svg');

  const attachPanel = (panel: vscode.WebviewPanel, key?: string) => {
    panel.iconPath = iconPath;
    const controller = new EmulatorViewController(panel.webview, context, reg, log, 'editor', key);
    panelControllers.set(panel, controller);
    panel.onDidChangeViewState(() => controller.setVisible(panel.visible));
    panel.onDidDispose(() => {
      panelControllers.delete(panel);
      controller.dispose();
    });
    return controller;
  };

  context.subscriptions.push(
    log,
    reg,
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      {
        resolveWebviewView(view, resolveContext) {
          // After a window reload, reattach to the device this view was showing.
          const controller = new EmulatorViewController(view.webview, context, reg, log, 'sidebar', savedKey(resolveContext?.state as SavedState));
          viewController = controller;
          view.onDidChangeVisibility(() => controller.setVisible(view.visible));
          view.onDidDispose(() => {
            if (viewController === controller) {
              viewController = undefined;
            }
            controller.dispose();
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),

    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      async deserializeWebviewPanel(panel, state: SavedState) {
        attachPanel(panel, savedKey(state));
      },
    }),

    vscode.commands.registerCommand('emulatorDock.openInEditor', () => {
      const panel = vscode.window.createWebviewPanel(
        PANEL_TYPE,
        'Android Emulator',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { retainContextWhenHidden: true },
      );
      attachPanel(panel, activeController()?.connectedKey);
    }),

    vscode.commands.registerCommand('emulatorDock.launchAvd', async () => {
      await reg.refresh();
      if (!reg.sdkPath) {
        const choice = await vscode.window.showErrorMessage('Android SDK not found.', 'Set SDK Path');
        if (choice) {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'emulatorDock.sdkPath');
        }
        return;
      }
      if (reg.avds.length === 0) {
        void vscode.window.showInformationMessage(
          "No Android Virtual Devices found. Create one in Android Studio's Device Manager or with `avdmanager create avd`.",
        );
        return;
      }
      const items = reg.avds.map((avd) => {
        const running = reg.running.some((r) => r.avdId === avd.id);
        return {
          label: avd.displayName,
          description: running ? 'running' : reg.isLaunching(avd.id) ? 'starting…' : avd.id,
          avdId: avd.id,
        };
      });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a virtual device to launch' });
      if (!pick) {
        return;
      }
      let controller = activeController();
      if (!controller) {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        controller = activeController();
      }
      if (controller) {
        await controller.launch(pick.avdId);
      } else {
        await reg.launch(pick.avdId);
      }
    }),

    vscode.commands.registerCommand('emulatorDock.stopEmulator', async () => {
      const controller = activeController();
      if (controller?.canStop) {
        await controller.stop();
        return;
      }
      if (reg.running.length === 0) {
        void vscode.window.showInformationMessage('No emulators are running.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        reg.running.map((r) => ({ label: r.avdName, description: `emulator-${r.serialPort}`, emulator: r })),
        { placeHolder: 'Select an emulator to stop' },
      );
      if (pick) {
        await reg.stop(pick.emulator);
      }
    }),

    vscode.commands.registerCommand('emulatorDock.screenshot', async () => {
      const controller = activeController();
      if (!controller) {
        void vscode.window.showWarningMessage('Open the Android Emulator view first.');
        return;
      }
      try {
        await controller.screenshot();
      } catch (e) {
        void vscode.window.showErrorMessage(`Screenshot failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('emulatorDock.toggleFullscreen', () => {
      const controller = activeController();
      if (controller) {
        controller.toggleFullscreen();
      } else {
        void vscode.window.showWarningMessage('Open the Android Emulator view first.');
      }
    }),
    // Title-bar buttons target their own view/tab, whichever webview was used last.
    vscode.commands.registerCommand('emulatorDock.view.toggleFullscreen', () => viewController?.toggleFullscreen()),
    vscode.commands.registerCommand('emulatorDock.panel.toggleFullscreen', () => {
      for (const [panel, controller] of panelControllers) {
        if (panel.active) {
          controller.toggleFullscreen();
        }
      }
    }),

    vscode.commands.registerCommand('emulatorDock.refresh', () => reg.refresh()),
    vscode.commands.registerCommand('emulatorDock.showLogs', () => log.show()),
  );
}

export function deactivate(): void {
  // Deliberately does not stop emulators: deactivate also runs on "Reload Window", and the
  // emulator should survive that. Emulators launched with stopOnExit carry an idle timeout
  // and shut themselves down once no VS Code window is pinging them.
}
