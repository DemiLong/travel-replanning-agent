param([string]$FileName = 'dayshift-source-v6-assist-resolution.zip')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([IO.Path]::GetFileName($FileName) -ne $FileName) { throw 'Use a filename without directories.' }
$outputDirectory = Join-Path $projectRoot 'outputs'
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$archivePath = Join-Path $outputDirectory $FileName
if (Test-Path -LiteralPath $archivePath) { throw 'Archive already exists; select a new filename.' }
$paths = @(git -C $projectRoot ls-files --cached --others --exclude-standard) | Sort-Object -Unique
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate project source.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
  foreach ($relative in $paths) {
    if ($relative -match '^(outputs|work|node_modules|\.next|\.git|draft_8cf79000_folder)/') { continue }
    if ($relative -match '(^|/)\.env' -and $relative -ne '.env.example') { continue }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
    if (-not $sourcePath.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Source outside project.' }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $sourcePath, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $count++
  }
} finally { $archive.Dispose() }
Write-Output "Packaged $count source files: $archivePath"
