# Stop and remove existing webdaw container if it exists
Write-Host "Checking for existing webdaw container..." -ForegroundColor Cyan
$existingContainer = docker ps -a --filter "name=webdaw" --format "{{.ID}}"
if ($existingContainer) {
  Write-Host "Stopping existing webdaw container..." -ForegroundColor Yellow
  docker stop webdaw 2>$null | Out-Null
  docker rm webdaw 2>$null | Out-Null
  Write-Host "Removed existing webdaw container." -ForegroundColor Green
}

# Build the Docker image
Write-Host "Building Docker image..." -ForegroundColor Cyan
docker build -t webdaw:latest .
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker build failed!" -ForegroundColor Red
  exit 1
}

# Run the container
Write-Host "Starting webdaw container..." -ForegroundColor Cyan
docker run `
  --name webdaw `
  --restart=always `
  -d `
  -p 8083:8083 `
  webdaw:latest

if ($LASTEXITCODE -eq 0) {
  Write-Host "WebDAW is running at http://localhost:8083" -ForegroundColor Green
  Write-Host "Container will automatically restart on system reboot." -ForegroundColor Green
} else {
  Write-Host "Failed to start container!" -ForegroundColor Red
  exit 1
}
