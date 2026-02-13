// ═══════════════════════════════════════
// ATLAS — Skill: Screenshot
// Desktop/window capture using native OS commands
// ═══════════════════════════════════════

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Tool, ToolResult } from '../../../types';

export class ScreenshotTool implements Tool {
  private screenshotDir: string;

  definition = {
    name: 'screenshot',
    description:
      'Tomar captura de pantalla del escritorio o ventana activa. ' +
      'Usar cuando digan "screenshot", "captura de pantalla", "mostrame qué hay en pantalla".',
    input_schema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          enum: ['desktop', 'active_window'],
          description: 'desktop=pantalla completa, active_window=ventana activa. Default: desktop',
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo (sin extensión). Default: screenshot_[timestamp]',
        },
      },
      required: [],
    },
    dangerous: false,
  };

  constructor() {
    this.screenshotDir = path.join(process.cwd(), 'data', 'screenshots');
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const target = (params.target as string) || 'desktop';
    const filename = (params.filename as string) || `screenshot_${Date.now()}`;
    const filepath = path.join(this.screenshotDir, `${filename}.png`);

    try {
      if (process.platform === 'win32') {
        return this.captureWindows(filepath, target);
      } else if (process.platform === 'darwin') {
        return this.captureMac(filepath, target);
      } else {
        return this.captureLinux(filepath, target);
      }
    } catch (err: any) {
      return { success: false, output: '', error: `Screenshot error: ${err.message}` };
    }
  }

  private captureWindows(filepath: string, target: string): ToolResult {
    // PowerShell screenshot using .NET
    const escapedPath = filepath.replace(/\\/g, '\\\\');

    if (target === 'active_window') {
      // Capture active window
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen
        $bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
        $bitmap.Save('${escapedPath}')
        $graphics.Dispose()
        $bitmap.Dispose()
      `.replace(/\n/g, '; ');
      execSync(`powershell -command "${ps}"`, { timeout: 10000 });
    } else {
      // Full desktop
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $screens = [System.Windows.Forms.Screen]::AllScreens
        $top = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
        $left = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
        $right = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
        $bottom = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
        $width = $right - $left
        $height = $bottom - $top
        $bitmap = New-Object System.Drawing.Bitmap($width, $height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
        $bitmap.Save('${escapedPath}')
        $graphics.Dispose()
        $bitmap.Dispose()
      `.replace(/\n/g, '; ');
      execSync(`powershell -command "${ps}"`, { timeout: 10000 });
    }

    const size = fs.statSync(filepath).size;
    return {
      success: true,
      output: `Screenshot guardado: ${filepath}\nTamaño: ${Math.round(size / 1024)} KB`,
    };
  }

  private captureMac(filepath: string, target: string): ToolResult {
    if (target === 'active_window') {
      execSync(`screencapture -w "${filepath}"`, { timeout: 10000 });
    } else {
      execSync(`screencapture -x "${filepath}"`, { timeout: 10000 });
    }

    const size = fs.statSync(filepath).size;
    return {
      success: true,
      output: `Screenshot guardado: ${filepath}\nTamaño: ${Math.round(size / 1024)} KB`,
    };
  }

  private captureLinux(filepath: string, target: string): ToolResult {
    // Try multiple tools
    const tools = ['gnome-screenshot', 'scrot', 'import'];

    for (const tool of tools) {
      try {
        if (tool === 'gnome-screenshot') {
          execSync(`gnome-screenshot ${target === 'active_window' ? '-w' : ''} -f "${filepath}"`, { timeout: 10000 });
        } else if (tool === 'scrot') {
          execSync(`scrot ${target === 'active_window' ? '-u' : ''} "${filepath}"`, { timeout: 10000 });
        } else if (tool === 'import') {
          execSync(`import ${target === 'active_window' ? '-window "$(xdotool getactivewindow)"' : '-window root'} "${filepath}"`, { timeout: 10000 });
        }

        const size = fs.statSync(filepath).size;
        return {
          success: true,
          output: `Screenshot guardado: ${filepath}\nTamaño: ${Math.round(size / 1024)} KB`,
        };
      } catch {
        continue;
      }
    }

    return { success: false, output: '', error: 'No se encontró herramienta de screenshot (gnome-screenshot, scrot, import).' };
  }
}
