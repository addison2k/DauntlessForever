# Dauntless Forever - Dauntless 1.6.2 offline package
# Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
# Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
# meter-overlay.ps1 (v8) - damage meter window for the DamageMeter UE4SS mod (Dauntless 1.6.2).
# A small see-through window that stays on top of the game (borderless/windowed mode) with WoW-style bars:
#     1. Name ............................  43.98M | 407.2K        (damage done | DPS)
# Tabs, like Details!:  Current (this fight; frozen after it ends, replaced when the next starts)
#                       Last (the fight before)   Before (the one before that)   Overall (all fights added up)
# Reads %LOCALAPPDATA%\DauntlessOffline\dmgmeter.json (written by the mod once a second, mod v7 or newer).
#   Drag it by the title.  Resize from the bottom-right corner.  Position, size and tab are remembered.
#   The cog opens the settings: text size, background darkness, lock in combat.
#   The reset button clears everything (the mod picks it up within a second).  x closes the window.
# It never takes focus from the game. It turns click-through (clicks go to the game) during a fight and back after;
# the lock button keeps it click-through all the time, Ctrl+Shift+M locks / unlocks it from anywhere.
# Closes by itself when the game closes. Needs nothing installed (Windows PowerShell 5.1 + WPF).
param([string]$Dir = '')   # the folder the DamageMeter mod writes to (play-162.ps1 passes data\meter)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'DauntlessOffline' }
$DataFile  = Join-Path $Dir 'dmgmeter.json'
$ResetFile = Join-Path $Dir 'dmgmeter.reset'
$PosFile   = Join-Path $Dir 'meter-window.json'
$LogFile   = Join-Path $Dir 'meter-overlay.log'
New-Item -ItemType Directory -Force $Dir | Out-Null

