<#
  Qoduck 桌面宠物本体（WPF）。

  为什么是 PowerShell 而不是 Electron：DSH 的 Cordis 宿主跑在 Electron 主进程
  spawn 出来的 ELECTRON_RUN_AS_NODE 子进程里（见外壳 lib/main.js 的
  desktopNodeEnvironment），那里没有任何窗口 API；DSH 也没有给插件暴露窗口服务。
  所以窗口只能自己带。WPF 原生支持逐像素 alpha 的透明窗口，且 Windows 自带，
  零依赖——这是成本最低的可行路线。

  窗口只做四件事：
    1. 从 frames/manifest.json 读动画表，按每帧真实时长推帧；
    2. 每 ~130ms 读一次 state.json（宿主写的相位），决定基础姿态；
    3. 处理拖拽 / 单击 / 双击 / 右键菜单；
    4. 位置与尺寸写回 window.json。

  内存：每个 spritesheet 按显示尺寸解码（DecodePixelWidth），并且只在用到时才
  加载；缓存只保留 idle 与当前动画两张，避免 12 张全解码（约 143 MB）。
#>
param(
    [Parameter(Mandatory = $true)][string]$PluginDir,
    [Parameter(Mandatory = $true)][string]$StateDir
)

$ErrorActionPreference = 'Stop'

# 必须在任何窗口创建之前声明 DPI 感知。否则 WPF 用逻辑坐标、屏幕用物理像素，
# 在 150% 缩放的显示器上窗口会被算到屏幕外（实测：逻辑 2344 → 物理 3516，不可见）。
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class QoduckDpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public static void Enable() {
        // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2（Win10 1703+）
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
        try { SetProcessDPIAware(); } catch {}
    }
}
"@
[QoduckDpi]::Enable()

# 双击桌宠 → 把 DSH 客户端主窗口调到前台。
# 它的标题是动态的（实测 "🤔 思考中… 0秒"），没法按标题匹配；按进程名 +
# 非零主窗口句柄定位（Electron 主窗口是 Chrome_WidgetWin_1）。
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class QoduckWin {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    public static bool Activate(IntPtr h) {
        if (h == IntPtr.Zero) return false;
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        // Windows 的前台锁会拒绝后台进程抢前台。先把当前前台线程 attach 到本线程
        // 再调用，成功率显著提高；失败再退回 BringWindowToTop。
        IntPtr fg = GetForegroundWindow();
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(fgThread, me, true);
        bool ok = SetForegroundWindow(h);
        if (!ok) { BringWindowToTop(h); ok = SetForegroundWindow(h); }
        if (attached) AttachThreadInput(fgThread, me, false);
        return ok;
    }
}
"@

