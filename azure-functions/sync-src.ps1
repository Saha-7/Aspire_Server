$root = Join-Path $PSScriptRoot ".."

Copy-Item "$root\src\internal_db_sync.js"           ".\src\internal_db_sync.js"           -Force
Copy-Item "$root\src\sp_only_sync.js"                ".\src\sp_only_sync.js"                -Force
Copy-Item "$root\src\services\azureSqlService.js"    ".\src\services\azureSqlService.js"    -Force
Copy-Item "$root\src\utils\connectWithRetry.js"      ".\src\utils\connectWithRetry.js"      -Force
Copy-Item "$root\blobLogger.js"                      ".\blobLogger.js"                      -Force

Write-Host "Synced internal_db_sync.js, sp_only_sync.js, azureSqlService.js, connectWithRetry.js, blobLogger.js into azure-functions/"