// ═══════════════════════════════════════
// ATLAS — Screenshot Tool
// Capturar pantalla y enviar por el canal activo
// Navega al target antes de capturar
// ═══════════════════════════════════════

import { Tool, ToolDefinition, ToolResult, OutgoingAttachment } from '../../types';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import logger from '../../utils/logger';

const isWin = process.platform === 'win32';
const SCREENSHOTS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'screenshots');

// Ensure screenshots directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Well-known folder aliases (Spanish → actual path)
const FOLDER_ALIASES: Record<string, string> = {
  'descargas': path.join(os.homedir(), 'Downloads'),
  'downloads': path.join(os.homedir(), 'Downloads'),
  'documentos': path.join(os.homedir(), 'Documents'),
  'documents': path.join(os.homedir(), 'Documents'),
  'escritorio': path.join(os.homedir(), 'Desktop'),
  'desktop': path.join(os.homedir(), 'Desktop'),
  'imagenes': path.join(os.homedir(), 'Pictures'),
  'imágenes': path.join(os.homedir(), 'Pictures'),
  'pictures': path.join(os.homedir(), 'Pictures'),
  'musica': path.join(os.homedir(), 'Music'),
  'música': path.join(os.homedir(), 'Music'),
  'music': path.join(os.homedir(), 'Music'),
  'videos': path.join(os.homedir(), 'Videos'),
};

interface ChannelManagerLike {
  sendToChannel(channel: string, message: string, chatId?: string, attachments?: OutgoingAttachment[]): Promise<boolean>;
}

export class ScreenshotTool implements Tool {
  private channelManager: ChannelManagerLike;