function Show-DshClient {
    try {
        $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1
        if ($proc) { [void][QoduckWin]::Activate($proc.MainWindowHandle) }
    } catch {
        # 客户端不在（例如宿主被单独跑起来）时静默忽略
    }
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

$FramesDir = Join-Path $PluginDir 'frames'
$ManifestPath = Join-Path $FramesDir 'manifest.json'
$StatePath = Join-Path $StateDir 'state.json'
$WindowPath = Join-Path $StateDir 'window.json'
$ActivityPath = Join-Path $StateDir 'activity.json'

if (-not (Test-Path $ManifestPath)) { throw "缺少帧表：$ManifestPath" }
$Manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Cell = $Manifest._cell
$LookFrames = @($Manifest._lookFrames)

# ============================================================
# 状态文件
# ============================================================

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Write-JsonFile([string]$Path, $Object) {
    try {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $json = $Object | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# ============================================================
# 动画表与懒加载
# ============================================================

$AnimNames = @($Manifest.PSObject.Properties.Name | Where-Object { $_ -notlike '_*' })
$script:AnimationAlias = @{ interrupted = 'failed' }
$script:Sheets = @{}      # name -> BitmapSource（已按显示尺寸解码）
$script:FrameCache = @{}  # "name:index" -> CroppedBitmap

function Get-Animation([string]$Name) {
    # Qoduck 没有单独的中断动画；Qoder 原版也把 interrupted 映到 failed 姿态
    # （见其 phase 映射表）。语义差别体现在状态文案与状态灯上。
    if ($script:AnimationAlias.ContainsKey($Name)) { $Name = $script:AnimationAlias[$Name] }
    if ($AnimNames -contains $Name) { return $Manifest.$Name }
    return $Manifest.idle
}

function Get-Sheet([string]$Name, [int]$DisplayFrameWidth) {
    $key = "$Name@$DisplayFrameWidth"
    if ($script:Sheets.ContainsKey($key)) { return $script:Sheets[$key] }

    $anim = Get-Animation $Name
    $path = Join-Path $FramesDir $anim.file
    $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit()
    $bmp.UriSource = [Uri]::new($path)
    $bmp.CacheOption = 'OnLoad'
    # 按显示尺寸解码，而不是原图 256px——内存差 4 倍以上。
    $bmp.DecodePixelWidth = [int]($DisplayFrameWidth * $anim.cols)
    $bmp.EndInit()
    $bmp.Freeze()

    # 只保留 idle 与最近用到的动画，避免所有表常驻。
    if ($script:Sheets.Count -ge 3) {
        $drop = @($script:Sheets.Keys | Where-Object { $_ -notlike 'idle@*' -and $_ -ne $key })
        foreach ($k in $drop) { $script:Sheets.Remove($k) | Out-Null }
        foreach ($k in @($script:FrameCache.Keys | Where-Object { $_ -like ($drop -join '|') })) {
            $script:FrameCache.Remove($k) | Out-Null
        }
    }
    $script:Sheets[$key] = $bmp
    return $bmp
}

function Get-Frame([string]$Name, [int]$Index, [int]$DisplayFrameWidth) {
    $anim = Get-Animation $Name
    $count = [int]$anim.frames
    if ($count -le 0) { return $null }
    $i = (($Index % $count) + $count) % $count
    $key = "$Name@$DisplayFrameWidth#$i"
    if ($script:FrameCache.ContainsKey($key)) { return $script:FrameCache[$key] }

    $sheet = Get-Sheet $Name $DisplayFrameWidth
    # 单元格尺寸必须由**解码后的表**整除得出，不能按缩放比各自四舍五入：
    # DecodePixelWidth 会独立取整表高，两边分别 round 会让最后一行越界
    # （实测 11 行 x 208 = 2288 > 实际表高 2285），CroppedBitmap 直接抛
    # 「值不在预期的范围内」。整除保证 cols*cw <= 宽、rows*ch <= 高。
    $cols = [int]$anim.cols
    $rows = [int]$anim.rows
    $cw = [int][Math]::Floor($sheet.PixelWidth / $cols)
    $ch = [int][Math]::Floor($sheet.PixelHeight / $rows)
    if ($cw -le 0 -or $ch -le 0) { return $null }
    $col = $i % $cols
    $row = [int][Math]::Floor($i / $cols)

    $rect = New-Object System.Windows.Int32Rect ($col * $cw), ($row * $ch), $cw, $ch
    $cropped = New-Object System.Windows.Media.Imaging.CroppedBitmap $sheet, $rect
    $cropped.Freeze()
    if ($script:FrameCache.Count -gt 400) { $script:FrameCache.Clear() }
    $script:FrameCache[$key] = $cropped
    return $cropped
}

function Get-LookFrame([int]$Index, [int]$DisplayFrameWidth) {
    $i = (($Index % 16) + 16) % 16
    $key = "look@$DisplayFrameWidth#$i"
    if ($script:FrameCache.ContainsKey($key)) { return $script:FrameCache[$key] }
    $path = Join-Path $FramesDir $LookFrames[$i]
    $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit()
    $bmp.UriSource = [Uri]::new($path)
    $bmp.CacheOption = 'OnLoad'
    $bmp.DecodePixelWidth = $DisplayFrameWidth
    $bmp.EndInit()
    $bmp.Freeze()
    $script:FrameCache[$key] = $bmp
    return $bmp
}

# ============================================================
# 窗口
# ============================================================

$saved = Read-JsonFile $WindowPath
$initial = Read-JsonFile $StatePath

$script:SizePx = 128
if ($initial -and $initial.size) { $script:SizePx = [int]$initial.size }
elseif ($saved -and $saved.size) { $script:SizePx = [int]$saved.size }
if ($script:SizePx -lt 48) { $script:SizePx = 48 }
if ($script:SizePx -gt 384) { $script:SizePx = 384 }

$aspect = $Cell.height / $Cell.width
$script:WinW = [int][Math]::Round($script:SizePx)
$script:WinH = [int][Math]::Round($script:SizePx * $aspect)

# 坐标系：声明 DPI 感知后，WPF 的 Window.Left/Top/Width/Height 都是 DIP，
# 而 WinForms 的 Screen / Cursor 返回物理像素。两套混用会把窗口算到屏幕外
# （实测 150% 缩放下 3840 物理宽被当成 3840 DIP，实际落到 5760）。
# 这里统一以 DIP 为内部单位，只在读光标时做一次换算。
$physicalWidth = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
$dipWidth = [System.Windows.SystemParameters]::PrimaryScreenWidth
$script:DpiScale = if ($dipWidth -gt 0) { $physicalWidth / $dipWidth } else { 1.0 }
if ($script:DpiScale -le 0) { $script:DpiScale = 1.0 }

function ConvertTo-Dip([double]$PhysicalPixels) { return $PhysicalPixels / $script:DpiScale }

$work = [System.Windows.SystemParameters]::WorkArea   # 已经是 DIP

$script:Left = $work.Right - $script:WinW - 24
$script:Top = $work.Bottom - $script:WinH - 24
if ($saved -and $null -ne $saved.left -and $null -ne $saved.top) {
    $script:Left = [double]$saved.left
    $script:Top = [double]$saved.top
}

$image = New-Object System.Windows.Controls.Image
$image.Stretch = 'Fill'
$image.SnapsToDevicePixels = $true
[System.Windows.Media.RenderOptions]::SetBitmapScalingMode($image, [System.Windows.Media.BitmapScalingMode]::HighQuality)
$image.HorizontalAlignment = 'Center'
$image.VerticalAlignment = 'Bottom'
# 必须显式给宽高：窗口现在还要装卡片，比宠物大；不给的话图片会被拉去填满整窗，
# 宠物就被压扁了。
$image.Width = $script:WinW
$image.Height = $script:WinH

# ---- 活动卡片 ----
# 卡片画在这个独立窗口里，读不到 DSH Web 的主题 token（那是浏览器里的 CSS 变量），
# 所以用一套自带配色，跟随桌面而不是跟随网页主题。
$script:CardWidth = 300.0
# 投影要占地方：Border 外面必须留出 Margin，否则 DropShadowEffect 会被窗口/popup 裁掉。
$script:ShadowMargin = 18.0

$CardXaml = @'
<Border xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Margin="18" CornerRadius="12" Background="#F21C1C1E" BorderThickness="0"
        Padding="14,12,12,12" HorizontalAlignment="Center" VerticalAlignment="Top">
  <Border.Effect>
    <DropShadowEffect BlurRadius="16" ShadowDepth="4" Direction="270" Opacity="0.45" Color="#000000"/>
  </Border.Effect>
  <Border.Resources>
    <!-- 圆角方形图标按钮：WPF 默认 Button 模板是系统方角 chrome，必须自己给模板 -->
    <Style x:Key="IconButton" TargetType="Button">
      <Setter Property="Width" Value="28"/>
      <Setter Property="Height" Value="28"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Background" Value="#26FFFFFF"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Bd" CornerRadius="8" Background="{TemplateBinding Background}"
                    SnapsToDevicePixels="True">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Bd" Property="Opacity" Value="0.78"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Bd" Property="Opacity" Value="0.6"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- DSH 原生图标：16x16 viewBox，stroke=currentColor。
         由 scripts/gen-icon-xaml.py 从 assets/icons/native-icons.json 转写，**别手改**。
         分描边/填充两组的原因：WPF 一个 Path 只有一组 Fill/Stroke，而原生 artwork 里
         既有纯描边的开放折线（一旦被填充会糊成实心块，如 commands 的 `M3 4L7 8L3 12`），
         也有「既填充又描边」的闭合环（如 read 的双线方框）。所以拆成两个 Path 叠加。
         坐标是 SVG 原值（M/C/L/H/V/Z 在 WPF 迷你语言里语法一致；本次不含 A 圆弧，
         若以后出现 A，WPF 与 SVG 的参数格式不同，必须人工逐条转换）。 -->
    <Geometry x:Key="Icon.thinking">
      M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z
      M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z
    </Geometry>
    <Geometry x:Key="IconFill.thinking">
      M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z
    </Geometry>
    <Geometry x:Key="Icon.read">
      M4.9375 5.90295H11.0625
      M4.9375 9.02991H8.27841
    </Geometry>
    <Geometry x:Key="IconFill.read">
      M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z
    </Geometry>
    <Geometry x:Key="Icon.readImage">
      M4.9375 5.90295H11.0625
      M4.9375 9.02991H8.27841
    </Geometry>
    <Geometry x:Key="IconFill.readImage">
      M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z
    </Geometry>
    <Geometry x:Key="Icon.search">
      M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z
      M10.2991 10.3933L14.7783 14.8725
    </Geometry>
    <Geometry x:Key="Icon.edit">
      M7.7849 8.23878L13.888 2.13574
    </Geometry>
    <Geometry x:Key="IconFill.edit">
      M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z
    </Geometry>
    <Geometry x:Key="Icon.write">
      M7.7849 8.23878L13.888 2.13574
    </Geometry>
    <Geometry x:Key="IconFill.write">
      M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z
    </Geometry>
    <Geometry x:Key="Icon.commands">
      M3 4L7 8L3 12
      M9 12H13
    </Geometry>
    <Geometry x:Key="Icon.code">
      M6.27612 1.5L4.52612 14.5
      M11.4739 1.5L9.72388 14.5
      M2.39868 5.5H14.0681
      M1.93188 10.5H13.6013
    </Geometry>
    <Geometry x:Key="Icon.webSearch">
      M7.99986 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 7.99986 1.91125C4.63715 1.91125 1.91113 4.63727 1.91113 7.99998C1.91113 11.3627 4.63715 14.0887 7.99986 14.0887Z
      M2.34619 8H13.6538
      M7.99976 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 7.99976 1.91138
      M7.99973 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 7.99973 1.91138
    </Geometry>
    <Geometry x:Key="Icon.webFetch">
      M4.9375 5.90295H11.0625
      M4.9375 9.02991H8.27841
    </Geometry>
    <Geometry x:Key="IconFill.webFetch">
      M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z
    </Geometry>
    <Geometry x:Key="Icon.subagents">
      M7.99136 5.28105C8.87501 5.28105 9.59136 4.56471 9.59136 3.68105C9.59136 2.7974 8.87501 2.08105 7.99136 2.08105C7.1077 2.08105 6.39136 2.7974 6.39136 3.68105C6.39136 4.56471 7.1077 5.28105 7.99136 5.28105Z
      M3.94009 12.9417C4.82374 12.9417 5.54009 12.2254 5.54009 11.3417C5.54009 10.458 4.82374 9.7417 3.94009 9.7417C3.05643 9.7417 2.34009 10.458 2.34009 11.3417C2.34009 12.2254 3.05643 12.9417 3.94009 12.9417Z
      M12.0851 12.9417C12.9688 12.9417 13.6851 12.2254 13.6851 11.3417C13.6851 10.458 12.9688 9.7417 12.0851 9.7417C11.2015 9.7417 10.4851 10.458 10.4851 11.3417C10.4851 12.2254 11.2015 12.9417 12.0851 12.9417Z
    </Geometry>
    <Geometry x:Key="IconFill.subagents">
      M6.51867 12.3282C7.29816 12.6011 8.16475 12.6514 9.02269 12.4216C9.57879 12.2726 10.0784 12.0185 10.5087 11.6888C10.7819 12.0555 11.1606 12.3304 11.5913 12.4805C10.9688 13.029 10.2149 13.4478 9.35911 13.6771C8.13946 14.0038 6.90632 13.8971 5.82126 13.4533C6.15821 13.1562 6.4021 12.7652 6.51867 12.3282ZM9.17629 2.89409C11.1101 3.34433 12.739 4.81872 13.2889 6.87043C13.4219 7.3665 13.4811 7.8649 13.4774 8.35466C13.0924 8.13213 12.6422 8.01837 12.1741 8.05276L12.1711 8.05257C12.1539 7.77199 12.109 7.48889 12.0334 7.20684C11.6363 5.72533 10.5048 4.6372 9.13549 4.22844C9.25559 3.87667 9.29214 3.49087 9.22309 3.09892C9.2108 3.02922 9.19451 2.96108 9.17629 2.89409ZM4.7311 3.89107L4.78302 4.11879C4.87648 4.4488 5.04146 4.74263 5.25579 4.98896C3.98078 6.01355 3.35848 7.72904 3.8089 9.41059C3.81828 9.44559 3.82866 9.48025 3.83885 9.51479C3.38217 9.61268 2.98548 9.84137 2.68107 10.1556C2.63414 10.022 2.5897 9.88632 2.55244 9.74726C1.93301 7.43489 2.86717 5.07173 4.71504 3.76697L4.7311 3.89107Z
    </Geometry>
    <Geometry x:Key="Icon.plan">
      M4.9375 5.90295H11.0625
      M4.9375 9.02991H8.27841
    </Geometry>
    <Geometry x:Key="IconFill.plan">
      M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z
      M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z
      M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z
    </Geometry>
    <Geometry x:Key="Icon.questions">
      M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z
      M5.75 6.69646C5.75 6.29865 5.88196 5.90976 6.12919 5.57899C6.37643 5.24821 6.72783 4.99041 7.13896 4.83817C7.5501 4.68593 8.0025 4.6461 8.43895 4.72371C8.87541 4.80132 9.27632 4.99289 9.59099 5.27419C9.90566 5.55549 10.12 5.91388 10.2068 6.30406C10.2936 6.69423 10.249 7.09866 10.0787 7.4662C9.90843 7.83373 9.62004 8.14787 9.25003 8.36889C9.19476 8.4019 9.13803 8.43262 9.08004 8.46099C8.52566 8.73217 8 9.20817 8 9.82532
      M8 10.7416V11.7416
    </Geometry>
    <Geometry x:Key="Icon.tools">
      M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z
      M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z
      M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z
    </Geometry>
  </Border.Resources>
  <StackPanel>
    <!-- 三列两行：图标列 / 文字列 / 按钮列。
         图标在图标列里居中，两行文字在各自容器里左对齐。
         用 Grid 而不是 StackPanel——后者的子元素拿无限宽度，宽度判断与裁剪都无从下手。 -->
    <Grid>
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="Auto"/>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <!-- 图标列里居中对齐：蓝点 8px、活动图标 16px，都居中才落在同一条竖线上。
           文字在各自的列里左对齐，放不下就省略号。 -->
      <Ellipse x:Name="StatusDot" Grid.Row="0" Grid.Column="0" Width="8" Height="8"
               Fill="#4C8DFF" HorizontalAlignment="Center" VerticalAlignment="Center"/>
      <TextBlock x:Name="TitleText" Grid.Row="0" Grid.Column="1" Margin="9,0,10,0" FontSize="13"
                 Foreground="#F2F2F2" TextTrimming="CharacterEllipsis" TextWrapping="NoWrap"
                 VerticalAlignment="Center"/>

      <!-- 原生图标是 16x16 viewBox，Stretch="None" 下给 16x16 才不会被裁掉边缘。
           拆两个 Path：DetailIcon 画纯描边的开放折线，DetailIconFill 画既填充又描边的闭合块
           （单个 Path 只有一组 Fill/Stroke，无法两者兼得，详见上面资源区的注释）。
           两者必须精确重叠，所以都放同一格且不占边距。 -->
      <Grid Grid.Row="1" Grid.Column="0" Margin="0,7,0,0" HorizontalAlignment="Center"
            VerticalAlignment="Center">
        <Path x:Name="DetailIcon" Width="14" Height="14" Visibility="Collapsed"
              Stroke="#9A9A9E" StrokeThickness="1.35" StrokeStartLineCap="Round"
              StrokeEndLineCap="Round" StrokeLineJoin="Round" Stretch="None"
              HorizontalAlignment="Center" VerticalAlignment="Center"/>
        <Path x:Name="DetailIconFill" Width="14" Height="14" Visibility="Collapsed"
              Stroke="#9A9A9E" StrokeThickness="1.35" StrokeStartLineCap="Round"
              StrokeEndLineCap="Round" StrokeLineJoin="Round" Stretch="None"
              HorizontalAlignment="Center" VerticalAlignment="Center"/>
      </Grid>
      <TextBlock x:Name="DetailText" Grid.Row="1" Grid.Column="1" Margin="9,7,10,0" FontSize="11"
                 Foreground="#9A9A9E" TextTrimming="CharacterEllipsis" TextWrapping="NoWrap"
                 VerticalAlignment="Center"/>

      <StackPanel Grid.Row="0" Grid.Column="2" Grid.RowSpan="2" Orientation="Horizontal"
                  VerticalAlignment="Top">
        <Button x:Name="ToggleButton" Style="{StaticResource IconButton}" ToolTip="展开 / 收起回复框">
          <Path x:Name="ToggleGlyph" Stroke="#E8E8E8" StrokeThickness="1.6" StrokeStartLineCap="Round"
                StrokeEndLineCap="Round" StrokeLineJoin="Round"
                Data="M 0,0 L 4.5,4.5 L 9,0" RenderTransformOrigin="0.5,0.5"/>
        </Button>
        <!-- 这一个按钮承担四种含义：跑着是「停止」，需要你选择是「问号」，
             完成未读是「对号」，已读是「暂停」。图形的可见性由 Set-CardStateIcon 切换。 -->
        <Button x:Name="StopButton" Style="{StaticResource IconButton}" Margin="8,0,0,0"
                Background="#E5534B" ToolTip="停止任务">
          <Grid>
            <Rectangle x:Name="StopGlyph" Width="9" Height="9" RadiusX="2" RadiusY="2" Fill="#FFFFFF"/>
            <Path x:Name="SelectGlyph" Width="13" Height="13" Visibility="Collapsed"
                  Stroke="#FFFFFF" StrokeThickness="1.8" StrokeStartLineCap="Round"
                  StrokeEndLineCap="Round" StrokeLineJoin="Round" Stretch="None"
                  Data="M 3.9,4.8 A 2.6,2.6 0 1 1 6.5,7.4 L 6.5,9.4 M 6.5,10.9 L 6.5,11.05"/>
            <Path x:Name="DoneGlyph" Width="13" Height="13" Visibility="Collapsed"
                  Stroke="#FFFFFF" StrokeThickness="1.8" StrokeStartLineCap="Round"
                  StrokeEndLineCap="Round" StrokeLineJoin="Round" Stretch="None"
                  Data="M 1.5,7 L 5,10.5 L 11.5,3"/>
            <Path x:Name="ReadGlyph" Width="13" Height="13" Visibility="Collapsed"
                  Stroke="#FFFFFF" StrokeThickness="1.8" StrokeStartLineCap="Round"
                  StrokeEndLineCap="Round" Stretch="None"
                  Data="M 4,2 L 4,11 M 9,2 L 9,11"/>
          </Grid>
        </Button>
      </StackPanel>
    </Grid>
    <!-- 回复框：一个圆角容器，输入与发送键都在里面 -->
    <Border x:Name="ReplyRow" Margin="0,11,0,0" Height="34" CornerRadius="9"
            Background="#14FFFFFF" BorderBrush="#33FFFFFF" BorderThickness="1"
            Padding="10,0,3,0" Visibility="Collapsed">
      <DockPanel>
        <Button x:Name="SendButton" DockPanel.Dock="Right" Style="{StaticResource IconButton}"
                Width="26" Height="26" Margin="6,0,0,0" Background="Transparent"
                VerticalAlignment="Center" ToolTip="发送回复">
          <Path x:Name="SendGlyph" Stroke="#E8E8E8" StrokeThickness="1.6" StrokeStartLineCap="Round"
                StrokeEndLineCap="Round" StrokeLineJoin="Round"
                Data="M 5,11 L 5,1 M 1,5 L 5,1 L 9,5"/>
        </Button>
        <Grid>
          <TextBox x:Name="ReplyBox" FontSize="12" Background="Transparent" BorderThickness="0"
                   Foreground="#F2F2F2" CaretBrush="#F2F2F2" VerticalContentAlignment="Center"/>
          <TextBlock x:Name="ReplyPlaceholder" Text="回复当前任务" FontSize="12"
                     Foreground="#6E6E73" VerticalAlignment="Center" IsHitTestVisible="False"/>
        </Grid>
      </DockPanel>
    </Border>
  </StackPanel>
</Border>
'@

$card = [System.Windows.Markup.XamlReader]::Parse($CardXaml)
$card.Visibility = 'Collapsed'
$card.Width = $script:CardWidth
$cardTitle = $card.FindName('TitleText')
$cardDetail = $card.FindName('DetailText')
$cardDot = $card.FindName('StatusDot')
$cardStop = $card.FindName('StopButton')
$cardToggle = $card.FindName('ToggleButton')
$cardReplyRow = $card.FindName('ReplyRow')
$cardReplyBox = $card.FindName('ReplyBox')
$cardPlaceholder = $card.FindName('ReplyPlaceholder')
$cardSend = $card.FindName('SendButton')
$cardToggleGlyph = $card.FindName('ToggleGlyph')
$cardSendGlyph = $card.FindName('SendGlyph')
$cardDetailIcon = $card.FindName('DetailIcon')
$cardDetailIconFill = $card.FindName('DetailIconFill')
$cardStopGlyph = $card.FindName('StopGlyph')
$cardSelectGlyph = $card.FindName('SelectGlyph')
$cardDoneGlyph = $card.FindName('DoneGlyph')
$cardReadGlyph = $card.FindName('ReadGlyph')

# activity.js 的 PROCESS_ICONS 导出的是**旧图标名**（think/browse/api/globe/...），那是
# 客户端 artwork 组件的叫法。这里改用 DSH 原生 16x16 artwork，资源键按**类别名**命名，
# 所以先把旧名归一。归一而不是让宿主改导出：这样宿主侧的行为契约（isSessionEvent、
# snapshot.icon）不用动，且 read/readImage/webFetch 三者的 artwork 本来就是同一个
# BrowseOutlineArtwork、edit/write 同为 IconEditOutlineArtwork，映射不丢任何视觉信息。
$script:IconAlias = @{
    think    = 'thinking'
    browse   = 'read'
    search   = 'search'
    edit     = 'edit'
    api      = 'commands'
    code     = 'code'
    globe    = 'webSearch'
    agent    = 'subagents'
    plan     = 'plan'
    question = 'questions'
    sparkle  = 'tools'
}

# 类别 → XAML 资源键。描边组与填充组分开，因为 WPF 一个 Path 只能有一组 Fill/Stroke，
# 而原生 artwork 里两者混用（见资源区注释）。没有填充组的类别（commands/code/search/
# questions/tools/webSearch）就是纯线稿。由 scripts/gen-icon-xaml.py 生成，别手改。
$script:IconStrokeKeys = @{
    thinking  = 'Icon.thinking'
    read      = 'Icon.read'
    readImage = 'Icon.readImage'
    search    = 'Icon.search'
    edit      = 'Icon.edit'
    write     = 'Icon.write'
    commands  = 'Icon.commands'
    code      = 'Icon.code'
    webSearch = 'Icon.webSearch'
    webFetch  = 'Icon.webFetch'
    subagents = 'Icon.subagents'
    plan      = 'Icon.plan'
    questions = 'Icon.questions'
    tools     = 'Icon.tools'
}
$script:IconFillKeys = @{
    thinking  = 'IconFill.thinking'
    read      = 'IconFill.read'
    readImage = 'IconFill.readImage'
    edit      = 'IconFill.edit'
    write     = 'IconFill.write'
    webFetch  = 'IconFill.webFetch'
    subagents = 'IconFill.subagents'
    plan      = 'IconFill.plan'
}

function Set-DetailIcon([string]$Icon) {
    if (-not $Icon) { Set-DetailIconGeometry $null $null; return }
    # 先按类别名查，查不到再按旧图标名归一。两边都要支持：类别名是 activity.js 内部用的键，
    # 旧名是它导出给外部（含这里）的值。
    $cat = if ($script:IconStrokeKeys.ContainsKey($Icon) -or $script:IconFillKeys.ContainsKey($Icon)) {
        $Icon
    } elseif ($script:IconAlias.ContainsKey($Icon)) {
        $script:IconAlias[$Icon]
    } else {
        $null
    }
    $strokeKey = if ($cat -and $script:IconStrokeKeys.ContainsKey($cat)) { $script:IconStrokeKeys[$cat] } else { $null }
    $fillKey = if ($cat -and $script:IconFillKeys.ContainsKey($cat)) { $script:IconFillKeys[$cat] } else { $null }
    Set-DetailIconGeometry $strokeKey $fillKey
}

function Set-DetailIconGeometry($StrokeKey, $FillKey) {
    if (-not $StrokeKey -and -not $FillKey) {
        $cardDetailIcon.Visibility = 'Collapsed'
        $cardDetailIconFill.Visibility = 'Collapsed'
        return
    }
    try {
        if ($StrokeKey) {
            $cardDetailIcon.Data = $card.Resources[$StrokeKey]
            $cardDetailIcon.Visibility = 'Visible'
        } else {
            $cardDetailIcon.Data = $null
            $cardDetailIcon.Visibility = 'Collapsed'
        }
        if ($FillKey) {
            # 填充组在原 SVG 里同时带 stroke=currentColor（描一遍轮廓），所以要设 Fill 也要保留
            # Apply-Theme 设的 Stroke；纯填充不加描边会显得比线稿细一圈。
            $cardDetailIconFill.Data = $card.Resources[$FillKey]
            $cardDetailIconFill.Visibility = 'Visible'
        } else {
            $cardDetailIconFill.Data = $null
            $cardDetailIconFill.Visibility = 'Collapsed'
        }
    } catch {
        # 取不到资源不该让整张卡片更新失败——收起图标，文字照常显示
        $cardDetailIcon.Visibility = 'Collapsed'
        $cardDetailIconFill.Visibility = 'Collapsed'
    }
}

# 右侧按钮承担四种含义：跑着 = 红色停止、等你选择 = 蓝色问号、完成未读 = 绿色对号、已读过 = 暂停。
# 前三者是状态指示，用语义色；「已读过」的暂停不是状态告警，它和旁边的回复按钮
# 一样是个中性控件图标，所以底色跟按钮一致（$p.btnBg），不要再叠一层灰。
$script:StateStopColor = '#E5534B'
$script:StateSelectColor = '#4C8DFF'
$script:StateDoneColor = '#3FB950'

# 提示音。素材放在插件自己的 assets 下（引用 $PluginDir，不引用任何临时下载目录），
# 由宿主侧读不到也无所谓——只有这个窗口进程自己播。
$script:NotifySoundPath = Join-Path $PluginDir (Join-Path 'assets' 'notify.mp3')
# MediaPlayer 支持 mp3（SoundPlayer 只吃 wav）。复用同一个实例：每次 new 会累积
# 对象且不释放文件句柄，播完停在 Close() 上等下一次 Open()。
$script:NotifyPlayer = $null

function Play-NotifySound {
    if (-not $script:NotifySoundPath -or -not (Test-Path -LiteralPath $script:NotifySoundPath)) { return }
    try {
        if (-not $script:NotifyPlayer) { $script:NotifyPlayer = New-Object System.Windows.Media.MediaPlayer }
        $script:NotifyPlayer.Stop()
        $script:NotifyPlayer.Close()
        $script:NotifyPlayer.Open([Uri]$script:NotifySoundPath)
        $script:NotifyPlayer.Play()
    } catch {
        # 缺 Windows Media 组件（如 N/KN 版）或文件损坏都不该打断卡片刷新
    }
}

# 上一次的按钮状态。这个函数每 250ms 被 Update-Card 调一次，不记上一次的话
# 「等你选择 / 已完成」会每帧重播一次提示音。
$script:CardState = ''

function Set-CardStateIcon([string]$State) {
    $cardStopGlyph.Visibility = if ($State -eq 'running') { 'Visible' } else { 'Collapsed' }
    $cardSelectGlyph.Visibility = if ($State -eq 'blue') { 'Visible' } else { 'Collapsed' }
    $cardDoneGlyph.Visibility = if ($State -eq 'done') { 'Visible' } else { 'Collapsed' }
    $cardReadGlyph.Visibility = if ($State -eq 'read') { 'Visible' } else { 'Collapsed' }

    $color = switch ($State) {
        'running' { $script:StateStopColor }
        # 蓝 = 需要你的选择（宿主的 waiting：在等你点确认或回答问题）。
        # 不用状态点那个橙 #E8A33D——橙在这里已经被「已中断」占用，且橙偏告警；
        # 蓝色是这个尺寸下最中性的「该你操作了」。图形用问号：它比感叹号更准确地
        # 表达「等你决定」，感叹号在 13x13 里也容易和别的告警图标混。
        'blue' { $script:StateSelectColor }
        'done' { $script:StateDoneColor }
        # 已读过：底色跟旁边的回复按钮一致，图形描边走按钮前景色，
        # 这样它看起来是「同一个控件族」，而不是又一个状态告警。
        default {
            if ($script:Palette) { $script:Palette.btnBg } else { '#26FFFFFF' }
        }
    }
    $cardStop.Background = Resolve-Brush $color
    if ($State -ne 'running' -and $State -ne 'done' -and $State -ne 'blue') {
        # 暂停图形本来是白描边（配灰底），底换成按钮底色后描边要跟着换前景色才看得见
        $tint = if ($script:Palette) { $script:Palette.btnFg } else { '#E8E8E8' }
        $cardReadGlyph.Stroke = Resolve-Brush $tint
    }
    # 只有「跑着」时它才是按钮；另三种形态是状态指示，别让点击落空
    $cardStop.IsEnabled = ($State -eq 'running')
    $cardStop.ToolTip = switch ($State) {
        'running' { '停止任务' }
        'blue' { '需要你的选择' }
        'done' { '本轮已完成，双击宠物打开客户端' }
        default { '已查看' }
    }

    # 提示音只在真正跨状态时响一声。$script:CardState 为空表示这是首次上色（启动时
    # Apply-Theme 的那一次），不该凭空响。
    $prev = $script:CardState
    $script:CardState = $State
    if ($prev -and $prev -ne $State -and ($State -eq 'blue' -or $State -eq 'done')) {
        Play-NotifySound
    }
}

# ---- 跟随桌面的亮 / 暗模式 ----
# Windows 把「应用」的亮暗存在这个注册表值里：0 = 暗，1 = 亮。
# 桌面部件没有 DSH Web 的主题 token 可读，这个值就是唯一可靠的来源。
function Get-SystemIsLight {
    try {
        $value = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' `
            -Name 'AppsUseLightTheme' -ErrorAction Stop
        return ([int]$value -eq 1)
    } catch {
        return $false
    }
}

function Get-Palette([bool]$Light) {
    if ($Light) {
        return @{
            cardBg        = '#FAFFFFFF'
            title         = '#1C1C1E'
            detail        = '#6A6A6E'
            btnBg         = '#12000000'
            btnFg         = '#1C1C1E'
            boxBg         = '#0A000000'
            boxBorder     = '#24000000'
            boxFg         = '#1C1C1E'
            placeholder   = '#9A9A9E'
            menuBg        = '#FAFFFFFF'
            menuFg        = '#1C1C1E'
            menuHover     = '#E6E6E6'
            shadowColor   = '#000000'
            shadowOpacity = 0.22
        }
    }
    return @{
        cardBg        = '#F21C1C1E'
        title         = '#F2F2F2'
        detail        = '#9A9A9E'
        btnBg         = '#26FFFFFF'
        btnFg         = '#E8E8E8'
        boxBg         = '#14FFFFFF'
        boxBorder     = '#33FFFFFF'
        boxFg         = '#F2F2F2'
        placeholder   = '#6E6E73'
        menuBg        = '#F21C1C1E'
        menuFg        = '#F2F2F2'
        menuHover     = '#2E2E32'
        shadowColor   = '#000000'
        shadowOpacity = 0.5
    }
}

$script:IsLight = Get-SystemIsLight

# 右键菜单整体由 XAML 生成：WPF 默认的 ContextMenu 模板用的是系统 chrome，
# 只设 Background 会露出白色底和方角——必须自己给 ContextMenu.Template。
# 高亮触发器在模板里，配色改不了，所以换主题时整棵菜单重建。
function New-PetMenu {
    $p = Get-Palette $script:IsLight
    $xaml = @"
<ContextMenu xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             HasDropShadow="False" Padding="0">
  <ContextMenu.Template>
    <ControlTemplate TargetType="ContextMenu">
      <Border Margin="16" CornerRadius="10" Background="$($p.menuBg)"
              BorderThickness="0" Padding="4" SnapsToDevicePixels="True">
        <Border.Effect>
          <DropShadowEffect BlurRadius="16" ShadowDepth="4" Direction="270"
                            Opacity="$($p.shadowOpacity)" Color="$($p.shadowColor)"/>
        </Border.Effect>
        <ItemsPresenter/>
      </Border>
    </ControlTemplate>
  </ContextMenu.Template>
  <ContextMenu.ItemContainerStyle>
    <Style TargetType="MenuItem">
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Foreground" Value="$($p.menuFg)"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="MenuItem">
            <Border x:Name="Bd" Background="Transparent" CornerRadius="6" Padding="14,7">
              <ContentPresenter ContentSource="Header"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsHighlighted" Value="True">
                <Setter TargetName="Bd" Property="Background" Value="$($p.menuHover)"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </ContextMenu.ItemContainerStyle>
  <MenuItem x:Name="ClosePetItem" Header="关闭宠物"/>
</ContextMenu>
"@
    $built = [System.Windows.Markup.XamlReader]::Parse($xaml)
    $item = $built.FindName('ClosePetItem')
    $item.Add_Click({ Send-PetAction 'close' })
    return $built
}

function Apply-Theme {
    $p = Get-Palette $script:IsLight
    # 缓存当前调色板：四态按钮在换主题后要按新色重刷一次
    $script:Palette = $p
    $card.Background = Resolve-Brush $p.cardBg
    $cardTitle.Foreground = Resolve-Brush $p.title
    $cardDetail.Foreground = Resolve-Brush $p.detail
    $cardReplyRow.Background = Resolve-Brush $p.boxBg
    $cardReplyRow.BorderBrush = Resolve-Brush $p.boxBorder
    $cardReplyBox.Foreground = Resolve-Brush $p.boxFg
    $cardReplyBox.CaretBrush = Resolve-Brush $p.boxFg
    if ($cardPlaceholder) { $cardPlaceholder.Foreground = Resolve-Brush $p.placeholder }
    # 图标是矢量 Path，颜色走 Stroke（不是 Foreground）
    if ($cardToggleGlyph) { $cardToggleGlyph.Stroke = Resolve-Brush $p.btnFg }
    if ($cardSendGlyph) { $cardSendGlyph.Stroke = Resolve-Brush $p.btnFg }
    if ($cardDetailIcon) { $cardDetailIcon.Stroke = Resolve-Brush $p.detail }
    # 填充组要用同一个颜色：既填实心块、也描轮廓，否则两组会出双色。
    if ($cardDetailIconFill) {
        $cardDetailIconFill.Stroke = Resolve-Brush $p.detail
        $cardDetailIconFill.Fill = Resolve-Brush $p.detail
    }
    $cardToggle.Background = Resolve-Brush $p.btnBg
    # 右侧按钮的颜色由四态决定（红停止 / 蓝待选择 / 绿对号 / 灰暂停），这里不能覆盖；
    # 换主题后按当前状态重刷一次即可。重刷是同状态，不会触发提示音。
    if ($script:CardState) { Set-CardStateIcon $script:CardState }
    else { Set-CardStateIcon 'done' }
    $cardSend.Background = Resolve-Brush '#00000000'
    $cardShadow = $card.Effect
    if ($cardShadow) {
        $cardShadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($p.shadowColor)
        $cardShadow.Opacity = [double]$p.shadowOpacity
    }
    $script:Menu = New-PetMenu
    $root.ContextMenu = $script:Menu
}

$root = New-Object System.Windows.Controls.Grid
$root.Background = [System.Windows.Media.Brushes]::Transparent
$null = $root.Children.Add($image)
$null = $root.Children.Add($card)

$window = New-Object System.Windows.Window
$window.Title = 'Qoduck'
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ResizeMode = 'NoResize'
$window.WindowStartupLocation = 'Manual'
# 桌宠不该抢焦点：Show() 时不激活，用户正在打字的窗口不会被顶掉。
# ShowInTaskbar=false 由 WPF 用一个隐藏 owner 窗口实现，任务栏里不会出现条目。
$window.ShowActivated = $false
$window.Left = $script:Left
$window.Top = $script:Top
$window.Width = $script:WinW
$window.Height = $script:WinH
$window.Content = $root

# ============================================================
# 运行时状态
# ============================================================

$script:Phase = 'idle'
$script:OneShot = $null
$script:OneShotUntil = [DateTime]::MinValue
$script:DragDir = $null
$script:LookIndex = -1
$script:MouseTracking = $true
$script:Enabled = $true
$script:FrameIndex = 0
$script:FrameAccum = 0.0
$script:LastTick = [DateTime]::UtcNow
$script:PollAccum = 0.0
$script:Dragging = $false
$script:DragOrigin = $null
$script:DragMoved = $false
$script:LastClickAt = [DateTime]::MinValue
$script:SuppressMove = $false
$script:DebugTick = 0
# idle 停留时长；够久就换眨眼变体
$script:IdleMs = 0.0
$script:IdleEyeAfterMs = 2.0 * [double](Get-Animation 'idle').totalMs
# 闲置多久之后「睡着」：10 分钟。waiting 素材本来画的就是闭眼睡觉 + ZZZ，
# 用它表示长时间没事干才对（放在「等你选择」上语义是反的，见 Resolve-Animation）。
# 睡着后只有鼠标交互（悬停/拖拽/移动）才会醒，并清零重新计时。
$script:IdleSleepAfterMs = 10.0 * 60.0 * 1000.0
# 是否睡着。睡着时卡片淡出，鼠标一动就醒并重新计时。
$script:Sleeping = $false
# 卡片因睡眠而淡出的目标透明度；实际值逐帧趋近，做出淡入淡出。
$script:CardFadeTarget = 1.0
$script:CardFade = 1.0
$script:CardFadeSpeed = 3.2   # 每秒变化量，约 0.3s 走完全程
# 注视触发范围：宠物中心 ±这个值（DIP）。Qoder 的 pointerLookTrackingSize=400 取半宽。
# 按「到宠物中心的直线距离」判定（圆形），不是 x/y 分别比较的方框——方框在
# 对角会把 sqrt(2) 倍远的位置也算进范围，比预期大一圈。
$script:LookTrackHalf = 200.0
# 注视的**下限**：太贴近宠物时不注视，那块归悬停跳跃管。
# 对齐 Qoder 原版：max(lookTrackingMinDistance=40, min(宽,高)*lookTrackingDistanceRatio=0.38)。
# 随宠物尺寸变化，所以在 Apply-Config 里重算，不能写死。
$script:LookTrackMinRatio = 0.38
$script:LookTrackMinFloor = 40.0
$script:LookTrackMin = [Math]::Max($script:LookTrackMinFloor,
    [Math]::Min([double]$script:WinW, [double]$script:WinH) * $script:LookTrackMinRatio)
# 指针是否落在宠物自身范围内（由 Update-Look 每帧刷新）
$script:Hovering = $false
# 注视回落：只有指针真的移动过才刷新注视方向。静止不动地停在宠物旁边，
# 视线不该一直黏着指针——那会让宠物永远停在注视静态帧，回不到 idle 待机动画。
# 位移小于死区不计移动（防手抖和采样噪声反复续期），静止超过 LookIdleMs 就
# 把 LookIndex 置 -1 放宠物回去待机。
$script:LookMoveDeadZone = 3.0
$script:LookIdleMs = 1500.0
$script:LastCursorX = $null
$script:LastCursorY = $null
$script:LastCursorMoveAt = [DateTime]::MinValue
# 当前正在播的动画名；变化时要把帧游标归零
$script:CurrentAnim = ''

# 活动卡片：当前展示的会话与展开态
$script:CardSessionId = ''
# 展开态随窗口位置一起持久化（Qoder 的卡片也记 collapsed）
$script:CardExpanded = ($saved -and $saved.cardExpanded -eq $true)
$script:CardVisible = $false
# 右侧按钮的「已读」标记：双击宠物打开客户端就算看过了，图形转为灰色暂停。
# 新一轮任务开始时清掉。
$script:CardRead = $false
# 没有任何会话在跑多久之后自动收起卡片；期间保持展示以便随时监控进度。
$script:CardAutoHideMs = 4 * 60 * 1000
$script:CardLastActiveAt = [DateTime]::UtcNow
# 卡片数据轮询累加器（比相位轮询慢一档）
$script:ActivityAccum = 0.0
# 亮暗模式复查累加器：用户在系统设置里切换后，这里跟上
$script:ThemeAccum = 0.0

# 卡片状态 → 文案与状态点颜色（与宿主侧 activity.js 的状态名一致）
$script:CardStatusText = @{
    running     = '正在执行'
    waiting     = '等待你的处理'
    completed   = '本轮已完成'
    failed      = '本轮执行失败'
    interrupted = '本轮已中断'
}
$script:CardStatusColor = @{
    running     = '#4C8DFF'
    waiting     = '#E8A33D'
    completed   = '#3FB950'
    failed      = '#E5534B'
    interrupted = '#E8A33D'
}

function Resolve-Brush([string]$Hex) {
    return [System.Windows.Media.BrushConverter]::new().ConvertFromString($Hex)
}

# 窗口尺寸自己记账，不去读回 $window.Width/Height——WPF 的属性写入与布局不是
# 同一拍，读回会拿到上一轮的尺寸，锚点就算歪。
# 初值必须是**宠物尺寸**：卡片出现前窗口就等于宠物，写 0 会让第一次 Set-WindowLayout
# 把 bottom 算成 window.Top + 0，宠物整体上跳一个自身高度。
$script:WindowW = [double]$script:WinW
$script:WindowH = [double]$script:WinH

# 窗口尺寸 = max(宠物, 卡片) x (卡片 + 宠物)。
# 卡片与宠物都水平居中，所以锚定要取**宠物自身的水平中心 + 窗口底边**：
# 卡片展开/收起时宠物不会横向跳，也不会上下跳。
function Set-WindowLayout {
    $card.Visibility = if ($script:CardVisible) { 'Visible' } else { 'Collapsed' }
    $cardH = 0.0
    if ($script:CardVisible) {
        # 量卡片时要把它自己的 Margin（留给投影）一起算进去
        $card.Measure([System.Windows.Size]::new(
            $script:CardWidth + 2 * $script:ShadowMargin, [double]::PositiveInfinity))
        $cardH = [Math]::Ceiling($card.DesiredSize.Height)
    }
    $w = [Math]::Max([double]$script:WinW, $script:CardWidth + 2 * $script:ShadowMargin)
    $h = [double]$script:WinH + $cardH

    $petCenterX = (Get-PetLeft) + $script:WinW / 2
    $bottom = $window.Top + $script:WindowH

    $script:WindowW = $w
    $script:WindowH = $h
    $window.Width = $w
    $window.Height = $h
    # 宠物在窗口里居中：petLeft = (w - WinW) / 2
    $window.Left = $petCenterX - $script:WinW / 2 - ($w - $script:WinW) / 2
    $window.Top = $bottom - $h
}

# 按 activity.json 刷新卡片内容。返回 true 表示卡片可见性可能变了。
function Update-Card($activity) {
    if (-not $activity -or $activity.showCard -eq $false) {
        $script:CardSessionId = ''
        if ($script:CardVisible) { $script:CardVisible = $false; $script:CardState = ''; return $true }
        return $false
    }
    $items = @($activity.items)
    if ($items.Count -eq 0) {
        $script:CardSessionId = ''
        if ($script:CardVisible) { $script:CardVisible = $false; $script:CardState = ''; return $true }
        return $false
    }

    $item = $items[0]
    $status = if ($item.status) { [string]$item.status } else { 'running' }
    $now = [DateTime]::UtcNow

    # 有任务在跑（或在等用户）就记一次活跃时间；新一轮开始同时清掉「已读」，
    # 让右侧图标从灰色暂停回到红色停止。
    $active = ($status -eq 'running' -or $status -eq 'waiting')
    if ($active) {
        $script:CardLastActiveAt = $now
        if ($status -eq 'running') { $script:CardRead = $false }
    } elseif (($now - $script:CardLastActiveAt).TotalMilliseconds -gt $script:CardAutoHideMs) {
        # 长时间没有任何会话在跑 → 自动收起，等下次有任务再弹出来
        $script:CardSessionId = ''
        if ($script:CardVisible) { $script:CardVisible = $false; $script:CardState = ''; return $true }
        return $false
    }

    $script:CardSessionId = [string]$item.sessionId

    # 第一行：会话标题（多会话时缀一个 +N）
    $title = [string]$item.title
    if ($items.Count -gt 1) { $title = "$title  +$($items.Count - 1)" }
    $cardTitle.Text = $title

    # 第二行：实时信息——宿主给的是「正在干什么」（「运行 pnpm test」「读取 lib/pet.ps1」），
    # 拿不到才退回状态词，至少不空着。
    $label = if ($script:CardStatusText.ContainsKey($status)) { $script:CardStatusText[$status] } else { $status }
    $detail = [string]$item.detail
    $cardDetail.Text = if ($detail) { $detail } else { $label }
    Set-DetailIcon ([string]$item.icon)

    $color = if ($script:CardStatusColor.ContainsKey($status)) { $script:CardStatusColor[$status] } else { '#4C8DFF' }
    $cardDot.Fill = Resolve-Brush $color
    $cardDot.ToolTip = $label

    # 右侧按钮：跑着 = 红色停止；等你选择 = 蓝色问号；完成未读 = 绿色对号；双击看过 = 灰色暂停
    if ($status -eq 'running') { Set-CardStateIcon 'running' }
    elseif ($status -eq 'waiting') { Set-CardStateIcon 'blue' }
    elseif ($script:CardRead) { Set-CardStateIcon 'read' }
    else { Set-CardStateIcon 'done' }

    $cardReplyRow.Visibility = if ($script:CardExpanded) { 'Visible' } else { 'Collapsed' }

    # 只有可见性真的变了才让调用方重排窗口，避免每 250ms 白算一次布局
    $wasVisible = $script:CardVisible
    $script:CardVisible = $true
    return (-not $wasVisible)
}

# 把动作交给宿主：写 action.json，宿主轮询消费。
# 不新增免鉴权的 HTTP 变更端点——`/api/*` 有鉴权、非 /api 路径没有，
# 为一个桌宠按钮开会话写入口不值当。
function Write-PetAction($Payload) {
    try {
        $json = $Payload | ConvertTo-Json -Depth 4 -Compress
        $tmp = Join-Path $StateDir ('action.' + $PID + '.tmp')
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination (Join-Path $StateDir 'action.json') -Force
    } catch {
        # 写不进去就放弃这次动作，不打扰用户
    }
}

# 不带会话的动作（目前只有「关闭宠物」）
function Send-PetAction([string]$Action) {
    Write-PetAction @{ action = $Action; at = [DateTime]::UtcNow.ToString('o') }
}

function Send-CardAction([string]$Action, [string]$Text) {
    if ($script:CardSessionId -eq '') { return }
    $payload = @{
        action    = $Action
        sessionId = $script:CardSessionId
        at        = [DateTime]::UtcNow.ToString('o')
    }
    if ($null -ne $Text -and $Text -ne '') {
        $payload.text = $Text
        # 会话正在跑就用 steer（插话），否则排队
        $payload.mode = if ($script:Phase -eq 'running') { 'steer' } else { 'queue' }
    }
    Write-PetAction $payload
}

<#
 睡眠态的进出。

 睡着判定是「idle 相位连续闲置超过 IdleSleepAfterMs」，但**不能只用 IdleMs 归零
 来唤醒**：睡着时 Phase 依然是 idle，IdleMs 会继续累加，于是永远醒不过来。
 所以唤醒是一个显式动作——鼠标悬停、拖拽、或指针在注视范围内移动都算「有人在
 摸它」，立刻醒来并把闲置计时清零重新开始。

 睡着期间卡片淡出；醒来时淡入。
#>
function Update-Sleep([double]$dt) {
    $awake = $script:Hovering -or $null -ne $script:DragDir -or $script:LookIndex -ge 0
    if ($awake) {
        if ($script:Sleeping) { $script:Sleeping = $false }
        $script:IdleMs = 0.0
        return
    }
    if ($script:Phase -ne 'idle') {
        # 有任务时谈不上睡觉；清掉睡眠态免得和相位动画打架
        $script:Sleeping = $false
        return
    }
    if ($script:IdleMs -ge $script:IdleSleepAfterMs) { $script:Sleeping = $true }
}

function Resolve-Animation {
    if ($script:OneShot) { return $script:OneShot }
    if ($script:DragDir) { return $script:DragDir }
    $phase = $script:Phase

    # 「等你选择」播 review（凑过来看着你），不播 waiting——
    # Qoduck 的 waiting 素材画的是闭眼睡觉 + ZZZ，放在「等你操作」上语义完全相反。
    if ($phase -eq 'waiting') { return 'review' }

    # idle 的两档：先待机呼吸，够久换眨眼变体，再久就真的睡着了（waiting 素材）。
    # 睡着之后一直保持，不再被 idle/idleEye 或注视打断——它就是「长时间没事干」的终态，
    # 有别的事发生（相位离开 idle、鼠标动起来）自然会把 IdleMs 清零退出去。
    if ($phase -eq 'idle') {
        # 睡着是「长时间没事干」的终态：醒着的判定交给 Update-Sleep，
        # 这里只在确实睡着时返回睡觉动画，之后一直保持到被唤醒。
        if ($script:Sleeping) { return 'waiting' }
        # idle 待够两个动画周期后换成眨眼变体；一离开 idle 立刻切回
        # （Qoder 原版行为：idleMotionCycleDurationMs * idleMotionIntroLoopCount）。
        if ($script:IdleMs -ge $script:IdleEyeAfterMs) { return 'idleEye' }
    }
    return $phase
}

function Apply-Config($state) {
    if (-not $state) { return }
    $changed = $false

    if ($null -ne $state.size) {
        $next = [int]$state.size
        if ($next -ne $script:SizePx) {
            $script:SizePx = [Math]::Max(48, [Math]::Min(384, $next))
            $script:WinW = [int][Math]::Round($script:SizePx)
            $script:WinH = [int][Math]::Round($script:SizePx * $aspect)
            # 尺寸变了，注视下限跟着重算（见 $script:LookTrackMin 的注释）
            $script:LookTrackMin = [Math]::Max($script:LookTrackMinFloor,
                [Math]::Min([double]$script:WinW, [double]$script:WinH) * $script:LookTrackMinRatio)
            $changed = $true
        }
    }
    if ($null -ne $state.mouseTracking) { $script:MouseTracking = [bool]$state.mouseTracking }
    if ($null -ne $state.enabled) {
        $enabled = [bool]$state.enabled
        if ($enabled -ne $script:Enabled) {
            $script:Enabled = $enabled
            if ($enabled) { $window.Show() } else { $window.Hide() }
        }
    }
    if ($null -ne $state.phase) { $script:Phase = [string]$state.phase }
    if ($null -ne $state.pin -and -not $script:Dragging) {
        $pin = [string]$state.pin
        if ($state.reset -eq $true) {
            $script:Left = $work.Right - $script:WinW - 24
            $script:Top = $work.Bottom - $script:WinH - 24
            $changed = $true
        }
    }
    if ($changed) {
        # 尺寸变了：宠物图跟着变，并保持右下角不动重排窗口
        $image.Width = $script:WinW
        $image.Height = $script:WinH
        Set-WindowLayout
    }
}

# 卡片展开时窗口比宠物大，所以对外一律用「宠物自己的矩形」，
# 免得把窗口左上角当成宠物位置存下来。宠物在窗口里水平居中、贴底。
function Get-PetLeft { return $window.Left + ($script:WindowW - $script:WinW) / 2 }
function Get-PetTop { return $window.Top + ($script:WindowH - $script:WinH) }

function Set-PetPosition([double]$PetLeft, [double]$PetTop) {
    $petCenterX = $PetLeft + $script:WinW / 2
    $bottom = $PetTop + $script:WinH
    $window.Left = $petCenterX - $script:WinW / 2 - ($script:WindowW - $script:WinW) / 2
    $window.Top = $bottom - $script:WindowH
}

function Save-Position {
    Write-JsonFile $WindowPath @{
        left         = [int](Get-PetLeft)
        top          = [int](Get-PetTop)
        size         = [int]$script:SizePx
        cardExpanded = [bool]$script:CardExpanded
        saved        = (Get-Date).ToString('o')
    }
}

# ============================================================
# 鼠标：拖拽 / 点击 / 注视
# ============================================================

# 光标位置是物理像素，窗口坐标是 DIP；统一换成 DIP 再比较。
function Get-CursorDip {
    $p = [System.Windows.Forms.Cursor]::Position
    return @{ x = (ConvertTo-Dip $p.X); y = (ConvertTo-Dip $p.Y) }
}

# 播放一次单次动作（waving / jumping），播完自动回到基础姿态。
function Start-OneShot([string]$Name) {
    $now = [DateTime]::UtcNow
    $script:OneShot = $Name
    $script:OneShotUntil = $now.AddMilliseconds((Get-Animation $Name).totalMs + 60)
    # 清空「当前动画」标记，强制下一帧走切换分支把帧游标归零——
    # 否则连播同一个动作（悬停反复跳跃）时动画名没变，会从上次的末帧接着放。
    $script:CurrentAnim = ''
}

$root.Add_MouseLeftButtonDown({
    $script:Dragging = $true
    $script:DragMoved = $false
    $c = Get-CursorDip
    $script:DragOrigin = @{ x = $c.x; y = $c.y; left = $window.Left; top = $window.Top }
    $root.CaptureMouse() | Out-Null
})

$root.Add_MouseMove({
    if (-not $script:Dragging -or -not $script:DragOrigin) { return }
    $c = Get-CursorDip
    $dx = $c.x - $script:DragOrigin.x
    $dy = $c.y - $script:DragOrigin.y
    if (-not $script:DragMoved -and [Math]::Abs($dx) -lt 4 -and [Math]::Abs($dy) -lt 4) { return }
    $script:DragMoved = $true
    $script:DragDir = if ($dx -ge 4) { 'runningRight' } elseif ($dx -le -4) { 'runningLeft' } else { $null }
    $window.Left = $script:DragOrigin.left + $dx
    $window.Top = $script:DragOrigin.top + $dy
})

$root.Add_MouseLeftButtonUp({
    if (-not $script:Dragging) { return }
    $script:Dragging = $false
    $script:DragDir = $null
    $script:DragOrigin = $null
    $root.ReleaseMouseCapture()
    if ($script:DragMoved) { Save-Position; return }

    # 没拖动 = 点击。双击唤起客户端；单击不做动作——招手只属于「开窗问候」与
    # 「待机随机」，点一下就挥手既突兀、又会被随后的悬停跳跃打断。
    $now = [DateTime]::UtcNow
    if (($now - $script:LastClickAt).TotalMilliseconds -lt 350) {
        $script:LastClickAt = [DateTime]::MinValue
        Start-OneShot 'jumping'
        Show-DshClient
        # 打开客户端就等于看过了：右侧图标从绿色对号转成灰色暂停
        if ($script:CardVisible) { $script:CardRead = $true }
    } else {
        $script:LastClickAt = $now
    }
})

function Update-Look {
    if (-not $script:MouseTracking) {
        $script:LookIndex = -1
        $script:Hovering = $false
        # 关掉跟踪就把坐标基准一并清干净，重新打开时才不会拿着过期的上次位置秒判「移动」。
        $script:LastCursorX = $null
        $script:LastCursorY = $null
        $script:LastCursorMoveAt = [DateTime]::MinValue
        return
    }
    $c = Get-CursorDip

    # 移动检测必须在下面几处提前 return 之前算完：悬停、超出范围两条路径都会 return。
    # 若把「更新基准」留到最后，指针停在宠物身上几秒后一移出，基准过期，会被瞬间判成
    # 位移几百 DIP 而误触发注视。
    $moved = $false
    if ($null -eq $script:LastCursorX) {
        # 首帧只有基准、没有上一次，不算移动：脚本刚起来时指针可能本来就停在宠物旁边，
        # 不该因此就进入注视。但**必须同时续期**——LastCursorMoveAt 初值是
        # [DateTime]::MinValue，不续期的话「静止时长」一上来就是几千年，首帧之后
        # 立刻被判过期，指针缓慢移到宠物旁边再停住就永远注视不了。
        $script:LastCursorX = $c.x
        $script:LastCursorY = $c.y
        $script:LastCursorMoveAt = [DateTime]::UtcNow
    } elseif ([Math]::Abs($c.x - $script:LastCursorX) -ge $script:LookMoveDeadZone -or
              [Math]::Abs($c.y - $script:LastCursorY) -ge $script:LookMoveDeadZone) {
        # 超过死区才算真的移动；低于死区的抖动既不续期也不刷新注视方向。
        $moved = $true
        $script:LastCursorMoveAt = [DateTime]::UtcNow
        $script:LastCursorX = $c.x
        $script:LastCursorY = $c.y
    }

    # 静止超过阈值就不再注视。之前这里每帧无条件按光标位置刷新 LookIndex，指针就算
    # 完全静止 LookIndex 也一直 >= 0，主循环就会把静态注视帧一直贴在那 ——
    # 用户感知的「待机时错误触发注视」。现在放开 LookIndex 让宠物回 idle/idleEye。
    $lookExpired = (-not $moved) -and
        (([DateTime]::UtcNow - $script:LastCursorMoveAt).TotalMilliseconds -ge $script:LookIdleMs)
    if ($lookExpired) { $script:LookIndex = -1 }

    # 判定用**宠物自己的矩形**，不是整窗——窗口现在还要装卡片，
    # 鼠标移到卡片上不该被当成在摸宠物（会误触发跳跃）。
    $petLeft = Get-PetLeft
    $petTop = Get-PetTop

    # 指针落在宠物范围内 → 不触发注视，并记下悬停态（悬停要反复跳）。
    # 这里原来是「贴身处用 lookLeft/lookRight 转头」，而转头方向由 $dx 的正负决定，
    # 指针在中心附近微动就会在左右之间来回翻，视觉上就是抽搐。现在直接不触发。
    if ($c.x -ge $petLeft -and $c.x -le ($petLeft + $script:WinW) -and
        $c.y -ge $petTop -and $c.y -le ($petTop + $script:WinH)) {
        $script:LookIndex = -1
        $script:Hovering = $true
        return
    }
    $script:Hovering = $false

    $wx = $petLeft + $script:WinW / 2
    $wy = $petTop + $script:WinH / 2
    $dx = $c.x - $wx
    $dy = $c.y - $wy

    # 圆形判定：到宠物中心的直线距离。原来分别比较 Abs(dx)/Abs(dy) 是方框，
    # 对角位置实际距离 sqrt(2)*200≈283 DIP 仍算命中，范围比「半径 200」大一圈。
    $dist = [Math]::Sqrt($dx * $dx + $dy * $dy)
    if ($dist -gt $script:LookTrackHalf) { $script:LookIndex = -1; return }

    # 下限门槛（对齐 Qoder 原版 lookTrackingMinDistance / lookTrackingDistanceRatio）：
    # 太贴近宠物时不注视——那块区域已经由上面的悬停分支负责跳了。
    if ($dist -lt $script:LookTrackMin) { $script:LookIndex = -1; return }

    # 已经静止超时：方向不再刷新，宠物继续待机。
    if ($lookExpired) { return }

    $deg = ([Math]::Atan2($dx, -$dy) * 180 / [Math]::PI + 360) % 360
    $script:LookIndex = [int]([Math]::Round($deg / 22.5) % 16)
}

# ============================================================
# 右键菜单
# ============================================================

# 右键菜单只留「关闭宠物」一项——尺寸、注视这些都在设置页里，桌面部件上
# 不该再摊开一层功能。配色跟随桌面亮暗模式。
$MenuXaml = @'
<ContextMenu xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             Padding="4" BorderThickness="1" HasDropShadow="False">
  <ContextMenu.ItemContainerStyle>
    <Style TargetType="MenuItem">
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="MenuItem">
            <Border x:Name="Bd" Background="Transparent" CornerRadius="6" Padding="14,7">
              <ContentPresenter ContentSource="Header"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsHighlighted" Value="True">
                <Setter TargetName="Bd" Property="Opacity" Value="0.72"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </ContextMenu.ItemContainerStyle>
  <MenuItem x:Name="ClosePetItem" Header="关闭宠物"/>
</ContextMenu>
'@

$menu = [System.Windows.Markup.XamlReader]::Parse($MenuXaml)
$menuItem = $menu.FindName('ClosePetItem')
$script:Menu = $menu
$script:MenuCloseItem = $menuItem
$menuItem.Add_Click({ Send-PetAction 'close' })
$root.ContextMenu = $menu

# 首次上色（菜单要先建好，Apply-Theme 会引用它）
Apply-Theme

# ============================================================
# 卡片交互
# ============================================================

$cardStop.Add_Click({ Send-CardAction 'stop' $null })

# 展开态用箭头旋转表达，不换字符
function Set-ToggleGlyph([bool]$Expanded) {
    $angle = if ($Expanded) { 180.0 } else { 0.0 }
    $cardToggleGlyph.RenderTransform = New-Object System.Windows.Media.RotateTransform $angle
}

$cardToggle.Add_Click({
    $script:CardExpanded = -not $script:CardExpanded
    Set-ToggleGlyph $script:CardExpanded
    $cardReplyRow.Visibility = if ($script:CardExpanded) { 'Visible' } else { 'Collapsed' }
    [void](Set-WindowLayout)
    Save-Position
    if ($script:CardExpanded) {
        # 用户主动点开回复框，就是要打字——这时候抢焦点是符合预期的，
        # 与「开窗时不抢焦点」不冲突。
        try { $window.Activate() } catch { }
        [void]$cardReplyBox.Focus()
    }
})

# 占位文字：有内容就藏起来
$cardReplyBox.Add_TextChanged({
    if ($null -eq $cardPlaceholder) { return }
    $cardPlaceholder.Visibility = if ($cardReplyBox.Text -eq '') { 'Visible' } else { 'Collapsed' }
})

# 恢复上次的展开态
if ($script:CardExpanded) {
    Set-ToggleGlyph $true
    $cardReplyRow.Visibility = 'Visible'
}

function Send-CardReply {
    $text = $cardReplyBox.Text
    if ($null -eq $text -or $text.Trim() -eq '') { return }
    Send-CardAction 'reply' $text.Trim()
    $cardReplyBox.Text = ''
    $script:CardExpanded = $false
    Set-ToggleGlyph $false
    $cardReplyRow.Visibility = 'Collapsed'
    [void](Set-WindowLayout)
    Save-Position
}

$cardSend.Add_Click({ Send-CardReply })

$cardReplyBox.Add_KeyDown({
    param($sender, $eventArgs)
    if ($eventArgs.Key -eq 'Enter') {
        $eventArgs.Handled = $true
        Send-CardReply
    }
})

# ============================================================
# 主循环
# ============================================================

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(16)
$timer.Add_Tick({
    $now = [DateTime]::UtcNow
    $dt = ($now - $script:LastTick).TotalMilliseconds
    $script:LastTick = $now
    if ($dt -le 0 -or $dt -gt 500) { $dt = 16 }

    # 每 ~130ms 读一次宿主写的相位
    $script:PollAccum += $dt
    if ($script:PollAccum -ge 130) {
        $script:PollAccum = 0
        Apply-Config (Read-JsonFile $StatePath)
    }

    # 每 ~250ms 读一次活动卡片；可见性变化时重排窗口（宠物中心 + 底边锚定）
    $script:ActivityAccum += $dt
    if ($script:ActivityAccum -ge 250) {
        $script:ActivityAccum = 0
        if (Update-Card (Read-JsonFile $ActivityPath)) {
            [void](Set-WindowLayout)
        }
    }

    # 每 ~5s 复查一次桌面亮暗模式，用户在系统设置里切换后跟上
    $script:ThemeAccum += $dt
    if ($script:ThemeAccum -ge 5000) {
        $script:ThemeAccum = 0
        $light = Get-SystemIsLight
        if ($light -ne $script:IsLight) {
            $script:IsLight = $light
            Apply-Theme
        }
    }

    if (-not $script:Enabled) { return }

    if ($script:OneShot -and $now -ge $script:OneShotUntil) { $script:OneShot = $null }

    # 每帧刷新注视方向与悬停态。必须调用——LookIndex / Hovering 全靠它更新，
    # 少了这一行注视与悬停跳跃都不会触发。
    Update-Look

    # 悬停在宠物上 → 反复播放跳跃：一次跳完（OneShot 被清空）立刻再来一次。
    if ($script:Hovering -and -not $script:DragDir) {
        if ($script:OneShot -ne 'jumping') { Start-OneShot 'jumping' }
    }

    # 睡眠时卡片淡出、醒来淡入。透明度逐帧趋近目标值；卡片始终占位，
    # 只用 Opacity 而不切 Visibility，免得窗口尺寸跟着跳。
    $script:CardFadeTarget = if ($script:Sleeping) { 0.0 } else { 1.0 }
    $step = $script:CardFadeSpeed * ($dt / 1000.0)
    if ($script:CardFade -lt $script:CardFadeTarget) {
        $script:CardFade = [Math]::Min($script:CardFadeTarget, $script:CardFade + $step)
    } elseif ($script:CardFade -gt $script:CardFadeTarget) {
        $script:CardFade = [Math]::Max($script:CardFadeTarget, $script:CardFade - $step)
    }
    if ($card) { $card.Opacity = $script:CardFade }

    # 睡眠态：由下面 Update-Sleep 统一维护，这里只管计时。
    # 睡着时鼠标一有动静（悬停/拖拽/移动）就醒，并清零重新计时。
    Update-Sleep $dt

    # idle 连续计时：够久就让 Resolve-Animation 换眨眼变体；离开 idle 立刻清零。
    if ($script:Phase -eq 'idle') { $script:IdleMs += $dt } else { $script:IdleMs = 0.0 }

    $animName = Resolve-Animation
    $anim = Get-Animation $animName
    $displayW = [int]$window.Width

    # 动画切换时必须把帧游标归零。否则从 idle（82 帧）切到 waving（34 帧）时，
    # 旧游标会越界读到 $null，推进循环直接落到最后一帧卡住——这就是
    # 「点一下变成招手某一帧不动」的根因。
    if ($animName -ne $script:CurrentAnim) {
        $script:CurrentAnim = $animName
        $script:FrameIndex = 0
        $script:FrameAccum = 0.0
    }

    # 注视帧优先：没有单次动作、没有拖拽时，指针在半径内就用 16 向静态帧。
    # 但只限 idle 相位——running/waiting/failed/review 这些相位在讲「我正在干活/出错」，
    # 被一张中性的注视静态帧盖掉，用户就完全看不到状态了。这些相位一律播相位动画。
    if ($lookIdx -ge 0 -and $script:Phase -eq 'idle' -and
        -not $script:OneShot -and -not $script:DragDir) {
        $image.Source = Get-LookFrame $lookIdx $displayW
        return
    }

    $durations = @($anim.durationsMs)
    $count = [int]$anim.frames
    if ($count -le 0) { return }

    $script:FrameAccum += $dt
    $guard = 0
    while ($script:FrameAccum -ge [double]$durations[$script:FrameIndex] -and $guard -lt 8) {
        $script:FrameAccum -= [double]$durations[$script:FrameIndex]
        $script:FrameIndex++
        $guard++
        if ($script:FrameIndex -ge $count) {
            if ($anim.loop) { $script:FrameIndex = 0 }
            else { $script:FrameIndex = $count - 1; $script:FrameAccum = 0; break }
        }
    }
    if ($script:FrameIndex -ge $count) { $script:FrameIndex = 0 }

    $image.Source = Get-Frame $animName $script:FrameIndex $displayW

    # 诊断：QODUCK_DEBUG=1 时每 20 拍记一次关键状态（约 0.3s 一条）
    if ($env:QODUCK_DEBUG -eq '1' -and $script:DebugTick -lt 800) {
        $script:DebugTick++
        if ($script:DebugTick % 20 -eq 0) {
            "[$($script:DebugTick)] anim=$animName frame=$($script:FrameIndex)/$count hover=$($script:Hovering) look=$lookIdx oneShot=$($script:OneShot) phase=$($script:Phase) card=$($script:CardVisible) win=$([int]$window.Left),$([int]$window.Top) $([int]$window.Width)x$([int]$window.Height) pet=$([int](Get-PetLeft)),$([int](Get-PetTop)) $($script:WinW)x$($script:WinH) dpi=$($script:DpiScale)" |
                Add-Content -LiteralPath (Join-Path $StateDir 'debug.log') -Encoding UTF8
        }
    }
})

$window.Add_Closed({
    $timer.Stop()
    Save-Position
})

$window.Show()
# 只设 Topmost 不够：窗口在其它已存在的顶层窗口之后创建时，未必被放进 topmost 带。
# 关掉再打开一次是强制重排 z 序的标准做法，且不会抢焦点。
$window.Topmost = $false
$window.Topmost = $true
# 打开时先挥个手打招呼（Qoder 原版开窗也有一段问候动作）。
Start-OneShot 'waving'
$timer.Start()
[System.Windows.Threading.Dispatcher]::Run()
