
#!/bin/zsh
set -e

rm -rf a
rm -rf b
rm -rf c
rm -rf d
rm -rf e
rm -rf f

rm -rf prebuilds/

bare-make generate --build a --platform ios --arch arm64 --simulator
bare-make build --build a
bare-make install --build a

bare-make generate --build b --platform ios --arch x64 --simulator
bare-make build --build b
bare-make install --build b

bare-make generate --build c --platform ios --arch arm64
bare-make build --build c
bare-make install --build c

bare-make generate --build d --platform darwin --arch arm64
bare-make build --build d
bare-make install --build d

bare-make generate --build e --platform darwin --arch x64
bare-make build --build e
bare-make install --build e

bare-make generate --build f --platform android --arch arm64
bare-make build --build f
bare-make install --build f