  definition: ToolDefinition = {
    name: 'screenshot',
    description:
      'Capturar pantalla del PC y enviarla por el canal actual. ' +
      'Targets disponibles:\n' +
      '- desktop: Minimiza TODAS las ventanas (muestra el escritorio limpio) y captura la pantalla completa.\n' +
      '- active_window: Captura la ventana que está en primer plano.\n' +
      '- window: Busca una ventana por título parcial (ej: "Chrome", "Discord") y la captura. Si no existe, intenta abrirla.\n' +
      '- folder: Abre una carpeta en el Explorador de archivos y captura esa ventana. Acepta nombre conocido (descargas, documentos) o ruta completa.\n' +
      'SIEMPRE usá este tool cuando pidan "captura", "screenshot", "mostrame la pantalla", etc. ' +
      'Para "captura del escritorio" usá target=desktop. Para "captura de descargas" usá target=folder con folder_path="descargas".',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['capture', 'list'],
          description: 'Acción: capture (tomar y enviar captura), list (listar capturas guardadas)',
        },
        target: {
          type: 'string',
          enum: ['desktop', 'active_window', 'window', 'folder'],
          description: 'Qué capturar: desktop=escritorio limpio (minimiza todo), active_window=ventana activa, window=ventana por título, folder=carpeta en Explorer',
        },
        window_title: {
          type: 'string',
          description: 'Título parcial de la ventana a capturar (ej: "Chrome", "Discord", "WhatsApp"). Solo para target=window. Búsqueda parcial case-insensitive.',
        },
        folder_path: {
          type: 'string',
          description: 'Carpeta a abrir y capturar. Acepta alias (descargas, documentos, escritorio, imagenes, musica, videos) o ruta completa (C:\\Users\\...\\MiCarpeta). Solo para target=folder.',
        },
        channel: {
          type: 'string',
          enum: ['whatsapp', 'telegram', 'web', 'all'],
          description: 'Canal donde enviar la captura (default: whatsapp)',
        },
        chatId: {
          type: 'string',
          description: 'ID del chat destino (opcional, usa el último chat activo)',
        },
        message: {
          type: 'string',
          description: 'Mensaje/caption para acompañar la captura',
        },
      },
      required: ['action'],
    },
  };

  constructor(channelManager: ChannelManagerLike) {
    this.channelManager = channelManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string;

    try {
      switch (action) {
        case 'capture':
          return await this.capture(params);
        case 'list':
          return this.listScreenshots();
        default:
          return { success: false, output: '', error: `Acción desconocida: ${action}` };
      }
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  }

  private async capture(params: Record<string, unknown>): Promise<ToolResult> {
    const channel = (params.channel as string) || 'whatsapp';
    const chatId = params.chatId as string | undefined;
    let target = (params.target as string) || 'desktop';
    const windowTitle = params.window_title as string | undefined;
    const folderPath = params.folder_path as string | undefined;

    // If window_title is provided, force target=window
    if (windowTitle && target !== 'window' && target !== 'folder') {
      target = 'window';
    }
    // If folder_path is provided, force target=folder
    if (folderPath && target !== 'folder') {
      target = 'folder';
    }

    const defaultCaption = target === 'window' && windowTitle
      ? `Ventana: ${windowTitle}`
      : target === 'folder' && folderPath
        ? `Carpeta: ${folderPath}`
        : target === 'active_window'
          ? 'Ventana activa'
          : 'Escritorio';
    const caption = (params.message as string) || defaultCaption;

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `screenshot_${timestamp}.png`;
    const filePath = path.join(SCREENSHOTS_DIR, fileName);

    // Take the screenshot
    try {
      if (isWin) {
        this.captureWindows(filePath, target, windowTitle, folderPath);
      } else if (process.platform === 'darwin') {
        if (target === 'active_window') {
          execSync(`screencapture -w "${filePath}"`, { timeout: 10000 });
        } else {
          execSync(`screencapture -x "${filePath}"`, { timeout: 10000 });
        }
      } else {
        this.captureLinux(filePath, target);
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Error capturando pantalla: ${err.message}` };
    }

    // Verify file was created
    if (!fs.existsSync(filePath)) {
      return { success: false, output: '', error: 'No se pudo crear la captura de pantalla' };
    }

    const fileSize = fs.statSync(filePath).size;
    const fileSizeKB = (fileSize / 1024).toFixed(1);
    const targetLabel = target === 'window' && windowTitle
      ? `ventana "${windowTitle}"`
      : target === 'folder' && folderPath
        ? `carpeta "${folderPath}"`
        : target === 'active_window'
          ? 'ventana activa'
          : 'escritorio';

    // Send through channel
    try {
      const buffer = fs.readFileSync(filePath);
      const attachment: OutgoingAttachment = {
        type: 'image',
        buffer,
        path: filePath,
        fileName,
      };

      const sent = await this.channelManager.sendToChannel(channel, caption, chatId, [attachment]);

      if (sent) {
        logger.info(`Screenshot sent via ${channel}: ${fileName} (${fileSizeKB}KB)`);
        return {
          success: true,
          output: `Captura de ${targetLabel} enviada por ${channel}: ${fileName} (${fileSizeKB}KB)`,
        };
      } else {
        return {
          success: true,
          output: `Captura guardada en ${filePath} (${fileSizeKB}KB) pero no se pudo enviar por ${channel}. ¿El canal está activo?`,
        };
      }
    } catch (err: any) {
      return {
        success: true,
        output: `Captura guardada en ${filePath} (${fileSizeKB}KB) pero falló el envío: ${err.message}`,
      };
    }
  }

  private captureWindows(outputPath: string, target: string, windowTitle?: string, folderPath?: string): void {
    const psPath = path.join(os.tmpdir(), `atlas_screenshot_${Date.now()}.ps1`);
    const escapedOutput = outputPath.replace(/\\/g, '\\\\');

    // Common Win32 API declarations for window capture
    const winApiBlock = [
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'using System.Text;',
      'using System.Collections.Generic;',
      'public class WinAPI {',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
      '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int count);',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
      '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
      '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
      '  public static List<KeyValuePair<IntPtr,string>> GetVisibleWindows() {',
      '    var result = new List<KeyValuePair<IntPtr,string>>();',
      '    EnumWindows((hWnd, _) => {',
      '      if (!IsWindowVisible(hWnd)) return true;',
      '      var sb = new StringBuilder(256);',
      '      GetWindowText(hWnd, sb, 256);',
      '      var title = sb.ToString();',
      '      if (!string.IsNullOrWhiteSpace(title)) {',
      '        result.Add(new KeyValuePair<IntPtr,string>(hWnd, title));',
      '      }',
      '      return true;',
      '    }, IntPtr.Zero);',
      '    return result;',
      '  }',
      '}',
      '"@',
    ];

    // Helper: capture a specific window rect
    const captureWindowRect = [
      '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))',
      `$bmp.Save('${escapedOutput}')`,
      '$g.Dispose()',
      '$bmp.Dispose()',
    ];

    let psScript: string;

    if (target === 'folder' && folderPath) {
      // Open folder in Explorer, wait for it to be foreground, capture that window
      const resolvedPath = this.resolveFolder(folderPath);
      // In PS single-quoted strings, backslashes are literal — no need to double them
      const escapedFolder = resolvedPath.replace(/'/g, "''");

      psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        ...winApiBlock,
        '',
        '# Remember windows BEFORE opening Explorer',
        '$before = @{}',
        'foreach ($win in [WinAPI]::GetVisibleWindows()) {',
        '  $before[$win.Key] = $true',
        '}',
        '',
        '# Open the folder in Explorer',
        `explorer.exe '${escapedFolder}'`,
        '',
        '# Wait for the NEW Explorer window to appear (up to 5 seconds)',
        '$newHwnd = [IntPtr]::Zero',
        'for ($i = 0; $i -lt 25; $i++) {',
        '  Start-Sleep -Milliseconds 200',
        '  foreach ($win in [WinAPI]::GetVisibleWindows()) {',
        '    if (-not $before.ContainsKey($win.Key)) {',
        '      $newHwnd = $win.Key',
        '      break',
        '    }',
        '  }',
        '  if ($newHwnd -ne [IntPtr]::Zero) { break }',
        '}',
        '',
        '# If no new window detected, use the foreground window as fallback',
        'if ($newHwnd -eq [IntPtr]::Zero) {',
        '  Start-Sleep -Milliseconds 500',
        '  $newHwnd = [WinAPI]::GetForegroundWindow()',
        '}',
        '',
        '# Bring window to front and capture it',
        '[WinAPI]::SetForegroundWindow($newHwnd) | Out-Null',
        'Start-Sleep -Milliseconds 600',
        '$rect = New-Object WinAPI+RECT',
        '[WinAPI]::GetWindowRect($newHwnd, [ref]$rect) | Out-Null',
        '$w = $rect.Right - $rect.Left',
        '$h = $rect.Bottom - $rect.Top',
        '',
        'if ($w -le 0 -or $h -le 0) {',
        '  # Fallback: capture full screen',
        '  $screen = [System.Windows.Forms.Screen]::PrimaryScreen',
        '  $w = $screen.Bounds.Width',
        '  $h = $screen.Bounds.Height',
        '  $rect.Left = 0',
        '  $rect.Top = 0',
        '}',
        '',
        ...captureWindowRect,
      ].join('\r\n');

    } else if (target === 'window' && windowTitle) {
      // Find window by title and capture it
      const escapedTitle = windowTitle.replace(/'/g, "''");
      psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        ...winApiBlock,
        `$search = '${escapedTitle}'.ToLower()`,
        '$windows = [WinAPI]::GetVisibleWindows()',
        '$match = $null',
        'foreach ($win in $windows) {',
        '  if ($win.Value.ToLower().Contains($search)) {',
        '    $match = $win',
        '    break',
        '  }',
        '}',
        '',
        '# If not found, try to launch the app',
        'if ($match -eq $null) {',
        '  $launched = $false',
        '',
        '  # Strategy 1: Direct Start-Process (works for PATH apps)',
        '  if (-not $launched) {',
        '    try {',
        `      Start-Process '${escapedTitle}' -ErrorAction Stop`,
        '      $launched = $true',
        '    } catch { }',
        '  }',
        '',
        '  # Strategy 2: Search Start Menu shortcuts (.lnk files)',
        '  if (-not $launched) {',
        '    $shell = New-Object -ComObject WScript.Shell',
        '    $lnkDirs = @(',
        '      "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",',
        '      "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"',
        '    )',
        '    foreach ($dir in $lnkDirs) {',
        '      if (-not (Test-Path $dir)) { continue }',
        '      $lnks = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue',
        '      foreach ($lnk in $lnks) {',
        '        if ($lnk.BaseName.ToLower().Contains($search)) {',
        '          try {',
        '            $shortcut = $shell.CreateShortcut($lnk.FullName)',
        '            Start-Process $shortcut.TargetPath -ErrorAction Stop',
        '            $launched = $true',
        '            break',
        '          } catch { }',
        '        }',
        '      }',
        '      if ($launched) { break }',
        '    }',
        '  }',
        '',
        '  # Strategy 3: Search Program Files for matching .exe',
        '  if (-not $launched) {',
        '    $searchDirs = @(',
        '      "$env:ProgramFiles",',
        '      "${env:ProgramFiles(x86)}",',
        '      "$env:LOCALAPPDATA",',
        '      "$env:APPDATA"',
        '    )',
        '    foreach ($dir in $searchDirs) {',
        '      if (-not (Test-Path $dir)) { continue }',
        `      $exe = Get-ChildItem -Path $dir -Filter '*${escapedTitle}*.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1`,
        '      if ($exe) {',
        '        try {',
        '          Start-Process $exe.FullName -ErrorAction Stop',
        '          $launched = $true',
        '          break',
        '        } catch { }',
        '      }',
        '    }',
        '  }',
        '',
        '  # Wait for app window to appear',
        '  if ($launched) {',
        '    for ($j = 0; $j -lt 15; $j++) {',
        '      Start-Sleep -Milliseconds 300',
        '      $windows = [WinAPI]::GetVisibleWindows()',
        '      foreach ($win in $windows) {',
        '        if ($win.Value.ToLower().Contains($search)) {',
        '          $match = $win',
        '          break',
        '        }',
        '      }',
        '      if ($match -ne $null) { break }',
        '    }',
        '  }',
        '}',
        '',
        'if ($match -eq $null) {',
        '  $titles = ($windows | ForEach-Object { $_.Value }) -join ", "',
        `  Write-Error "No se encontro ventana '${escapedTitle}'. Ventanas: $titles"`,
        '  exit 1',
        '}',
        '# Bring window to front for clean capture',
        '# SW_RESTORE = 9 (restores minimized windows)',
        '[WinAPI]::ShowWindow($match.Key, 9) | Out-Null',
        '[WinAPI]::SetForegroundWindow($match.Key) | Out-Null',
        'Start-Sleep -Milliseconds 500',
        '$rect = New-Object WinAPI+RECT',
        '[WinAPI]::GetWindowRect($match.Key, [ref]$rect) | Out-Null',
        '$w = $rect.Right - $rect.Left',
        '$h = $rect.Bottom - $rect.Top',
        'if ($w -le 0 -or $h -le 0) {',
        '  Write-Error "La ventana tiene dimensiones invalidas ($w x $h)"',
        '  exit 1',
        '}',
        ...captureWindowRect,
      ].join('\r\n');

    } else if (target === 'active_window') {
      // Capture the foreground window
      psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        ...winApiBlock,
        '$hwnd = [WinAPI]::GetForegroundWindow()',
        '$rect = New-Object WinAPI+RECT',
        '[WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null',
        '$w = $rect.Right - $rect.Left',
        '$h = $rect.Bottom - $rect.Top',
        'if ($w -le 0 -or $h -le 0) {',
        '  $screen = [System.Windows.Forms.Screen]::PrimaryScreen',
        '  $w = $screen.Bounds.Width',
        '  $h = $screen.Bounds.Height',
        '  $rect.Left = 0',
        '  $rect.Top = 0',
        '}',
        ...captureWindowRect,
      ].join('\r\n');

    } else {
      // Desktop capture: minimize all windows first (show desktop), then capture
      psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '',
        '# Minimize all windows to show clean desktop (Win+D)',
        '$shell = New-Object -ComObject Shell.Application',
        '$shell.MinimizeAll()',
        'Start-Sleep -Milliseconds 800',
        '',
        '# Capture the clean desktop',
        '$screen = [System.Windows.Forms.Screen]::PrimaryScreen',
        '$w = $screen.Bounds.Width',
        '$h = $screen.Bounds.Height',
        '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)',
        `$bmp.Save('${escapedOutput}')`,
        '$g.Dispose()',
        '$bmp.Dispose()',
        '',
        '# Restore windows (undo minimize)',
        '$shell.UndoMinimizeAll()',
      ].join('\r\n');
    }

    try {
      fs.writeFileSync(psPath, psScript, 'utf-8');
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, {
        timeout: 20000,
        windowsHide: true,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      // Extract useful error from PowerShell stderr
      const stderr = err.stderr?.toString() || err.message || '';
      if (stderr.includes('No se encontro ventana') || stderr.includes('No se encontró ventana')) {
        throw new Error(stderr.trim());
      }
      throw err;
    } finally {
      try { fs.unlinkSync(psPath); } catch {}
    }
  }

  /** Resolve folder alias or path */
  private resolveFolder(folderPath: string): string {
    const lower = folderPath.toLowerCase().trim();
    // Check alias map
    if (FOLDER_ALIASES[lower]) {
      return FOLDER_ALIASES[lower];
    }
    // If it looks like an absolute path, use it directly
    if (path.isAbsolute(folderPath)) {
      return folderPath;
    }
    // Try as subfolder of user home
    const homePath = path.join(os.homedir(), folderPath);
    if (fs.existsSync(homePath)) {
      return homePath;
    }
    // Last resort: treat as-is (Explorer will error if not found)
    return folderPath;
  }

  private captureLinux(filePath: string, target: string): void {
    const windowFlag = target === 'active_window';
    try {
      if (windowFlag) {
        execSync(`import -window "$(xdotool getactivewindow)" "${filePath}"`, { timeout: 10000 });
      } else {
        execSync(`import -window root "${filePath}"`, { timeout: 10000 });
      }
      return;
    } catch {}
    try {
      execSync(`scrot ${windowFlag ? '-u ' : ''}"${filePath}"`, { timeout: 10000 });
      return;
    } catch {}
    execSync(`gnome-screenshot ${windowFlag ? '-w ' : ''}-f "${filePath}"`, { timeout: 10000 });
  }

  private listScreenshots(): ToolResult {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      return { success: true, output: 'No hay capturas guardadas.' };
    }

    const files = fs.readdirSync(SCREENSHOTS_DIR)
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
      .sort()
      .reverse();

    if (files.length === 0) {
      return { success: true, output: 'No hay capturas guardadas.' };
    }

    const lines = files.slice(0, 20).map(f => {
      const stat = fs.statSync(path.join(SCREENSHOTS_DIR, f));
      const sizeKB = (stat.size / 1024).toFixed(1);
      const date = stat.mtime.toISOString().slice(0, 19).replace('T', ' ');
      return `  ${f} — ${sizeKB}KB — ${date}`;
    });

    return {
      success: true,
      output: `Capturas guardadas (${files.length}):\n${lines.join('\n')}`,
    };
  }
}