# Weapon colours (EWeaponType numbers from the game). Change them here.
$Weapons = @{
    0 = @('Unknown',         '#6E7A86')
    1 = @('Hammer',          '#C79C6E')
    2 = @('Axe',             '#C63D36')
    3 = @('Sword',           '#F58CBA')
    4 = @('Chain Blades',    '#9656CC')
    5 = @('War Pike',        '#4A80D6')
    6 = @('Repeaters',       '#DDBB35')
    7 = @('Aether Strikers', '#00FF98')
    8 = @('Bow',             '#A4CA45')
}
$Tabs = @(
    @{ Key = 'current'; Label = 'Current';  Empty = 'Hit something to start.' },
    @{ Key = 'last';    Label = 'Last';     Empty = 'No earlier fight yet.' },
    @{ Key = 'before';  Label = 'Before';   Empty = 'No fight before that yet.' },
    @{ Key = 'overall'; Label = 'Overall';  Empty = 'Nothing yet.' }
)

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Damage meter" Width="380" Height="250" MinWidth="240" MinHeight="110"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ShowActivated="False" ResizeMode="CanResizeWithGrip"
        FontFamily="Bahnschrift, Segoe UI" FontSize="13">
  <Border x:Name="Panel" CornerRadius="6" BorderThickness="1" BorderBrush="#61D6AB4A" Background="#DB0D1116">
    <DockPanel LastChildFill="True">
      <Border x:Name="Head" DockPanel.Dock="Top" Height="28" Background="#EB181F27" CornerRadius="6,6,0,0">
        <DockPanel Margin="10,0,4,0">
          <Button x:Name="BtnClose" DockPanel.Dock="Right" Content="&#x2715;" Width="22" Height="22" ToolTip="Close"
                  Background="Transparent" BorderThickness="0" Foreground="#A9B6C4" Cursor="Hand"/>
          <Button x:Name="BtnLock" DockPanel.Dock="Right" Content="&#x1F513;" Width="22" Height="22"
                  ToolTip="Lock: always click-through (Ctrl+Shift+M unlocks)" FontFamily="Segoe UI Emoji" FontSize="11"
                  Background="Transparent" BorderThickness="0" Foreground="#A9B6C4" Cursor="Hand"/>
          <Button x:Name="BtnSettings" DockPanel.Dock="Right" Content="&#x2699;" Width="22" Height="22" ToolTip="Settings"
                  Background="Transparent" BorderThickness="0" Foreground="#A9B6C4" Cursor="Hand" FontSize="14"/>
          <Button x:Name="BtnReset" DockPanel.Dock="Right" Content="&#x21BA;" Width="22" Height="22" ToolTip="Reset all fights"
                  Background="Transparent" BorderThickness="0" Foreground="#A9B6C4" Cursor="Hand" FontSize="15"/>
          <TextBlock x:Name="Clock" DockPanel.Dock="Right" Text="0:00" Foreground="#A9B6C4" FontSize="12"
                     VerticalAlignment="Center" Margin="6,0,8,0"/>
          <Ellipse x:Name="Dot" DockPanel.Dock="Right" Width="7" Height="7" Fill="#56626E" VerticalAlignment="Center"
                   ToolTip="Green = in combat"/>
          <TextBlock Text="Damage Done" Foreground="#D6AB4A" FontWeight="SemiBold" FontSize="14" VerticalAlignment="Center"/>
        </DockPanel>
      </Border>
      <Border DockPanel.Dock="Top" Background="#D9141A21" BorderBrush="#61D6AB4A" BorderThickness="0,0,0,1">
        <StackPanel x:Name="TabBar" Orientation="Horizontal" Margin="6,2,6,2"/>
      </Border>
      <Border x:Name="SettingsPanel" DockPanel.Dock="Top" Visibility="Collapsed" Background="#F0141A21"
              BorderBrush="#61D6AB4A" BorderThickness="0,0,0,1" Padding="10,6,10,7">
        <StackPanel>
          <DockPanel Margin="0,0,0,5">
            <TextBlock Text="Text size" Foreground="#C9D3DD" FontSize="12" VerticalAlignment="Center" Width="92"/>
            <Button x:Name="BtnSmaller" Content="A&#x2212;" Width="34" Height="22" Margin="0,0,4,0" Cursor="Hand"
                    Background="#2A3440" Foreground="#EEF2F6" BorderThickness="0" FontSize="12"/>
            <Button x:Name="BtnBigger" Content="A+" Width="34" Height="22" Margin="0,0,8,0" Cursor="Hand"
                    Background="#2A3440" Foreground="#EEF2F6" BorderThickness="0" FontSize="12"/>
            <TextBlock x:Name="SizeLabel" Text="15" Foreground="#A9B6C4" FontSize="12" VerticalAlignment="Center"/>
          </DockPanel>
          <DockPanel Margin="0,0,0,5">
            <TextBlock Text="Background" Foreground="#C9D3DD" FontSize="12" VerticalAlignment="Center" Width="92"/>
            <Slider x:Name="BgSlider" Minimum="0.3" Maximum="1" Value="0.86" Width="150" VerticalAlignment="Center"
                    HorizontalAlignment="Left" IsMoveToPointEnabled="True"/>
          </DockPanel>
          <CheckBox x:Name="ChkAutoLock" Content="Lock (click-through) during a fight" Foreground="#C9D3DD" FontSize="12"
                    IsChecked="True" Margin="0,0,0,3"/>
          <TextBlock Text="Ctrl+Shift+M locks / unlocks the window from anywhere." Foreground="#8796A6" FontSize="11"/>
        </StackPanel>
      </Border>
      <TextBlock x:Name="Status" DockPanel.Dock="Bottom" Foreground="#8796A6" FontSize="10.5" Margin="8,0,18,3"
                 TextTrimming="CharacterEllipsis"/>
      <Border x:Name="Detail" DockPanel.Dock="Bottom" Visibility="Collapsed" Background="#F2141A21"
              BorderBrush="#61D6AB4A" BorderThickness="0,1,0,0" Padding="9,5,9,6">
        <TextBlock x:Name="DetailText" Foreground="#E3E9EF" FontSize="12" TextWrapping="Wrap"/>
      </Border>
      <ScrollViewer VerticalScrollBarVisibility="Auto" Margin="3,3,3,2">
        <StackPanel x:Name="Rows"/>
      </ScrollViewer>
    </DockPanel>
  </Border>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$Rows   = $win.FindName('Rows');  $Clock = $win.FindName('Clock'); $Dot = $win.FindName('Dot')
$Head   = $win.FindName('Head');  $Status = $win.FindName('Status'); $TabBar = $win.FindName('TabBar')
$conv   = New-Object System.Windows.Media.BrushConverter
function Brush([string]$c) { $conv.ConvertFromString($c) }
function Note([string]$t) { $Status.Text = $t; $Status.ToolTip = $t }
function Log-Err([string]$t) { try { Add-Content -Path $LogFile -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $t) } catch {} }

$script:tab = 'current'
$script:fontSize = 15        # text size (setting)
$script:bgOpacity = 0.86     # background darkness (setting)
$script:autoLockSaved = $true
$script:data = $null

