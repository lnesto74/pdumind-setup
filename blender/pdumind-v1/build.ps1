$ErrorActionPreference='Continue'
$env:PDUMIND_ASSET_OUT='C:/HS/exchange/pdumind-viewport-v1/assets'
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python-exit-code 1 --python C:/HS/exchange/pdumind-viewport-v1/build_assets.py *> C:/HS/exchange/pdumind-viewport-v1/build.log
exit $LASTEXITCODE
