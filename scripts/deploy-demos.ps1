# Copy the repo's demo projects (projects/demo*) into the local WebDAW
# root folder, replacing any existing copy of each demo.
$ErrorActionPreference = 'Stop'

$dest = 'C:\Users\MarcCawood\my-data\webdaw'
$source = Join-Path $PSScriptRoot '..\projects'

New-Item -ItemType Directory -Force -Path $dest | Out-Null

$demos = Get-ChildItem -Path $source -Directory -Filter 'demo*'
if (-not $demos) {
    Write-Host "No projects/demo* folders found."
    exit 0
}

foreach ($demo in $demos) {
    $target = Join-Path $dest $demo.Name
    if (Test-Path $target) {
        Remove-Item -Recurse -Force $target
    }
    Copy-Item -Recurse -Force $demo.FullName $target
    Write-Host "Copied '$($demo.Name)' -> $target"
}