# remembered position, size and tab (position only if it is still on screen)
try {
    $pos = Get-Content -Raw $PosFile -ErrorAction Stop | ConvertFrom-Json
    if ($pos.Locked) { $script:pinnedAtStart = $true }
    if ($pos.FontSize -ge 10 -and $pos.FontSize -le 28) { $script:fontSize = [double]$pos.FontSize }
    if ($pos.BgOpacity -ge 0.3 -and $pos.BgOpacity -le 1) { $script:bgOpacity = [double]$pos.BgOpacity }
    if ($null -ne $pos.AutoLock) { $script:autoLockSaved = [bool]$pos.AutoLock }
    if ($pos.Tab -and ($Tabs | Where-Object { $_.Key -eq $pos.Tab })) { $script:tab = $pos.Tab }
    $vs = [System.Windows.SystemParameters]
    if ($pos.Left -ge $vs::VirtualScreenLeft -and $pos.Left -lt ($vs::VirtualScreenLeft + $vs::VirtualScreenWidth - 60) -and
        $pos.Top -ge $vs::VirtualScreenTop -and $pos.Top -lt ($vs::VirtualScreenTop + $vs::VirtualScreenHeight - 40)) {
        $win.WindowStartupLocation = 'Manual'
        $win.Left = $pos.Left; $win.Top = $pos.Top
        if ($pos.Width -ge 240) { $win.Width = $pos.Width }
        if ($pos.Height -ge 110) { $win.Height = $pos.Height }
    } else { throw 'off screen' }
} catch {
    $wa = [System.Windows.SystemParameters]::WorkArea
    $win.WindowStartupLocation = 'Manual'
    $win.Left = $wa.Right - 370; $win.Top = $wa.Top + [int]($wa.Height * 0.32)
}
function Save-Pos { try { @{ Left = $win.Left; Top = $win.Top; Width = $win.ActualWidth; Height = $win.ActualHeight; Tab = $script:tab; Locked = [bool]$script:pinned; FontSize = $script:fontSize; BgOpacity = $script:bgOpacity; AutoLock = [bool]$script:autoLock } | ConvertTo-Json | Set-Content $PosFile } catch {} }

# ---------------------------------------------------------------- number formats (no format strings with padding)
function Short([double]$n) {
    if ($n -ge 1e6) { return ($n / 1e6).ToString('0.00') + 'M' }
    if ($n -ge 1e4) { return ($n / 1e3).ToString('0.0') + 'K' }
    return [math]::Round($n).ToString('#,0')
}
function Clock-Text([double]$sec) {
    $s = [int][math]::Floor($sec)
    $m = [int][math]::Floor($s / 60)
    $r = [int]($s - 60 * $m)
    return ($m.ToString() + ':' + $r.ToString('00'))
}

# ---------------------------------------------------------------- tabs
$TabButtons = @{}
foreach ($t in $Tabs) {
    $b = New-Object System.Windows.Controls.Button
    $b.Content = $t.Label; $b.Tag = $t.Key
    $b.Margin = '0,0,4,0'; $b.Padding = '8,1,8,1'; $b.FontSize = 13
    $b.BorderThickness = 0; $b.Cursor = 'Hand'
    $b.Add_Click({ param($sender, $e) $script:tab = $sender.Tag; Update-Tabs; Render; Save-Pos })
    [void]$TabBar.Children.Add($b)
    $TabButtons[$t.Key] = $b
}
function Update-Tabs {
    foreach ($t in $Tabs) {
        $b = $TabButtons[$t.Key]
        if ($t.Key -eq $script:tab) { $b.Background = Brush '#40D6AB4A'; $b.Foreground = Brush '#F0C866' }
        else { $b.Background = Brush '#00000000'; $b.Foreground = Brush '#8796A6' }
    }
}

# ---------------------------------------------------------------- rows
# hover breakdown: only out of combat, and not while the window is locked for good
$Detail = $win.FindName('Detail'); $DetailText = $win.FindName('DetailText')
function Show-Detail([string]$text) {
    if ($script:pinned -or ($script:data -and $script:data.inCombat)) { return }
    $DetailText.FontSize = [math]::Max($script:fontSize - 2, 10)
    $DetailText.Text = $text
    $Detail.Visibility = 'Visible'
}
function Hide-Detail { $Detail.Visibility = 'Collapsed' }

