[CmdletBinding()]param()
function main() {
  cd $PSScriptRoot
  cd ..

  $ver = Get-Content .\package.json | ConvertFrom-Json | Select-Object -ExpandProperty version

  # Build with the GitHub Pages subpath so asset URLs resolve under /webdaw/.
  npx vite build --base=/webdaw/ --emptyOutDir
  if ($LASTEXITCODE -ne 0) { throw "vite build failed" }

  # Stamp the package.json version into the built title tag (replacing any prior "(vX.Y.Z)" suffix).
  $distIndex = ".\dist\index.html"
  $indexContent = Get-Content $distIndex -Raw
  $indexContent = $indexContent -replace '<title>(.*?)(?:\s*\(v[\d.]+\))?</title>', "<title>`$1 (v$ver)</title>"
  Set-Content -Path $distIndex -Value $indexContent -NoNewline

  $targetRel = "../cawoodm.github.io/webdaw"

  if (-not (Test-Path $targetRel)) {New-Item -ItemType Directory -Path $targetRel | Out-Null}
  if (-not (Test-Path "$targetRel/projects")) {New-Item -ItemType Directory -Path "$targetRel/projects" | Out-Null}

  Push-Location $targetRel
  try {
    git pull
    if ($LASTEXITCODE -ne 0) { throw "GIT PULL Failed!" }

    # Wipe the target subfolder (the github.io repo's .git lives one level up,
    # so it's not affected).
    Get-ChildItem -Force | Remove-Item -Recurse -Force -Verbose

    Copy-Item ../../webdaw/dist/* -Recurse ./ -Verbose
    Copy-Item ../../webdaw/projects -Recurse ./projects -Verbose

    git add .
    git commit -m "webdaw-$ver-$(Get-Date -f yyyyMMddHHmm)"
    if ($LASTEXITCODE -ne 0) { Write-Warning "Nothing to commit (or commit failed)." }
    git push
    if ($LASTEXITCODE -ne 0) { throw "GIT PUSH Failed!" }
    #start "https://cawoodm.github.io/webdaw"
  } catch {
    throw $_
  } finally {
    Pop-Location
  }
}
$ErrorActionPreference = "Stop"
main