function Show-Segment($seg, [bool]$inCombat, [string]$emptyText) {
    $secs = 0.0; if ($seg) { $secs = [double]$seg.seconds }
    $Clock.Text = Clock-Text $secs
    $live = $inCombat -and ($script:tab -eq 'current' -or $script:tab -eq 'overall')
    $Dot.Fill = if ($live) { Brush '#5FD3C6' } else { Brush '#56626E' }
    $Rows.Children.Clear()
    if ($inCombat -or $script:pinned) { Hide-Detail }
    $players = @()
    if ($seg) { $players = @($seg.players | Sort-Object { [double]$_.core } -Descending) }
    if ($players.Count -eq 0) {
        $t = New-Object System.Windows.Controls.TextBlock
        $t.Text = $emptyText; $t.Foreground = Brush '#A9B6C4'; $t.FontSize = $script:fontSize - 1; $t.Margin = '8,10,8,0'
        [void]$Rows.Children.Add($t); return
    }
    $top = [math]::Max([double]$players[0].core, 1)
    $script:segTotal = [math]::Max([double](($players | Measure-Object -Property core -Sum).Sum), 1)
    $i = 0
    foreach ($p in $players) {
        $i++
        $w = $Weapons[[int]$p.weapon]; if (-not $w) { $w = $Weapons[0] }
        $row = New-Object System.Windows.Controls.Grid
        $row.Height = [math]::Round($script:fontSize * 1.65); $row.Margin = '0,0,0,2'
        $avg = 0; if ([int]$p.hits -gt 0) { $avg = [double]$p.core / [int]$p.hits }
        $share = 100 * [double]$p.core / $script:segTotal
        $row.Tag = $p.name + '  -  ' + $w[0] + "`n" +
            'Core ' + ([double]$p.core).ToString('#,0') + '   ' + (Short ([double]$p.dps)) + ' DPS   ' + $share.ToString('0.0') + "% of the group`n" +
            'Part ' + ([double]$p.part).ToString('#,0') + '   Stagger ' + ([double]$p.stagger).ToString('#,0') + "`n" +
            [string]$p.hits + ' hits   ' + (Short $avg) + ' core per hit'
        $row.Background = Brush '#01000000'   # so the whole row reacts to the mouse
        $row.Add_MouseEnter({ param($sender, $e) Show-Detail $sender.Tag })
        $row.Add_MouseLeave({ Hide-Detail })
        $track = New-Object System.Windows.Controls.Border
        $track.Background = Brush '#0BFFFFFF'; $track.CornerRadius = 3
        if ($p.me) { $track.BorderBrush = Brush '#55FFFFFF'; $track.BorderThickness = 1 }
        [void]$row.Children.Add($track)
        # the bar: first column = share of the top player
        $bar = New-Object System.Windows.Controls.Grid
        $frac = [math]::Max([double]$p.core / $top, 0.02)
        $c1 = New-Object System.Windows.Controls.ColumnDefinition; $c1.Width = New-Object System.Windows.GridLength($frac, 'Star')
        $c2 = New-Object System.Windows.Controls.ColumnDefinition; $c2.Width = New-Object System.Windows.GridLength((1 - $frac + 0.0001), 'Star')
        [void]$bar.ColumnDefinitions.Add($c1); [void]$bar.ColumnDefinitions.Add($c2)
        $fill = New-Object System.Windows.Controls.Border
        $fill.Background = Brush $w[1]; $fill.CornerRadius = 3; $fill.Opacity = 0.92
        [void]$bar.Children.Add($fill)
        [void]$row.Children.Add($bar)
        # text: name (fills) | damage done (right aligned) | "|" | DPS (fixed width, right aligned)
        $txt = New-Object System.Windows.Controls.Grid
        $txt.Margin = '7,0,6,0'
        foreach ($wd in @('*', 'Auto', 'Auto', [string][math]::Round($script:fontSize * 4.3))) {
            $cd = New-Object System.Windows.Controls.ColumnDefinition
            if ($wd -eq '*') { $cd.Width = New-Object System.Windows.GridLength(1, 'Star') }
            elseif ($wd -eq 'Auto') { $cd.Width = [System.Windows.GridLength]::Auto }
            else { $cd.Width = New-Object System.Windows.GridLength([double]$wd) }
            [void]$txt.ColumnDefinitions.Add($cd)
        }
        $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
        $shadow.ShadowDepth = 1; $shadow.BlurRadius = 2; $shadow.Opacity = 0.95; $shadow.Color = [System.Windows.Media.Colors]::Black
        $txt.Effect = $shadow
        $cells = @(
            @{ Text = ([string]$i + '. ' + $p.name); Col = 0; Align = 'Left' },
            @{ Text = (Short ([double]$p.core));       Col = 1; Align = 'Right' },
            @{ Text = '|';                             Col = 2; Align = 'Center' },
            @{ Text = (Short ([double]$p.dps));        Col = 3; Align = 'Right' }
        )
        foreach ($c in $cells) {
            $tb = New-Object System.Windows.Controls.TextBlock
            $tb.Text = $c.Text; $tb.Foreground = Brush '#EEF2F6'; $tb.VerticalAlignment = 'Center'
            $tb.HorizontalAlignment = $c.Align; $tb.FontSize = $script:fontSize
            if ($c.Col -eq 0) { $tb.TextTrimming = 'CharacterEllipsis'; if ($p.me) { $tb.FontWeight = 'Bold' } }
            if ($c.Col -eq 1) { $tb.Margin = '8,0,0,0' }
            if ($c.Col -eq 2) { $tb.Margin = '6,0,6,0'; $tb.Foreground = Brush '#B8C4D0' }
            [System.Windows.Controls.Grid]::SetColumn($tb, $c.Col)
            [void]$txt.Children.Add($tb)
        }
        [void]$row.Children.Add($txt)
        [void]$Rows.Children.Add($row)
    }
}

function Render {
    $d = $script:data
    $t = $Tabs | Where-Object { $_.Key -eq $script:tab } | Select-Object -First 1
    if (-not $d) { Show-Segment $null $false $t.Empty; return }
    $seg = $null
    if ($d.v -ge 2) { $seg = $d.($script:tab) }
    elseif ($script:tab -eq 'current') { $seg = $d }      # old mod (v6 or earlier): one segment only
    Show-Segment $seg ([bool]$d.inCombat) $t.Empty
}


# ---------------------------------------------------------------- focus and click-through
Add-Type -Namespace DmgMeter -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
'@
$GWL_EXSTYLE = -20; $WS_EX_TRANSPARENT = 0x20; $WS_EX_TOOLWINDOW = 0x80; $WS_EX_NOACTIVATE = 0x08000000
$script:hwnd = [IntPtr]::Zero
$script:pinned = $false          # lock button / Ctrl+Shift+M: click-through all the time
$script:autoLock = $true         # click-through while a fight is on
$script:clickThrough = $false
$BtnLock = $win.FindName('BtnLock')
function Set-ClickThrough([bool]$on) {
    if ($script:hwnd -eq [IntPtr]::Zero -or $on -eq $script:clickThrough) { return }
    $ex = [DmgMeter.Win]::GetWindowLong($script:hwnd, $GWL_EXSTYLE)
    if ($on) { $ex = $ex -bor $WS_EX_TRANSPARENT } else { $ex = $ex -band (-bnot $WS_EX_TRANSPARENT) }
    [void][DmgMeter.Win]::SetWindowLong($script:hwnd, $GWL_EXSTYLE, $ex)
    $script:clickThrough = $on
}
function Update-Lock {
    $fight = [bool]($script:data -and $script:data.inCombat)
    Set-ClickThrough ($script:pinned -or ($script:autoLock -and $fight))
    if ($script:pinned -or $fight) { Hide-Detail }
    # dim a little only while a fight has it locked; locked for good = stays as it is
    $win.Opacity = if ($script:clickThrough -and -not $script:pinned) { 0.85 } else { 1.0 }
    $BtnLock.Content = if ($script:pinned) { [char]::ConvertFromUtf32(0x1F512) } else { [char]::ConvertFromUtf32(0x1F513) }
    $BtnLock.Foreground = if ($script:pinned) { Brush '#F0C866' } else { Brush '#A9B6C4' }
}
$win.Add_SourceInitialized({
    $script:hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
    $ex = [DmgMeter.Win]::GetWindowLong($script:hwnd, $GWL_EXSTYLE)
    [void][DmgMeter.Win]::SetWindowLong($script:hwnd, $GWL_EXSTYLE, ($ex -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW))
    Update-Lock
})
$BtnLock.Add_Click({ $script:pinned = $true; Update-Lock; Save-Pos })
# Ctrl+Shift+M from anywhere (the window cannot be clicked while it is click-through)
$script:keyWas = $false
$keyTimer = New-Object System.Windows.Threading.DispatcherTimer
$keyTimer.Interval = [TimeSpan]::FromMilliseconds(80)
$keyTimer.Add_Tick({
    $down = ([DmgMeter.Win]::GetAsyncKeyState(0x11) -band 0x8000) -and ([DmgMeter.Win]::GetAsyncKeyState(0x10) -band 0x8000) -and
            ([DmgMeter.Win]::GetAsyncKeyState(0x4D) -band 0x8000)
    if ($down -and -not $script:keyWas) { $script:pinned = -not $script:pinned; Update-Lock; Save-Pos }
    $script:keyWas = [bool]$down
})
$keyTimer.Start()

# ---------------------------------------------------------------- settings (cog)
$SettingsPanel = $win.FindName('SettingsPanel'); $SizeLabel = $win.FindName('SizeLabel')
$BgSlider = $win.FindName('BgSlider'); $ChkAutoLock = $win.FindName('ChkAutoLock'); $Panel = $win.FindName('Panel')
function Apply-Settings {
    $SizeLabel.Text = [string]$script:fontSize
    $a = [int][math]::Round(255 * $script:bgOpacity)
    $Panel.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb($a, 0x0D, 0x11, 0x16))
}
$win.FindName('BtnSettings').Add_Click({
    $SettingsPanel.Visibility = if ($SettingsPanel.Visibility -eq 'Visible') { 'Collapsed' } else { 'Visible' }
})
$win.FindName('BtnSmaller').Add_Click({ if ($script:fontSize -gt 10) { $script:fontSize--; Apply-Settings; Render; Save-Pos } })
$win.FindName('BtnBigger').Add_Click({ if ($script:fontSize -lt 28) { $script:fontSize++; Apply-Settings; Render; Save-Pos } })
$BgSlider.Value = $script:bgOpacity
$BgSlider.Add_ValueChanged({ $script:bgOpacity = [math]::Round($BgSlider.Value, 2); Apply-Settings; Save-Pos })
$script:autoLock = $script:autoLockSaved
$ChkAutoLock.IsChecked = $script:autoLock
$ChkAutoLock.Add_Click({ $script:autoLock = [bool]$ChkAutoLock.IsChecked; Update-Lock; Save-Pos })
Apply-Settings

$Head.Add_MouseLeftButtonDown({ try { $win.DragMove(); Save-Pos } catch {} })
$win.Add_SizeChanged({ Save-Pos })
$win.FindName('BtnClose').Add_Click({ $win.Close() })
$win.FindName('BtnReset').Add_Click({
    try { Set-Content -Path $ResetFile -Value '' } catch {}
    $script:data = $null; Render
})

# ---------------------------------------------------------------- poll the file twice a second; close when the game has closed
$script:lastWrite = [datetime]::MinValue
$script:sawGame = $false
$script:tick = 0
$script:showErr = $null
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
    $fi = Get-Item -LiteralPath $DataFile -ErrorAction SilentlyContinue
    if (-not $fi) {
        Note ('Waiting for the mod: no ' + $DataFile + ' yet')
    } else {
        $age = [int]((Get-Date) - $fi.LastWriteTime).TotalSeconds
        if ($fi.LastWriteTime -ne $script:lastWrite) {
            $d = $null
            try { $d = Get-Content -Raw -LiteralPath $DataFile -ErrorAction Stop | ConvertFrom-Json } catch { }   # caught mid-write: next tick
            if ($d) {
                $script:lastWrite = $fi.LastWriteTime
                $script:data = $d
                try { Render; $script:showErr = $null; Update-Lock }
                catch { $script:showErr = 'Display error: ' + $_.Exception.Message + ' (line ' + $_.InvocationInfo.ScriptLineNumber + ')'; Log-Err $script:showErr }
            }
        }
        if ($script:showErr) { Note $script:showErr }
        elseif ($script:data -and $script:data.v -lt 2) { Note 'Old mod version: update the DamageMeter mod to v7 for the fight tabs' }
        elseif ($age -gt 15 -and -not ($script:data -and $script:data.inCombat)) { Note ('mod data ' + $age + 's old (waiting for hits)') }
        else { Note '' }
    }
    $script:tick++
    if ($script:tick % 10 -eq 0) {   # every 5 s: is the game (not a server copy) still running?
        $game = Get-CimInstance Win32_Process -Filter "Name = 'Dauntless-Win64-Shipping.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -notmatch '\s-server(\s|$)' }
        if ($game) { $script:sawGame = $true } elseif ($script:sawGame) { $win.Close() }
    }
})
$timer.Start()
$win.Add_Closed({ $timer.Stop(); $keyTimer.Stop(); Save-Pos })
if ($script:pinnedAtStart) { $script:pinned = $true }
Update-Tabs
Render
[void]$win.ShowDialog()
